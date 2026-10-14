// 渲染进程状态镜像。
//
// 主进程是业务权威，这里只保存「展示所需」的投影：
// 会话摘要列表、当前会话的完整消息、运行态标志与工作区清单。
// 所有变更都来自 (a) 用户操作的 invoke 返回，或 (b) 主进程推来的事件。
import { create } from 'zustand'
import { useSpeech } from './speech/speechStore'
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
  agents: AgentDto[]
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

  init(): Promise<void>
  reloadSummaries(): Promise<void>
  selectConversation(id: string): Promise<void>
  createConversation(): Promise<ConversationDto>
  deleteConversation(id: string): Promise<void>
  setMode(mode: AgentMode): void
  setThinking(value: boolean): void
  setWebSearch(value: boolean): void
  openSettings(open: boolean): void
  reloadSettings(): Promise<void>
  send(text: string): Promise<void>
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
  /** 端侧增强：把外部文件导入当前会话工作区 */
  intakeFiles(paths: string[]): Promise<void>
}

function applyEvent(state: State, event: GuncatEvent): Partial<State> {
  switch (event.type) {
    case 'conversation:created':
      return {
        summaries: [summaryOf(event.conversation), ...state.summaries],
        activeId: event.conversation.id,
        active: event.conversation
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
      set({ agents, summaries, settings, ready: true })
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
        mode: (conv?.mode as AgentMode) ?? 'chat',
        running: false
      })
      await get().loadWorkspace()
    },

    async createConversation() {
      const agent = get().agents.find((a) => a.id === get().active?.agentId) ?? get().agents[0]
      const conv = await window.guncat.conversations.create(agent?.id ?? '', get().mode)
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

    setMode(mode) {
      set({ mode })
      const active = get().active
      if (active !== null) {
        set({ active: { ...active, mode } })
      }
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
    }
  }
})
