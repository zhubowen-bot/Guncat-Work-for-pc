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
  /** 本地联网搜索的引擎目录（渲染层据此渲染选项，不必自己维护一份引擎表） */
  settingsSearchEngines: 'settings:searchEngines',
  /**
   * 选择要发送给模型的附件（图片 / 文档）。
   * 原版输入区有回形针与预览条；桌面端此前**完全没有附件入口** ——
   * ChatSendRequest.attachmentPaths 这个字段一直存在，却从来没有人赋值。
   */
  attachmentsPick: 'attachments:pick',
  /**
   * 工作模式执行中插话（原版流式时的「发送(插话)」按钮）。
   * 不打断当前请求，文本在下一轮开始前并入消息，返回是否被接受。
   */
  workSteer: 'work:steer',
  /** 会话的任务统计与当前目标（原版 DetailsPanelView 的统计卡 + 目标卡） */
  conversationStats: 'conversation:stats',
  /**
   * 本会话的产物汇总（原版对话流末尾的 Codex 风格 Changes 卡）。
   * 汇总逻辑是已移植的 `core/common/WorkArtifacts.WorkArtifactUtil.collect`，
   * 在桌面端此前**零引用**（连 core 内部都没人 import）。
   */
  conversationArtifacts: 'conversation:artifacts',
  /**
   * 表格提取（原版 AgentDrawerView 的「表格提取」→ pages/TableOcrPage）。
   * 原版这是**唯一一个不依赖大模型对话的独立工具页**，桌面端此前完全不存在：
   * `TableOcrService` 零引用，也没有任何界面入口。
   */
  tableOcrPickImage: 'tableOcr:pickImage',
  tableOcrRun: 'tableOcr:run',
  /**
   * 配置方案（多套 API 配置）。原版 SettingsPanel 顶部的「配置方案 / 配置名称」就是它；
   * 桌面端此前 ApiProfileDto、saveApiProfiles 通道、StorageManager 的读写**全都在**，
   * 只有渲染层从来没有调用点 —— 用户无法保存/切换第二套配置。
   */
  settingsSelectApiProfile: 'settings:selectApiProfile',
  settingsAddApiProfile: 'settings:addApiProfile',
  settingsDeleteApiProfile: 'settings:deleteApiProfile',
  settingsSaveCurrentApiProfile: 'settings:saveCurrentApiProfile',
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
  /**
   * 端侧增强：弹出系统文件选择框，把选中的文件导入工作区。
   *
   * 为什么必须有这条：鸿蒙版 WorkspaceBar 的头部有一个显眼的「上传」按钮
   * （空态文案就是「工作区为空, 点击"上传"添加文件」）。桌面版此前只有
   * 「拖拽到窗口」这一条路 —— 而拖拽在界面上没有任何提示，用户根本找不到入口。
   */
  intakePickFiles: 'intake:pickFiles',
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
  /**
   * 是否自动补全协议路径后缀（/chat/completions、/responses、/v1/messages…）。
   * 关闭后严格按填写的 Base URL 发起请求，适合非标准路径的自建网关/代理。
   *
   * 对齐原版 SettingsPanel 的「协议路径后缀补全」开关。此前这个字段**没有进 DTO**，
   * 后果是静默的：渲染层看不到它，而 fromApiConfigDto 每次都把它重置成默认的 true ——
   * 用户（或从原版迁移过来的配置）关掉它以后，只要在桌面端点一次「保存」，设置就被悄悄丢掉。
   */
  autoSuffix: boolean
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

/**
 * 本地联网搜索的引擎目录（由主进程给出，见 settings:searchEngines）。
 *
 * 为什么不让渲染层直接 import LocalWebSearch 里的常量与判断函数：
 * 那个模块依赖 `@kit.NetworkKit`（真正的网络实现只在主进程侧），
 * 而渲染层的 vite 配置里根本没有 `@kit.*` 别名 —— 引进来会直接构建失败。
 * 由主进程把「有哪些引擎、各自要不要 Key/BaseUrl」报出来，既避免重复定义，也不会漂移。
 */
/**
 * 会话的任务统计与当前目标。
 *
 * 对齐原版 DetailsPanelView 的统计卡（任务用时 / 输出速度 / 缓存命中 / 工具调用轮数）
 * 与目标卡（GoalService.read）。桌面端此前全库 `elapsed` 零命中，
 * `GoalService.read` 在渲染层与主进程也都没有调用点 —— 跑长任务时看不到「跑了多久、目标是什么」。
 */
export interface ConversationStatsDto {
  /** 最近一次任务用时（毫秒；0 = 还没跑过或正在跑） */
  elapsedMs: number
  /** 平均输出速度（字符/秒；-1 = 无数据） */
  speed: number
  /** 平均缓存命中率（0..1；-1 = 无数据） */
  cacheHit: number
  /** 最近一次任务的工具调用轮数 */
  rounds: number
  /** 当前目标；没有目标时为 null */
  goal: GoalDto | null
}

export interface GoalDto {
  objective: string
  status: string
  rounds: number
  maxRounds: number
}

/** diff 缩略的一行（对应原版 WorkArtifactsCard 的 ArtifactDiffRow） */
export interface ArtifactDiffRowDto {
  type: string
  text: string
}

/** 产物汇总里的一个文件 */
export interface ArtifactFileDto {
  path: string
  /** 是否有可展示的行级 diff（Office/二进制产物没有） */
  hasDiff: boolean
  adds: number
  dels: number
  /** 最多 8 行的 diff 缩略（对齐原版 diffPreviewRows 的上限） */
  rows: ArtifactDiffRowDto[]
}

/** 产物汇总卡的数据（对应 core 的 WorkArtifactSummary） */
export interface WorkArtifactsDto {
  files: ArtifactFileDto[]
  totalAdds: number
  totalDels: number
}

export interface TableOcrImageDto {
  path: string
  name: string
  size: number
  /** 预览缩略图（data URL）；生成失败时为空串 */
  thumbnail: string
}

export interface TableOcrResultDto {
  /** 已清洗的 `<table>` 片段（只保留表格结构与 colspan/rowspan） */
  html: string
  /** 实际使用的模型（界面上说清「用的是哪套配置」） */
  model: string
}

/** 表格提取可选的模型来源（原版 TableOcrPage 从配置方案里列模型） */
export interface TableOcrModelDto {
  /** 传回给主进程的标识（模型名） */
  id: string
  label: string
  baseUrl: string
}

export interface SearchEngineDto {
  id: string
  label: string
  needsApiKey: boolean
  supportsBaseUrl: boolean
}

/**
 * 选中的附件（发送前）。
 * 只带「怎么显示」与「文件在哪」—— 真正的读取与解析放在主进程的发送路径上
 * （多模态配置、API Key 都在那边），避免解析两遍。
 */
export interface PickedAttachmentDto {
  path: string
  name: string
  size: number
  /** 图片的小缩略图（data URL）；非图片为空串，渲染层退回显示文件名 */
  thumbnail: string
}

export interface AppSettingsDto {
  apiConfig: ApiConfigDto | null
  apiProfiles: ApiProfileDto[]
  /** 当前选中的配置方案 id（对齐原版 Constants.LS_KEY_CURRENT_API_PROFILE_ID） */
  currentApiProfileId: string
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
  /**
   * 推理强度：'max' | 'high' | 'low'（原版按形态分档：工作 Max/High/Low，交互 High/Low/Off）。
   * 不传时由主进程按 thinkingEnabled 推默认值 —— 此前是**写死** 'high'/'none'，
   * 于是工作模式永远拿不到 Max 档，也没法选 Low 提速。
   */
  reasoningEffort?: string
}

/** 推理强度的合法取值（对齐 AgentLoopService 下发给三种协议的取值） */
export const REASONING_EFFORTS: string[] = ['max', 'high', 'low', 'none']

/**
 * 重新生成最后一条回答（对应原版消息操作行的「重答」）。
 *
 * 语义：把最后一条用户消息之后的 assistant 消息全部丢弃（那次失败的/被中止的输出
 * 就地消失，而不是在它下面再叠一条），然后用同一个问题重跑一次。
 */
export interface ChatRegenerateRequest {
  conversationId: string
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
  /**
   * 会话内容被整体改写（目前只有「重新生成」：末尾若干条消息被丢弃）。
   * 与 message:added/patched 这类增量事件不同，渲染进程收到它应当用整份会话替换本地投影。
   */
  | { type: 'conversation:sync'; conversation: ConversationDto }
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
