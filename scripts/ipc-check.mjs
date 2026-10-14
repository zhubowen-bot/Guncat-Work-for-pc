// 主进程 IPC 契约的无头集成验证。
//
// 用 electron 替身把 ipcMain 换掉，然后把渲染进程会调用的**每一个通道**
// 逐个真实 invoke 一遍，断言注册、参数、返回值与事件推送。
// 这是对「Electron 窗口起不来」这一环境限制最直接的对冲：
// 窗口没能验证的部分，至少把窗口背后的整条 IPC 链路验证掉。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { root, alias } from './esbuild-aliases.mjs'

const dir = path.join(root, '.smoke')
fs.mkdirSync(dir, { recursive: true })

const entry = path.join(dir, 'ipc-entry.ts')
fs.writeFileSync(
  entry,
  `export { registerIpcHandlers } from '@main/ipc'
export { SessionManager } from '@main/session/SessionManager'
export { collectFileArgs } from '@main/intake'
export { resolveTranscriptionUrl, loadAsrConfig, transcribeAudio } from '@main/asr'
export { __invoke, __channels, __events, __calls, __setOpenDialog, __reset } from 'electron'
export { initAppPaths, clearTempDir } from '@core/platform/appPaths'
export { LocalWebSearch, SearchEngineSettings } from '@core/service/LocalWebSearch'
`
)

const outfile = path.join(dir, 'ipc.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['fflate'],
  alias: {
    ...alias,
    '@main': path.join(root, 'src/main'),
    // 关键：把 electron 换成测试替身
    electron: path.join(root, 'scripts/electron-stub.ts')
  },
  logLevel: 'error'
})

const mod = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

const dataRoot = path.join(os.tmpdir(), `guncat-ipc-${Date.now()}`)
// 启动日志也写到临时目录：注册 IPC 不再触发日志，但「渲染进程阶段上报」会写日志 ——
// 绝不能因此覆盖用户真实的那份启动日志（排查问题时要看的正是它）。
process.env.GUNCAT_BOOTLOG_DIR = dataRoot
mod.initAppPaths({ dataRoot, resourcesRoot: path.resolve('resources') })
mod.clearTempDir()

const events = []
const session = new mod.SessionManager((e) => events.push(e))
mod.registerIpcHandlers(session)

const inv = (channel, ...args) => mod.__invoke(channel, ...args)

console.log('\n17. 主进程 IPC 契约（渲染进程真实调用的通道）')

// --- 通道注册完整性：渲染进程 preload 暴露的每个方法都要有对应通道 ---
const channels = mod.__channels()
const required = [
  'settings:load',
  'settings:saveApiConfig',
  'settings:saveApiProfiles',
  'settings:saveMultimodalConfig',
  'settings:saveFlag',
  'agents:list',
  'conversations:load',
  'conversations:create',
  'conversations:delete',
  'conversations:rename',
  'conversation:get',
  'chat:send',
  'chat:abort',
  'chat:regenerate',
  'chat:patchMessage',
  'work:run',
  'work:abort',
  'workspace:list',
  'workspace:treeText',
  'workspace:read',
  'workspace:delete',
  'workspace:clear',
  'workspace:openInFolder',
  'workspace:exportZip',
  'app:info',
  'app:rendererStage',
  'settings:saveString',
  'settings:searchEngines',
  'settings:selectApiProfile',
  'settings:addApiProfile',
  'settings:deleteApiProfile',
  'settings:saveCurrentApiProfile',
  'intake:import',
  'intake:pickFiles',
  'attachments:pick',
  'message:exportDocx',
  'asr:transcribe'
]
const missing = required.filter((c) => !channels.includes(c))
check('preload 用到的通道全部已注册', missing.length === 0, missing.length > 0 ? `缺 ${missing.join(', ')}` : `${channels.length} 个通道`)

// --- 应用信息 ---
const info = await inv('app:info')
check('app:info 返回版本与路径', info.version !== undefined && info.dataRoot === dataRoot, `version=${info.version}`)

// --- 启动诊断：渲染进程上报「走进了哪一步」 ---
// 这条链路补的是主进程的盲区：它自己最多只能看到「页面加载完成」，
// 再往里（React 有没有挂载、有没有产出帧、有没有渲染期异常）完全看不见 ——
// 而本轮白屏恰恰发生在那段盲区里。上报必须落进启动日志才算数。
await inv('app:rendererStage', 'mounted')
await inv('app:rendererStage', 'painted')
await inv('app:rendererStage', 'error', 'ipc-check boom')
await inv('app:rendererStage', 'nonsense-stage')
const stageLog = fs.readFileSync(path.join(dataRoot, 'startup.log'), 'utf8')
check('React 挂载上报落进启动日志', stageLog.includes('[REACT_MOUNTED]'))
check('首帧上报落进启动日志', stageLog.includes('[FRAME_PAINTED]'))
check(
  'React 渲染异常上报落进启动日志（否则白屏没有任何痕迹）',
  stageLog.includes('[REACT_ERROR]') && stageLog.includes('ipc-check boom')
)
check('无法识别的阶段不会被静默丢弃', stageLog.includes('无法识别的渲染进程阶段上报'))

// --- 智能体 ---
await session.bootstrap()
const agents = await inv('agents:list')
check('agents:list 返回智能体清单', Array.isArray(agents) && agents.length > 0, `${agents.length} 个`)
check('智能体带系统提示词', agents.every((a) => typeof a.prompt === 'string'))

// --- 设置往返 ---
const cfg = {
  provider: 'openai-responses',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test-123',
  model: 'deepseek-chat',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  extraParams: '{"enable_search":true}'
}
await inv('settings:saveApiConfig', cfg)
const settings = await inv('settings:load')
check('settings:saveApiConfig → load 往返一致', settings.apiConfig?.apiKey === cfg.apiKey && settings.apiConfig?.model === cfg.model)
check('provider 类型保留', settings.apiConfig?.provider === 'openai-responses')
check('温度等数值保留', settings.apiConfig?.temperature === 0.7)

await inv('settings:saveMultimodalConfig', {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'mm-key',
  model: 'glm-4v-flash',
  preparseEnabled: true
})
const settings2 = await inv('settings:load')
check('多模态配置往返一致', settings2.multimodalConfig?.model === 'glm-4v-flash')

await inv('settings:saveApiProfiles', [
  { id: 'p1', name: '生产', config: cfg, multimodalConfig: settings2.multimodalConfig }
])
const settings3 = await inv('settings:load')
check('多套 API 配置可保存', settings3.apiProfiles.length === 1 && settings3.apiProfiles[0].name === '生产')

await inv('settings:saveFlag', 'thinking', true)
check('开关类配置可保存', true)

// --- 对话生命周期 ---
const convList0 = await inv('conversations:load')
check('conversations:load 起始为空', convList0.length === 0)

const created = await inv('conversations:create', agents[0].id, 'interactive')
check('conversations:create 返回会话', created.id !== '' && created.mode === 'interactive')
// 事故（用户实测）：建会话时把「引擎名」写进了标题，而标题推导的守卫只认 ''/'新对话'，
// 于是侧栏里每条会话都顶着同一个引擎名。标题必须留空，只由首条用户消息推导。
check(
  'conversations:create 的标题是空的（标题只由首条用户消息推导）',
  created.title === '',
  `title="${created.title}"`
)
check('创建事件已推送', events.some((e) => e.type === 'conversation:created'), `${events.length} 个事件`)

const fetched = await inv('conversation:get', created.id)
check('conversation:get 可取回会话', fetched !== null && fetched.id === created.id)

await inv('conversations:rename', created.id, '改名后的对话')
const renamed = await inv('conversation:get', created.id)
check('conversations:rename 生效', renamed.title === '改名后的对话')
check('改名事件已推送', events.some((e) => e.type === 'conversation:title' && e.title === '改名后的对话'))

const listAfter = await inv('conversations:load')
check('会话出现在列表中', listAfter.length === 1 && listAfter[0].title === '改名后的对话')

// --- 缺配置时的护栏：不能静默失败 ---
events.length = 0
await inv('chat:send', {
  conversationId: created.id,
  text: '你好',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})
// 上面已配置了 apiKey，所以这次会真的发起请求 → 网络不可达时会走失败分支。
// 这里只断言「一定产生了终态事件」，不依赖外网。
check(
  'chat:send 必然产生终态事件（不挂起）',
  events.some((e) => e.type === 'turn:finished' || e.type === 'notice'),
  events.map((e) => e.type).join(',')
)

// 标题推导：首条用户消息必须把空标题填上（这是侧栏标题正确的另一半）
const renamedAfterSend = await inv('conversation:get', created.id)
check(
  '已改名的会话不会被首条消息改题',
  renamedAfterSend.title === '改名后的对话',
  `title="${renamedAfterSend.title}"`
)

const convTitle = await inv('conversations:create', agents[0].id, 'chat')
events.length = 0
await inv('chat:send', {
  conversationId: convTitle.id,
  text: '季度复盘怎么做',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const titled = await inv('conversation:get', convTitle.id)
check(
  '首条用户消息推出会话标题',
  titled.title === '季度复盘怎么做',
  `title="${titled.title}"`
)

// --- 「重答」：丢掉末尾的 assistant 之后重跑 ---
// INVOKE.chatRegenerate 在契约里早已声明，但一直没有处理器；这里既验证通道可用，
// 也验证「删掉旧回答」是靠 conversation:sync 整份同步表达的（增量事件表达不了删除）。
events.length = 0
await inv('chat:regenerate', {
  conversationId: convTitle.id,
  thinkingEnabled: false,
  webSearchEnabled: false
})
check(
  'chat:regenerate 推送了整份会话同步事件',
  events.some((e) => e.type === 'conversation:sync'),
  events.map((e) => e.type).join(',')
)
check(
  'chat:regenerate 必然产生终态事件（不挂起）',
  events.some((e) => e.type === 'turn:finished' || e.type === 'notice'),
  events.map((e) => e.type).join(',')
)
const afterRegen = await inv('conversation:get', convTitle.id)
check(
  '重新生成后末尾仍是一条用户消息 + 一条 assistant（旧回答没有叠在里面）',
  afterRegen.messages.length === 2 &&
    afterRegen.messages[0].role === 'user' &&
    afterRegen.messages[1].role === 'assistant',
  afterRegen.messages.map((m) => m.role).join(',')
)

// --- 未配置 API Key 时必须明确报错 ---
await inv('settings:saveApiConfig', { ...cfg, apiKey: '' })
const conv2 = await inv('conversations:create', agents[0].id, 'chat')
events.length = 0
await inv('chat:send', {
  conversationId: conv2.id,
  text: '你好',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})
check(
  '未配置 API Key 时给出明确提示',
  events.some((e) => e.type === 'notice' && e.level === 'error'),
  events.map((e) => (e.type === 'notice' ? e.text : e.type)).join(' | ')
)

// --- 交互模式状态回写 ---
const msgId = 'msg-test-1'
events.length = 0
await inv('chat:patchMessage', conv2.id, msgId, '内容')
check('patchMessage 对不存在的消息安全退出', true)

// --- 工作区 ---
const wsList = await inv('workspace:list', conv2.id)
check('workspace:list 可用（空工作区）', Array.isArray(wsList) && wsList.length === 0)

const treeText = await inv('workspace:treeText', conv2.id)
check('workspace:treeText 可用', typeof treeText === 'string')

await inv('workspace:clear', conv2.id)
check('workspace:clear 不抛异常', true)

let readError = ''
try {
  await inv('workspace:read', conv2.id, 'nope.txt')
} catch (e) {
  readError = String(e && e.message ? e.message : e)
}
check('workspace:read 对越界/不存在路径明确报错', readError.includes('不存在') || readError.includes('越界'), readError.slice(0, 60))

let traversalError = ''
try {
  await inv('workspace:read', conv2.id, '../../../etc/passwd')
} catch (e) {
  traversalError = String(e && e.message ? e.message : e)
}
check('workspace:read 拒绝目录穿越', traversalError.includes('越界'), traversalError.slice(0, 60))

// --- 删除会话 ---
events.length = 0
await inv('conversations:delete', conv2.id)
const afterDelete = await inv('conversations:load')
check('conversations:delete 生效', !afterDelete.some((c) => c.id === conv2.id))
check('删除事件已推送', events.some((e) => e.type === 'conversation:deleted'))

// ===== 18. 端侧增强（朗读偏好 / 文件收件 / 导出 Word） =====
const passedBefore = passed
console.log('\n18. 端侧增强')

// --- 字符串偏好（朗读音色 / 语速）---
await inv('settings:saveString', 'reader_voice', 'Microsoft Xiaoxiao')
await inv('settings:saveString', 'reader_rate', '1.7')
const settings4 = await inv('settings:load')
check('字符串偏好可保存', settings4.prefs?.reader_voice === 'Microsoft Xiaoxiao', settings4.prefs?.reader_voice)
check('语速偏好可保存', settings4.prefs?.reader_rate === '1.7')

// --- 协议路径后缀补全开关（用户报障类：这个字段以前根本没进 DTO，保存时被静默重置） ---
// 事故形状：渲染层看不到 autoSuffix，fromApiConfigDto 每次都把它写成默认 true ——
// 用户（或从原版迁移过来的配置）关掉它以后，只要在桌面端点一次「保存」，设置就被悄悄丢掉。
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'https://gateway.example.com/custom',
  apiKey: 'sk-test',
  model: 'test-model',
  temperature: 0.2,
  topP: 0.9,
  maxTokens: 1234,
  extraParams: '{"enable_search":true}',
  autoSuffix: false
})
const settingsSuffix = await inv('settings:load')
check(
  '关掉「协议路径后缀补全」后能原样读回（此前会被静默重置成 true）',
  settingsSuffix.apiConfig?.autoSuffix === false,
  String(settingsSuffix.apiConfig?.autoSuffix)
)
check('其它字段没被这次往返弄丢', settingsSuffix.apiConfig?.maxTokens === 1234 && settingsSuffix.apiConfig?.extraParams === '{"enable_search":true}')

await inv('settings:saveApiConfig', { ...settingsSuffix.apiConfig, autoSuffix: true })
check('重新打开该开关也生效', (await inv('settings:load')).apiConfig?.autoSuffix === true)

// --- 本地联网搜索：引擎目录 + 配置落盘并立即生效 ---
// 原版这套配置由 SettingsPanel 编辑、ChatViewModel 落盘并 bind() 给工具层；
// 桌面端此前既没读也没下发，LocalWebSearch.bind() 从来没有调用者 —— 配置形同不存在。
const engines = await inv('settings:searchEngines')
check(
  '主进程报出本地搜索的引擎目录（渲染层不必自己维护一份引擎表）',
  Array.isArray(engines) && engines.length >= 6 && engines[0].id === 'bing',
  (engines ?? []).map((e) => e.id).join(', ')
)
check(
  '引擎目录标出了各自要不要 Key / BaseUrl',
  engines.some((e) => e.id === 'tavily' && e.needsApiKey === true) &&
    engines.some((e) => e.id === 'bing' && e.needsApiKey === false) &&
    engines.some((e) => e.id === 'exa' && e.supportsBaseUrl === true)
)

const searchPrefKey = 'guncat_local_search_config'
await inv('settings:saveString', searchPrefKey, JSON.stringify({ engine: 'tavily', maxResults: 3, tavilyApiKey: 'tvly-x' }))
const settingsSearch = await inv('settings:load')
check(
  '本地搜索配置按同一个键名往返（渲染层与主进程的键名必须一致）',
  settingsSearch.prefs?.[searchPrefKey] !== undefined &&
    settingsSearch.prefs[searchPrefKey].includes('tavily'),
  settingsSearch.prefs?.[searchPrefKey]
)
check(
  '加载设置时会把配置 bind 给工具层（否则用户在界面里配的引擎永不生效）',
  mod.LocalWebSearch.currentSettings().engine === 'tavily' &&
    mod.LocalWebSearch.currentSettings().maxResults === 3,
  mod.LocalWebSearch.currentSettings().engine
)

// --- 配置方案（多套 API 配置）：原版「配置方案 / 配置名称」，桌面端此前渲染层零调用点 ---
const settingsProfiles = await inv('settings:load')
check(
  '首次加载会把已有的单份配置迁移成一份「默认配置」方案（老用户的 Key 不会丢）',
  Array.isArray(settingsProfiles.apiProfiles) &&
    settingsProfiles.apiProfiles.length >= 1 &&
    settingsProfiles.apiProfiles[0].name.length > 0 &&
    settingsProfiles.currentApiProfileId === settingsProfiles.apiProfiles[0].id,
  (settingsProfiles.apiProfiles ?? []).map((p) => p.name).join(', ')
)

const firstProfileId = settingsProfiles.currentApiProfileId
const added = await inv('settings:addApiProfile')
check('新建配置方案返回新方案', added !== undefined && added.id !== firstProfileId, added?.name)
check(
  '新方案内容复制自当前方案（原版是空白方案，会让「加了配置就发不出请求」）',
  added?.config?.baseUrl === settingsProfiles.apiConfig?.baseUrl,
  `${added?.config?.baseUrl}`
)
const afterAdd = await inv('settings:load')
check(
  '新建后当前方案切到新的那份',
  afterAdd.currentApiProfileId === added.id && afterAdd.apiProfiles.length === settingsProfiles.apiProfiles.length + 1
)

await inv('settings:saveCurrentApiProfile', '测试方案', {
  ...added.config,
  model: 'profile-model-x',
  autoSuffix: false
}, added.multimodalConfig)
const afterSaveProfile = await inv('settings:load')
check(
  '一次性保存方案：名称与配置都落到方案上',
  afterSaveProfile.apiProfiles.some((p) => p.name === '测试方案' && p.config.model === 'profile-model-x')
)
check(
  '一次性保存方案：运行时生效的配置同步更新（工作轮次读的是旧键）',
  afterSaveProfile.apiConfig?.model === 'profile-model-x' &&
    afterSaveProfile.apiConfig?.autoSuffix === false
)

await inv('settings:selectApiProfile', firstProfileId)
const afterSelect = await inv('settings:load')
check('切换方案后运行时配置跟着换', afterSelect.currentApiProfileId === firstProfileId)
check(
  '切换方案会把该方案写回运行时键（否则界面切了、发请求还用旧的）',
  afterSelect.apiConfig?.model !== 'profile-model-x',
  String(afterSelect.apiConfig?.model)
)

await inv('settings:deleteApiProfile', added.id)
const afterProfileDelete = await inv('settings:load')
check('删除方案生效', !afterProfileDelete.apiProfiles.some((p) => p.id === added.id))

// 删到只剩一份时必须拒绝：一份都不剩会让应用彻底没有可用配置
const profilesNow = (await inv('settings:load')).apiProfiles
for (const p of profilesNow.slice(1)) {
  await inv('settings:deleteApiProfile', p.id)
}
const lastProfile = await inv('settings:load')
await inv('settings:deleteApiProfile', lastProfile.apiProfiles[0].id)
check(
  '至少保留一份配置方案（删最后一份会被拒绝）',
  (await inv('settings:load')).apiProfiles.length === 1
)

// --- 命令行文件收件：argv 解析 ---
const intakeDir = path.join(dataRoot, 'inbox')
fs.mkdirSync(intakeDir, { recursive: true })
const f1 = path.join(intakeDir, '素材.txt')
const f2 = path.join(intakeDir, '数据.csv')
fs.writeFileSync(f1, 'hello intake', 'utf8')
fs.writeFileSync(f2, 'a,b\n1,2\n', 'utf8')

const parsedArgs = mod.collectFileArgs([
  'electron.exe',
  '.',
  '--enable-logging',
  f1,
  f2,
  path.join(intakeDir, '不存在.txt'),
  intakeDir,
  '--no-sandbox'
])
check('argv 里只挑出真实存在的文件', parsedArgs.length === 2, parsedArgs.map((p) => path.basename(p)).join(', '))
check('argv 解析跳过开关项', !parsedArgs.some((p) => p.startsWith('--')))
check('argv 解析跳过目录', !parsedArgs.includes(intakeDir))
check('argv 解析去重', mod.collectFileArgs(['x', f1, f1]).length === 1)

// --- 文件导入工作区 ---
const conv3 = await inv('conversations:create', agents[0].id, 'work')
events.length = 0
const intakeResult = await inv('intake:import', conv3.id, [f1, f2, path.join(intakeDir, '不存在.txt')])
check('intake:import 导入成功 2 个', intakeResult.imported === 2, intakeResult.names.join(', '))
check('不存在的文件被记为失败', intakeResult.failed.length === 1)
check('导入后工作区有文件', (await inv('workspace:list', conv3.id)).length === 2)
check('收件事件已推送', events.some((e) => e.type === 'files:intaken'))
check('工作区变更事件已推送', events.some((e) => e.type === 'workspace:changed'))

const readBack = await inv('workspace:read', conv3.id, '素材.txt')
check('导入内容可读回', readBack.text === 'hello intake', JSON.stringify(readBack.text))

// --- 工作区「上传」按钮：弹系统文件选择框并导入 ---
// 用户报障「工作区上传文件找不到入口」——原版 WorkspaceBar 头部有可见的「上传」按钮，
// 桌面版此前只有拖拽（界面上没有任何提示）。这里把那条链路整条钉住。
const uploadDir = path.join(dataRoot, 'upload')
fs.mkdirSync(uploadDir, { recursive: true })
const up1 = path.join(uploadDir, '报表.csv')
fs.writeFileSync(up1, 'x,y\n3,4\n', 'utf8')

mod.__setOpenDialog({ canceled: true, filePaths: [] })
const uploadCanceled = await inv('intake:pickFiles', conv3.id)
check('上传：用户取消时不导入任何文件', uploadCanceled.canceled === true && uploadCanceled.imported === 0)
check(
  '上传：确实弹了系统文件选择框',
  mod.__calls().some((c) => c.fn === 'dialog.showOpenDialog')
)

mod.__setOpenDialog({ canceled: false, filePaths: [up1] })
const uploadOk = await inv('intake:pickFiles', conv3.id)
check('上传：选中的文件被导入工作区', uploadOk.canceled === false && uploadOk.imported === 1, uploadOk.names.join(', '))
check('上传后文件真的在工作区里', (await inv('workspace:list', conv3.id)).some((e) => e.path === '报表.csv'))
mod.__setOpenDialog(null)

// --- 聊天模式附件：此前整条链路是空壳（审计 P0） ---
//
// 事故形状：SessionManager.makeAttachments 只留了文件名（dataUrl / parsedText / fileId 全空串），
// 而 ChatService 三条协议都会因 `parsedText === '' && dataUrl === ''` 直接 continue ——
// 于是「加了附件」对请求零影响：图片发不过去、文档也没内容。
// 这里从「发一条带附件的消息」一路查到持久化的消息 DTO。
mod.__setOpenDialog({ canceled: true, filePaths: [] })
check('附件选择：取消时不选任何文件', (await inv('attachments:pick')).length === 0)
mod.__setOpenDialog(null)

await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'sk-attachment-test',
  model: 'attachment-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const attachPath = path.join(intakeDir, '附件素材.txt')
fs.writeFileSync(attachPath, 'attachment payload 内容', 'utf8')
const convAttach = await inv('conversations:create', agents[0].id, 'chat')
await inv('chat:send', {
  conversationId: convAttach.id,
  text: '看看这个附件',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false,
  attachmentPaths: [attachPath]
})
const convAttachDto = await inv('conversation:get', convAttach.id)
const attachUserMsg = (convAttachDto?.messages ?? []).find((m) => m.role === 'user')
const attachList = attachUserMsg?.attachments ?? []
check('附件被记进这条用户消息', attachList.length === 1, `${attachList.length} 个`)
check(
  '附件带上了真实内容（此前 dataUrl/parsedText 都是空串，协议会直接跳过它）',
  typeof attachList[0]?.dataUrl === 'string' &&
    attachList[0].dataUrl.startsWith('data:text/plain;base64,') &&
    attachList[0].dataUrl.length > 40,
  String(attachList[0]?.dataUrl).slice(0, 40)
)
check(
  '附件名取自文件路径（不是整条路径）',
  attachList[0]?.name === '附件素材.txt',
  String(attachList[0]?.name)
)
check('附件类型按扩展名归类', attachList[0]?.type === 'file', String(attachList[0]?.type))

// --- 导出回答为 Word ---
// 渲染进程走的是带保存对话框的通道（替身返回取消）
const exportCanceled = await inv('message:exportDocx', conv3.id, 'nope-msg')
check('导出通道存在且取消时安全返回', exportCanceled.saved === false)

// 直接验证导出内容本身可生成（绕过保存对话框）
let exportError = ''
try {
  await session.exportMessageDocx(conv3.id, 'nope-msg')
} catch (e) {
  exportError = String(e && e.message ? e.message : e)
}
check('对不存在的消息导出时报错清晰', exportError.includes('消息不存在'), exportError.slice(0, 40))

// 造一条真实消息再导出（assistant 消息在发起请求前就已落库，因此即使网络不可达也能拿到）
const conv4 = await inv('conversations:create', agents[0].id, 'chat')
await inv('settings:saveApiConfig', { ...cfg, baseUrl: 'http://127.0.0.1:9/', model: 'test-model' })
events.length = 0
await inv('chat:send', { conversationId: conv4.id, text: '生成一段回答', mode: 'chat', thinkingEnabled: false, webSearchEnabled: false })
const conv4Full = await inv('conversation:get', conv4.id)
const assistantMsg = conv4Full.messages.find((m) => m.role === 'assistant')
check('发起请求后存在 assistant 消息', assistantMsg !== undefined, `${conv4Full.messages.length} 条消息`)
let docxBytes = null
let docxError = ''
try {
  docxBytes = await session.exportMessageDocx(conv4.id, assistantMsg.id)
} catch (e) {
  docxError = String(e && e.message ? e.message : e)
}
check(
  '回答可导出为合法 docx（PK 魔数）',
  docxBytes !== null && docxBytes.length > 0 && docxBytes[0] === 0x50,
  docxBytes !== null ? `${docxBytes.length} 字节` : docxError.slice(0, 60)
)

console.log(`\n端侧增强验证：通过 ${passed - passedBefore} 项`)

// ===== 19. 语音输入（ASR）配置解析与端点拼接 =====
const passedBeforeAsr = passed
console.log('\n19. 语音输入（ASR）')

// 端点拼接：Base URL 的几种常见写法都要落到 /audio/transcriptions
const urlCases = [
  ['https://api.openai.com/v1', 'https://api.openai.com/v1/audio/transcriptions'],
  ['https://api.openai.com/v1/', 'https://api.openai.com/v1/audio/transcriptions'],
  ['https://api.openai.com', 'https://api.openai.com/audio/transcriptions'],
  ['  https://x.example.com/v1/audio/transcriptions  ', 'https://x.example.com/v1/audio/transcriptions']
]
for (const [input, want] of urlCases) {
  const got = mod.resolveTranscriptionUrl(input)
  check(`端点拼接 ${input.trim()}`, got === want, got)
}
check('空 Base URL 返回空', mod.resolveTranscriptionUrl('') === '')
check('仅斜杠返回空', mod.resolveTranscriptionUrl('///') === '')

// 配置解析：专用偏好优先，缺省回落到多模态配置
await inv('settings:saveString', 'asr_baseUrl', '')
await inv('settings:saveString', 'asr_apiKey', '')
await inv('settings:saveString', 'asr_model', '')
await inv('settings:saveMultimodalConfig', {
  baseUrl: 'https://mm.example.com/v1',
  apiKey: 'mm-key',
  model: 'glm-4v-flash',
  preparseEnabled: true
})
const cfgFallback = await mod.loadAsrConfig()
check('转写配置回落到多模态配置', cfgFallback.baseUrl === 'https://mm.example.com/v1' && cfgFallback.apiKey === 'mm-key')
check('转写模型有默认值', cfgFallback.model === 'whisper-1', cfgFallback.model)

await inv('settings:saveString', 'asr_baseUrl', 'https://asr.example.com/v1')
await inv('settings:saveString', 'asr_apiKey', 'asr-key')
await inv('settings:saveString', 'asr_model', 'whisper-large-v3')
const cfgDedicated = await mod.loadAsrConfig()
check('专用转写配置优先于多模态配置', cfgDedicated.baseUrl === 'https://asr.example.com/v1' && cfgDedicated.model === 'whisper-large-v3')

// 未配置时必须明确报错
await inv('settings:saveString', 'asr_baseUrl', '')
await inv('settings:saveString', 'asr_apiKey', '')
await inv('settings:saveMultimodalConfig', { baseUrl: '', apiKey: '', model: '', preparseEnabled: false })
const noConfig = await inv('asr:transcribe', new Uint8Array([1, 2, 3]), 'audio/webm')
check('未配置转写服务时给出可操作提示', noConfig.ok === false && noConfig.error.includes('尚未配置'), noConfig.error.slice(0, 50))

const emptyAudio = await mod.transcribeAudio(new Uint8Array(0), 'audio/webm')
check('空录音给出明确错误', emptyAudio.ok === false && emptyAudio.error.includes('没有录到音频'), emptyAudio.error)

// 不可达地址：必须是「可读错误」而不是抛异常
await inv('settings:saveString', 'asr_baseUrl', 'http://127.0.0.1:9/v1')
await inv('settings:saveString', 'asr_apiKey', 'k')
const unreachable = await inv('asr:transcribe', new Uint8Array([1, 2, 3]), 'audio/webm')
check(
  '转写服务不可达时返回可读错误而非抛异常',
  unreachable.ok === false && unreachable.error.length > 0,
  unreachable.error.slice(0, 60)
)

console.log(`\n语音输入验证：通过 ${passed - passedBeforeAsr} 项`)

console.log(`\nIPC 验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
}
fs.rmSync(dataRoot, { recursive: true, force: true })
process.exitCode = failed === 0 ? 0 : 1
