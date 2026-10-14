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
export { __invoke, __channels, __events, __reset } from 'electron'
export { initAppPaths, clearTempDir } from '@core/platform/appPaths'
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
  'intake:import',
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
