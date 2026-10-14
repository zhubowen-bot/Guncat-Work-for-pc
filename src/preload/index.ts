// Preload：只暴露窄接口，渲染进程拿不到 Node 能力。
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { INVOKE, EVENT } from '../ipc/contract'
import type {
  AgentDto,
  ApiConfigDto,
  ApiProfileDto,
  AppInfoDto,
  AppSettingsDto,
  ChatRegenerateRequest,
  ChatSendRequest,
  ConversationDto,
  ConversationSummaryDto,
  GuncatEvent,
  MultimodalConfigDto,
  RendererStage,
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
    /** 配置方案：选中（会同时把该方案写回运行时生效的配置） */
    selectApiProfile: (profileId: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSelectApiProfile, profileId),
    /** 配置方案：新建（复制当前配置，返回新方案） */
    addApiProfile: (): Promise<ApiProfileDto> => ipcRenderer.invoke(INVOKE.settingsAddApiProfile),
    /** 配置方案：删除（至少保留一份） */
    deleteApiProfile: (profileId: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsDeleteApiProfile, profileId),
    /** 配置方案：一次性保存当前方案（名称 + API 配置 + 多模态配置） */
    saveCurrentApiProfile: (
      name: string,
      config: ApiConfigDto,
      multimodal: MultimodalConfigDto
    ): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveCurrentApiProfile, name, config, multimodal),
    saveMultimodalConfig: (dto: MultimodalConfigDto): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveMultimodalConfig, dto),
    saveFlag: (key: string, value: boolean): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveFlag, key, value),
    saveString: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.settingsSaveString, key, value),
    /** 本地联网搜索的引擎目录（渲染层据此渲染选项） */
    searchEngines: (): Promise<import('../ipc/contract').SearchEngineDto[]> =>
      ipcRenderer.invoke(INVOKE.settingsSearchEngines)
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
    /** 重新生成最后一条回答（丢弃它后面已产出的 assistant 消息后再跑一次） */
    regenerate: (request: ChatRegenerateRequest): Promise<void> =>
      ipcRenderer.invoke(INVOKE.chatRegenerate, request),
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
    info: (): Promise<AppInfoDto> => ipcRenderer.invoke(INVOKE.appInfo),
    /**
     * 启动诊断：把「渲染进程走到了哪一步」告诉主进程。
     * 主进程只能看到「页面加载完成」，再往里是不是真挂载成功、有没有画出帧，
     * 它一无所知 —— 白屏就发生在那段盲区里。
     */
    reportStage: (stage: RendererStage, detail?: string): Promise<void> =>
      ipcRenderer.invoke(INVOKE.appRendererStage, stage, detail)
  },

  /** 端侧增强 */
  intake: {    /** 把外部文件导入指定会话的工作区 */
    importPaths: (
      conversationId: string,
      paths: string[]
    ): Promise<{ names: string[]; imported: number; failed: string[] }> =>
      ipcRenderer.invoke(INVOKE.intakeImport, conversationId, paths),
    /** 弹系统文件选择框并导入（工作区面板的「上传」按钮） */
    pickFiles: (
      conversationId: string
    ): Promise<{ names: string[]; imported: number; failed: string[]; canceled: boolean }> =>
      ipcRenderer.invoke(INVOKE.intakePickFiles, conversationId)
  },

  /** 聊天模式的附件：选文件（读取与解析在主进程的发送路径上） */
  attachments: {
    pick: (): Promise<import('../ipc/contract').PickedAttachmentDto[]> =>
      ipcRenderer.invoke(INVOKE.attachmentsPick)
  },

  /** 工作模式执行中插话；返回是否被接受（false 时应改走普通发送） */
  steer: (conversationId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(INVOKE.workSteer, conversationId, text),

  /** 会话的任务统计与当前目标（工作区面板的统计卡与目标卡） */
  stats: (conversationId: string): Promise<import('../ipc/contract').ConversationStatsDto> =>
    ipcRenderer.invoke(INVOKE.conversationStats, conversationId),

  /** 本会话的产物汇总（对话流末尾的 Changes 卡） */
  artifacts: (conversationId: string): Promise<import('../ipc/contract').WorkArtifactsDto> =>
    ipcRenderer.invoke(INVOKE.conversationArtifacts, conversationId),

  messages: {
    /** 把一条回答导出为 Word */
    exportDocx: (
      conversationId: string,
      messageId: string,
      suggestedName?: string
    ): Promise<{ saved: boolean; path?: string }> =>
      ipcRenderer.invoke(INVOKE.messageExportDocx, conversationId, messageId, suggestedName)
  },

  /**
   * 拖拽进来的 File 对象在开启 contextIsolation 后拿不到真实路径，
   * 必须经 webUtils.getPathForFile 换算。这里只暴露这一个转换函数，
   * 不把整个 webUtils 交给渲染进程。
   */
  files: {
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  },

  /** 语音输入（录音 → 转写） */
  asr: {
    transcribe(audio: Uint8Array, mime: string): Promise<{ ok: boolean; text: string; error: string }> {
      return ipcRenderer.invoke(INVOKE.asrTranscribe, audio, mime)
    }
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
