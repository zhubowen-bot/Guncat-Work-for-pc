// SessionManager：主进程的业务权威。
//
// 它持有全部会话（内存中的 Conversation 模型 + 落盘持久化），
// 驱动「聊天模式」的三协议流式对话与「工作模式」的 Agent Loop，
// 并把状态变化以事件形式推给渲染进程。
//
// 对应鸿蒙版的 viewmodel/ChatViewModel.ets —— 那里 ViewModel 同时承担
// UI 状态与循环驱动；桌面端把循环驱动留在主进程，UI 状态由渲染进程的 store 负责，
// 因此这里只保留「业务」那一半。
import { appContext } from '@core/platform/kit/AbilityKit'
import fs from 'node:fs'
import path from 'node:path'
import { StorageManager } from '@core/data/StorageManager'
import { FileService, type PickedFile } from '@core/service/FileService'
import { DocxBuilder } from '@core/export/DocxBuilder'
import { AgentLoader } from '@core/service/AgentLoader'
import { ChatService } from '@core/service/ChatService'
import { AgentLoopService, LoopMessage, LoopTurnResult, LoopTurnCallbacks } from '@core/service/AgentLoopService'
import { WorkToolRunner } from '@core/service/WorkToolRunner'
import { WorkFileService } from '@core/service/WorkFileService'
import { SubagentService } from '@core/service/SubagentService'
import { Conversation } from '@core/model/Conversation'
import { Message } from '@core/model/Message'
import { Attachment } from '@core/model/Attachment'
import { ApiConfig } from '@core/model/ApiConfig'
import { ApiProfile } from '@core/model/ApiProfile'
import { MultimodalConfig } from '@core/model/MultimodalConfig'
import { Agent } from '@core/model/Agent'
import { ToolCallRecord } from '@core/model/ToolCallRecord'
import { StreamCallbacks, AbortSignal } from '@core/common/Types'
import { Constants } from '@core/common/Constants'
import { generateMessageId } from '@core/common/Utils'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { GuncatUiRuntime, GuncatUiTrailer } from '@core/common/GuncatUiRuntime'

import type {
  AgentDto,
  AppSettingsDto,
  ApiConfigDto,
  ApiProfileDto,
  ChatRegenerateRequest,
  ChatSendRequest,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  MessageDto,
  MultimodalConfigDto,
  ToolCallRecordDto,
  WorkRunRequest
} from '../../ipc/contract'

type Emit = (event: GuncatEvent) => void

/** 每个会话同一时刻只允许一个前台任务 */
class RunHandle {
  abort: AbortSignal = new AbortSignal()
  busy: boolean = false
}

export class SessionManager {
  private emit: Emit
  private conversations: Conversation[] = []
  private agents: Agent[] = []
  private runs: Map<string, RunHandle> = new Map()
  private loaded: boolean = false

  constructor(emit: Emit) {
    this.emit = emit
  }

  private ctx(): Context {
    return appContext()
  }

  // ===== 生命周期 =====

  async bootstrap(): Promise<void> {
    if (this.loaded) {
      return
    }
    const ctx: Context = this.ctx()
    // 技能库与工具表都是按需惰性同步的（见 WorkSkillService.ensureToolSkills），
    // 这里只做智能体加载与对话读取。
    this.agents = await AgentLoader.loadAllAgents(ctx)
    try {
      this.conversations = await StorageManager.loadConversations(ctx)
    } catch {
      this.conversations = []
    }
    this.loaded = true
  }

  listAgents(): AgentDto[] {
    return this.agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      shortDescription: a.shortDescription,
      icon: a.icon,
      category: a.category,
      prompt: a.systemPrompt
    }))
  }

  // ===== 设置 =====

  async loadSettings(): Promise<AppSettingsDto> {
    const ctx: Context = this.ctx()
    const apiConfig: ApiConfig | null = await StorageManager.loadApiConfig(ctx).catch(
      (): ApiConfig | null => null
    )
    const apiProfiles: ApiProfile[] = await StorageManager.loadApiProfiles(ctx).catch(
      (): ApiProfile[] => []
    )
    const multimodalConfig: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    return {
      apiConfig: apiConfig === null ? null : SessionManager.toApiConfigDto(apiConfig),
      apiProfiles: apiProfiles.map((p) => ({
        id: p.id,
        name: p.name,
        config: SessionManager.toApiConfigDto(p.apiConfig),
        multimodalConfig: SessionManager.toMultimodalDto(p.multimodalConfig)
      })),
      multimodalConfig: SessionManager.toMultimodalDto(multimodalConfig),
      flags: {},
      prefs: await this.loadStringPrefs()
    }
  }

  async saveApiConfig(dto: ApiConfigDto): Promise<void> {
    await StorageManager.saveApiConfig(this.ctx(), SessionManager.fromApiConfigDto(dto))
  }

  async saveApiProfiles(profiles: ApiProfileDto[]): Promise<void> {
    const models: ApiProfile[] = profiles.map((p) => {
      const profile: ApiProfile = new ApiProfile()
      profile.id = p.id
      profile.name = p.name
      profile.apiConfig = SessionManager.fromApiConfigDto(p.config)
      profile.multimodalConfig = SessionManager.fromMultimodalDto(p.multimodalConfig)
      return profile
    })
    await StorageManager.saveApiProfiles(this.ctx(), models)
  }

  async saveMultimodalConfig(dto: MultimodalConfigDto): Promise<void> {
    await StorageManager.saveMultimodalConfig(this.ctx(), SessionManager.fromMultimodalDto(dto))
  }

  async saveFlag(key: string, value: boolean): Promise<void> {
    await StorageManager.saveBoolean(this.ctx(), key, value)
  }

  async saveString(key: string, value: string): Promise<void> {
    await StorageManager.saveString(this.ctx(), key, value)
  }

  /** 字符串型偏好：朗读音色/语速、语音转写配置等（鸿蒙侧存在 Preferences，桌面端同构） */
  private static readonly STRING_PREF_KEYS: string[] = [
    'reader_voice',
    'reader_rate',
    'reader_enabled',
    'asr_baseUrl',
    'asr_apiKey',
    'asr_model'
  ]

  private async loadStringPrefs(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const key of SessionManager.STRING_PREF_KEYS) {
      try {
        const value: string = await StorageManager.loadString(this.ctx(), key, '')
        if (value !== '') {
          out[key] = value
        }
      } catch {
        // 单个偏好读取失败不影响其它设置
      }
    }
    return out
  }

  // ===== 对话 =====

  listConversations(): ConversationSummaryDto[] {
    return this.conversations
      .map((c) => SessionManager.toSummary(c))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getConversation(id: string): ConversationDto | null {
    const conv: Conversation | undefined = this.find(id)
    return conv === undefined ? null : SessionManager.toDto(conv)
  }

  private find(id: string): Conversation | undefined {
    return this.conversations.find((c) => c.id === id)
  }

  private mustFind(id: string): Conversation {
    const conv: Conversation | undefined = this.find(id)
    if (conv === undefined) {
      throw new Error(`会话不存在: ${id}`)
    }
    return conv
  }

  async createConversation(agentId: string, mode: string): Promise<ConversationDto> {
    // 标题留空 —— 对齐鸿蒙原版 ChatViewModel.startNewConversation：
    //   Conversation.create(this.currentAgent.id, '', mode)
    // 标题由「第一条用户消息」推导（见 sendChat / runWork 里的 deriveTitle），
    // 侧栏在标题为空时回退显示「与 X 的对话」。
    //
    // 历史事故：这里原先传的是 agent.name，而标题推导的守卫只认 ''/'新对话'，
    // 于是引擎名被当成标题焊死在会话上 —— 用户看到的正是「每一条会话都叫轻简模式」。
    const conv: Conversation = Conversation.create(agentId, '', mode)
    this.conversations.push(conv)
    await this.persist()
    const dto: ConversationDto = SessionManager.toDto(conv)
    this.emit({ type: 'conversation:created', conversation: dto })
    return dto
  }

  async deleteConversation(id: string): Promise<void> {
    const index: number = this.conversations.findIndex((c) => c.id === id)
    if (index < 0) {
      return
    }
    this.conversations.splice(index, 1)
    try {
      WorkFileService.deleteWorkspace(this.ctx(), id)
    } catch {
      // 工作区清理失败不阻塞会话删除
    }
    await this.persist()
    this.emit({ type: 'conversation:deleted', conversationId: id })
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const conv: Conversation = this.mustFind(id)
    conv.title = title
    await this.persist()
    this.emit({ type: 'conversation:title', conversationId: id, title })
  }

  /**
   * 交互模式：把界面控件的绑定值（状态尾标记）写回消息正文并落盘。
   * 只更新 content/displayContent，不触发模型请求。
   */
  async patchMessageContent(conversationId: string, messageId: string, content: string): Promise<void> {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined) {
      return
    }
    const msg: Message | undefined = conv.messages.find((m) => m.id === messageId)
    if (msg === undefined) {
      return
    }
    msg.content = content
    msg.displayContent = content
    await this.persist()
    this.patchMessage(conversationId, messageId, { content, displayContent: content })
  }

  private async persist(): Promise<void> {
    try {
      await StorageManager.saveConversations(this.ctx(), this.conversations)
    } catch (e) {
      this.emit({ type: 'notice', level: 'warn', text: `对话保存失败: ${String(e)}` })
    }
  }

  // ===== 运行态控制 =====

  private handle(conversationId: string): RunHandle {
    let handle: RunHandle | undefined = this.runs.get(conversationId)
    if (handle === undefined) {
      handle = new RunHandle()
      this.runs.set(conversationId, handle)
    }
    return handle
  }

  isBusy(conversationId: string): boolean {
    return this.handle(conversationId).busy
  }

  abort(conversationId: string): void {
    const handle: RunHandle = this.handle(conversationId)
    handle.abort.aborted = true
    // 两个服务各自持有活跃请求注册表，都要中断
    ChatService.abort()
    AgentLoopService.abort()
  }

  // ===== 聊天模式 =====

  async sendChat(request: ChatSendRequest): Promise<void> {
    const conv: Conversation = this.mustFind(request.conversationId)
    const handle: RunHandle = this.handle(conv.id)
    if (handle.busy) {
      this.emit({ type: 'notice', level: 'warn', text: '当前会话正在生成中，请先停止' })
      return
    }

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      this.emit({ type: 'notice', level: 'error', text: '请先在设置里配置 API Key 与模型' })
      return
    }

    const attachments: Attachment[] = this.makeAttachments(request.attachmentPaths ?? [])
    const userMsg: Message = Message.ofUser(
      generateMessageId(),
      request.text,
      request.text,
      attachments
    )
    conv.messages.push(userMsg)
    this.emit({ type: 'message:added', conversationId: conv.id, message: SessionManager.toMessageDto(userMsg) })

    const agent: Agent | undefined = this.agents.find((a) => a.id === conv.agentId)
    // 首条用户消息用它作为会话标题
    if (SessionManager.needsDerivedTitle(conv.title, agent !== undefined ? agent.name : '')) {
      const title: string = SessionManager.deriveTitle(request.text)
      if (title !== '' && title !== conv.title) {
        conv.title = title
        this.emit({ type: 'conversation:title', conversationId: conv.id, title })
      }
    }

    await this.runChatTurn(
      conv,
      config,
      agent,
      request.text,
      request.thinkingEnabled,
      request.webSearchEnabled
    )
  }

  /**
   * 重新生成：丢掉最后一条用户消息之后的所有 assistant 消息，再用同一个问题重跑。
   * 与「重发」不同 —— 失败的/被中止的那次输出就地消失，不会在它下面再叠一条。
   */
  async regenerateChat(request: ChatRegenerateRequest): Promise<void> {
    const conv: Conversation = this.mustFind(request.conversationId)
    const handle: RunHandle = this.handle(conv.id)
    if (handle.busy) {
      this.emit({ type: 'notice', level: 'warn', text: '当前会话正在生成中，请先停止' })
      return
    }

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      this.emit({ type: 'notice', level: 'error', text: '请先在设置里配置 API Key 与模型' })
      return
    }

    let lastUserIndex: number = -1
    for (let i: number = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex < 0) {
      this.emit({ type: 'notice', level: 'warn', text: '这条会话还没有可重新生成的问题' })
      return
    }
    const prompt: string = conv.messages[lastUserIndex].content
    conv.messages = conv.messages.slice(0, lastUserIndex + 1)
    await this.persist()
    // 整份会话同步给渲染进程：增量事件表达不了「消息被删掉」这件事
    this.emit({ type: 'conversation:sync', conversation: SessionManager.toDto(conv) })

    const agent: Agent | undefined = this.agents.find((a) => a.id === conv.agentId)
    await this.runChatTurn(
      conv,
      config,
      agent,
      prompt,
      request.thinkingEnabled,
      request.webSearchEnabled
    )
  }

  /** 执行一轮聊天流式输出（sendChat / regenerateChat 共用） */
  private async runChatTurn(
    conv: Conversation,
    config: ApiConfig,
    agent: Agent | undefined,
    prompt: string,
    thinkingEnabled: boolean,
    webSearchEnabled: boolean
  ): Promise<void> {
    const handle: RunHandle = this.handle(conv.id)
    const assistantMsg: Message = Message.ofAssistant(generateMessageId(), '')
    conv.messages.push(assistantMsg)
    this.emit({
      type: 'message:added',
      conversationId: conv.id,
      message: SessionManager.toMessageDto(assistantMsg)
    })
    this.emit({ type: 'turn:started', conversationId: conv.id, messageId: assistantMsg.id })

    const history: Message[] = conv.messages.slice(0, -1)
    handle.busy = true
    handle.abort = new AbortSignal()

    const callbacks: StreamCallbacks = new StreamCallbacks()
    let streamed: string = ''
    callbacks.onToken = (text: string): void => {
      streamed += text
      this.patchMessage(conv.id, assistantMsg.id, { content: streamed, displayContent: streamed })
    }
    callbacks.onReasoning = (text: string): void => {
      this.patchMessage(conv.id, assistantMsg.id, { reasoning: text })
    }
    callbacks.onUsage = (speed: number, hit: number): void => {
      this.patchMessage(conv.id, assistantMsg.id, { tokenSpeed: speed, cacheHitRate: hit })
    }

    let failure: string = ''
    try {
      const result = await ChatService.streamChat(
        config,
        agent ?? null,
        history,
        prompt,
        thinkingEnabled,
        webSearchEnabled,
        callbacks,
        handle.abort
      )
      if (result.toolCalls.length > 0) {
        assistantMsg.toolCalls = result.toolCalls
        this.patchMessage(conv.id, assistantMsg.id, { content: streamed })
      }
    } catch (e) {
      failure = (e as Error)?.message ?? String(e)
    } finally {
      handle.busy = false
      assistantMsg.content = streamed
      assistantMsg.displayContent = streamed
      await this.persist()
      if (handle.abort.aborted) {
        this.emit({ type: 'turn:finished', conversationId: conv.id, messageId: assistantMsg.id, status: 'aborted' })
      } else if (failure !== '') {
        this.emit({
          type: 'turn:finished',
          conversationId: conv.id,
          messageId: assistantMsg.id,
          status: 'error',
          error: failure
        })
      } else {
        this.emit({ type: 'turn:finished', conversationId: conv.id, messageId: assistantMsg.id, status: 'ok' })
      }
    }
  }

  // ===== 工作模式 / 交互模式：Agent Loop =====

  async runWork(request: WorkRunRequest): Promise<void> {
    const conv: Conversation = this.mustFind(request.conversationId)
    const handle: RunHandle = this.handle(conv.id)
    if (handle.busy) {
      this.emit({ type: 'notice', level: 'warn', text: '当前会话正在执行中，请先停止' })
      return
    }

    const config: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    if (config === null || config.apiKey === '' || config.model === '') {
      this.emit({ type: 'notice', level: 'error', text: '请先在设置里配置 API Key 与模型' })
      return
    }

    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conv.id)

    // 子代理工具通过钩子执行；这里注入当前配置，让 subagent 能独立发起请求
    SubagentService.bind(
      config,
      request.thinkingEnabled,
      request.thinkingEnabled ? 'high' : 'none',
      (context: never, convId: string, name: string, argsJson: string, abortSignal?: never) =>
        WorkToolRunner.execute(context, convId, name, argsJson, abortSignal ?? null)
    )

    const userMsg: Message = Message.ofUser(generateMessageId(), request.text, request.text, [])
    conv.messages.push(userMsg)
    this.emit({ type: 'message:added', conversationId: conv.id, message: SessionManager.toMessageDto(userMsg) })
    const agent: Agent | undefined = this.agents.find((a) => a.id === conv.agentId)
    if (SessionManager.needsDerivedTitle(conv.title, agent !== undefined ? agent.name : '')) {
      const title: string = SessionManager.deriveTitle(request.text)
      if (title !== '' && title !== conv.title) {
        conv.title = title
        this.emit({ type: 'conversation:title', conversationId: conv.id, title })
      }
    }

    // 循环消息：系统提示词固定在第 0 条
    // 交互模式的状态回传：把上一轮界面里用户调过的绑定值翻译成一句人话附在任务后，
    // 模型才知道界面当前处于什么状态（对齐上游 GuncatUiRuntime.describeStateForModel）。
    const uiContext: string = this.describeUiState(conv)
    const taskText: string = uiContext === '' ? request.text : `${request.text}\n${uiContext}`

    const messages: LoopMessage[] = [
      LoopMessage.system(AgentLoopService.buildWorkSystemPromptFor(request.mode)),
      LoopMessage.user(taskText)
    ]

    const mode: string = request.mode === 'interactive' ? 'interactive' : 'work'
    const reasoningEffort: string = request.thinkingEnabled ? 'high' : 'none'
    const maxSteps: number = Constants.WORK_MAX_STEPS

    handle.busy = true
    handle.abort = new AbortSignal()

    let assistantMsg: Message | null = null
    let streamed: string = ''
    let failure: string = ''

    try {
      for (let step: number = 0; step < maxSteps; step++) {
        if (handle.abort.aborted) {
          break
        }

        // 每一轮在 UI 上是一条 assistant 消息（思考 → 工具 → 正文）
        assistantMsg = Message.ofAssistant(generateMessageId(), '')
        conv.messages.push(assistantMsg)
        this.emit({
          type: 'message:added',
          conversationId: conv.id,
          message: SessionManager.toMessageDto(assistantMsg)
        })
        this.emit({ type: 'turn:started', conversationId: conv.id, messageId: assistantMsg.id })

        const targetMsg: Message = assistantMsg
        streamed = ''
        const callbacks: LoopTurnCallbacks = new LoopTurnCallbacks()
        callbacks.onToken = (text: string): void => {
          streamed += text
          this.patchMessage(conv.id, targetMsg.id, { content: streamed, displayContent: streamed })
        }
        callbacks.onReasoning = (text: string): void => {
          this.patchMessage(conv.id, targetMsg.id, { reasoning: text })
        }
        callbacks.onToolCalls = (calls: ToolCallRecord[]): void => {
          targetMsg.toolCalls = calls
        }
        callbacks.onUsage = (speed: number, hit: number): void => {
          this.patchMessage(conv.id, targetMsg.id, { tokenSpeed: speed, cacheHitRate: hit })
        }

        const turn: LoopTurnResult = await AgentLoopService.runTurnWithRetry(
          config,
          messages,
          request.thinkingEnabled,
          reasoningEffort,
          request.webSearchEnabled,
          callbacks,
          handle.abort,
          true
        )

        targetMsg.reasoning = turn.reasoning
        targetMsg.tokenSpeed = turn.tokenSpeed
        targetMsg.cacheHitRate = turn.cacheHitRate
        targetMsg.toolCalls = turn.toolCalls

        // 工具调用先行落到时间线上（执行前后各推一次，UI 可显示"执行中"）
        for (const call of turn.toolCalls) {
          this.emit({
            type: 'tool:started',
            conversationId: conv.id,
            messageId: targetMsg.id,
            call: SessionManager.toToolDto(call)
          })
        }

        const loopMsg: LoopMessage = LoopMessage.fromTurn(turn)
        messages.push(loopMsg)

        if (turn.toolCalls.length === 0) {
          this.patchMessage(conv.id, targetMsg.id, { content: streamed })
          await this.persist()
          this.emit({ type: 'turn:finished', conversationId: conv.id, messageId: targetMsg.id, status: 'ok' })
          break
        }

        // 串行执行工具（与鸿蒙侧默认行为一致：同一轮的调用按序执行，结果回填到同一批记录）
        for (const call of turn.toolCalls) {
          if (handle.abort.aborted) {
            break
          }
          const outcome = await WorkToolRunner.execute(
            ctx as never,
            conv.id,
            call.name,
            call.argsJson,
            handle.abort
          )
          call.result = outcome.ok ? outcome.output : outcome.output
          call.isError = !outcome.ok
          call.durationMs = 0
          call.timeout = outcome.timeout
          call.cancelled = outcome.cancelled
          call.schemaError = outcome.schemaError
          if (outcome.meta !== '') {
            call.meta = outcome.meta
          }
          this.emit({
            type: 'tool:finished',
            conversationId: conv.id,
            messageId: targetMsg.id,
            call: SessionManager.toToolDto(call)
          })
          // 工作区可能已被工具改写
          this.emit({ type: 'workspace:changed', conversationId: conv.id })
        }

        this.patchMessage(conv.id, targetMsg.id, { content: streamed })
        await this.persist()
        this.emit({
          type: 'turn:finished',
          conversationId: conv.id,
          messageId: targetMsg.id,
          status: handle.abort.aborted ? 'aborted' : 'ok'
        })

        if (turn.finishReason === 'stop' && turn.toolCalls.length === 0) {
          break
        }
      }
    } catch (e) {
      failure = (e as Error)?.message ?? String(e)
      if (assistantMsg !== null) {
        this.emit({
          type: 'turn:finished',
          conversationId: conv.id,
          messageId: assistantMsg.id,
          status: 'error',
          error: failure
        })
      }
    } finally {
      handle.busy = false
      await this.persist()
    }
  }

  // ===== 工作区 =====

  listWorkspace(conversationId: string): Array<{
    name: string
    path: string
    isDirectory: boolean
    size: number
    modifiedAt: number
  }> {
    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conversationId)
    const items = WorkFileService.listWorkspace(ctx, conversationId)
    return items.map((item) => ({
      name: item.path.split('/').pop() ?? item.path,
      path: item.path,
      isDirectory: item.isDir,
      size: item.size,
      modifiedAt: 0
    }))
  }

  workspaceTreeText(conversationId: string): string {
    return WorkFileService.listWorkspaceTree(this.ctx(), conversationId)
  }

  workspaceRoot(conversationId: string): string {
    return WorkFileService.workspaceRoot(this.ctx(), conversationId)
  }

  /**
   * 文件收件：把外部文件（拖拽 / 命令行 / 系统「打开方式」）导入会话沙箱工作区。
   * 这是鸿蒙版「接收系统分享」在桌面端的等价入口 —— 收进来的文件进工作区，
   * 由模型通过文件工具读取，而不是自动当附件发出去。
   */
  async intakePaths(
    conversationId: string,
    paths: string[]
  ): Promise<{ names: string[]; imported: number; failed: string[] }> {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv === undefined) {
      throw new Error(`会话不存在: ${conversationId}`)
    }
    const ctx: Context = this.ctx()
    WorkFileService.ensureWorkspace(ctx, conversationId)

    const files: PickedFile[] = []
    const failed: string[] = []
    for (const p of paths) {
      try {
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
          failed.push(p)
          continue
        }
        const stat = fs.statSync(p)
        // 与上游单文件上限保持一致，避免把超大文件塞进工作区
        if (stat.size > Constants.WORK_WRITE_MAX_BYTES * 4) {
          failed.push(`${path.basename(p)}（超过体积上限）`)
          continue
        }
        const buf: Buffer = fs.readFileSync(p)
        files.push({
          name: path.basename(p),
          uri: p,
          fileType: FileService.guessTypeByName(path.basename(p)),
          size: stat.size,
          buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        })
      } catch {
        failed.push(p)
      }
    }

    const names: string[] = WorkFileService.savePickedFiles(ctx, conversationId, files)
    this.emit({ type: 'workspace:changed', conversationId })
    this.emit({
      type: 'files:intaken',
      conversationId,
      names,
      imported: names.length,
      failed
    })
    return { names, imported: names.length, failed }
  }

  /**
   * 把某条回答导出为 Word（复用移植过来的 DocxBuilder，含 LaTeX → OMML 公式转换）。
   * 返回字节，由调用方决定落盘位置。
   */
  async exportMessageDocx(conversationId: string, messageId: string): Promise<Uint8Array> {
    const conv: Conversation = this.mustFind(conversationId)
    const msg: Message | undefined = conv.messages.find((m) => m.id === messageId)
    if (msg === undefined) {
      throw new Error('消息不存在')
    }
    // 交互模式的界面程序不适合直接进 Word，这里只导出文本部分
    const body: string = GuncatUiParts.build(msg.content, true).textOnly || msg.content
    const title: string = conv.title !== '' ? conv.title : 'Guncat 回答'
    return await DocxBuilder.buildFromMarkdown(body, title, {
      resolve: async (): Promise<null> => null
    } as never)
  }

  // ===== 内部工具 =====

  private patchMessage(conversationId: string, messageId: string, patch: Partial<MessageDto>): void {
    const conv: Conversation | undefined = this.find(conversationId)
    if (conv !== undefined) {
      const msg: Message | undefined = conv.messages.find((m) => m.id === messageId)
      if (msg !== undefined) {
        if (patch.content !== undefined) {
          msg.content = patch.content
        }
        if (patch.displayContent !== undefined) {
          msg.displayContent = patch.displayContent
        }
        if (patch.reasoning !== undefined) {
          msg.reasoning = patch.reasoning
        }
        if (patch.tokenSpeed !== undefined) {
          msg.tokenSpeed = patch.tokenSpeed
        }
        if (patch.cacheHitRate !== undefined) {
          msg.cacheHitRate = patch.cacheHitRate
        }
      }
    }
    this.emit({ type: 'message:patched', conversationId, messageId, patch })
  }

  private makeAttachments(paths: string[]): Attachment[] {
    const out: Attachment[] = []
    for (const p of paths) {
      const name: string = p.split(/[\\/]/).pop() ?? p
      out.push(Attachment.of(name, '', 'file', '', '', ''))
    }
    return out
  }

  /**
   * 把最近一轮交互界面的绑定状态翻译成一句给模型看的人话。
   * 没有界面状态时返回空串。
   */
  private describeUiState(conv: Conversation): string {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const msg: Message = conv.messages[i]
      if (msg.role !== 'assistant' || msg.content === '') {
        continue
      }
      const split = GuncatUiTrailer.split(msg.content)
      if (!split.hasState) {
        continue
      }
      const parts = GuncatUiParts.build(msg.content, true)
      const uiSeg = parts.segments.find((s) => s.type === 'ui' && s.program !== null)
      if (uiSeg === undefined || uiSeg.program === null) {
        return ''
      }
      return GuncatUiRuntime.describeStateForModel(uiSeg.program, split.stateJson)
    }
    return ''
  }

  // ===== DTO 映射 =====

  static deriveTitle(text: string): string {
    const line: string = text.trim().split('\n')[0].trim()
    return line.length > 24 ? line.substring(0, 24) + '…' : line
  }

  /**
   * 这条会话的标题是否还需要从首条用户消息推导。
   *
   * 除空标题与历史默认名之外，还认「标题恰好等于引擎名」这一种脏数据：
   * 早期版本建会话时把 agent.name 写成了 title，只认 ''/'新对话' 的守卫会永远跳过它，
   * 于是会话列表里每条都顶着同一个引擎名。这里补上自救，用户下次发消息标题就正常了。
   */
  static needsDerivedTitle(title: string, agentName: string): boolean {
    const trimmed: string = title.trim()
    if (trimmed === '' || trimmed === '新对话') {
      return true
    }
    return agentName !== '' && trimmed === agentName
  }

  static toSummary(conv: Conversation): ConversationSummaryDto {
    let updatedAt: number = conv.createdAt
    let preview: string = ''
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m: Message = conv.messages[i]
      if (m.content !== '') {
        preview = m.content.slice(0, 60)
        break
      }
    }
    if (conv.messages.length > 0) {
      updatedAt = conv.messages[conv.messages.length - 1].timestamp
    }
    return {
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      mode: conv.mode,
      updatedAt,
      messageCount: conv.messages.length,
      lastPreview: preview
    }
  }

  static toToolDto(rec: ToolCallRecord): ToolCallRecordDto {
    return {
      id: rec.id,
      name: rec.name,
      argsJson: rec.argsJson,
      result: rec.result,
      status: rec.isError ? 'error' : rec.durationMs < 0 ? 'running' : 'ok',
      startedAt: 0,
      finishedAt: 0,
      diff: rec.meta
    }
  }

  static toMessageDto(msg: Message): MessageDto {
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      displayContent: msg.displayContent,
      reasoning: msg.reasoning,
      attachments: msg.attachments.map((a, index) => ({
        id: `${msg.id}_att${index}`,
        name: a.name,
        type: a.type,
        dataUrl: a.dataUrl,
        thumbnail: a.thumbnail,
        parsedText: a.parsedText,
        fileId: a.fileId
      })),
      toolCalls: msg.toolCalls.map((c) => SessionManager.toToolDto(c)),
      timestamp: msg.timestamp,
      tokenSpeed: msg.tokenSpeed,
      cacheHitRate: msg.cacheHitRate
    }
  }

  static toDto(conv: Conversation): ConversationDto {
    return {
      id: conv.id,
      title: conv.title,
      agentId: conv.agentId,
      mode: conv.mode,
      createdAt: conv.createdAt,
      updatedAt: conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].timestamp : conv.createdAt,
      messages: conv.messages.map((m) => SessionManager.toMessageDto(m))
    }
  }

  static toApiConfigDto(config: ApiConfig): ApiConfigDto {
    return {
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature ?? 0,
      topP: config.topP ?? 0,
      maxTokens: config.maxTokens ?? 0,
      extraParams: config.extraBody
    }
  }

  static fromApiConfigDto(dto: ApiConfigDto): ApiConfig {
    const config: ApiConfig = new ApiConfig()
    config.provider = ApiConfig.normalizeProvider(dto.provider)
    config.baseUrl = dto.baseUrl
    config.apiKey = dto.apiKey
    config.model = dto.model
    config.temperature = dto.temperature > 0 ? dto.temperature : null
    config.topP = dto.topP > 0 ? dto.topP : null
    config.maxTokens = dto.maxTokens > 0 ? dto.maxTokens : null
    config.extraBody = dto.extraParams
    return config
  }

  static toMultimodalDto(config: MultimodalConfig): MultimodalConfigDto {
    return {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      preparseEnabled: config.preparseEnabled
    }
  }

  static fromMultimodalDto(dto: MultimodalConfigDto): MultimodalConfig {
    const config: MultimodalConfig = MultimodalConfig.default()
    config.baseUrl = dto.baseUrl
    config.apiKey = dto.apiKey
    config.model = dto.model
    config.preparseEnabled = dto.preparseEnabled
    return config
  }
}
