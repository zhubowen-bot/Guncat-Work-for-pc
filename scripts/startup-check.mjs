// 主进程启动链路的无头验证。
//
// 为什么需要它：本机的 Electron 二进制连 `--version` 都返回 STATUS_BREAKPOINT，
// 所以我从没见过应用真的起来。这个脚本用 electron 替身把**真实入口**
// （src/main/index.ts）完整跑一遍，并断言：
//   - 单实例锁、whenReady、窗口创建依次发生
//   - BrowserWindow 的 preload 路径**指向真实存在的文件**（路径错会让窗口起不来）
//   - loadFile 指向真实存在的 index.html
//   - IPC 通道全部注册
//   - 数据目录被创建
//   - 全程无异常
//
// 这是对「启动即退」最直接的对冲：即使拿不到窗口，也能证明启动链路本身是通的。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { root, alias } from './esbuild-aliases.mjs'

const dataRoot = path.join(os.tmpdir(), `guncat-startup-${Date.now()}`)
process.env.GUNCAT_DATA_DIR = dataRoot
// 启动日志写到临时目录：绝不能覆盖用户真实的那份（排查问题时要看的正是它）
process.env.GUNCAT_BOOTLOG_DIR = dataRoot

// 记录任何逃逸出来的异常 —— 那正是「启动即退」的形态
const uncaught = []
process.on('uncaughtException', (e) => uncaught.push(`uncaughtException: ${e && e.stack ? e.stack : e}`))
process.on('unhandledRejection', (e) => uncaught.push(`unhandledRejection: ${e && e.stack ? e.stack : e}`))

const dir = path.join(root, '.smoke')
fs.mkdirSync(dir, { recursive: true })

const entry = path.join(dir, 'startup-entry.ts')
fs.writeFileSync(entry, `export * from '@main/index'\nexport * from 'electron'\n`)

// 关键：测试包必须落在与生产**同一层级**，因为 window.ts 用
// `path.join(__dirname, '../preload/index.mjs')` 解析 preload/preload 与 renderer。
// 放在 out/_check/ 下，../preload 才会指向 out/preload，与真实打包态一致。
const checkDir = path.join(root, 'out', '_check')
if (!fs.existsSync(path.join(root, 'out', 'preload'))) {
  console.error('\n✗ 找不到构建产物（out/preload）。请先跑 npm run build。\n')
  process.exit(1)
}
fs.mkdirSync(checkDir, { recursive: true })
const outfile = path.join(checkDir, 'startup.mjs')
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
    electron: path.join(root, 'scripts/electron-stub.ts')
  },
  logLevel: 'error'
})

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

console.log('\n20. 主进程启动链路（真实入口 + electron 替身）')

// 导入即执行入口的副作用（单实例锁 → whenReady → 建窗口 → 注册 IPC）
const stub = await import(pathToFileURL(outfile).href)
// 让 whenReady().then(...) 的微任务跑完
await new Promise((resolve) => setTimeout(resolve, 300))

const calls = stub.__calls()
const find = (fn) => calls.filter((c) => c.fn === fn)

check('模块加载无异常', uncaught.length === 0, uncaught[0]?.slice(0, 160) ?? '')
check('申请了单实例锁', find('requestSingleInstanceLock').length === 1)
check('等待了 app ready', find('app.whenReady').length === 1)
check('没有提前退出', find('app.quit').length === 0, find('app.quit').length > 0 ? '调用了 app.quit' : '')

// --- 窗口 ---
const windowCalls = find('new BrowserWindow')
check('创建了主窗口', windowCalls.length === 1, `${windowCalls.length} 个`)

const options = windowCalls[0]?.args[0] ?? {}
const preload = options.webPreferences?.preload
check('窗口配置了 preload', typeof preload === 'string' && preload !== '', String(preload))
check(
  'preload 指向真实存在的文件',
  typeof preload === 'string' && fs.existsSync(preload),
  typeof preload === 'string' ? path.relative(root, preload) : '(无)'
)
check('preload 扩展名与格式匹配', typeof preload === 'string' && /\.(mjs|cjs|js)$/.test(preload), String(preload ?? ''))
check('openExternal 通过 setWindowOpenHandler 接管', find('setWindowOpenHandler').length === 1)

const loadCalls = find('loadFile')
check('调用了 loadFile（打包态）', loadCalls.length === 1, `${loadCalls.length} 次`)
const indexPath = loadCalls[0]?.args[0]
check('loadFile 指向真实存在的 index.html', typeof indexPath === 'string' && fs.existsSync(indexPath), String(indexPath))

// 回归防线：窗口可见性**绝不能**依赖渲染进程。
// 真实事故——窗口曾用 show:false 建、只在 ready-to-show 时才显示，
// 结果渲染进程没加载完窗口就永远不出现，用户看到的是「双击了没反应」。
check(
  '窗口创建时即可见（不依赖渲染进程）',
  options.show === true,
  options.show === true ? 'show: true' : `show=${String(options.show)} —— 会导致「启动即无反应」`
)
check(
  '页面加载完成后才推送积压的收件文件',
  find('webContents.on').some((c) => c.args[0] === 'did-finish-load'),
  '监听了 did-finish-load'
)
check(
  '渲染进程的失败路径都有监听（否则出问题无从查起）',
  ['did-fail-load', 'preload-error', 'render-process-gone', 'console-message', 'dom-ready'].every(
    (e) => find('webContents.on').some((c) => c.args[0] === e)
  )
)
// 真实事故：渲染进程 did-start-loading 之后毫无动静，页面永远停在占位页，
// 且没有任何失败事件可依赖 —— 只能用超时判定。这条断言保证看门狗还在。
check(
  '装了渲染进程就绪看门狗（应对「不报错也不动」的卡死）',
  find('webContents.once').some((c) => c.args[0] === 'dom-ready'),
  find('webContents.once').map((c) => c.args[0]).join(', ') || '(未注册)'
)

// --- IPC ---
const channels = stub.__channels()
check('IPC 通道已注册', channels.length >= 24, `${channels.length} 个`)
check('渲染进程需要的核心通道都在', ['settings:load', 'agents:list', 'conversations:load', 'chat:send'].every((c) => channels.includes(c)))

// --- 数据目录 ---
check('数据目录已创建', fs.existsSync(dataRoot))
check('files 子目录已创建', fs.existsSync(path.join(dataRoot, 'files')))
check('temp 子目录已创建', fs.existsSync(path.join(dataRoot, 'temp')))

// --- 启动后仍无异常 ---
check('启动完成后无未捕获异常', uncaught.length === 0, uncaught[0]?.slice(0, 200) ?? '')

// --- 页面加载完成后应把待收件文件推给渲染进程（这里只验证不抛异常） ---

console.log(`\n启动链路验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
}
for (const u of uncaught) {
  console.log(`\n未捕获异常：\n${u}`)
}
// 清掉检查用的临时产物，避免混进打包结果
fs.rmSync(checkDir, { recursive: true, force: true })
fs.rmSync(dataRoot, { recursive: true, force: true })
process.exitCode = failed === 0 ? 0 : 1
