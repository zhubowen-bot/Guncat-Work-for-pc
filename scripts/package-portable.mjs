// 组装可双击运行的 Windows 应用目录。
//
// 为什么不用 electron-builder：
//   它的 pnpm 依赖收集器在本机环境下拿不到 `pnpm list --json` 的输出（管道捕获失败），
//   会在打包中途报 "No JSON content found in output"。而本应用的运行时代码已被 vite
//   全部打进 out/，**没有任何 node_modules 需要在打包时收集** —— 收集这一步本就是多余的。
//
// 组装方式（Electron 的标准应用目录结构）：
//   release/Guncat Work/
//   ├── Guncat Work.exe                 ← 双击这个
//   ├── *.dll / *.pak / locales/ …      ← Electron 运行时（整份复制）
//   └── resources/
//       ├── app/                        ← 我们的代码（out/ + package.json）
//       └── resources/                  ← 随包资源（智能体、提示词、技能库）
//
// 用法：node scripts/package-portable.mjs
//   前置：已跑过 `pnpm build`（out/ 存在）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appName = 'Guncat Work'
const outDir = path.join(root, 'release', appName)
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function step(message) {
  console.log(`  · ${message}`)
}

// ===== 前置检查 =====
if (!fs.existsSync(electronDist)) {
  fail('找不到 Electron 运行时（node_modules/electron/dist）。请先跑 pnpm install。')
}
if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  fail('找不到构建产物（out/main/index.js）。请先跑 pnpm build。')
}

console.log(`\n组装 ${appName} …`)

// ===== 1. 清空并复制 Electron 运行时 =====
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
step('复制 Electron 运行时')
fs.cpSync(electronDist, outDir, { recursive: true })

// ===== 2. 去掉 Electron 自带的默认应用，换上我们的 =====
const defaultApp = path.join(outDir, 'resources', 'default_app.asar')
if (fs.existsSync(defaultApp)) {
  fs.rmSync(defaultApp, { force: true })
  step('移除 default_app.asar')
}

// ===== 3. 应用代码放到 resources/app =====
const appTarget = path.join(outDir, 'resources', 'app')
fs.mkdirSync(appTarget, { recursive: true })
step('写入应用代码 → resources/app')
fs.cpSync(path.join(root, 'out'), path.join(appTarget, 'out'), { recursive: true })

// package.json 只保留 Electron 启动需要的字段，避免把构建配置带进产物
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
fs.writeFileSync(
  path.join(appTarget, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: appName,
      version: pkg.version,
      description: pkg.description,
      main: pkg.main,
      author: pkg.author,
      license: pkg.license,
      type: pkg.type
    },
    null,
    2
  ),
  'utf8'
)

// ===== 4. 随包资源（智能体 / 提示词 / 技能库）放到 resources/resources =====
// 与 src/main/paths.ts 的 resolveResourcesRoot() 约定一致
step('复制随包资源 → resources/resources')
fs.cpSync(path.join(root, 'resources'), path.join(outDir, 'resources', 'resources'), {
  recursive: true
})

// ===== 5. 可执行文件改名 =====
const exeSource = path.join(outDir, 'electron.exe')
const exeTarget = path.join(outDir, `${appName}.exe`)
if (fs.existsSync(exeSource)) {
  fs.renameSync(exeSource, exeTarget)
  step(`可执行文件 → ${appName}.exe`)
}

// ===== 6. 简短说明 =====
fs.writeFileSync(
  path.join(outDir, '使用说明.txt'),
  [
    'Guncat Work（电脑版）',
    '',
    '双击本目录下的「Guncat Work.exe」即可启动，无需安装、无需命令行。',
    '',
    '首次使用：',
    '  1. 打开应用后点左下角「设置」',
    '  2. 填入接入方式、Base URL、API Key 与模型，保存',
    '  3. 回到主界面即可开始对话',
    '',
    '数据位置：',
    '  对话历史、沙箱工作区与配置都保存在 %APPDATA%\\Guncat Work 下，',
    '  不会写入本目录，删除本目录不影响已有数据。',
    '',
    '三种形态（左侧栏顶部可切换）：',
    '  ✦ 交互模式  一句话直出可操作界面',
    '  🛠 工作模式  多轮工具循环 + 沙箱工作区，可直出 PPT / Word / Excel',
    '    聊天模式  纯对话',
    '',
    '把文件拖进窗口即可导入当前会话的工作区。'
  ].join('\r\n'),
  'utf8'
)

// ===== 汇总 =====
function treeSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? treeSize(full) : fs.statSync(full).size
  }
  return total
}

const size = treeSize(outDir)
console.log(`\n✓ 完成：${path.relative(root, exeTarget)}`)
console.log(`  目录：${path.relative(root, outDir)}（${(size / 1024 / 1024).toFixed(1)} MB）`)
console.log('  双击目录里的 exe 即可启动。\n')
