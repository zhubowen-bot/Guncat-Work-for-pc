// 渲染进程状态镜像。
//
// 主进程是业务权威，这里只保存「展示所需」的投影：
// 会话摘要列表、当前会话的完整消息、运行态标志与工作区清单。
// 所有变更都来自 (a) 用户操作的 invoke 返回，或 (b) 主进程推来的事件。
import { create } from 'zustand'
import { useSpeech } from './speech/speechStore'
import {
  agentIdForMode,
  buildAgentList,
  engineIdOfConversation,
  isVirtualAgentId,
  modeForAgentId
} from './conversations'
import type {
  AgentDto,
  AgentMode,
  AppSettingsDto,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  MessageDto,
  WorkspaceEntryDto
} from '@ipc/contract'

export interface Notice {
  level: 'info' | 'warn' | 'error'
  text: string
  at: number
}

interface State {
  ready: boolean
  /** 真实智能体（agents.json，IPC 原样） */
  agents: AgentDto[]
  /** 引擎列表 = 两个虚拟智能体（工作 / 交互）+ 真实智能体，侧栏「引擎」区直接渲染它 */
  engines: AgentDto[]
  /** 当前选中的引擎 id（可能是 work / interactive 这两个虚拟智能体） */
  activeAgentId: string
  summaries: ConversationSummaryDto[]
  activeId: string | null
  active: ConversationDto | null
  mode: AgentMode
  running: boolean
  thinkingEnabled: boolean
  webSearchEnabled: boolean
  settings: AppSettingsDto | null
  workspace: WorkspaceEntryDto[]
  notice: Notice | null
  settingsOpen: boolean
  /** 「填入输入框 / 重新编辑」请求：由消息操作行写入，输入框消费后清空 */
  pendingDraft: { text: string; at: number } | null

  init(): Promise<void>
  reloadSummaries(): Promise<void>
  selectConversation(id: string): Promise<void>
  createConversation(): Promise<ConversationDto>
  deleteConversation(id: string): Promise<void>
  /** 切换引擎（原版侧栏「引擎」区）：选中即切到该引擎的最新会话，没有就新建 */
  selectAgent(agentId: string): Promise<void>
  setMode(mode: AgentMode): void
  setThinking(value: boolean): void
  setWebSearch(value: boolean): void
  openSettings(open: boolean): void
  reloadSettings(): Promise<void>
  send(text: string): Promise<void>
  /** 重新生成最后一条回答 */
  regenerate(): Promise<void>
  /** 交互模式：把界面控件的绑定值写回消息并持久化 */
  patchMessageContent(messageId: string, content: string): Promise<void>
  abort(): Promise<void>
  loadWorkspace(): Promise<void>
  deleteWorkspaceEntry(path: string): Promise<void>
  clearWorkspace(): Promise<void>
  exportWorkspace(): Promise<void>
  openWorkspaceFolder(): Promise<void>
  pushNotice(level: Notice['level'], text: string): void
  dismissNotice(): void
  /** 把一段文本填进输入框（消息操作行的「编辑 / 重新编辑」） */
  fillDraft(text: string): void
  consumeDraft(): void
  /** 端侧增强：把外部文件导入当前会话工作区 */
  intakeFiles(paths: string[]): Promise<void>
  /** 端侧增强：弹系统文件选择框并导入（工作区面板的「上传」按钮） */
  pickWorkspaceFiles(): Promise<void>
}

function applyEvent(state: State, event: GuncatEvent): Partial<State> {
  switch (event.type) {
    case 'conversation:created':
      return {
        summaries: [summaryOf(event.conversation), ...state.summaries],
        activeId: event.conversation.id,
        active: event.conversation,
        activeAgentId: engineIdOfConversation(event.conversation),
        mode: event.conversation.mode as AgentMode
      }

    case 'conversation:sync':
      // 「重新生成」把末尾若干条消息删掉了：增量事件表达不了删除，用整份会话替换
      if (state.active === null || state.active.id !== event.conversation.id) {
        return {}
      }
      return {
        active: event.conversation,
        summaries: state.summaries.map((s) =>
          s.id === event.conversation.id ? summaryOf(event.conversation) : s
        )
      }

    case 'conversation:deleted': {
      const summaries = state.summaries.filter((s) => s.id !== event.conversationId)
      const wasActive = state.activeId === event.conversationId
      return {
        summaries,
        activeId: wasActive ? null : state.activeId,
        active: wasActive ? null : state.active
      }
    }

    case 'conversation:title':
      return {
        summaries: state.summaries.map((s) =>
          s.id === event.conversationId ? { ...s, title: event.title } : s
        ),
        active:
          state.active !== null && state.active.id === event.conversationId
            ? { ...state.active, title: event.title }
            : state.active
      }

    case 'message:added': {
      if (state.active === null || state.active.id !== event.conversationId) {
        return {}
      }
      return { active: { ...state.active, messages: [...state.active.messages, event.message] } }
    }

    case 'message:patched': {
      if (state.active === null || state.active.id !== event.conversationId) {
        return {}
      }
      return {
        active: {
          ...state.active,
          messages: state.active.messages.map((m) =>
            m.id === event.messageId ? { ...m, ...event.patch } : m
          )
        }
      }
    }

    case 'tool:started':
    case 'tool:finished':
      return patchToolCall(state, event.conversationId, event.messageId, event.call)

    case 'turn:started':
      return state.active !== null && state.active.id === event.conversationId
        ? { running: true }
        : {}

    case 'turn:finished':
      return state.active !== null && state.active.id === event.conversationId
        ? { running: false }
        : { running: false }

    case 'notice':
      return { notice: { level: event.level, text: event.text, at: Date.now() } }

    default:
      return {}
  }
}

function patchToolCall(
  state: State,
  conversationId: string,
  messageId: string,
  call: import('@ipc/contract').ToolCallRecordDto
): Partial<State> {
  if (state.active === null || state.active.id !== conversationId) {
    return {}
  }
  return {
    active: {
      ...state.active,
      messages: state.active.messages.map((m: MessageDto) => {
        if (m.id !== messageId) {
          return m
        }
        const existing = m.toolCalls.findIndex((c) => c.id === call.id)
        const toolCalls =
          existing >= 0
            ? m.toolCalls.map((c) => (c.id === call.id ? { ...c, ...call } : c))
            : [...m.toolCalls, call]
        return { ...m, toolCalls }
      })
    }
  }
}

function summaryOf(conv: ConversationDto): ConversationSummaryDto {
  const last = conv.messages[conv.messages.length - 1]
  return {
    id: conv.id,
    title: conv.title,
    agentId: conv.agentId,
    mode: conv.mode,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    lastPreview: last?.content?.slice(0, 60) ?? ''
  }
}
export const useStore = create<State>((set, get) => {
  async function refreshSummaries(): Promise<void> {
    const summaries = await window.guncat.conversations.list()
    set({ summaries })
  }

  return {
    ready: false,
    agents: [],
    engines: [],
    activeAgentId: '',
    summaries: [],
    activeId: null,
    active: null,
    mode: 'chat',
    running: false,
    thinkingEnabled: false,
    webSearchEnabled: false,
    settings: null,
    workspace: [],
    notice: null,
    settingsOpen: false,
    pendingDraft: null,

    async init() {
      window.guncat.onEvent((event: GuncatEvent) => {
        set((state) => applyEvent(state, event))
        if (event.type === 'workspace:changed' && get().activeId === event.conversationId) {
          void get().loadWorkspace()
        }
        // 外部文件到达（拖拽 / 命令行 / 系统「打开方式」）→ 导入当前会话工作区
        if (event.type === 'files:pending') {
          void get().intakeFiles(event.paths)
        }
      })
      await Promise.all([useSpeech.getState().init()])
      const [agents, summaries, settings] = await Promise.all([
        window.guncat.agents.list(),
        window.guncat.conversations.list(),
        window.guncat.settings.load()
      ])
      const engines = buildAgentList(agents)
      const firstReal = agents.find((a) => !isVirtualAgentId(a.id))
      set({
        agents,
        engines,
        activeAgentId: firstReal === undefined ? '' : firstReal.id,
        summaries,
        settings,
        ready: true
      })
      if (summaries.length > 0) {
        await get().selectConversation(summaries[0].id)
      }
    },

    async reloadSummaries() {
      await refreshSummaries()
    },

    async selectConversation(id) {
      const conv = await window.guncat.conversations.get(id)
      set({
        activeId: id,
        active: conv,
        activeAgentId: conv === null ? get().activeAgentId : engineIdOfConversation(conv),
        mode: (conv?.mode as AgentMode) ?? 'chat',
        running: false
      })
      await get().loadWorkspace()
    },

    async createConversation() {
      // 空会话等价于新会话：先把它清掉，避免列表里堆一串没有任何内容的会话
      // （对齐原版 cleanupEmptyConversation）。工作区里有文件时保留 ——
      // 删会话只是把 id 从列表里抹掉，用户会看不到那些文件。
      const current = get().active
      if (current !== null && current.messages.length === 0 && get().workspace.length === 0) {
        await window.guncat.conversations.remove(current.id)
        set({ activeId: null, active: null })
      }
      const agentId = get().activeAgentId
      const conv = await window.guncat.conversations.create(agentId, get().mode)
      // conversation:created 事件已把状态写好，这里只补工作区
      await get().loadWorkspace()
      return conv
    },

    async deleteConversation(id) {
      await window.guncat.conversations.remove(id)
      const remaining = get().summaries.filter((s) => s.id !== id)
      if (get().activeId === id) {
        if (remaining.length > 0) {
          await get().selectConversation(remaining[0].id)
        } else {
          set({ activeId: null, active: null, workspace: [] })
        }
      }
    },

    async selectAgent(agentId) {
      const engine = get().engines.find((a) => a.id === agentId)
      if (engine === undefined) {
        return
      }
      const mode = modeForAgentId(agentId)
      set({ activeAgentId: agentId, mode })
      // 切到该引擎的最新会话；没有就新建（原版 selectAgent 的行为）
      const summaries = get().summaries
      const latest =
        summaries.find((s) => engineIdOfConversation(s) === agentId) ??
        (isVirtualAgentId(agentId)
          ? summaries.find((s) => s.agentId === agentId)
          : undefined)
      if (latest !== undefined) {
        await get().selectConversation(latest.id)
      } else {
        await get().createConversation()
      }
    },

    setMode(mode) {
      // 形态与引擎是同一件事的两种说法（原版：形态切换就是切到对应虚拟智能体），
      // 因此这里走 selectAgent，顺带把会话也切过去，避免「界面显示工作模式、
      // 实际发到聊天模式会话」这种错位。
      const target = agentIdForMode(mode, get().agents, get().activeAgentId)
      if (target === '') {
        set({ mode })
        const active = get().active
        if (active !== null) {
          set({ active: { ...active, mode } })
        }
        return
      }
      void get().selectAgent(target)
    },

    setThinking(value) {
      set({ thinkingEnabled: value })
    },

    setWebSearch(value) {
      set({ webSearchEnabled: value })
    },

    openSettings(open) {
      set({ settingsOpen: open })
    },

    async reloadSettings() {
      const settings = await window.guncat.settings.load()
      set({ settings })
    },

    async send(text) {
      let activeId = get().activeId
      if (activeId === null) {
        const conv = await get().createConversation()
        activeId = conv.id
      }
      const mode = get().mode
      const request = {
        conversationId: activeId,
        text,
        mode,
        thinkingEnabled: get().thinkingEnabled,
        webSearchEnabled: get().webSearchEnabled
      }
      set({ running: true })
      try {
        if (mode === 'chat') {
          await window.guncat.chat.send(request)
        } else {
          await window.guncat.work.run(request)
        }
      } finally {
        set({ running: false })
        await refreshSummaries()
      }
    },

    async regenerate() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      set({ running: true })
      try {
        await window.guncat.chat.regenerate({
          conversationId: activeId,
          thinkingEnabled: get().thinkingEnabled,
          webSearchEnabled: get().webSearchEnabled
        })
      } finally {
        set({ running: false })
        await refreshSummaries()
      }
    },

    async abort() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.chat.abort(activeId)
    },

    async patchMessageContent(messageId, content) {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.chat.patchMessage(activeId, messageId, content)
    },

    async loadWorkspace() {
      const activeId = get().activeId
      if (activeId === null) {
        set({ workspace: [] })
        return
      }
      try {
        const entries = await window.guncat.workspace.list(activeId)
        set({ workspace: entries })
      } catch {
        set({ workspace: [] })
      }
    },

    async deleteWorkspaceEntry(path) {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.workspace.remove(activeId, path)
      await get().loadWorkspace()
    },

    async clearWorkspace() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.workspace.clear(activeId)
      await get().loadWorkspace()
    },

    async exportWorkspace() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      const result = await window.guncat.workspace.exportZip(activeId)
      if (result.saved) {
        get().pushNotice('info', `已导出到 ${result.path ?? ''}`)
      }
    },

    async openWorkspaceFolder() {
      const activeId = get().activeId
      if (activeId === null) {
        return
      }
      await window.guncat.workspace.openInFolder(activeId)
    },

    pushNotice(level, text) {
      set({ notice: { level, text, at: Date.now() } })
    },

    dismissNotice() {
      set({ notice: null })
    },

    fillDraft(text) {
      set({ pendingDraft: { text, at: Date.now() } })
    },

    consumeDraft() {
      set({ pendingDraft: null })
    },

    async intakeFiles(paths) {
      if (paths.length === 0) {
        return
      }
      let activeId = get().activeId
      // 还没有会话时先建一个（同时切到工作模式，工作区才是模型的文件入口）
      if (activeId === null) {
        const conv = await get().createConversation()
        activeId = conv.id
      }
      try {
        const result = await window.guncat.intake.importPaths(activeId, paths)
        await get().loadWorkspace()
        const parts: string[] = []
        if (result.imported > 0) {
          parts.push(`已导入 ${result.imported} 个文件到工作区：${result.names.join('、')}`)
        }
        if (result.failed.length > 0) {
          parts.push(`${result.failed.length} 个未导入`)
        }
        get().pushNotice(
          result.imported > 0 ? 'info' : 'warn',
          parts.join('；') || '没有可导入的文件'
        )
      } catch (e) {
        get().pushNotice('error', `导入失败：${String(e)}`)
      }
    },

    /**
     * 工作区面板的「上传」按钮：弹系统文件选择框，把选中的文件导入当前会话工作区。
     * 与拖拽走同一条落盘链路，只是换成用户找得到的入口（原版 WorkspaceBar 的「上传」）。
     */
    async pickWorkspaceFiles() {
      let activeId = get().activeId
      // 还没会话就先建一个，否则对话框选完文件却无处可放
      if (activeId === null) {
        const conv = await get().createConversation()
        activeId = conv.id
      }
      try {
        const result = await window.guncat.intake.pickFiles(activeId)
        if (result.canceled) {
          return
        }
        await get().loadWorkspace()
        const parts: string[] = []
        if (result.imported > 0) {
          parts.push(`已导入 ${result.imported} 个文件：${result.names.join('、')}`)
        }
        if (result.failed.length > 0) {
          parts.push(`${result.failed.length} 个未导入`)
        }
        get().pushNotice(
          result.imported > 0 ? 'info' : 'warn',
          parts.join('；') || '没有可导入的文件'
        )
      } catch (e) {
        get().pushNotice('error', `上传失败：${String(e)}`)
      }
    }
  }
})
