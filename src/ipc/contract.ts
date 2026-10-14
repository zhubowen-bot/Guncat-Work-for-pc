// 主进程 ↔ 渲染进程的 IPC 契约。
// 主进程是业务状态的唯一权威（对话、工作区、Agent Loop 都在主进程跑），
// 渲染进程只持有镜像并通过事件保持同步，因此这里定义的都是可结构化克隆的纯数据 DTO。

export const INVOKE = {
  /** 设置：读取全部配置 */
  settingsLoad: 'settings:load',
  settingsSaveApiConfig: 'settings:saveApiConfig',
  settingsSaveApiProfiles: 'settings:saveApiProfiles',
  settingsSaveMultimodalConfig: 'settings:saveMultimodalConfig',
  settingsSaveFlag: 'settings:saveFlag',
  /** 字符串型偏好（朗读音色/语速等） */
  settingsSaveString: 'settings:saveString',

  /** 智能体 */
  agentsList: 'agents:list',

  /** 对话 */
  conversationsLoad: 'conversations:load',
  conversationsCreate: 'conversations:create',
  conversationsDelete: 'conversations:delete',
  conversationsRename: 'conversations:rename',

  /** 聊天 */
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatRegenerate: 'chat:regenerate',
  /** 交互模式：把控件状态（尾标记）写回消息并持久化 */
  messagePatch: 'chat:patchMessage',

  /** 工作模式 / 交互模式 */
  workRun: 'work:run',
  workAbort: 'work:abort',
  workAnswer: 'work:answer',

  /** 沙箱工作区 */
  workspaceList: 'workspace:list',
  workspaceTreeText: 'workspace:treeText',
  workspaceUpload: 'workspace:upload',
  workspaceRead: 'workspace:read',
  workspaceDelete: 'workspace:delete',
  workspaceClear: 'workspace:clear',
  workspaceExportZip: 'workspace:exportZip',
  workspaceOpenInFolder: 'workspace:openInFolder',

  /** 应用信息 */
  appInfo: 'app:info',
  /**
   * 启动诊断：渲染进程主动上报自己走到了哪一步。
   * 「页面加载完成」是主进程能自己看到的最远一步；再往里（React 有没有挂载成功、
   * 有没有真的产出帧）主进程完全看不见 —— 白屏恰恰发生在那段盲区里。
   */
  appRendererStage: 'app:rendererStage',

  /** 端侧增强：文件收件（拖拽 / 系统「打开方式」/ 命令行参数） */
  intakeImport: 'intake:import',
  /** 端侧增强：把一条回答导出为 Word */
  messageExportDocx: 'message:exportDocx',
  /** 端侧增强：语音输入（录音 → 转写） */
  asrTranscribe: 'asr:transcribe'
} as const

export const EVENT = 'guncat:event'

/**
 * 渲染进程上报的启动阶段。
 *
 * 三者都是「白屏」，但原因完全不同，必须分开：
 *   mounted —— React 挂载成功（界面树已进 DOM）
 *   painted —— 浏览器已产出首帧
 *   error   —— React 在挂载/渲染时抛异常（没有这一步，主进程只会看到一片安静）
 */
export type RendererStage = 'mounted' | 'painted' | 'error'

// ===== 设置 =====

export interface ApiConfigDto {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  extraParams: string
}

export interface ApiProfileDto {
  id: string
  name: string
  config: ApiConfigDto
  multimodalConfig: MultimodalConfigDto
}

export interface MultimodalConfigDto {
  baseUrl: string
  apiKey: string
  model: string
  preparseEnabled: boolean
}

export interface AppSettingsDto {
  apiConfig: ApiConfigDto | null
  apiProfiles: ApiProfileDto[]
  multimodalConfig: MultimodalConfigDto
  flags: Record<string, boolean>
  /** 字符串型偏好（朗读音色/语速等） */
  prefs: Record<string, string>
}

// ===== 智能体 =====

export interface AgentDto {
  id: string
  name: string
  description: string
  shortDescription: string
  icon: string
  category: string
  prompt: string
}

// ===== 对话 =====

export interface ToolCallRecordDto {
  id: string
  name: string
  argsJson: string
  result: string
  status: string
  startedAt: number
  finishedAt: number
  diff: string
}

export interface AttachmentDto {
  id: string
  name: string
  type: string
  dataUrl: string
  thumbnail: string
  parsedText: string
  fileId: string
}

export interface MessageDto {
  id: string
  role: string
  content: string
  displayContent: string
  reasoning: string
  attachments: AttachmentDto[]
  toolCalls: ToolCallRecordDto[]
  timestamp: number
  tokenSpeed: number
  cacheHitRate: number
  /** 交互模式：guncat-ui 界面程序源码（阶段二接入渲染） */
  uiProgram?: string
  /** 交互模式的控件状态尾标记（阶段二） */
  uiState?: string
}

export interface ConversationDto {
  id: string
  title: string
  agentId: string
  mode: string
  createdAt: number
  updatedAt: number
  messages: MessageDto[]
}

/** 会话列表用的轻量投影（不带消息体） */
export interface ConversationSummaryDto {
  id: string
  title: string
  agentId: string
  mode: string
  updatedAt: number
  messageCount: number
  lastPreview: string
}

// ===== 请求 =====

export type AgentMode = 'chat' | 'work' | 'interactive'

export interface ChatSendRequest {
  conversationId: string
  text: string
  mode: AgentMode
  thinkingEnabled: boolean
  webSearchEnabled: boolean
  attachmentPaths?: string[]
}

export interface WorkRunRequest {
  conversationId: string
  text: string
  mode: AgentMode
  thinkingEnabled: boolean
  webSearchEnabled: boolean
}

export interface ConversationRef {
  conversationId: string
}

export interface WorkspaceRef {
  conversationId: string
}

export interface WorkspacePathRef {
  conversationId: string
  path: string
}

export interface WorkspaceEntryDto {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

// ===== 事件（主进程 → 渲染进程） =====

export type GuncatEvent =
  | { type: 'conversation:created'; conversation: ConversationDto }
  | { type: 'conversation:deleted'; conversationId: string }
  | { type: 'conversation:title'; conversationId: string; title: string }
  | { type: 'message:added'; conversationId: string; message: MessageDto }
  | { type: 'message:patched'; conversationId: string; messageId: string; patch: Partial<MessageDto> }
  | { type: 'tool:started'; conversationId: string; messageId: string; call: ToolCallRecordDto }
  | { type: 'tool:finished'; conversationId: string; messageId: string; call: ToolCallRecordDto }
  | { type: 'turn:started'; conversationId: string; messageId: string }
  | { type: 'turn:finished'; conversationId: string; messageId: string; status: 'ok' | 'error' | 'aborted'; error?: string }
  | { type: 'workspace:changed'; conversationId: string }
  | { type: 'files:intaken'; conversationId: string; names: string[]; imported: number; failed: string[] }
  /** 外部文件到达（命令行 / 系统「打开方式」/ 第二实例），等渲染进程决定导入哪个会话 */
  | { type: 'files:pending'; paths: string[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'ask:user'; conversationId: string; requestId: string; question: string; options: string[] }

export interface AppInfoDto {
  version: string
  dataRoot: string
  resourcesRoot: string
  platform: string
  electron: string
}
