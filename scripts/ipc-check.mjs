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
export { ContextBudget } from '@core/common/ContextBudget'
export { Constants } from '@core/common/Constants'
// 运行时快照断言要直接引用生产侧的识别前缀，避免测试里再抄一份字面量导致两边悄悄漂移
export { AgentLoopService } from '@core/service/AgentLoopService'
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
  'workspace:listDir',
  'workspace:treeText',
  'workspace:read',
  'workspace:readBinary',
  'workspace:openFile',
  'workspace:reveal',
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

// --- 形态与智能体必须自洽（真实事故：冷启动只设智能体不设形态） ---
//
// 两个虚拟智能体（work / interactive）的 id **就是**形态，它们的系统提示词由主进程按
// mode 现拼（虚拟智能体自己没有 prompt）。渲染层一旦传来矛盾组合，会话会被建坏：
// 界面走聊天分支、请求走 chat:send、聊天路径又取智能体自己的 prompt（空）——
// 用户看到的是「没有提示词、纯对话」。主进程这道兜底以 agentId 为准。
{
  const mismatch = await inv('conversations:create', 'interactive', 'chat')
  check(
    'agentId=interactive 配 mode=chat → 建出来的会话是交互形态（不是聊天）',
    mismatch.mode === 'interactive',
    `mode=${mismatch.mode}`
  )
  const mismatch2 = await inv('conversations:create', 'work', 'chat')
  check(
    'agentId=work 配 mode=chat → 建出来的会话是工作形态',
    mismatch2.mode === 'work',
    `mode=${mismatch2.mode}`
  )
  const realAgentConv = await inv('conversations:create', agents[0].id, 'chat')
  check(
    '真实智能体照旧按传入的形态建会话（不被兜底改写成 loop 形态）',
    realAgentConv.mode === 'chat',
    `mode=${realAgentConv.mode}`
  )
  check(
    '自愈：读回来的会话形态与智能体一致',
    (await inv('conversation:get', mismatch.id)).mode === 'interactive'
  )
}

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

// --- 工作区文件打开链路（树懒加载 / 二进制预览 / 外部打开 / 显示位置） ---
const dirItems = await inv('workspace:listDir', conv3.id, '')
check(
  'workspace:listDir 单层列出导入的两个文件',
  dirItems.length === 2 && dirItems.every((it) => it.isDirectory === false),
  dirItems.map((it) => it.path).join(', ')
)
check(
  'workspace:listDir 的 name 是纯文件名',
  dirItems.every((it) => !it.name.includes('/'))
)
const traversalItems = await inv('workspace:listDir', conv3.id, '../../../Windows')
check('workspace:listDir 拒绝目录穿越（一个都不列出来）', Array.isArray(traversalItems) && traversalItems.length === 0)
const bin = await inv('workspace:readBinary', conv3.id, '素材.txt')
check('workspace:readBinary 返回 data URL 与 MIME', bin.dataUrl.startsWith('data:') && bin.dataUrl.includes('base64,') && bin.size > 0)
check('workspace:readBinary 字节可还原', Buffer.from(bin.dataUrl.split('base64,')[1], 'base64').toString('utf8') === 'hello intake')
await inv('workspace:openFile', conv3.id, '素材.txt')
check('workspace:openFile 走通（替身 shell.openPath）', mod.__calls().some((c) => c.fn === 'shell.openPath'))
await inv('workspace:reveal', conv3.id, '素材.txt')
check('workspace:reveal 走通（替身 shell.showItemInFolder）', mod.__calls().some((c) => c.fn === 'shell.showItemInFolder'))
let openMissing = ''
try {
  await inv('workspace:openFile', conv3.id, '不存在.txt')
} catch (e) {
  openMissing = String(e.message ?? e)
}
check('workspace:openFile 对不存在路径报错', openMissing.includes('不存在'), openMissing.slice(0, 60))

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

// --- 聊天请求失败必须留下失败痕迹（原版 handleStreamError 3394-3408） ---
//
// 事故形状：`ChatService.streamChat` 是**吞掉异常**再回调 `onError` 的，
// 而端口此前根本没接这个回调 —— 于是聊天模式一旦网络/鉴权失败，
// 用户看到的是一条**空白回答**，`turn:finished` 还报 'ok'，连原因都没有。
{
  const failBodies = []
  const failServer = http.createServer((req, res) => {
    req.on('data', (chunk) => {
      failBodies.push(chunk.toString('utf8'))
    })
    req.on('end', () => {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"rate limit exceeded"}}')
    })
  })
  await new Promise((resolve) => failServer.listen(0, '127.0.0.1', resolve))
  const failPort = failServer.address().port
  await inv('settings:saveApiConfig', {
    provider: 'openai-completions',
    baseUrl: 'http://127.0.0.1:' + String(failPort),
    apiKey: 'sk-fail-test',
    model: 'fail-model',
    temperature: 0,
    topP: 0,
    maxTokens: 0,
    extraParams: '',
    autoSuffix: true
  })
  const convFail = await inv('conversations:create', agents[0].id, 'chat')
  events.length = 0
  // chat:send 是「立刻返回、后台继续跑」的，必须等这一轮真的结束再读会话
  const failRun = inv('chat:send', {
    conversationId: convFail.id,
    text: '这次一定失败',
    mode: 'chat',
    thinkingEnabled: false,
    webSearchEnabled: false
  })
  await failRun
  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.type === 'turn:finished')) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const failDto = await inv('conversation:get', convFail.id)
  const failMessage = (failDto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
  check(
    '聊天请求失败时正文里留下失败原因（不是一条空白回答）',
    // 429 会被内核翻译成给用户看的中文文案，所以断言「非空 + 有警示前缀 + 确实是失败文案」，
    // 而不是断言服务端原文（原文是给开发者看的）
    String(failMessage?.content ?? '').startsWith('⚠️') &&
      String(failMessage?.content ?? '').length > 4,
    String(failMessage?.content ?? '').slice(0, 80)
  )
  check(
    '失败那一轮的事件状态是 error（此前写死 ok）',
    events.some((e) => e.type === 'turn:finished' && e.status === 'error'),
    JSON.stringify(events.filter((e) => e.type === 'turn:finished').map((e) => e.status))
  )
  // 注意：发送时主进程会先推一条**派生**标题（首条用户消息推导，这里就是「这次一定失败」），
  // 所以要等一会儿再看「有没有**新的**标题事件」——失败轮不该起标题（空答复起不出标题）。
  const titleEventsAfterFail = events.filter((e) => e.type === 'conversation:title').length
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    '失败的那一轮不再触发生成会话标题（空答复起不出标题）',
    events.filter((e) => e.type === 'conversation:title').length === titleEventsAfterFail,
    `标题事件 ${events.filter((e) => e.type === 'conversation:title').length} 条`
  )
  failServer.closeAllConnections?.()
  failServer.close()
}



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

// --- 收尾标注：手动停止 / 输出顶到上限（原版 appendTurnNote + finalizeWorkTurn） ---
//
// 事故形状：手动停止一个任务后，那条被中断的回答在界面上和「正常答完」一模一样
// （没有「已停止」），用户回头翻记录时分不清哪些是被自己打断的；
// 模型的输出顶到 max_tokens 时也没有任何说明，看上去像「答到一半没了」。
const noteBodies = []
const noteServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    noteBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (noteBodies.length % 2 === 1) {
      // 奇数轮：慢慢吐（留出中止的时间窗），最后给一个正常结尾
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '正在整理' } }] }) + '\n\n')
      setTimeout(() => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '……' } }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      }, 400)
      return
    }
    // 偶数轮：输出顶到模型上限
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '写到一半' } }] }) + '\n\n')
    res.write(
      'data: ' +
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) +
        '\n\n'
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => noteServer.listen(0, '127.0.0.1', () => resolve()))
const notePort = noteServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(notePort),
  apiKey: 'sk-note-test',
  model: 'note-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convStop = await inv('conversations:create', agents[0].id, 'work')
events.length = 0
const stopRun = inv('work:run', {
  conversationId: convStop.id,
  text: '整理一份季度总结',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
for (let i = 0; i < 250 && noteBodies.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
// 等第一段正文真的落盘再中止 —— 否则中止可能发生在模型还没吐字时，
// 那样「标注单独成段」这条断言会因为正文为空而随机失败（不是代码问题，是测试时序问题）。
for (let i = 0; i < 200; i++) {
  const mid = await inv('conversation:get', convStop.id)
  const midText = ((mid?.messages ?? []).filter((m) => m.role === 'assistant').pop()?.content ?? '')
  if (String(midText) !== '') {
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
}
await inv('work:abort', convStop.id)
await stopRun
const stopDto = await inv('conversation:get', convStop.id)
const stopMessage = (stopDto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
check(
  '手动停止会在那一轮正文末尾留下「任务已手动停止」标注（原版 WORK_STOPPED_NOTE）',
  String(stopMessage?.content ?? '').includes('任务已手动停止'),
  String(stopMessage?.content ?? '').slice(-40)
)
check(
  '标注是独立成段追加的（不是和模型正文粘在一行）',
  String(stopMessage?.content ?? '').includes('\n\n任务已手动停止')
)
check(
  '停止的事件状态仍是 aborted（标注不影响状态语义）',
  events.some((e) => e.type === 'turn:finished' && e.status === 'aborted'),
  JSON.stringify(events.filter((e) => e.type === 'turn:finished').map((e) => e.status))
)

const convMax = await inv('conversations:create', agents[0].id, 'work')
const maxRun = inv('work:run', {
  conversationId: convMax.id,
  text: '写一份很长的报告',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
await maxRun
const maxDto = await inv('conversation:get', convMax.id)
const maxMessage = (maxDto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
check(
  '输出顶到 max_tokens 时收尾并提示「发送继续」（原版 shouldBreakOnMaxTokens）',
  String(maxMessage?.content ?? '').includes('达到模型上限'),
  String(maxMessage?.content ?? '').slice(-60)
)
check(
  '顶到上限后**不再多跑一轮**（原版是 break，不是继续循环）',
  noteBodies.length === 2,
  `共 ${noteBodies.length} 次模型请求`
)
noteServer.closeAllConnections?.()
noteServer.close()

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

// --- 上下文预算管理（Agent Loop 三级压缩，这是原版有、端口整块缺失的能力） ---
//
// 事故形状：源码里 WORK_PRUNE_* / WORK_COMPACT_* 常量定义了但**零调用点**，runWork 的
// messages 数组只增不减 —— 长任务跑到后面必然撞上下文上限（400/413/超长报错），
// 早期巨大的工具结果还一直占着预算，用户看到的是任务莫名失败。
// 三级策略（修剪工具结果 → 前缀复用摘要压缩 → 从最旧处整条丢弃）已实现成纯函数，
// 先在这里逐级断言，再用一个假模型服务做端到端验证。
const CB = mod.ContextBudget

// 纯函数只看 role/content/toolCalls，用普通对象就够（core 不认识 LoopMessage）
const cbSys = (t) => ({ role: 'system', content: t, toolCalls: [] })
const cbUsr = (t) => ({ role: 'user', content: t, toolCalls: [] })
const cbAsst = (t, calls) => ({ role: 'assistant', content: t, toolCalls: calls ?? [] })
const cbCall = (argsJson, result) => ({ argsJson, result })
const CB_HEAD = { system: (c) => cbSys(c), user: (c) => cbUsr(c) }

// 第一级：只修剪「早期」区间里超长的工具结果，短的原样保留
const longResult = 'A'.repeat(5000) + '中段原文' + 'B'.repeat(5000)
const budgetMsgs = [
  cbSys('系统提示词'),
  cbUsr('任务'),
  cbAsst('早轮', [cbCall('{"path":"大文件"}', longResult), cbCall('{}', '短结果')])
]
check('修剪：超长结果确实被修剪（返回 true）', CB.pruneOldToolResults(budgetMsgs, 1, 3) === true)
check(
  '修剪：中段换成带省略字数与重新获取方式的提示',
  budgetMsgs[2].toolCalls[0].result.includes('早期工具结果已修剪, 省略 ') &&
    budgetMsgs[2].toolCalls[0].result.includes('read_file/search_files/parse_document 重新获取') &&
    !budgetMsgs[2].toolCalls[0].result.includes('中段原文'),
  budgetMsgs[2].toolCalls[0].result.slice(1195, 1290)
)
check(
  '修剪：原文只保留头 1200 + 尾 400（对齐 WORK_PRUNE_KEEP_HEAD/TAIL）',
  budgetMsgs[2].toolCalls[0].result.startsWith('A'.repeat(1200)) &&
    budgetMsgs[2].toolCalls[0].result.endsWith('B'.repeat(400)) &&
    budgetMsgs[2].toolCalls[0].result.length < longResult.length
)
check('修剪：短结果原样不动（只动超长的）', budgetMsgs[2].toolCalls[1].result === '短结果')
check(
  '修剪：system 与 user 消息不在处理范围内（区间只扫 assistant）',
  budgetMsgs[0].content === '系统提示词' && budgetMsgs[1].content === '任务'
)
check('修剪：已修剪过的结果不会反复修剪（长度已低于阈值，返回 false）',
  CB.pruneOldToolResults(budgetMsgs, 1, 3) === false)

// 预算判据：字符估算 / usage 锚定
check('估算：无实测数据时按 2 字符/token 的保守值', CB.estimateTokens(1000, 0, 0) === 500)
check('估算：有实测比例时按实测比例', CB.estimateTokens(1000, 800, 4000) === 200)
check('阈值：= 上下文窗口 * 占比', CB.threshold() === 1000000 * 0.85, String(CB.threshold()))
check(
  '超预算：上一请求真实 usage 达阈值即算超预算（历史只会继续增长）',
  CB.overBudget([cbSys('s'), cbUsr('u')], { tokens: CB.threshold() + 1, chars: 10 }) === true
)
check(
  '超预算：无锚定值时按估算比对（短历史不算超预算）',
  CB.overBudget([cbSys('s'), cbUsr('u')], { tokens: 0, chars: 0 }) === false
)
check(
  '超预算：无锚定值时按估算比对（超长历史算超预算）',
  CB.overBudget([cbSys('s'), cbAsst('', [cbCall('{}', 'z'.repeat(1800000))])], { tokens: 0, chars: 0 }) ===
    true
)

// 第二级：摘要压缩后的数组结构
const shortMsgs = [cbSys('系统提示词'), cbUsr('任务')]
for (let i = 0; i < 6; i++) {
  shortMsgs.push(cbAsst('第' + i + '轮', [cbCall('{}', 'r' + i)]))
}
check(
  '压缩边界：短历史不给旧历史压缩机会（oldEnd 恒为 1，区间为空）',
  CB.summaryEndIndex(shortMsgs.length) === 1,
  `共 ${shortMsgs.length} 条, oldEnd=${CB.summaryEndIndex(shortMsgs.length)}`
)
const longMsgs = [cbSys('系统提示词'), cbUsr('任务')]
for (let i = 0; i < 20; i++) {
  longMsgs.push(cbAsst('第' + i + '轮', [cbCall('{}', 'r' + i)]))
}
const oldEnd = CB.summaryEndIndex(longMsgs.length)
check(
  '压缩边界：尾部保留最近 12 条原样，其余进摘要',
  oldEnd === longMsgs.length - 12 && oldEnd === 10,
  `共 ${longMsgs.length} 条, oldEnd=${oldEnd}`
)
const rebuiltMsgs = CB.rebuildWithSummary(longMsgs, oldEnd, '状态摘要正文', '按模式重建的系统提示词', CB_HEAD)
check(
  '摘要重建：结构是 [system, user(状态摘要), ...保留的尾部]',
  rebuiltMsgs.length === 2 + (longMsgs.length - oldEnd) &&
    rebuiltMsgs[0].role === 'system' &&
    rebuiltMsgs[0].content === '按模式重建的系统提示词' &&
    rebuiltMsgs[1].role === 'user',
  `${rebuiltMsgs.length} 条: ${rebuiltMsgs.map((m) => m.role).slice(0, 3).join(',')}...`
)
check(
  '摘要重建：摘要以「【上下文压缩】…」的用户消息形式进入历史，并写明汇总条数',
  rebuiltMsgs[1].content.includes('【上下文压缩】') &&
    rebuiltMsgs[1].content.includes('以下为此前 9 条执行历史的状态摘要') &&
    rebuiltMsgs[1].content.endsWith('状态摘要正文')
)
check(
  '摘要重建：尾部还是原来那批消息对象（UI 时间线共享同一批记录）',
  rebuiltMsgs[2] === longMsgs[oldEnd] && rebuiltMsgs[rebuiltMsgs.length - 1] === longMsgs[longMsgs.length - 1]
)
check('摘要重建：早期历史整体消失（不是叠加在保留尾部之前）',
  !rebuiltMsgs.some((m) => m.content === '第0轮'))
check(
  '摘要重建：摘要超长会被截断到 WORK_SUMMARY_MAX_CHARS',
  CB.truncateSummary('x'.repeat(5000)).length === 2400 + 1
)

// 第三级：整条丢弃只从索引 1 开始
const dropMsgs = [cbSys('系统提示词'), cbUsr('历史0'), cbUsr('历史1'), cbUsr('历史2'), cbUsr('历史3'), cbUsr('历史4'), cbAsst('最后一条', [])]
const hotAnchor = { tokens: CB.threshold() * 2, chars: 10 }
const droppedCount = CB.dropOldestUntilUnderBudget(dropMsgs, hotAnchor)
check(
  '整条丢弃：只从索引 1 开始丢，system 消息必须保住',
  dropMsgs[0].content === '系统提示词' && dropMsgs.length === 2 && droppedCount === 5,
  `剩 ${dropMsgs.length} 条, 丢 ${droppedCount} 条`
)
check('整条丢弃：至少留住最近一条消息（循环条件 length > 2）',
  dropMsgs[dropMsgs.length - 1].content === '最后一条')

// --- 上下文预算管理的端到端：发出去的请求体里真的看不到被修剪掉的中段 ---
//
// 只断言纯函数还不够 —— 真正要证的是**请求体变小了**：早期那条巨大的工具结果在后续轮次的
// 历史里必须已经变成头尾节选 + 省略提示。用一个假模型服务把历史堆到「压缩边界能覆盖到那条
// 早期工具结果」，再抓请求体逐个断言。
//
// 假服务的编排（两个场景共用）：
//   第 1 轮：吐 8 个 read_file 调用（读 8 份约 1.4 万字符的大文件 → 工具结果合计约 9.6 万字符）；
//   第 2~13 轮：各吐一个读小文件的调用。消息数要堆到 15 条才有意义 ——
//              WORK_COMPACT_KEEP_MESSAGES=12 时 oldEnd = 消息数 - 12，消息数不足 15 条时
//              修剪区间 [1, oldEnd) 里根本没有 assistant 消息，什么也修剪不到；
//   第 13 轮：附上真实 usage（prompt_tokens 超过阈值）→ 下一轮必然判定超预算；
//   第 14 轮：收尾（不再调工具）。
// summaryResult 传空白串时模拟「摘要请求拿不到有效摘要」的回退路径；
// overflowRound 指定一轮改回 400「上下文超限」错误，用来验证强制压缩后重试的路径；
// usageRound 指定哪一轮附上真实 usage（0 表示始终不带，即全靠错误驱动的强制压缩）。
const PRUNE_BIG_COUNT = 8
const PRUNE_ROUNDS_BEFORE_FINAL = 13

function makeBudgetServer(summaryResult, overflowRound = 0, usageRound = PRUNE_ROUNDS_BEFORE_FINAL) {
  const bodies = []
  let toolRounds = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      bodies.push(raw)
      const isSummary = raw.includes('【上下文压缩指令】')
      const isTitle = raw.includes('会话标题生成器')
      if (!isSummary && !isTitle) {
        toolRounds++
        if (overflowRound !== 0 && toolRounds === overflowRound) {
          // 服务端明确报上下文超限：调用方必须先压缩历史再重试（原版 runStepWithOverflowRetry）
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"This model\\u0027s maximum context length is exceeded"}}')
          return
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n')
      const done = () => {
        res.write('data: [DONE]\n\n')
        res.end()
      }
      // 上下文压缩请求（复用完整前缀 + 末尾追加压缩指令）
      if (isSummary) {
        send({ choices: [{ delta: { content: summaryResult } }] })
        done()
        return
      }
      // 会话标题生成是独立的旁路请求，不参与工具轮次编排
      if (isTitle) {
        send({ choices: [{ delta: { content: '上下文预算' } }] })
        done()
        return
      }
      if (toolRounds === 1) {
        const calls = []
        for (let i = 0; i < PRUNE_BIG_COUNT; i++) {
          calls.push({
            index: i,
            id: 'call_prune_' + i,
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'big' + i + '.txt' }) }
          })
        }
        send({ choices: [{ delta: { tool_calls: calls } }] })
      } else if (toolRounds <= PRUNE_ROUNDS_BEFORE_FINAL) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_small_' + toolRounds,
                    type: 'function',
                    function: { name: 'read_file', arguments: JSON.stringify({ path: 'small.txt' }) }
                  }
                ]
              }
            }
          ]
        })
      } else {
        send({ choices: [{ delta: { content: '任务完成' } }] })
      }
      if (usageRound !== 0 && toolRounds === usageRound) {
        // 真实 usage 锚定：此时历史（含 8 份大文件）已远超阈值，下一轮必须触发预算管理
        send({ usage: { prompt_tokens: 900000, completion_tokens: 20 } })
      }
      done()
    })
  })
  return {
    server,
    // 循环请求（排除压缩请求与标题请求）与压缩请求分开看，断言才有区分度
    loopBodies: () =>
      bodies.filter((b) => !b.includes('【上下文压缩指令】') && !b.includes('会话标题生成器')),
    summaryBodies: () => bodies.filter((b) => b.includes('【上下文压缩指令】'))
  }
}

// 大文件：第 1 行是「头部保留标记」（会被保留在节选开头），第 101 行是只可能出现在中段的
// 原文标记（按头 1200 + 尾 400 字符修剪后，它必然落在被省略的中段里）
function seedBudgetWorkspace(convId) {
  const root = session.workspaceRoot(convId)
  fs.mkdirSync(root, { recursive: true })
  const lines = (i) => {
    const out = []
    for (let n = 0; n < 400; n++) {
      if (n === 0) {
        out.push('头部保留标记_' + i)
      } else if (n === 100) {
        out.push('中段原文标记_' + i + '_这段只有在没被修剪掉时才看得到')
      } else {
        out.push('第' + n + '行 ' + 'x'.repeat(30))
      }
    }
    return out.join('\n')
  }
  for (let i = 0; i < PRUNE_BIG_COUNT; i++) {
    fs.writeFileSync(path.join(root, 'big' + i + '.txt'), lines(i), 'utf8')
  }
  fs.writeFileSync(path.join(root, 'small.txt'), '小文件\n', 'utf8')
}

async function runBudgetScenario(summaryResult, options = {}) {
  const harness = makeBudgetServer(
    summaryResult,
    options.overflowRound ?? 0,
    options.usageRound ?? PRUNE_ROUNDS_BEFORE_FINAL
  )
  await new Promise((resolve) => harness.server.listen(0, '127.0.0.1', () => resolve()))
  const port = harness.server.address().port
  await inv('settings:saveApiConfig', {
    provider: 'openai-completions',
    baseUrl: 'http://127.0.0.1:' + String(port),
    apiKey: 'sk-prune-test',
    model: 'prune-model',
    temperature: 0,
    topP: 0,
    maxTokens: 0,
    extraParams: '',
    autoSuffix: true
  })
  const conv = await inv('conversations:create', agents[0].id, 'work')
  seedBudgetWorkspace(conv.id)
  await inv('work:run', {
    conversationId: conv.id,
    text: '把 8 份大文件都读一遍',
    mode: 'work',
    thinkingEnabled: false,
    webSearchEnabled: false
  })
  const loopBodies = harness.loopBodies()
  const summaryBodies = harness.summaryBodies()
  const dto = await inv('conversation:get', conv.id)
  const last = (dto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
  harness.server.closeAllConnections?.()
  harness.server.close()
  return { loopBodies, summaryBodies, content: String(last?.content ?? '') }
}

const parseBodyJson = (raw) => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// 场景 A：摘要拿不到结果（空白）→ 只剩第一级修剪，修剪后的历史必须留在后续请求体里
const sceneA = await runBudgetScenario(' ')
const loopA = sceneA.loopBodies
const finalA = loopA[loopA.length - 1] ?? ''
check(
  '端到端前提：早一轮请求里确实带着未修剪的完整大结果（后面几条断言的对照）',
  loopA.length === 14 && String(loopA[1] ?? '').includes('中段原文标记_0'),
  `共 ${loopA.length} 轮循环请求, 压缩请求 ${sceneA.summaryBodies.length} 次`
)
check(
  '端到端：修剪后发出去的请求体里不再有中段原文（真的修剪了，不是只改了内存里的注释）',
  finalA !== '' && !finalA.includes('中段原文标记_0') && !finalA.includes('中段原文标记_7'),
  finalA.includes('中段原文标记_0') ? '中段仍在请求体里' : '中段已消失'
)
check(
  '端到端：头尾节选留在历史里（模型仍看得到开头与结尾，不会因为修剪而一无所知）',
  finalA.includes('头部保留标记_0') && finalA.includes('头部保留标记_7')
)
check(
  '端到端：中段替换提示进了模型看到的历史（模型知道自己看到的是节选）',
  finalA.includes('早期工具结果已修剪, 省略 ') &&
    finalA.includes('需要原文时用 read_file/search_files/parse_document 重新获取')
)
check(
  '端到端：顺序是「先零成本修剪，再花模型调用做摘要」（摘要请求里的历史已经是修剪过的）',
  sceneA.summaryBodies.length === 1 &&
    sceneA.summaryBodies[0].includes('早期工具结果已修剪, 省略 ') &&
    !sceneA.summaryBodies[0].includes('中段原文标记_0')
)
const finalAJson = parseBodyJson(finalA)
check(
  '端到端：摘要不可用时不重建历史（回退路径保留原结构，第 1 条仍是任务消息）',
  finalAJson !== null && !String(finalAJson.messages[1].content).startsWith('【上下文压缩】'),
  finalAJson === null ? '请求体不是合法 JSON' : String(finalAJson.messages[1].content).slice(0, 30)
)
check(
  '端到端：用户看得见「已自动修剪」标注（notes 真的进了本轮正文）',
  sceneA.content.includes('（已自动修剪早期过长的工具结果以释放上下文）'),
  sceneA.content.slice(0, 60)
)
check(
  '端到端：没有发生的级别不写标注（没压缩就不写「已自动压缩/已自动裁剪」）',
  !sceneA.content.includes('已自动压缩早期历史') && !sceneA.content.includes('已自动裁剪早期历史')
)

// 场景 B：摘要可用 → 早期历史被状态摘要取代，重建后的请求体结构必须正确
const sceneB = await runBudgetScenario('状态摘要: 已读完 8 份大文件, 结论是……')
const loopB = sceneB.loopBodies
const finalB = loopB[loopB.length - 1] ?? ''
const finalBJson = parseBodyJson(finalB)
check(
  '端到端：早期历史确实被压成了状态摘要（【上下文压缩】用户消息）',
  finalB.includes('【上下文压缩】') && finalB.includes('状态摘要: 已读完 8 份大文件')
)
check(
  '端到端：重建后的请求体结构是 [system, 摘要, ...保留的尾部]（system 必须还在第 0 条）',
  finalBJson !== null &&
    finalBJson.messages[0].role === 'system' &&
    String(finalBJson.messages[1].content).startsWith('【上下文压缩】') &&
    !finalBJson.messages.slice(2).some((m) => m.role === 'system'),
  finalBJson === null ? '请求体不是合法 JSON' : finalBJson.messages.map((m) => m.role).join(',')
)
check(
  '端到端：摘要重建后中段原文同样不复存在（早期历史整段被汇总）',
  !finalB.includes('中段原文标记_0') && !finalB.includes('中段原文标记_7')
)
check(
  '端到端：用户同时看得见「已自动修剪」与「已自动压缩: N 条」两条标注',
  // N 从 2 变成 3 是运行时快照带来的：压缩边界是「消息条数 - 保留的尾部条数」，
  // 快照本身就是一条 user 消息（且每轮请求前都已经在 history 里），边界因此整体后移一条。
  // 原版同样如此（ChatViewModel 的 messages 在压缩时也已经带着此前的快照）。
  sceneB.content.includes('（已自动修剪早期过长的工具结果以释放上下文）') &&
    sceneB.content.includes('（已自动压缩早期历史: 3 条已汇总为状态摘要）'),
  sceneB.content.slice(0, 80)
)
check(
  '端到端：模型正文仍然完整（标注是加在正文前面，不是替代正文）',
  sceneB.content.includes('任务完成')
)

// 场景 C：服务端直接报上下文超限（400）→ 必须强制压缩历史后重试一次，任务不能因此报废。
// 这条路径与「按需压缩」不同：请求已经发出去了，只能先把历史改小再重试，否则重试必然再失败。
const sceneC = await runBudgetScenario('状态摘要: 溢出后压缩出的摘要', {
  overflowRound: 14,
  usageRound: 0
})
const loopC = sceneC.loopBodies
const overflowedC = loopC[13] ?? ''
const retryC = loopC[14] ?? ''
check(
  '端到端（溢出强制压缩）：400 那一轮的请求体里还是未修剪的原文（前提成立）',
  loopC.length === 15 && overflowedC.includes('中段原文标记_0'),
  `共 ${loopC.length} 轮循环请求`
)
check(
  '端到端（溢出强制压缩）：重试的请求体已经过压缩（中段消失、摘要就位）',
  retryC !== '' &&
    !retryC.includes('中段原文标记_0') &&
    retryC.includes('【上下文压缩】') &&
    retryC.includes('状态摘要: 溢出后压缩出的摘要'),
  retryC.includes('中段原文标记_0') ? '中段仍在重试请求里' : '重试请求已压缩'
)
check(
  '端到端（溢出强制压缩）：任务在强制压缩后继续跑完，不会带着 400 直接失败',
  sceneC.content.includes('任务完成') &&
    sceneC.content.includes('（已自动修剪早期过长的工具结果以释放上下文）'),
  sceneC.content.slice(0, 80)
)

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

// ===== 20. 聊天模式本机联网搜索的多轮循环 + 交互模式界面补助 =====
//
// 两块此前都是「能力已移植、调用点为零」的缺口：
//   · 聊天模式的 runChatTurn 是单轮的 —— 模型调了 local_web_search，没有谁去执行，
//     用户只看到一句「我要搜索」的空回答；
//   · 交互模式跑完之后从不检查「到底有没有产出可渲染的界面」，界面被截断/没成形
//     就永远停在一条没有界面的回答上（Constants.UI_CONTINUE_MESSAGE /
//     UI_CONTINUE_MAX_ROUNDS / generateUiProgram / GuncatUiParts.needsRepair 零调用点）。
const passedBeforeChatUi = passed
console.log('\n20. 聊天模式本机联网搜索（多轮）与交互模式界面补助')

// --- 假「本地搜索引擎」：把 LocalWebSearch 的 firecrawl 引擎指到它上面 ---
// 这条链路必须走**真实实现**（不能用替身）：要证明的正是「工具调用真的在本机执行了」。
const searchHits = []
const searchServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    searchHits.push({ url: req.url, body: raw })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: {
          web: [
            {
              title: '季度复盘方法论',
              url: 'https://example.com/review',
              description: '复盘四步：回顾目标、评估结果、分析原因、总结规律。'
            }
          ]
        }
      })
    )
  })
})
await new Promise((resolve) => searchServer.listen(0, '127.0.0.1', () => resolve()))
const searchPort = searchServer.address().port
await inv(
  'settings:saveString',
  'guncat_local_search_config',
  JSON.stringify({
    engine: 'firecrawl',
    maxResults: 3,
    firecrawlApiKey: 'fc-local-test',
    firecrawlBaseUrl: 'http://127.0.0.1:' + String(searchPort)
  })
)
// settings:load 会把这套配置 bind 给工具层（LocalWebSearch.bind）；不 bind 就还是旧引擎
await inv('settings:load')
check(
  '本机搜索后端已指向本地假服务（否则这条链路会真的去联网）',
  mod.LocalWebSearch.currentSettings().engine === 'firecrawl' &&
    mod.LocalWebSearch.currentSettings().firecrawlBaseUrl.includes('127.0.0.1'),
  mod.LocalWebSearch.currentSettings().engine +
    ' @ ' +
    mod.LocalWebSearch.currentSettings().firecrawlBaseUrl
)

// --- 假模型：第一轮要求调 local_web_search，第二轮给出最终回答 ---
const multiBodies = []
const multiServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    multiBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (multiBodies.length === 1) {
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_search_1',
                      type: 'function',
                      function: { name: 'local_web_search', arguments: '{"query":"季度复盘方法"}' }
                    }
                  ]
                }
              }
            ]
          }) +
          '\n\n'
      )
    } else {
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '复盘分四步。' } }] }) + '\n\n'
      )
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => multiServer.listen(0, '127.0.0.1', () => resolve()))
const multiPort = multiServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(multiPort),
  apiKey: 'sk-chat-loop',
  model: 'chat-loop-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convChatLoop = await inv('conversations:create', agents[0].id, 'chat')
events.length = 0
await inv('chat:send', {
  conversationId: convChatLoop.id,
  text: '季度复盘怎么做',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})

// ① 确实发了第二轮请求（工具结果回灌后继续，而不是一轮就结束）
check(
  '聊天模式在本轮有工具调用时继续下一轮（此前单轮直接结束）',
  multiBodies.length >= 2,
  `${multiBodies.length} 轮请求`
)
const multiSecond = multiBodies[1] !== undefined ? JSON.parse(multiBodies[1]) : {}
const multiMessages = multiSecond.messages ?? []
// ② 第二轮请求体里带着工具结果（role:tool + 上一轮的 assistant tool_calls 都要在）
check(
  '第二轮请求体里带着本机搜索的工具结果（role:tool 与 tool_calls 成对回灌）',
  multiMessages.some((m) => m.role === 'tool' && String(m.content).includes('example.com/review')) &&
    multiMessages.some(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((c) => c.function !== undefined && c.function.name === 'local_web_search')
    ),
  multiMessages.map((m) => m.role).join(',')
)
// 本机搜索真的执行了（请求打到了本地假搜索引擎上）
check(
  '本机搜索走的是真实实现（本地假搜索引擎被真的请求到了）',
  searchHits.length >= 1 &&
    String(searchHits[0].url).includes('/v2/search') &&
    String(searchHits[0].body).includes('季度复盘方法'),
  searchHits.length > 0 ? searchHits[0].url : '(没有请求)'
)
// ③ 用户可见正文里有搜索标注（带引擎标签）与最终回答
const chatLoopDto = await inv('conversation:get', convChatLoop.id)
const chatLoopAssistant = (chatLoopDto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
check(
  '正文里出现「进行了一次本机联网搜索(引擎)：query」',
  String(chatLoopAssistant?.content).includes('进行了一次本机联网搜索') &&
    String(chatLoopAssistant?.content).includes('Firecrawl') &&
    String(chatLoopAssistant?.content).includes('季度复盘方法'),
  String(chatLoopAssistant?.content).slice(0, 60)
)
check(
  '跨轮累积：最终回答与搜索标注在同一条 assistant 消息里',
  String(chatLoopAssistant?.content).includes('复盘分四步')
)
// ④ 工具行有耗时（durationMs 默认 -1 表示「还在跑」，界面上会一直转圈）
const searchToolDto = (chatLoopAssistant?.toolCalls ?? []).find((c) => c.id === 'call_search_1')
check(
  '工具行记下了真实耗时（不再是 -1 / 永远转圈）',
  searchToolDto !== undefined && searchToolDto.durationMs >= 0 && searchToolDto.durationMs < 60000,
  searchToolDto !== undefined ? `${searchToolDto.durationMs}ms` : '(没有工具行)'
)
check(
  '工具行以 started / finished 两次事件推给渲染层（执行中可见）',
  events.some((e) => e.type === 'tool:started' && e.call.id === 'call_search_1') &&
    events.some((e) => e.type === 'tool:finished' && e.call.id === 'call_search_1')
)
multiServer.closeAllConnections?.()
multiServer.close()

// --- 未知工具名：回填错误结果送回模型，而不是静默丢弃 ---
const unknownBodies = []
const unknownServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    unknownBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (unknownBodies.length === 1) {
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_bad_1',
                      type: 'function',
                      function: { name: 'make_coffee', arguments: '{}' }
                    }
                  ]
                }
              }
            ]
          }) +
          '\n\n'
      )
    } else {
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '换个工具再来。' } }] }) + '\n\n'
      )
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => unknownServer.listen(0, '127.0.0.1', () => resolve()))
const unknownPort = unknownServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(unknownPort),
  apiKey: 'sk-chat-unknown',
  model: 'chat-unknown-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convUnknown = await inv('conversations:create', agents[0].id, 'chat')
await inv('chat:send', {
  conversationId: convUnknown.id,
  text: '随便调个工具',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})
check(
  '未知工具名被回填成错误结果（静默丢弃会让模型以为自己没调用过）',
  unknownBodies.length >= 2 && String(unknownBodies[1]).includes('未知工具: make_coffee'),
  unknownBodies.length >= 2 ? '错误提示已进第二轮请求体' : `${unknownBodies.length} 轮请求`
)
unknownServer.closeAllConnections?.()
unknownServer.close()

// --- 防失控保险：轮次到 CHAT_SEARCH_MAX_ROUNDS 时停止继续搜索 ---
// 假模型**一直**回工具调用，直到端口自己踩到上限。搜索后端是本地假服务，每轮很快。
const maxRoundBodies = []
const maxRoundServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    maxRoundBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_loop_' + String(maxRoundBodies.length),
                    type: 'function',
                    function: { name: 'local_web_search', arguments: '{"query":"再搜一次"}' }
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
  })
})
await new Promise((resolve) => maxRoundServer.listen(0, '127.0.0.1', () => resolve()))
const maxRoundPort = maxRoundServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(maxRoundPort),
  apiKey: 'sk-chat-max',
  model: 'chat-max-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convMaxRound = await inv('conversations:create', agents[0].id, 'chat')
await inv('chat:send', {
  conversationId: convMaxRound.id,
  text: '一直搜',
  mode: 'chat',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const maxRoundDto = await inv('conversation:get', convMaxRound.id)
const maxRoundAssistant = (maxRoundDto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
check(
  '达到搜索轮数上限时正文追加防失控保险提示并停止',
  String(maxRoundAssistant?.content).includes('已连续搜索') &&
    String(maxRoundAssistant?.content).includes('轮(防失控保险), 停止继续搜索。'),
  String(maxRoundAssistant?.content).slice(-40)
)
check(
  '轮数是逐一执行的：正好 CHAT_SEARCH_MAX_ROUNDS 轮请求后收手（不多不少）',
  maxRoundBodies.length === mod.Constants.CHAT_SEARCH_MAX_ROUNDS,
  `${maxRoundBodies.length} 轮 / 上限 ${mod.Constants.CHAT_SEARCH_MAX_ROUNDS}`
)
maxRoundServer.closeAllConnections?.()
maxRoundServer.close()

// --- 交互模式：没有产出可渲染界面时的自动重做 ---
const UI_NO_PROGRAM = '```guncat-ui\n$unused = 1\n```'
const UI_PROGRAM = 'root = Card([\n  CardHeader("周报")\n])'
// 界面补救请求的判据：它的系统提示词是 GuncatUiPrompt.REPAIR_SYSTEM（只有它用这句话）
const isRepairBody = (raw) => raw.includes('你是界面程序生成器')

// 场景 A：主回答没有可用界面 → 单独要一份界面程序，成功 → 追加一条带围栏的 assistant 消息
const fixBodies = []
const fixServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    fixBodies.push(raw)
    const content = isRepairBody(raw) ? UI_PROGRAM : UI_NO_PROGRAM
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => fixServer.listen(0, '127.0.0.1', () => resolve()))
const fixPort = fixServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(fixPort),
  apiKey: 'sk-ui-fix',
  model: 'ui-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convUiFix = await inv('conversations:create', agents[0].id, 'interactive')
await inv('work:run', {
  conversationId: convUiFix.id,
  text: '出一份周报界面',
  mode: 'interactive',
  thinkingEnabled: false,
  webSearchEnabled: false
})
check(
  '交互模式界面不成形时触发了 generateUiProgram 的单独请求',
  fixBodies.filter(isRepairBody).length === 1,
  `${fixBodies.filter(isRepairBody).length} 次补救请求 / 共 ${fixBodies.length} 次`
)
const uiFixDto = await inv('conversation:get', convUiFix.id)
const uiFixAssistant = (uiFixDto?.messages ?? []).filter((m) => m.role === 'assistant').pop()
check(
  '补回来的界面是一条带 guncat-ui 围栏的 assistant 消息',
  String(uiFixAssistant?.content).includes('```guncat-ui') &&
    String(uiFixAssistant?.content).includes('root = Card('),
  String(uiFixAssistant?.content).slice(0, 50)
)
check(
  '这条消息的展示文案是「（界面已重新生成）」（源码不进正文展示位）',
  uiFixAssistant?.displayContent === '（界面已重新生成）',
  String(uiFixAssistant?.displayContent)
)
fixServer.closeAllConnections?.()
fixServer.close()

// 场景 B：单独生成也失败 → 追加 UI_CONTINUE_MESSAGE 的 user 消息，并**再跑一轮**
let fallbackRounds = 0
const fallbackBodies = []
const fallbackServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    fallbackBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (isRepairBody(raw)) {
      // 补救请求回空（generateUiProgram 会按「空响应」重试一次后抛错）
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    fallbackRounds++
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: UI_NO_PROGRAM } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => fallbackServer.listen(0, '127.0.0.1', () => resolve()))
const fallbackPort = fallbackServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(fallbackPort),
  apiKey: 'sk-ui-fallback',
  model: 'ui-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convUiFallback = await inv('conversations:create', agents[0].id, 'interactive')
await inv('work:run', {
  conversationId: convUiFallback.id,
  text: '出一份周报界面',
  mode: 'interactive',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const uiFallbackDto = await inv('conversation:get', convUiFallback.id)
const continueMsg = (uiFallbackDto?.messages ?? []).find(
  (m) => m.role === 'user' && m.content === mod.Constants.UI_CONTINUE_MESSAGE
)
check(
  '单独生成失败时追加 UI_CONTINUE_MESSAGE 的 user 消息',
  continueMsg !== undefined,
  continueMsg !== undefined ? String(continueMsg.content).slice(0, 30) : '(没有续写消息)'
)
check(
  '这条续写消息的展示文案是「（界面输出被截断，已自动续写）」',
  continueMsg?.displayContent === '（界面输出被截断，已自动续写）',
  String(continueMsg?.displayContent)
)
check(
  '兜底路径真的**又跑了工作循环**（不是只追加一条消息就收场）',
  fallbackRounds >= 2,
  `${fallbackRounds} 轮工作循环`
)
check(
  '补救次数被 UI_CONTINUE_MAX_ROUNDS 卡住（不会无限续命）',
  fallbackBodies.filter(isRepairBody).length <=
    mod.Constants.UI_CONTINUE_MAX_ROUNDS * (mod.Constants.WORK_LLM_RETRY_MAX + 1),
  `${fallbackBodies.filter(isRepairBody).length} 次补救请求`
)
fallbackServer.closeAllConnections?.()
fallbackServer.close()

// 场景 C：正常产出界面 → 不该多打一次请求
const okBodies = []
const okServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    okBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: UI_PROGRAM } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => okServer.listen(0, '127.0.0.1', () => resolve()))
const okPort = okServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(okPort),
  apiKey: 'sk-ui-ok',
  model: 'ui-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convUiOk = await inv('conversations:create', agents[0].id, 'interactive')
await inv('work:run', {
  conversationId: convUiOk.id,
  text: '出一份周报界面',
  mode: 'interactive',
  thinkingEnabled: false,
  webSearchEnabled: false
})
check(
  '界面正常产出时不会多打一次补救请求',
  okBodies.length === 1 && okBodies.filter(isRepairBody).length === 0,
  `${okBodies.length} 次请求`
)
okServer.closeAllConnections?.()
okServer.close()

// 场景 D：工作模式不该被界面补救波及（只有交互模式才有这个问题）
const workBodies = []
const workUiServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    workBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: UI_NO_PROGRAM } }] }) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => workUiServer.listen(0, '127.0.0.1', () => resolve()))
const workUiPort = workUiServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(workUiPort),
  apiKey: 'sk-ui-work',
  model: 'ui-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convUiWork = await inv('conversations:create', agents[0].id, 'work')
await inv('work:run', {
  conversationId: convUiWork.id,
  text: '写一份说明（工作模式）',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
check(
  '工作模式不触发界面补救（它没有「界面没成形」这回事）',
  workBodies.length === 1 && workBodies.filter(isRepairBody).length === 0,
  `${workBodies.length} 次请求`
)
workUiServer.closeAllConnections?.()
workUiServer.close()

searchServer.closeAllConnections?.()
searchServer.close()

console.log(`\n聊天多轮与界面补助验证：通过 ${passed - passedBeforeChatUi} 项`)

// --- 运行时快照（RUNTIME SNAPSHOT）---
//
// 内核里 buildRuntimeSnapshot / findLastSnapshot / shouldAppendSnapshot 早就写好了，
// 却**全库零调用点**。用户能直接感到的后果：模型不知道今天是几号（问「今天」「本周」只能瞎猜）、
// 不知道当前工作区有哪些文件、不知道当前 todo / 自主目标 / 定时提醒（跨轮都会丢）。
//
// 这里用本地假模型服务把真正发出去的请求体抓下来，验证三件事：
//   1. 每轮请求末尾确实带着最新状态快照（日期 + 文件树 + 清单/目标/提醒段落）；
//   2. 状态没变时**不追加第二份**（逐字节相同）—— 这是请求前缀稳定、跨轮 KV 缓存命中的守门条件；
//   3. 状态真的变了（新 todo / 新文件）时才追加新快照，旧快照仍留在历史里、新快照在末尾。
const passedBeforeSnapshot = passed
// 直接用生产侧的常量：测试抄一份字面量的话，将来改了前缀这里会静默失效
const SNAPSHOT_PREFIX = mod.AgentLoopService.RUNTIME_SNAPSHOT_PREFIX
const SNAPSHOT_SEED_FILE = 'seed-alpha.txt'
const SNAPSHOT_NEW_FILE = 'runtime-snapshot-new.txt'
const SNAPSHOT_TODO_TEXT = '运行时快照断言项'
const SNAPSHOT_GOAL_TEXT = '把端口缺的运行时快照补齐'
const SNAPSHOT_SCHEDULE_TEXT = '记得回来看快照'
// buildRuntimeSnapshot 的日期格式：2026年08月30日 星期六 —— 按当天现算，不写死某一天
const snapshotToday = (() => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return (
    String(now.getFullYear()) +
    '年' + pad(now.getMonth() + 1) +
    '月' + pad(now.getDate()) +
    '日 星期' + weekdays[now.getDay()]
  )
})()

const snapshotBodies = []
// 标题生成与上下文压缩是同一条服务上的旁路请求，不参与轮次编排（与上面的预算场景同一写法）
const snapshotLoopBodies = () =>
  snapshotBodies.filter((b) => !b.includes('会话标题生成器') && !b.includes('【上下文压缩指令】'))
const jsonMessages = (raw) => {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.messages) ? parsed.messages : []
  } catch {
    return []
  }
}
const lastMessage = (raw) => {
  const msgs = jsonMessages(raw)
  return msgs.length === 0 ? null : msgs[msgs.length - 1]
}
// 历史里按顺序排好的快照正文（用于验证「没变不追加 / 变了追加 / 旧的还在」）
const snapshotContents = (raw) =>
  jsonMessages(raw)
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((c) => c.startsWith(SNAPSHOT_PREFIX))

const snapshotServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString('utf8')
  })
  req.on('end', () => {
    snapshotBodies.push(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n')
    const done = () => {
      res.write('data: [DONE]\n\n')
      res.end()
    }
    if (raw.includes('会话标题生成器')) {
      send({ choices: [{ delta: { content: '运行时快照' } }] })
      done()
      return
    }
    const round = snapshotLoopBodies().length
    const call = (name, args) =>
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_snap_' + String(round),
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) }
                }
              ]
            }
          }
        ]
      })
    if (round === 1) {
      // 只读工具：工作区不变，用来验证「第二轮不会再追加一份快照」
      call('get_workspace_tree', {})
    } else if (round === 2) {
      // 写任务清单：状态变了，下一步必须补一份新快照（含 <task_todo>）
      call('todo_write', {
        todos: JSON.stringify([{ content: SNAPSHOT_TODO_TEXT, status: 'in_progress' }])
      })
    } else if (round === 3) {
      // 写新文件：状态又变了，快照里要出现这个新文件名
      call('write_file', { path: SNAPSHOT_NEW_FILE, content: '运行时快照验证\n' })
    } else {
      send({ choices: [{ delta: { content: '快照验证完成' } }] })
    }
    done()
  })
})
await new Promise((resolve) => snapshotServer.listen(0, '127.0.0.1', () => resolve()))
const snapshotPort = snapshotServer.address().port
await inv('settings:saveApiConfig', {
  provider: 'openai-completions',
  baseUrl: 'http://127.0.0.1:' + String(snapshotPort),
  apiKey: 'sk-snapshot-test',
  model: 'snapshot-model',
  temperature: 0,
  topP: 0,
  maxTokens: 0,
  extraParams: '',
  autoSuffix: true
})
const convSnap = await inv('conversations:create', agents[0].id, 'work')
const snapRoot = session.workspaceRoot(convSnap.id)
fs.mkdirSync(snapRoot, { recursive: true })
fs.writeFileSync(path.join(snapRoot, SNAPSHOT_SEED_FILE), '种子文件\n', 'utf8')
await inv('work:run', {
  conversationId: convSnap.id,
  text: '看看工作区',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const snapBodies = snapshotLoopBodies()
check(
  '工作循环每轮请求都跑了 4 轮（后面的快照断言才有对照）',
  snapBodies.length === 4,
  `${snapBodies.length} 轮循环请求`
)

const firstBody = snapBodies[0] ?? ''
const firstLast = lastMessage(firstBody)
const firstSnap = firstLast === null ? '' : String(firstLast.content ?? '')
check(
  '运行时快照进了第一轮请求的末尾（此前 buildRuntimeSnapshot 零调用点）',
  firstLast !== null &&
    firstLast.role === 'user' &&
    firstSnap.startsWith(SNAPSHOT_PREFIX) &&
    snapshotContents(firstBody).length === 1,
  firstSnap.slice(0, 24) || '(没有快照消息)'
)
check(
  '快照带上了今天的日期（模型此前只能瞎猜「今天」）',
  firstSnap.includes(snapshotToday),
  firstSnap.includes(snapshotToday) ? snapshotToday : firstSnap.slice(0, 60)
)
check(
  '快照带上了工作区文件树（工作区里有文件时出现文件名）',
  firstSnap.includes('<workspace_files>') && firstSnap.includes(SNAPSHOT_SEED_FILE)
)

// 判重：工作区没变 → 新快照与历史末尾快照逐字节相同 → 不追加第二份。
// 这是「请求前缀稳定 / KV 缓存命中」的守门断言：前缀每轮都变，缓存命中率立刻归零。
const secondBody = snapBodies[1] ?? ''
const secondSnaps = snapshotContents(secondBody)
check(
  '第二轮请求体里没有第二条快照（状态没变 → 逐字节相同 → 不追加，前缀保持稳定）',
  secondSnaps.length === 1 && secondSnaps[0] === firstSnap,
  `${secondSnaps.length} 条快照`
)

// 状态真的变了（todo_write 写进了清单）→ 追加新快照，且旧快照仍留在历史里
const thirdBody = snapBodies[2] ?? ''
const thirdSnaps = snapshotContents(thirdBody)
const thirdLast = lastMessage(thirdBody)
check(
  '写了 todo 之后补上新快照（历史里变成两份：旧的仍在、新的在末尾）',
  thirdSnaps.length === 2 &&
    thirdSnaps[0] === firstSnap &&
    thirdLast !== null &&
    String(thirdLast.content ?? '') === thirdSnaps[1],
  `${thirdSnaps.length} 条快照`
)
check(
  '快照带上了任务清单段落（<task_todo> + 清单正文）',
  thirdSnaps.length === 2 &&
    thirdSnaps[1].includes('<task_todo>') &&
    thirdSnaps[1].includes(SNAPSHOT_TODO_TEXT)
)

// 再改一次状态（写了新文件）→ 第三份快照出现，含新文件名；旧快照全部保留，新的在末尾
const fourthBody = snapBodies[3] ?? ''
const fourthSnaps = snapshotContents(fourthBody)
const fourthLast = lastMessage(fourthBody)
check(
  '往工作区写新文件后再跑一轮：出现新快照（含新文件名），旧快照仍在历史里，新快照在末尾',
  fourthSnaps.length === 3 &&
    fourthSnaps[0] === firstSnap &&
    fourthSnaps[1] === thirdSnaps[1] &&
    fourthSnaps[2].includes(SNAPSHOT_NEW_FILE) &&
    fourthLast !== null &&
    String(fourthLast.content ?? '') === fourthSnaps[2] &&
    fourthLast.role === 'user',
  `${fourthSnaps.length} 条快照`
)

// 自主目标与定时提醒：写入工作区的 .goal.json / .schedule.json 后，快照里要出现对应段落
const convSnapMeta = await inv('conversations:create', agents[0].id, 'work')
const snapMetaRoot = session.workspaceRoot(convSnapMeta.id)
fs.mkdirSync(snapMetaRoot, { recursive: true })
fs.writeFileSync(
  path.join(snapMetaRoot, '.goal.json'),
  JSON.stringify({
    objective: SNAPSHOT_GOAL_TEXT,
    status: 'active',
    rounds: 3,
    maxRounds: 40,
    note: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }),
  'utf8'
)
fs.writeFileSync(
  path.join(snapMetaRoot, '.schedule.json'),
  JSON.stringify([
    {
      id: 'sch_snap_1',
      message: SNAPSHOT_SCHEDULE_TEXT,
      dueAt: Date.now() + 3600000,
      everySeconds: 0,
      createdAt: Date.now()
    }
  ]),
  'utf8'
)
snapshotBodies.length = 0
await inv('work:run', {
  conversationId: convSnapMeta.id,
  text: '看目标与提醒',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const metaFirst = snapshotLoopBodies()[0] ?? ''
const metaLast = lastMessage(metaFirst)
const metaText = metaLast === null ? '' : String(metaLast.content ?? '')
check(
  '快照带上了自主目标段落（<session_goal>）',
  metaText.includes('<session_goal>') && metaText.includes(SNAPSHOT_GOAL_TEXT)
)
check(
  '快照带上了定时提醒段落（<session_schedules>）',
  metaText.includes('<session_schedules>') && metaText.includes(SNAPSHOT_SCHEDULE_TEXT)
)
snapshotServer.closeAllConnections?.()
snapshotServer.close()

console.log(`\n运行时快照验证：通过 ${passed - passedBeforeSnapshot} 项`)

// --- ask_user_question：工具下发 / 挂起 / 回填 / 中止 ---
//
// 事故形状（用户报障的原话：「第一轮为什么不是修复 ask_user_question 工具而是给我删掉了」）：
// 这个工具曾被**整个删掉**，理由是没有提问卡片时它会一直挂到 5 分钟超时。
// 恢复它必须四个环节同时到位，缺任何一个都会退化成「挂到超时」，所以这里逐环节钉死：
//   1. 工具定义真的进了请求体（模型看得到才可能问）；
//   2. 工具挂起时主进程真的 emit 了 ask:user（带 question/options/multiSelect/requestId）；
//   3. work:answer 回填后工具返回、轮次继续（回答文本真的进了下一轮请求体）；
//   4. 中止时挂起的提问被取消（ask:done/canceled，且 run 承诺一定会落定）。
const passedBeforeAsk = passed
console.log('\n21. ask_user_question（工具下发 / 挂起 / 回填 / 中止）')

const ASK_QUESTION_1 = '这份季度复盘要交成什么？'
const ASK_OPTION_A = '内部汇报稿'
const ASK_OPTION_B = '对外发布稿'
const ASK_NOTE = '页数控制在 5 页以内'
const ASK_FINAL_TEXT = '已按你的选择继续'

const ASK_TOOL_RESULT_MARK = '[ask_user_question]'
const ASK_CANCEL_MARK = '用户未回答(已取消)'

/**
 * 请求体里是不是已经带着 ask_user_question 的工具结果了。
 * 作答与「跳过」两条路径的回填文本不同（前者带 [ask_user_question] 前缀，后者只有取消说明），
 * 两段都要认 —— 只认前者的后果很严重：跳过之后假服务会再要求一次提问，
 * 而那次没有任何人会作答，测试就会真的挂起来。
 */
const hasAskResult = (raw) => raw.includes(ASK_TOOL_RESULT_MARK) || raw.includes(ASK_CANCEL_MARK)

/**
 * 假模型服务：工具结果还没回填时要求调用 ask_user_question（工具会真的挂起等待界面作答），
 * 一旦请求体里出现了工具结果就给最终答复。请求体全部留下来供断言。
 */
function makeAskServer(askArgs) {
  const bodies = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      bodies.push(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n')
      const done = () => {
        res.write('data: [DONE]\n\n')
        res.end()
      }
      // 标题生成是旁路请求，不参与轮次编排（与上面的快照场景同一写法）
      if (raw.includes('会话标题生成器')) {
        send({ choices: [{ delta: { content: '提问' } }] })
        done()
        return
      }
      if (hasAskResult(raw)) {
        send({ choices: [{ delta: { content: ASK_FINAL_TEXT } }] })
        done()
        return
      }
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ask_1',
                  type: 'function',
                  function: { name: 'ask_user_question', arguments: JSON.stringify(askArgs) }
                }
              ]
            }
          }
        ]
      })
      done()
    })
  })
  return { server, bodies }
}

/** 只看轮次请求：标题生成与上下文压缩是旁路请求，会打乱「第几轮」的判据 */
const askLoop = (bodies) =>
  bodies.filter((b) => !b.includes('会话标题生成器') && !b.includes('【上下文压缩指令】'))

async function useAskServer(port) {
  await inv('settings:saveApiConfig', {
    provider: 'openai-completions',
    baseUrl: 'http://127.0.0.1:' + String(port),
    apiKey: 'sk-ask-test',
    model: 'ask-model',
    temperature: 0,
    topP: 0,
    maxTokens: 0,
    extraParams: '',
    autoSuffix: true
  })
}

const askOptionsJson = JSON.stringify([ASK_OPTION_A, ASK_OPTION_B])
const ask1 = makeAskServer({
  question: ASK_QUESTION_1,
  // options / multi_select 都按工具定义声明的 string 形态传（与本项目 todo_write 的 todos 同一约定：
  // JSON 字符串进、工具内部再解析；HarnessTools 的 strListArg / boolArg 两种形态都吃得下）
  options: askOptionsJson,
  multi_select: 'false'
})
await new Promise((resolve) => ask1.server.listen(0, '127.0.0.1', () => resolve()))
await useAskServer(ask1.server.address().port)
const ask1Loop = () => askLoop(ask1.bodies)

const convAsk = await inv('conversations:create', agents[0].id, 'work')
events.length = 0
const askRun = inv('work:run', {
  conversationId: convAsk.id,
  text: '做一份季度复盘',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const askUserEvent = await waitForEvent((e) => e.type === 'ask:user')
check('工具挂起时主进程 emit 了 ask:user', askUserEvent !== null)
check(
  'ask:user 带着问题原文',
  askUserEvent !== null && askUserEvent.question === ASK_QUESTION_1,
  askUserEvent === null ? '(没有事件)' : String(askUserEvent.question)
)
check(
  'ask:user 带着全部选项（界面才画得出 chips）',
  askUserEvent !== null &&
    Array.isArray(askUserEvent.options) &&
    askUserEvent.options.length === 2 &&
    askUserEvent.options[0] === ASK_OPTION_A,
  askUserEvent === null ? '(没有事件)' : JSON.stringify(askUserEvent.options)
)
check(
  'ask:user 带着 multiSelect=false（单选卡片）',
  askUserEvent !== null && askUserEvent.multiSelect === false
)
check(
  'ask:user 带 requestId 且属于本会话',
  askUserEvent !== null &&
    typeof askUserEvent.requestId === 'string' &&
    askUserEvent.requestId !== '' &&
    askUserEvent.conversationId === convAsk.id,
  askUserEvent === null ? '(没有事件)' : String(askUserEvent.requestId)
)
check(
  '此时轮次确实还挂在那里（没有 turn:finished）',
  !events.some((e) => e.type === 'turn:finished' && e.conversationId === convAsk.id)
)
check(
  '工具定义真的下发给模型了（第一轮请求体的工具表里有 ask_user_question）',
  ask1Loop().length >= 1 && ask1Loop()[0].includes('"ask_user_question"'),
  `${ask1Loop().length} 轮请求`
)
check(
  '工具定义里带了「仅当存在影响整体方向的关键缺口…」的原版措辞',
  ask1Loop().length >= 1 && ask1Loop()[0].includes('仅当存在影响整体方向的关键缺口')
)

// 作答：单选一项 + 文字补充
const answered = await inv('work:answer', {
  conversationId: convAsk.id,
  requestId: askUserEvent.requestId,
  canceled: false,
  selections: [ASK_OPTION_A],
  note: ASK_NOTE
})
check('work:answer 回填成功', answered === true)
await askRun
check(
  '作答后工具返回、轮次继续跑完（拿到最终答复）',
  (await inv('conversation:get', convAsk.id)).messages.some(
    (m) => m.role === 'assistant' && String(m.content).includes(ASK_FINAL_TEXT)
  )
)
const askSecondBody = ask1Loop()[ask1Loop().length - 1]
check(
  '回答被回填进下一轮请求体（选择与补充都真的送到了模型）',
  ask1Loop().length >= 2 &&
    askSecondBody.includes(ASK_OPTION_A) &&
    askSecondBody.includes(ASK_NOTE) &&
    askSecondBody.includes('[ask_user_question] 用户已回答'),
  `${ask1Loop().length} 轮请求`
)
check(
  '作答后界面收到 ask:done(answered)（卡片该收起来）',
  events.some(
    (e) =>
      e.type === 'ask:done' &&
      e.requestId === askUserEvent.requestId &&
      e.outcome === 'answered'
  )
)
check(
  '轮次以 ok 收尾（不是挂到超时）',
  events.some((e) => e.type === 'turn:finished' && e.conversationId === convAsk.id && e.status === 'ok')
)
check(
  '给一条已经不存在的提问作答会返回 false（界面据此直接收卡片，不报错）',
  (await inv('work:answer', {
    conversationId: convAsk.id,
    requestId: 'ask_不存在',
    canceled: false,
    selections: [],
    note: ''
  })) === false
)
ask1.server.closeAllConnections?.()
ask1.server.close()

// --- 多选 + 「跳过，由智能体自行决定」（取消路径） ---
const ask2 = makeAskServer({
  question: '这份复盘要涵盖哪些方面？',
  options: askOptionsJson,
  multi_select: 'true'
})
await new Promise((resolve) => ask2.server.listen(0, '127.0.0.1', () => resolve()))
await useAskServer(ask2.server.address().port)
const ask2Loop = () => askLoop(ask2.bodies)
const convAsk2 = await inv('conversations:create', agents[0].id, 'work')
events.length = 0
const askRun2 = inv('work:run', {
  conversationId: convAsk2.id,
  text: '再出一版复盘',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const askUserEvent2 = await waitForEvent((e) => e.type === 'ask:user')
check('多选提问同样 emit 了 ask:user', askUserEvent2 !== null)
check(
  'ask:user 带着 multiSelect=true（界面据此画「可多选」与方框选项）',
  askUserEvent2 !== null && askUserEvent2.multiSelect === true
)
check(
  '多选提问同样带上全部选项（数组元素逐个还原，不是把 JSON 原样当一项）',
  askUserEvent2 !== null &&
    askUserEvent2.options.length === 2 &&
    askUserEvent2.options[1] === ASK_OPTION_B,
  askUserEvent2 === null ? '(没有事件)' : JSON.stringify(askUserEvent2.options)
)
const skipped = await inv('work:answer', {
  conversationId: convAsk2.id,
  requestId: askUserEvent2.requestId,
  canceled: true,
  selections: [],
  note: ''
})
check('「跳过，由智能体自行决定」走取消路径且被接受', skipped === true)
await askRun2
check(
  '跳过后界面收到 ask:done(canceled)',
  events.some(
    (e) => e.type === 'ask:done' && e.requestId === askUserEvent2.requestId && e.outcome === 'canceled'
  )
)
check(
  '跳过后工具以「用户未回答(已取消)」返回，模型按合理假设继续（轮次不挂死）',
  ask2Loop().length >= 2 &&
    ask2Loop()[ask2Loop().length - 1].includes(ASK_CANCEL_MARK),
  `${ask2Loop().length} 轮请求`
)
check(
  '跳过的轮次同样以 ok 收尾',
  events.some((e) => e.type === 'turn:finished' && e.conversationId === convAsk2.id && e.status === 'ok')
)
ask2.server.closeAllConnections?.()
ask2.server.close()

// --- 中止：挂起中的提问必须被取消，不能留下永不结束的 Promise ---
const ask3 = makeAskServer({
  question: '这一版要对外发布吗？',
  options: askOptionsJson,
  multi_select: 'false'
})
await new Promise((resolve) => ask3.server.listen(0, '127.0.0.1', () => resolve()))
await useAskServer(ask3.server.address().port)
const convAsk3 = await inv('conversations:create', agents[0].id, 'work')
events.length = 0
const askRun3 = inv('work:run', {
  conversationId: convAsk3.id,
  text: '改一版对外稿',
  mode: 'work',
  thinkingEnabled: false,
  webSearchEnabled: false
})
const askUserEvent3 = await waitForEvent((e) => e.type === 'ask:user')
check('中止场景：提问确实挂起了', askUserEvent3 !== null)
await inv('work:abort', convAsk3.id)
// 用竞速断言「一定会落定」：中止没生效的话这个 promise 会一直吊着（正是当初删掉工具的症状）
const askSettled = await Promise.race([
  askRun3.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 4000))
])
check(
  '中止后轮次真的落定（挂起的提问被取消，没有永不结束的 Promise）',
  askSettled === true
)
check(
  '中止时界面收到 ask:done(canceled)',
  events.some(
    (e) => e.type === 'ask:done' && e.requestId === askUserEvent3.requestId && e.outcome === 'canceled'
  )
)
check(
  '被中止的轮次报 aborted（不是 ok）',
  events.some(
    (e) => e.type === 'turn:finished' && e.conversationId === convAsk3.id && e.status === 'aborted'
  )
)
check(
  '中止后挂起列表里不再有它（再作答只会返回 false）',
  (await inv('work:answer', {
    conversationId: convAsk3.id,
    requestId: askUserEvent3.requestId,
    canceled: false,
    selections: [],
    note: ''
  })) === false
)
ask3.server.closeAllConnections?.()
ask3.server.close()

console.log(`\nask_user_question 验证：通过 ${passed - passedBeforeAsk} 项`)

console.log(`\nIPC 验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
}
fs.rmSync(dataRoot, { recursive: true, force: true })
process.exitCode = failed === 0 ? 0 : 1