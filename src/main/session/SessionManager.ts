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
import { LocalWebSearch, SearchEngineSettings } from '@core/service/LocalWebSearch'
// 附件链路：MultimodalService（先行解析）与 FileUploadService（Files API）此前是零引用的
// 已移植能力，见 makeAttachments 的说明。
import { MultimodalService } from '@core/service/MultimodalService'
import { FileUploadService } from '@core/service/FileUploadService'
import { image } from '@core/platform/kit/ImageKit'

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
    // 本地联网搜索配置同样在启动时绑定一次：渲染层虽然会在 init 里读一次设置，
    // 但那是一次 IPC 往返，理论上可以在它之前就跑起一轮工作 —— 那时工具会拿到默认配置。
    await this.bindLocalSearchConfig(ctx)
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
    const multimodalConfig: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    // 配置方案列表（首次运行会把已有的单份配置迁移成「默认配置」，对齐原版 ChatViewModel.init）
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    // 本地联网搜索：把持久化的配置**绑定**给工具层。
    // LocalWebSearch.settings 是进程级单例，不 bind 的话永远停在默认值（Bing / 默认条数），
    // 用户配的引擎与 Key 一律不生效 —— 原版在 ChatViewModel.init 里做了这一步，桌面端漏了。
    await this.bindLocalSearchConfig(ctx)
    return {
      apiConfig: apiConfig === null ? null : SessionManager.toApiConfigDto(apiConfig),
      apiProfiles: profiles.map((p) => SessionManager.toApiProfileDto(p)),
      currentApiProfileId: currentId,
      multimodalConfig: SessionManager.toMultimodalDto(multimodalConfig),
      flags: {},
      prefs: await this.loadStringPrefs()
    }
  }

  // ===== 配置方案（多套 API 配置） =====

  /**
   * 读配置方案列表与当前选中项。
   *
   * 首次运行（或从只有「单份配置」的旧版本升级）时，把已有的 apiConfig / multimodalConfig
   * 迁移成一份名为「默认配置」的方案并落盘 —— 与原版 ChatViewModel.init 的处理一致，
   * 这样老用户的 Key 不会因为引入了方案机制而消失。
   */
  private async readApiProfiles(ctx: Context): Promise<{ profiles: ApiProfile[]; currentId: string }> {
    let profiles: ApiProfile[] = await StorageManager.loadApiProfiles(ctx).catch(
      (): ApiProfile[] => []
    )
    if (profiles.length === 0) {
      const legacyApi: ApiConfig = await StorageManager.loadApiConfig(ctx).catch(
        (): ApiConfig => ApiConfig.default()
      ) ?? ApiConfig.default()
      const legacyMm: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
        (): MultimodalConfig => MultimodalConfig.default()
      )
      profiles = [ApiProfile.fromLegacy('默认配置', legacyApi ?? ApiConfig.default(), legacyMm)]
      await StorageManager.saveApiProfiles(ctx, profiles).catch(() => {
        // 迁移失败不阻断：本次仍按这份内存里的方案工作
      })
    }
    const saved: string = await StorageManager.loadString(
      ctx,
      Constants.LS_KEY_CURRENT_API_PROFILE_ID,
      ''
    ).catch((): string => '')
    const currentId: string = profiles.some((p) => p.id === saved) ? saved : profiles[0].id
    return { profiles, currentId }
  }

  /** 当前生效的配置方案（id 对不上时退回第一份，保证永远有一个可用方案） */
  private async currentProfile(ctx: Context): Promise<ApiProfile> {
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    return profiles.find((p) => p.id === currentId) ?? profiles[0]
  }

  /**
   * 让某个方案成为运行时生效的配置。
   *
   * 关键点：桌面端的聊天/工作轮次都是从**旧的两个键**（guncat_api_config / guncat_mm_config）
   * 读配置的（见 sendChat / runWork / regenerateChat），所以切换方案必须把方案内容写回那两个键，
   * 否则界面上切了、真正发请求时用的还是上一套。
   */
  private async applyProfile(ctx: Context, profile: ApiProfile): Promise<void> {
    await StorageManager.saveApiConfig(ctx, profile.apiConfig)
    await StorageManager.saveMultimodalConfig(ctx, profile.multimodalConfig)
    await StorageManager.saveString(ctx, Constants.LS_KEY_CURRENT_API_PROFILE_ID, profile.id)
  }

  /** 把运行时配置回写进当前方案（用户点「保存」时走这条） */
  private async writeBackToProfile(
    ctx: Context,
    apiDto: ApiConfigDto,
    mmDto: MultimodalConfigDto,
    name?: string
  ): Promise<void> {
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    const index: number = profiles.findIndex((p) => p.id === currentId)
    if (index < 0) {
      return
    }
    const profile: ApiProfile = profiles[index]
    if (name !== undefined && name.trim() !== '') {
      profile.name = name.trim()
    }
    profile.apiConfig = SessionManager.fromApiConfigDto(apiDto)
    profile.multimodalConfig = SessionManager.fromMultimodalDto(mmDto)
    await StorageManager.saveApiProfiles(ctx, profiles)
  }

  async selectApiProfile(profileId: string): Promise<void> {
    const ctx: Context = this.ctx()
    const { profiles } = await this.readApiProfiles(ctx)
    const profile: ApiProfile | undefined = profiles.find((p) => p.id === profileId)
    if (profile === undefined) {
      return
    }
    await this.applyProfile(ctx, profile)
  }

  /**
   * 新建一个配置方案。
   *
   * 与原版的一点差异（有意为之）：原版新建的是**空白配置**并立刻应用，
   * 用户若随后取消编辑，生效的配置就已经是空的了。桌面端改为**复制当前配置**再改名，
   * 这样任何时刻都有一套能用的配置，不会出现「加了个配置方案，聊天就发不出去了」。
   */
  async addApiProfile(): Promise<ApiProfileDto> {
    const ctx: Context = this.ctx()
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    const current: ApiProfile | undefined = profiles.find((p) => p.id === currentId)
    const created: ApiProfile = ApiProfile.create(`新配置 ${profiles.length + 1}`)
    if (current !== undefined) {
      created.apiConfig = current.apiConfig
      created.multimodalConfig = current.multimodalConfig
    }
    profiles.push(created)
    await StorageManager.saveApiProfiles(ctx, profiles)
    await this.applyProfile(ctx, created)
    return SessionManager.toApiProfileDto(created)
  }

  async deleteApiProfile(profileId: string): Promise<void> {
    const ctx: Context = this.ctx()
    const { profiles, currentId } = await this.readApiProfiles(ctx)
    // 至少留一份：全删掉会让应用没有任何可用配置
    if (profiles.length <= 1) {
      return
    }
    const remaining: ApiProfile[] = profiles.filter((p) => p.id !== profileId)
    if (remaining.length === profiles.length) {
      return
    }
    await StorageManager.saveApiProfiles(ctx, remaining)
    if (profileId === currentId) {
      // 删掉的正是当前方案：切到剩下的第一份，并把它的内容写回运行时键
      await this.applyProfile(ctx, remaining[0])
    }
  }

  /** 一次性保存当前方案（名称 + API 配置 + 多模态配置）—— 设置面板的「保存」按钮 */
  async saveCurrentApiProfile(
    name: string,
    apiDto: ApiConfigDto,
    mmDto: MultimodalConfigDto
  ): Promise<void> {
    const ctx: Context = this.ctx()
    await StorageManager.saveApiConfig(ctx, SessionManager.fromApiConfigDto(apiDto))
    await StorageManager.saveMultimodalConfig(ctx, SessionManager.fromMultimodalDto(mmDto))
    await this.writeBackToProfile(ctx, apiDto, mmDto, name)
  }

  async saveApiConfig(dto: ApiConfigDto): Promise<void> {
    const ctx: Context = this.ctx()
    await StorageManager.saveApiConfig(ctx, SessionManager.fromApiConfigDto(dto))
    // 同步回当前方案：不同步的话「保存」只改了运行时键，
    // 下次切走再切回来（或重启后按方案应用）就会退回到旧值
    const mm: MultimodalConfig = await StorageManager.loadMultimodalConfig(ctx).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    await this.writeBackToProfile(ctx, dto, SessionManager.toMultimodalDto(mm))
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
    const ctx: Context = this.ctx()
    await StorageManager.saveMultimodalConfig(ctx, SessionManager.fromMultimodalDto(dto))
    const api: ApiConfig | null = await StorageManager.loadApiConfig(ctx).catch(
      (): ApiConfig | null => null
    )
    await this.writeBackToProfile(
      ctx,
      SessionManager.toApiConfigDto(api ?? ApiConfig.default()),
      dto
    )
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
    'asr_model',
    // 本地联网搜索配置（整体 JSON）。原版由 SettingsPanel 编辑、ChatViewModel 落盘；
    // 桌面端此前既没读也没下发，LocalWebSearch.bind() 从来没有调用者 ——
    // 结果是「本地联网搜索」那套配置（引擎 / 各引擎 Key / maxResults）在桌面上形同不存在。
    Constants.LS_KEY_LOCAL_SEARCH_CONFIG
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

  /**
   * 读持久化的本地联网搜索配置并绑定给工具层。
   * 读取失败（首次运行 / JSON 坏了）时绑定默认配置而不是不绑 —— 不绑会让工具停在
   * 「进程启动时的默认值」上，行为随调用顺序变化，比明确用默认值更难排查。
   */
  private async bindLocalSearchConfig(ctx: Context): Promise<void> {
    let settings: SearchEngineSettings = new SearchEngineSettings()
    try {
      const json: string = await StorageManager.loadString(
        ctx,
        Constants.LS_KEY_LOCAL_SEARCH_CONFIG,
        ''
      )
      settings = SearchEngineSettings.parse(json)
    } catch {
      // 用默认配置
    }
    LocalWebSearch.bind(settings)
  }

  /** 保存本地联网搜索配置（同时立即生效，不必重启） */
  async saveLocalSearchConfig(json: string): Promise<void> {
    await StorageManager.saveString(
      this.ctx(),
      Constants.LS_KEY_LOCAL_SEARCH_CONFIG,
      json
    )
    LocalWebSearch.bind(SearchEngineSettings.parse(json))
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

    const attachments: Attachment[] = await this.makeAttachments(request.attachmentPaths ?? [])
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

  /**
   * 把用户选中的文件变成真正的附件。
   *
   * 用户报障类问题（审计 P0）：原实现只留了文件名 ——
   * `Attachment.of(name, '', 'file', '', '', '')`，dataUrl / parsedText / fileId 全是空串。
   * 而 ChatService 的三条协议都会因 `parsedText === '' && dataUrl === ''` 直接 `continue`，
   * 于是「加了附件」对请求零影响：图片发不过去，文档也没内容。
   *
   * 移植自原版 ChatViewModel.enqueueFiles + parseOneFile + prepareAttachmentFileIds：
   *   · 先行解析（preparseEnabled）：交给 MultimodalService 把内容读成文字；
   *   · 未开先行解析、或解析失败：退回 Base64 内联（dataUrl），由主模型的多模态能力直接看；
   *   · 大文件 / Responses 协议的文档：走 Files API 拿 file_id，按各协议引用。
   */
  private async makeAttachments(paths: string[]): Promise<Attachment[]> {
    const out: Attachment[] = []
    if (paths.length === 0) {
      return out
    }
    const mm: MultimodalConfig = await StorageManager.loadMultimodalConfig(this.ctx()).catch(
      (): MultimodalConfig => MultimodalConfig.default()
    )
    const api: ApiConfig | null = await StorageManager.loadApiConfig(this.ctx()).catch(
      (): ApiConfig | null => null
    )
    for (const p of paths) {
      const name: string = p.split(/[\\/]/).pop() ?? p
      if (!fs.existsSync(p)) {
        this.emit({ type: 'notice', level: 'warn', text: `附件不存在，已跳过：${name}` })
        continue
      }
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(p)
      } catch (e: unknown) {
        this.emit({
          type: 'notice',
          level: 'warn',
          text: `附件读取失败，已跳过：${name}（${e instanceof Error ? e.message : String(e)}）`
        })
        continue
      }
      const mime: string = SessionManager.guessMime(name)
      const isImage: boolean = mime.startsWith('image/')
      const type: string = isImage ? 'image' : 'file'
      let parsedText: string = ''
      let dataUrl: string = ''
      // 先行解析：多模态服务把图片/文档读成文字（没配密钥时静默跳过，下面会退回内联）
      if (mm.preparseEnabled && mm.apiKey !== '') {
        try {
          const result = await MultimodalService.parseFile(
            mm,
            name,
            SessionManager.toArrayBuffer(bytes),
            mime
          )
          parsedText = result.content
          dataUrl = result.dataUrl
        } catch (e: unknown) {
          // 解析失败不该让整条消息发不出去：退回内联，并在界面上说清原因
          this.emit({
            type: 'notice',
            level: 'warn',
            text: `${name} 解析失败，改为直接内联发送：${e instanceof Error ? e.message : String(e)}`
          })
        }
      }
      if (parsedText === '' && dataUrl === '') {
        dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
      }
      let fileId: string = ''
      if (api !== null && SessionManager.shouldUploadViaFilesApi(api, type, bytes.byteLength)) {
        try {
          fileId = await FileUploadService.uploadFile(
            api,
            name,
            mime,
            SessionManager.toArrayBuffer(bytes)
          )
        } catch {
          // 上传失败保留 dataUrl 内联发送（与原版一致）
          fileId = ''
        }
      }
      out.push(Attachment.of(name, parsedText, type, await this.makeThumbnail(dataUrl), dataUrl, fileId))
    }
    return out
  }

  /**
   * 是否走 Files API（对齐原版 prepareAttachmentFileIds 的判定）：
   *   · 文档只在 OpenAI Responses 协议下上传（其余协议没有 file 类型的引用方式）；
   *   · 图片超过 4MB 才上传（小图 Base64 内联更省一次往返）；
   *   · Anthropic 协议下只在 DeepSeek 的兼容入口上这么干（官方入口的阈值不同）。
   */
  private static shouldUploadViaFilesApi(
    config: ApiConfig,
    type: string,
    byteLength: number
  ): boolean {
    const provider: string = config.provider
    if (
      provider !== 'openai-completions' &&
      provider !== 'openai-responses' &&
      provider !== 'anthropic-messages'
    ) {
      return false
    }
    if (type === 'file') {
      return provider === 'openai-responses'
    }
    const THRESHOLD: number = 4 * 1024 * 1024
    if (provider === 'anthropic-messages') {
      return byteLength > THRESHOLD && config.baseUrl.indexOf('deepseek.com') !== -1
    }
    return byteLength > THRESHOLD
  }

  /** 图片的 96px 缩略图（消息气泡里显示小图，避免每次重绘都解码全尺寸原图）。 */
  private async makeThumbnail(dataUrl: string): Promise<string> {
    const comma: number = dataUrl.indexOf(',')
    if (comma < 0) {
      return ''
    }
    let source: image.ImageSource | null = null
    let pixelMap: image.PixelMap | null = null
    let packer: image.ImagePacker | null = null
    try {
      source = image.createImageSource(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
      pixelMap = await source.createPixelMap({ desiredSize: { width: 96, height: 96 } })
      packer = image.createImagePacker()
      const buffer: ArrayBuffer = await packer.packToData(pixelMap, {
        format: 'image/png',
        quality: 80
      })
      return `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`
    } catch {
      // 缩略图失败不影响附件本身（渲染层会退回显示文件名）
      return ''
    } finally {
      if (pixelMap !== null) {
        await pixelMap.release().catch((): void => undefined)
      }
      if (source !== null) {
        await source.release().catch((): void => undefined)
      }
      if (packer !== null) {
        await packer.release().catch((): void => undefined)
      }
    }
  }

  private static toArrayBuffer(bytes: Buffer): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  /** 按扩展名给出 MIME（附件内联 / 上传都要用；认不出时按二进制处理） */
  static guessMime(name: string): string {
    const dot: number = name.lastIndexOf('.')
    const ext: string = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
    const table: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      log: 'text/plain',
      yaml: 'text/yaml',
      yml: 'text/yaml'
    }
    return table[ext] ?? 'application/octet-stream'
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
      extraParams: config.extraBody,
      autoSuffix: config.autoSuffix
    }
  }

  static toApiProfileDto(profile: ApiProfile): ApiProfileDto {
    return {
      id: profile.id,
      name: profile.name,
      config: SessionManager.toApiConfigDto(profile.apiConfig),
      multimodalConfig: SessionManager.toMultimodalDto(profile.multimodalConfig)
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
    // 只认显式的 false：老渲染层不带这个字段时不能把它当成「关掉」
    // （默认开启，见 ApiConfig.autoSuffix 的说明）
    config.autoSuffix = dto.autoSuffix !== false
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
