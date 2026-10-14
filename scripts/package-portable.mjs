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

// ===== 6. 双击即用的辅助入口 =====
// 诊断启动：依次尝试三种启动模式，每种都记录退出码。
// 之所以要分模式：Chromium 的沙箱在某些进程上下文里会初始化失败并直接让进程
// 以 STATUS_BREAKPOINT(-2147483645) 退出，此时 --no-sandbox 能绕过。
fs.writeFileSync(
  path.join(outDir, '诊断启动.cmd'),
  [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'set LOG=%~dp0启动日志.txt',
    'set CRASH=-2147483645',
    '',
    'echo ===== Guncat Work 诊断启动 ===== > "%LOG%"',
    'echo 时间: %date% %time% >> "%LOG%"',
    'echo 系统: %OS% %PROCESSOR_ARCHITECTURE% >> "%LOG%"',
    'echo.',
    'echo 即将依次尝试三种启动模式。',
    'echo 如果窗口出现，直接关闭窗口即可，脚本会继续记录退出码。',
    'echo.',
    '',
    'echo ---------- [1/3] 正常启动 ---------- >> "%LOG%"',
    'echo [1/3] 正常启动…',
    '"Guncat Work.exe" --enable-logging >> "%LOG%" 2>&1',
    'set CODE=%ERRORLEVEL%',
    'echo 退出码: %CODE% >> "%LOG%"',
    'if not "%CODE%"=="%CRASH%" goto done',
    '',
    'echo ---------- [2/3] --no-sandbox ---------- >> "%LOG%"',
    'echo [2/3] 正常启动崩了，改试 --no-sandbox…',
    '"Guncat Work.exe" --no-sandbox --enable-logging >> "%LOG%" 2>&1',
    'set CODE=%ERRORLEVEL%',
    'echo 退出码: %CODE% >> "%LOG%"',
    'if not "%CODE%"=="%CRASH%" goto done',
    '',
    'echo ---------- [3/3] --no-sandbox --disable-gpu ---------- >> "%LOG%"',
    'echo [3/3] 再试 --no-sandbox --disable-gpu…',
    '"Guncat Work.exe" --no-sandbox --disable-gpu --enable-logging >> "%LOG%" 2>&1',
    'set CODE=%ERRORLEVEL%',
    'echo 退出码: %CODE% >> "%LOG%"',
    '',
    ':done',
    'echo. >> "%LOG%"',
    'echo ===== 结束，最后一次退出码: %CODE% ===== >> "%LOG%"',
    'echo.',
    'echo 已结束。请把下面两个文件发出来：',
    'echo   · %LOG%',
    'echo   · %APPDATA%\\Guncat Work\\logs\\startup.log',
    'pause'
  ].join('\r\n'),
  'utf8'
)

// 桌面快捷方式（带应用图标；Windows 快捷方式只认 .ico）
fs.writeFileSync(
  path.join(outDir, '创建桌面快捷方式.cmd'),
  [
    '@echo off',
    'chcp 65001 >nul',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut([Environment]::GetFolderPath(\'Desktop\') + \'\\Guncat Work.lnk\'); $lnk.TargetPath = \'%~dp0Guncat Work.exe\'; $lnk.WorkingDirectory = \'%~dp0\'; $lnk.IconLocation = \'%~dp0resources\\resources\\app-icon.ico\'; $lnk.Description = \'Guncat Work\'; $lnk.Save()"',
    'echo.',
    'echo 已尝试在桌面创建「Guncat Work」快捷方式。',
    'pause'
  ].join('\r\n'),
  'utf8'
)
step('写入 诊断启动.cmd 与 创建桌面快捷方式.cmd')

// ===== 7. 简短说明 =====
fs.writeFileSync(
  path.join(outDir, '使用说明.txt'),
  [
    'Guncat Work（电脑版）',
    '',
    '双击本目录下的「Guncat Work.exe」即可启动，无需安装、无需命令行。',
    '想放到桌面就从「创建桌面快捷方式.cmd」双击一次，会生成带图标的快捷方式。',
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
    '把文件拖进窗口即可导入当前会话的工作区。',
    '',
    '如果双击后窗口没有出现：',
    '  双击本目录的「诊断启动.cmd」，它会带日志启动并留下两个日志文件：',
    '    · 本目录的「启动日志.txt」',
    '    · %APPDATA%\\Guncat Work\\logs\\startup.log',
    '  把这两个文件发出来即可定位问题。'
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
