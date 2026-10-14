// 渲染进程可见的 preload 接口类型。
// 只声明用到的部分，避免把 Electron 类型带进渲染进程的编译范围。
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
} from '@ipc/contract'

export interface GuncatApi {
  settings: {
    load(): Promise<AppSettingsDto>
    saveApiConfig(dto: ApiConfigDto): Promise<void>
    saveApiProfiles(profiles: ApiProfileDto[]): Promise<void>
    saveMultimodalConfig(dto: MultimodalConfigDto): Promise<void>
    saveFlag(key: string, value: boolean): Promise<void>
    saveString(key: string, value: string): Promise<void>
  }
  agents: {
    list(): Promise<AgentDto[]>
  }
  conversations: {
    list(): Promise<ConversationSummaryDto[]>
    get(id: string): Promise<ConversationDto | null>
    create(agentId: string, mode: string): Promise<ConversationDto>
    remove(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
  }
  chat: {
    send(request: ChatSendRequest): Promise<void>
    abort(conversationId: string): Promise<void>
    regenerate(request: ChatRegenerateRequest): Promise<void>
    patchMessage(conversationId: string, messageId: string, content: string): Promise<void>
  }
  work: {
    run(request: WorkRunRequest): Promise<void>
    abort(conversationId: string): Promise<void>
  }
  workspace: {
    list(conversationId: string): Promise<WorkspaceEntryDto[]>
    treeText(conversationId: string): Promise<string>
    read(conversationId: string, path: string): Promise<{ text: string; truncated: boolean }>
    remove(conversationId: string, path: string): Promise<void>
    clear(conversationId: string): Promise<void>
    openInFolder(conversationId: string): Promise<void>
    exportZip(conversationId: string): Promise<{ saved: boolean; path?: string }>
  }
  app: {
    info(): Promise<AppInfoDto>
    /** 启动诊断：上报「React 已挂载 / 已产出首帧 / 渲染出错」 */
    reportStage(stage: RendererStage, detail?: string): Promise<void>
  }
  intake: {
    importPaths(
      conversationId: string,
      paths: string[]
    ): Promise<{ names: string[]; imported: number; failed: string[] }>
    /** 弹系统文件选择框并导入（工作区面板的「上传」按钮） */
    pickFiles(
      conversationId: string
    ): Promise<{ names: string[]; imported: number; failed: string[]; canceled: boolean }>
  }
  messages: {
    exportDocx(
      conversationId: string,
      messageId: string,
      suggestedName?: string
    ): Promise<{ saved: boolean; path?: string }>
  }
  files: {
    pathForFile(file: File): string
  }
  asr: {
    transcribe(audio: Uint8Array, mime: string): Promise<{ ok: boolean; text: string; error: string }>
  }
  onEvent(listener: (event: GuncatEvent) => void): () => void
}

declare global {
  interface Window {
    guncat: GuncatApi
  }
}

export {}
