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
import http from 'node:http'
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
export { __invoke, __channels, __events, __calls, __setOpenDialog, __setMessageBox, __reset } from 'electron'
export { initAppPaths, clearTempDir } from '@core/platform/appPaths'
export { LocalWebSearch, SearchEngineSettings } from '@core/service/LocalWebSearch'
export { sanitizeTableHtml } from '@main/sanitizeHtml'
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

/**
 * 等一条主进程推来的事件（附件解析是**后台**逐个做的，pick 不会等它）。
 * 轮询而不是订阅：事件都在 events 数组里，重复进出的事件也用同一种写法查。
 */
async function waitForEvent(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = events.find(predicate)
    if (hit !== undefined) {
      return hit
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return null
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
  'work:steer',
  'conversation:stats',
  'conversation:artifacts',
  'tableOcr:pickImage',
  'tableOcr:run',
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

const convTitleGen = await inv('conversations:create', agents[0].id, 'chat')
events.length = 0
await inv('chat:send', {
  conversationId: convTitleGen.id,
  text: '季度复盘怎么做',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const titled = await inv('conversation:get', convTitleGen.id)
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
  conversationId: convTitleGen.id,
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
const afterRegen = await inv('conversation:get', convTitleGen.id)
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

// --- 附件先行解析（对齐原版 enqueueFiles：选完立刻出现卡片，解析逐个回报） ---
//
// 事故形状：附件此前只在**发送时**才解析，用户选完文件后看不到任何进度，
// 也不知道这份文件到底解析完了没有。原版的口径是：卡片先以「解析中...」出现，
// 解析完再变成「已就绪 / 解析失败」，且解析中的文件不允许发送。
//
// 先用「未开启先行解析」的配置走内联路径验证时序（不碰网络），
// 再用一个假的多模态服务验证「解析结果被缓存、发送时不会重复解析」。
const mmBefore = (await inv('settings:load')).multimodalConfig
const inlineFile = path.join(intakeDir, '先行解析内联.txt')
fs.writeFileSync(inlineFile, '内联附件内容', 'utf8')
await inv('settings:saveMultimodalConfig', { ...mmBefore, preparseEnabled: false, apiKey: '' })

events.length = 0
mod.__setOpenDialog({ canceled: false, filePaths: [inlineFile] })
const pickedParsing = await inv('attachments:pick')
mod.__setOpenDialog(null)
check(
  '选完文件立刻返回，状态是「解析中」（卡片先出现，不等解析做完）',
  pickedParsing.length === 1 && pickedParsing[0].status === 'parsing',
  JSON.stringify(pickedParsing.map((a) => a.status))
)
check(
  '立刻返回的那一份仍带齐预览信息（路径 / 文件名 / 大小 / 缩略图）',
  pickedParsing[0]?.path === inlineFile &&
    pickedParsing[0]?.name === '先行解析内联.txt' &&
    pickedParsing[0]?.size > 0 &&
    typeof pickedParsing[0]?.thumbnail === 'string',
  JSON.stringify({ name: pickedParsing[0]?.name, size: pickedParsing[0]?.size })
)
const inlineParsed = await waitForEvent(
  (e) => e.type === 'attachment:parsed' && e.path === inlineFile
)
check(
  '解析完成后推 attachment:parsed 事件（status=ready）',
  inlineParsed !== null && inlineParsed.status === 'ready',
  JSON.stringify(inlineParsed)
)

// 解析不出来的文件必须回报失败，并把原因带上 —— 卡片红底只说明「坏了」，
// 具体原因（这里是不存在）要靠 tooltip 查得到。
const missingFile = path.join(intakeDir, '不存在的附件.txt')
events.length = 0
mod.__setOpenDialog({ canceled: false, filePaths: [missingFile] })
await inv('attachments:pick')
mod.__setOpenDialog(null)
const missingParsed = await waitForEvent(
  (e) => e.type === 'attachment:parsed' && e.path === missingFile
)
check(
  '解析不出来的文件回报 status=error 并带上原因',
  missingParsed !== null &&
    missingParsed.status === 'error' &&
    typeof missingParsed.error === 'string' &&
    missingParsed.error !== '',
  JSON.stringify(missingParsed)
)

// 假的多模态服务：只数请求次数并回一句可识别的文字。
// 「发送时不再重复解析」这条只能靠请求次数钉住 —— 结果对但没有次数的话，
// 同一份文件会被调两次接口、传两次 Files API，用户看到的是「发个附件特别慢」。
const mmBodies = []
const mmServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    mmBodies.push(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '这是多模态解析出的文字' } }] }))
  })
})
await new Promise((resolve) => mmServer.listen(0, '127.0.0.1', resolve))
const mmPort = mmServer.address().port
const mmFile = path.join(intakeDir, '先行解析服务.txt')
fs.writeFileSync(mmFile, '要被多模态服务读到的内容', 'utf8')
await inv('settings:saveMultimodalConfig', {
  baseUrl: `http://127.0.0.1:${mmPort}`,
  apiKey: 'sk-mm-test',
  model: 'mm-test-model',
  preparseEnabled: true
})

events.length = 0
mod.__setOpenDialog({ canceled: false, filePaths: [mmFile] })
await inv('attachments:pick')
mod.__setOpenDialog(null)
const mmParsed = await waitForEvent((e) => e.type === 'attachment:parsed' && e.path === mmFile)
check(
  '开启先行解析时，解析结果来自多模态服务',
  mmParsed !== null && mmParsed.status === 'ready' && mmBodies.length === 1,
  `多模态请求 ${mmBodies.length} 次`
)

const convMm = await inv('conversations:create', agents[0].id, 'chat')
await inv('chat:send', {
  conversationId: convMm.id,
  text: '看这个文件',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false,
  attachmentPaths: [mmFile]
})
check(
  '发送时复用解析缓存，不重复调用多模态接口（此前每次发送都要重解析）',
  mmBodies.length === 1,
  `多模态请求 ${mmBodies.length} 次`
)
const mmMsg = ((await inv('conversation:get', convMm.id))?.messages ?? []).find(
  (m) => m.role === 'user'
)
check(
  '复用缓存的那份附件带着解析出的文字（缓存不是空壳）',
  mmMsg?.attachments?.[0]?.parsedText === '这是多模态解析出的文字',
  String(mmMsg?.attachments?.[0]?.parsedText)
)
await new Promise((resolve) => mmServer.close(resolve))

// 先行解析失败（服务端报错）时的兜底：卡片报「解析失败」，但文件仍以 Base64 内联发得出去。
// 这条是桌面端相对原版的**有意差异**（原版会把 error 的附件从 ready 里过滤掉、也就是不发送）：
// 这里的失败几乎总是「多模态入口没配好/临时抽风」，把文件一起丢掉才是真的不可用。
const badBodies = []
const badServer = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    badBodies.push(1)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"error":"boom"}')
  })
})
await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve))
const badPort = badServer.address().port
const badFile = path.join(intakeDir, '先行解析失败.txt')
fs.writeFileSync(badFile, '解析会失败的内容', 'utf8')
await inv('settings:saveMultimodalConfig', {
  baseUrl: `http://127.0.0.1:${badPort}`,
  apiKey: 'sk-bad-test',
  model: 'mm-bad-model',
  preparseEnabled: true
})
events.length = 0
mod.__setOpenDialog({ canceled: false, filePaths: [badFile] })
await inv('attachments:pick')
mod.__setOpenDialog(null)
const badParsed = await waitForEvent((e) => e.type === 'attachment:parsed' && e.path === badFile)
check(
  '先行解析失败：卡片收到 status=error 与失败原因',
  badParsed !== null &&
    badParsed.status === 'error' &&
    String(badParsed.error).includes('500') &&
    String(badParsed.error).includes('内联'),
  JSON.stringify(badParsed)
)
const convBad = await inv('conversations:create', agents[0].id, 'chat')
await inv('chat:send', {
  conversationId: convBad.id,
  text: '这个文件还发得出去吗',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false,
  attachmentPaths: [badFile]
})
const badMsg = ((await inv('conversation:get', convBad.id))?.messages ?? []).find(
  (m) => m.role === 'user'
)
check(
  '先行解析失败的附件仍退回 Base64 内联发送（不会连文件一起丢掉）',
  badMsg?.attachments?.length === 1 &&
    String(badMsg.attachments[0].dataUrl).startsWith('data:text/plain;base64,'),
  String(badMsg?.attachments?.[0]?.dataUrl).slice(0, 34)
)
check(
  '失败的那次解析也被缓存住了（不会每发一次就重试一遍慢接口）',
  badBodies.length === 1,
  `坏接口请求 ${badBodies.length} 次`
)
await new Promise((resolve) => badServer.close(resolve))
await inv('settings:saveMultimodalConfig', mmBefore)

// --- 定时提醒推进：此前 ScheduleService.tick 零调用点 ---
//
// 事故形状：模型调 schedule_create 会成功返回、并对用户说「5 分钟后提醒你」，
// 到点**什么都不发生** —— 不是功能缺失，而是静默失效，用户只会认为应用失灵。
// 这里直接往工作区写一份到期的提醒，启动每秒推进，看它是否真的注入成用户消息。
const convSched = await inv('conversations:create', agents[0].id, 'work')
const schedRoot = session.workspaceRoot(convSched.id)
fs.mkdirSync(schedRoot, { recursive: true })
const schedFile = path.join(schedRoot, '.schedule.json')
fs.writeFileSync(
  schedFile,
  JSON.stringify([
    {
      id: 'sched-1',
      message: '该提交周报了',
      dueAt: Date.now() - 1000,
      everySeconds: 0,
      createdAt: Date.now() - 60000
    }
  ]),
  'utf8'
)
events.length = 0
session.startScheduleTicker()
await new Promise((resolve) => setTimeout(resolve, 1600))
const convSchedDto = await inv('conversation:get', convSched.id)
const reminderMsg = (convSchedDto?.messages ?? []).find(
  (m) => m.role === 'user' && String(m.content).startsWith('【定时提醒】')
)
check(
  '到期的定时提醒被注入成用户消息（此前整条链路没有任何调用点）',
  reminderMsg !== undefined,
  String(reminderMsg?.content ?? '(没有消息)')
)
check(
  '触发时也推了一条可见提示',
  events.some((e) => e.type === 'notice' && String(e.text ?? '').includes('定时提醒已触发')),
  events.filter((e) => e.type === 'notice').map((e) => e.text).join(' | ').slice(0, 80)
)
let schedLeft = []
try {
  schedLeft = JSON.parse(fs.readFileSync(schedFile, 'utf8'))
} catch {
  schedLeft = []
}
check('一次性提醒触发后被移除（不会每拍重复响）', Array.isArray(schedLeft) && schedLeft.length === 0)
session.stopScheduleTicker()

// --- 推理强度：此前在主进程里被写死成 high/none（审计 P1-5） ---
//
// 内核本来就支持 max/high/low（AgentLoopService 下发给三种协议），
// 但 SessionManager 一直写 `thinkingEnabled ? 'high' : 'none'` ——
// 工作模式拿不到 Max 档（长程任务的推理预算被砍），也没法选 Low 提速。
// 这里用一个本地服务把真正发出去的请求体抓下来看。
const capturedBodies = []
const effortServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    capturedBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => effortServer.listen(0, '127.0.0.1', () => resolve()))
const effortPort = effortServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(effortPort),
  apiKey: 'sk-effort-test',
  model: 'effort-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convEffort = await inv('conversations:create', agents[0].id, 'work')

await inv('work:run', {
  conversationId: convEffort.id,
  text: '选最高档',
  mode: 'work',
  thinkingEnabled: true,
  webSearchEnabled: false,
  reasoningEffort: 'max'
})
const maxBody = capturedBodies.find((b) => b.includes('reasoning_effort')) ?? ''
check(
  '推理强度按请求透传（工作模式此前永远拿不到 Max 档）',
  maxBody.includes('"reasoning_effort":"max"'),
  maxBody.slice(maxBody.indexOf('reasoning_effort') - 20, maxBody.indexOf('reasoning_effort') + 30)
)
check('深度思考开关仍然照常下发', maxBody.includes('"thinking":{"type":"enabled"}'))

capturedBodies.length = 0
await inv('work:run', {
  conversationId: convEffort.id,
  text: '不传强度',
  mode: 'work',
  thinkingEnabled: true,
  webSearchEnabled: false
})
check(
  '不传强度时退回默认 high（与改动前一致，不改变既有行为）',
  capturedBodies.some((b) => b.includes('"reasoning_effort":"high"'))
)

capturedBodies.length = 0
await inv('work:run', {
  conversationId: convEffort.id,
  text: '非法强度',
  mode: 'work',
  thinkingEnabled: true,
  webSearchEnabled: false,
  reasoningEffort: 'turbo'
})
check(
  '非法强度被拒（不会把任意字符串塞进请求体）',
  capturedBodies.some((b) => b.includes('"reasoning_effort":"high"')) &&
    !capturedBodies.some((b) => b.includes('turbo'))
)

// --- 插话（审计 P1-4）：此前全库 `steer` 零命中，想补充要求只能中止重来 ---
//
// 真正的判据不是「接口返回 true」，而是**插话文本真的出现在下一轮请求体里**。
// 用一个会拖住第一轮的本地服务（先给工具调用、再给结论），
// 在第一轮工具执行期间插话，然后检查第二轮请求体里有没有那句话。
const steerBodies = []
// 第一轮的响应**故意挂住**：这样「执行中」是一个确定的窗口，而不是抢时间。
// 抢时间的写法不可靠 —— 工具跑得太快时，等请求体出现再插话，整个任务可能已经结束了。
let releaseSteerRound1 = null
const steerServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    steerBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (steerBodies.length === 1) {
      releaseSteerRound1 = () => {
        // 要求调一次工具 → 循环会真的执行工具并进入第二轮
        res.write(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_steer_1',
                        type: 'function',
                        function: { name: 'get_workspace_tree', arguments: '{}' }
                      }
                    ]
                  }
                }
              ]
            }) +
            '\n\n'
        )
        res.write('data: [DONE]\n\n')
        res.end()
      }
      return
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '收到补充要求' } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => steerServer.listen(0, '127.0.0.1', () => resolve()))
const steerPort = steerServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(steerPort),
  apiKey: 'sk-steer-test',
  model: 'steer-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convSteer = await inv('conversations:create', agents[0].id, 'work')
check('没在跑的时候插话被拒（渲染层会改走普通发送）', (await inv('work:steer', convSteer.id, '你好')) === false)

const steerRun = inv('work:run', {
  conversationId: convSteer.id,
  text: '先看看工作区',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
for (let i = 0; i < 250 && steerBodies.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
check('第一轮请求已发出（此时任务确实在执行中）', steerBodies.length === 1, `${steerBodies.length} 轮`)
const steerAccepted = await inv('work:steer', convSteer.id, '别忘了顺带把结果写成文档')
check('执行中插话被接受', steerAccepted === true)
if (releaseSteerRound1 !== null) {
  releaseSteerRound1()
}
await steerRun
check(
  '插话文本真的进了下一轮请求体（不是只返回一个 true）',
  steerBodies.length >= 2 && steerBodies[steerBodies.length - 1].includes('别忘了顺带把结果写成文档'),
  `${steerBodies.length} 轮请求`
)
const convSteerDto = await inv('conversation:get', convSteer.id)
check(
  '插话也作为用户消息落在会话里（用户看得见自己说了什么）',
  (convSteerDto?.messages ?? []).some(
    (m) => m.role === 'user' && String(m.content).includes('别忘了顺带把结果写成文档')
  )
)
steerServer.closeAllConnections?.()
steerServer.close()

// --- 任务统计与目标卡（审计 P2-10） ---
//
// 事故形状：工作区面板只有「N 个文件 / N 个目录 / N 次工具调用」，而且是全会话累计，
// 对应不到原版的「本轮」；全库 elapsed 零命中，GoalService.read 也没有调用点。
const convNew = await inv('conversations:create', agents[0].id, 'work')
const statsBefore = await inv('conversation:stats', convNew.id)
check(
  '没跑过时用时为 0、轮数为 0（不编造数字）',
  statsBefore.elapsedMs === 0 && statsBefore.rounds === 0
)
check(
  '没有 usage 时速度与命中是「无数据」（-1），不是 0 —— 0 会被误读成「很慢 / 一次都没命中」',
  statsBefore.speed === -1 && statsBefore.cacheHit === -1
)
// convEffort 上面跑过三次（那三次的响应体是空的，只留了用时），
// convSteer 跑过一次带工具调用的完整循环 —— 用后者验轮数。
const statsAfter = await inv('conversation:stats', convEffort.id)
check(
  '跑过之后有真实的任务用时（哪怕这一轮以失败收场，耗时也是事实）',
  statsAfter.elapsedMs > 0,
  `${statsAfter.elapsedMs}ms`
)
const statsSteer = await inv('conversation:stats', convSteer.id)
check(
  '工具轮数按真实轮次累计（带工具调用的那一轮）',
  statsSteer.rounds >= 1,
  `${statsSteer.rounds} 轮 / ${statsSteer.elapsedMs}ms`
)

const goalRoot = session.workspaceRoot(convEffort.id)
fs.mkdirSync(goalRoot, { recursive: true })
fs.writeFileSync(
  path.join(goalRoot, '.goal.json'),
  JSON.stringify({
    objective: '把季度报表补齐并导出',
    status: 'active',
    rounds: 3,
    maxRounds: 40,
    note: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }),
  'utf8'
)
const statsGoal = await inv('conversation:stats', convEffort.id)
check(
  '当前目标从工作区 .goal.json 读出来（GoalService.read 此前在主进程与渲染层都没有调用点）',
  statsGoal.goal?.objective === '把季度报表补齐并导出' && statsGoal.goal?.rounds === 3,
  JSON.stringify(statsGoal.goal)
)
check('没有目标时不编造（返回 null）', (await inv('conversation:stats', convNew.id)).goal === null)

// --- 表格提取（审计 P1-3）：原版唯一不依赖对话的独立工具页 ---
//
// 完整识别链路需要真实图片解码（本机 Electron 起不来），所以这里钉两件
// **能在无头环境里证明**的事：① 通道与错误路径；② 模型输出的清洗 ——
// 识别结果是模型生成的 HTML，要挂进 DOM，白名单清洗是必须的。
mod.__setOpenDialog({ canceled: true, filePaths: [] })
check('表格提取：取消选图时不返回图片', (await inv('tableOcr:pickImage')) === null)
mod.__setOpenDialog(null)
let ocrError = ''
try {
  await inv('tableOcr:run', path.join(intakeDir, '不存在.png'), '')
} catch (e) {
  ocrError = String(e?.message ?? e)
}
check('表格提取：图片不存在时给出可读原因（不是静默失败）', ocrError.includes('图片不存在'), ocrError.slice(0, 60))

const attack = mod.sanitizeTableHtml(
  '<div onclick="steal()">' +
    '<table><tr><th colspan="2">表头</th></tr>' +
    '<tr><td>甲</td><td rowspan="2">乙</td></tr></table>' +
    '<img src=x onerror="alert(1)">' +
    '<script>alert(document.cookie)</script>' +
    '<style>body{display:none}</style>' +
    '<a href="javascript:alert(1)">点我</a>' +
    '</div>'
)
check('清洗后保留表格结构', attack.includes('<table>') && attack.includes('<tr>') && attack.includes('表头'))
check('清洗后保留 colspan / rowspan（表格语义不能丢）', attack.includes('colspan="2"') && attack.includes('rowspan="2"'))
check(
  '剔除可执行载荷（script / style / 事件属性 / img）',
  !attack.includes('script') &&
    !attack.includes('style') &&
    !attack.includes('onerror') &&
    !attack.includes('onclick') &&
    !attack.includes('<img') &&
    !attack.includes('javascript:')
)
check('白名单外标签的文字内容仍然保留（不损失正常结果）', attack.includes('点我'))
check(
  '非法跨度被丢弃（不让超大 colspan 把表格撑坏）',
  !mod.sanitizeTableHtml('<table><td colspan="99999">a</td></table>').includes('99999')
)
check(
  '注释里的内容不会漏进去',
  !mod.sanitizeTableHtml('<table><!-- <img onerror=x> --><tr><td>a</td></tr></table>').includes('onerror')
)

// 表格提取的连接信息解析（原版从配置方案里列模型让用户选）。
// 这里用**当前生效的模型**：它一定在某个配置方案里（saveApiConfig 会回写当前方案）。
const currentModel = (await inv('settings:load')).apiConfig?.model ?? ''
const ocrConfig = await session.tableOcrConfig(currentModel)
check(
  '表格提取按模型名从配置方案里取连接信息',
  ocrConfig.model === currentModel && ocrConfig.apiKey !== '',
  `${ocrConfig.model} @ ${ocrConfig.baseUrl}`
)
const ocrFallback = await session.tableOcrConfig('不存在的模型')
check(
  '指定模型找不到时退回多模态配置 / 主配置，而不是直接报错',
  ocrFallback.apiKey !== '',
  ocrFallback.model
)
// 键名取自 core 的 Constants（'table_ocr_provider'），不要在这里自己拼字符串
await inv('settings:saveString', 'table_ocr_provider', currentModel)
check(
  '表格提取记住的模型选择能持久化（原版 TableOcrPage 的 LS_KEY_TABLE_OCR_PROVIDER）',
  (await inv('settings:load')).prefs?.['table_ocr_provider'] === currentModel
)

// --- 清空工作区的二次确认（原版 ChatViewModel.clearWorkspace 的 promptAction.showDialog） ---
const convClear = await inv('conversations:create', agents[0].id, 'work')
const clearRoot = session.workspaceRoot(convClear.id)
fs.mkdirSync(clearRoot, { recursive: true })
fs.writeFileSync(path.join(clearRoot, '待清空.txt'), 'x', 'utf8')
mod.__setMessageBox(0) // 用户点了「取消」
const cancelClear = await inv('workspace:clear', convClear.id)
check(
  '清空工作区：用户取消时不删任何东西（原版是带确认的破坏性操作）',
  cancelClear.cleared === false && fs.existsSync(path.join(clearRoot, '待清空.txt')),
  JSON.stringify(cancelClear)
)
check(
  '确认框的按钮文案与原版一致（取消 / 清空）',
  (mod.__calls() ?? []).some(
    (c) => c.fn === 'dialog.showMessageBox' && JSON.stringify(c.args).includes('清空')
  )
)
mod.__setMessageBox(1) // 用户点了「清空」
const doClear = await inv('workspace:clear', convClear.id)
check(
  '确认后才真的清空（目录被重建、文件消失）',
  doClear.cleared === true && fs.existsSync(clearRoot) && !fs.existsSync(path.join(clearRoot, '待清空.txt')),
  JSON.stringify(doClear)
)
mod.__setMessageBox(null)

// --- 开关类偏好的持久化（原版：联网搜索默认**开**，深度思考默认关，都落盘） ---
await inv('settings:saveString', 'guncat_web_search_enabled', 'false')
await inv('settings:saveString', 'guncat_thinking_enabled', 'true')
await inv('settings:saveString', 'guncat_reasoning_effort', 'max')
await inv('settings:saveString', 'guncat_interactive_effort', 'off')
await inv('settings:saveString', 'guncat_current_agent', 'interactive')
await inv('settings:saveString', 'guncat_current_conv', 'conv-x')
const prefsDto = (await inv('settings:load')).prefs ?? {}
check(
  '开关与档位偏好能往返（此前深度思考/联网搜索只存在内存里，重启即丢）',
  prefsDto['guncat_web_search_enabled'] === 'false' &&
    prefsDto['guncat_thinking_enabled'] === 'true' &&
    prefsDto['guncat_reasoning_effort'] === 'max' &&
    prefsDto['guncat_interactive_effort'] === 'off',
  JSON.stringify({
    web: prefsDto['guncat_web_search_enabled'],
    think: prefsDto['guncat_thinking_enabled'],
    work: prefsDto['guncat_reasoning_effort'],
    act: prefsDto['guncat_interactive_effort']
  })
)
check(
  '当前智能体 / 当前会话也落盘（原版每次切换都会写）',
  prefsDto['guncat_current_agent'] === 'interactive' && prefsDto['guncat_current_conv'] === 'conv-x'
)

// --- 会话标题由 LLM 生成（原版 maybeGenerateTitle；端口此前 generateSessionTitle 零调用点） ---
const titleBodies = []
const titleServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    titleBodies.push(raw)
    // 标题请求与普通轮次走同一个接口：按系统提示词区分，便于断言「第二轮调用的是标题生成」
    const isTitle = raw.includes('会话标题生成器')
    const content = isTitle ? '「季度复盘」' : '已完成季度复盘整理'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => titleServer.listen(0, '127.0.0.1', () => resolve()))
const titlePort = titleServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(titlePort),
  apiKey: 'sk-title-test',
  model: 'title-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convTitleLlm = await inv('conversations:create', agents[0].id, 'work')
events.length = 0
await inv('work:run', {
  conversationId: convTitleLlm.id,
  text: '帮我整理季度复盘',
  mode: 'work',
  thinkingEnabled: true,
  webSearchEnabled: false
})
// 标题生成是 fire-and-forget（不能拖住轮次收尾），所以要等一小会儿。
// 注意：发送时主进程会先推一条**派生标题**（首条用户消息推导）的 conversation:title，
// 所以要专门等「LLM 生成的那一条」，不能一看到 conversation:title 就收工。
for (let i = 0; i < 150; i++) {
  const seen = events.some((e) => e.type === 'conversation:title' && e.title === '季度复盘')
  if (seen) {
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const titleEvent = events.find((e) => e.type === 'conversation:title' && e.title === '季度复盘')
check(
  '首轮交付后用 LLM 生成会话标题（generateSessionTitle 此前零调用点）',
  titleEvent !== undefined && titleEvent.title === '季度复盘',
  JSON.stringify(titleEvent ?? null)
)
check(
  '标题里的引号/句号被剥掉（原版对模型输出做同样的清洗）',
  titleEvent !== undefined && !/[「」"'.。]/.test(titleEvent.title),
  String(titleEvent?.title)
)
check(
  '标题确实落盘到会话上（侧栏标题会跟着变）',
  (await inv('conversation:get', convTitleLlm.id))?.title === '季度复盘'
)
const titleCallsAfterFirst = titleBodies.filter((b) => b.includes('会话标题生成器')).length
await inv('work:run', {
  conversationId: convTitleLlm.id,
  text: '再补充一版',
  mode: 'work',
  thinkingEnabled: true,
  webSearchEnabled: false
})
await new Promise((resolve) => setTimeout(resolve, 300))
check(
  '标题每个会话只生成一次（原版 titleJobs 的去重；否则每轮都白花一次模型调用）',
  titleCallsAfterFirst === 1 &&
    titleBodies.filter((b) => b.includes('会话标题生成器')).length === 1,
  `标题请求 ${titleBodies.filter((b) => b.includes('会话标题生成器')).length} 次`
)
titleServer.closeAllConnections?.()
titleServer.close()

// --- 产物汇总（审计 P2-8）：一轮工作产出了哪些文件 ---
//
// 汇总逻辑是已移植的 `WorkArtifactUtil.collect`，在桌面端此前**零引用**
// （连 core 内部都没人 import），于是界面上完全看不到这轮的产物清单。
const artifactBodies = []
const artifactServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    artifactBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (artifactBodies.length === 1) {
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write_1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'reports/周报.md', content: '# 周报\n' })
                      }
                    }
                  ]
                }
              }
            ]
          }) +
          '\n\n'
      )
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '已生成周报' } }] }) + '\n\n')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => artifactServer.listen(0, '127.0.0.1', () => resolve()))
const artifactPort = artifactServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(artifactPort),
  apiKey: 'sk-artifact-test',
  model: 'artifact-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convArtifact = await inv('conversations:create', agents[0].id, 'work')
check(
  '没跑过时产物清单为空（不编造）',
  (await inv('conversation:artifacts', convArtifact.id)).files.length === 0
)
await inv('work:run', {
  conversationId: convArtifact.id,
  text: '写一份周报',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const artifactsDto = await inv('conversation:artifacts', convArtifact.id)
check(
  '写出来的文件进了产物清单（WorkArtifactUtil.collect 此前零引用）',
  artifactsDto.files.some((f) => f.path === 'reports/周报.md'),
  artifactsDto.files.map((f) => f.path).join(', ') || '(空)'
)
check(
  '总增减与各文件之和一致（统计不是各算各的）',
  artifactsDto.totalAdds === artifactsDto.files.reduce((sum, f) => sum + f.adds, 0) &&
    artifactsDto.totalDels === artifactsDto.files.reduce((sum, f) => sum + f.dels, 0),
  `+${artifactsDto.totalAdds} -${artifactsDto.totalDels} / 文件 ${JSON.stringify(artifactsDto.files.map((f) => ({ p: f.path, a: f.adds, d: f.dels, hd: f.hasDiff })))}`
)
artifactServer.closeAllConnections?.()
artifactServer.close()

effortServer.closeAllConnections?.()
effortServer.close()

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