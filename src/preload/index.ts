// Preload：只暴露窄接口，渲染进程拿不到 Node 能力。
import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE, EVENT } from '../ipc/contract'
import type {
  AgentDto,
  ApiConfigDto,
  ApiProfileDto,
  AppInfoDto,
  AppSettingsDto,
  ChatSendRequest,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  MultimodalConfigDto,
  WorkspaceEntryDto,
  WorkRunRequest
} from '../ipc/contract'

const api = {
  settings: {
    load: (): Promise<AppSettingsDto> => ipcRenderer.invoke(INVOKE.settingsLoad),
    saveApiConfig: (dto: ApiConfigDto): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveApiConfig, dto),
    saveApiProfiles: (profiles: ApiProfileDto[]): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveApiProfiles, profiles),
    saveMultimodalConfig: (dto: MultimodalConfigDto): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveMultimodalConfig, dto),
    saveFlag: (key: string, value: boolean): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveFlag, key, value)
  },

  agents: {
    list: (): Promise<AgentDto[]> => ipcRenderer.invoke(INVOKE.agentsList)
  },

  conversations: {
    list: (): Promise<ConversationSummaryDto[]> => ipcRenderer.invoke(INVOKE.conversationsLoad),
    get: (id: string): Promise<ConversationDto | null> => ipcRenderer.invoke('conversation:get', id),
    create: (agentId: string, mode: string): Promise<ConversationDto> =>
      ipcRenderer.invoke(INVOKE.conversationsCreate, agentId, mode),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(INVOKE.conversationsDelete, id),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.conversationsRename, id, title)
  },

  chat: {
    send: (request: ChatSendRequest): Promise<void> => ipcRenderer.invoke(INVOKE.chatSend, request),
    abort: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.chatAbort, conversationId),
    /** 交互模式：把控件状态写回消息正文（尾标记）并持久化 */
    patchMessage: (
      conversationId: string,
      messageId: string,
      content: string
    ): Promise<void> =>
      ipcRenderer.invoke(INVOKE.messagePatch, conversationId, messageId, content)
  },

  work: {
    run: (request: WorkRunRequest): Promise<void> => ipcRenderer.invoke(INVOKE.workRun, request),
    abort: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.workAbort, conversationId)
  },

  workspace: {
    list: (conversationId: string): Promise<WorkspaceEntryDto[]> =>
      ipcRenderer.invoke(INVOKE.workspaceList, conversationId),
    treeText: (conversationId: string): Promise<string> =>
      ipcRenderer.invoke(INVOKE.workspaceTreeText, conversationId),
    read: (conversationId: string, path: string): Promise<{ text: string; truncated: boolean }> =>
      ipcRenderer.invoke(INVOKE.workspaceRead, conversationId, path),
    remove: (conversationId: string, path: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.workspaceDelete, conversationId, path),
    clear: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.workspaceClear, conversationId),
    openInFolder: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.workspaceOpenInFolder, conversationId),
    exportZip: (conversationId: string): Promise<{ saved: boolean; path?: string }> =>
      ipcRenderer.invoke(INVOKE.workspaceExportZip, conversationId)
  },

  app: {
    info: (): Promise<AppInfoDto> => ipcRenderer.invoke(INVOKE.appInfo)
  },

  /** 订阅主进程事件；返回取消订阅函数 */
  onEvent: (listener: (event: GuncatEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: GuncatEvent): void => listener(payload)
    ipcRenderer.on(EVENT, handler)
    return () => {
      ipcRenderer.removeListener(EVENT, handler)
    }
  }
}

export type GuncatApi = typeof api

contextBridge.exposeInMainWorld('guncat', api)
