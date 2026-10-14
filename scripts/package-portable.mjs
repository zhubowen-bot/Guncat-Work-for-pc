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
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkgJson.version
// 输出目录带版本号：一来用户一眼知道拿的是哪版，二来避免旧目录被占用
// （比如用户还开着上一次的 cmd 窗口，其工作目录就在里面）导致整个打包失败。
const outDir = path.join(root, 'release', `${appName}-${version}`)
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
// Windows 上偶尔会把输出目录本身锁住（EPERM），但里面的内容通常可以删。
// 所以删除失败时退而求其次：清空内容，而不是整个打包流程失败。
fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
if (fs.existsSync(outDir)) {
  for (const entry of fs.readdirSync(outDir)) {
    try {
      fs.rmSync(path.join(outDir, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // 实在删不掉就留着，后面的复制会覆盖
    }
  }
  if (fs.existsSync(outDir)) {
    step('目录已存在且删不掉，改为就地覆盖')
  }
}
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
const pkg = pkgJson
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
//
// 注意：.cmd 一律只写 ASCII。
// 事故：这些脚本最初用中文提示、以 UTF-8 写出，而 cmd.exe 在中文 Windows 上按 GBK
// 解析批处理文件 —— 内存里的字节被解成乱码，整行变成无法识别的命令，
// 批处理的 if/goto 控制流直接被拆坏（实测表现为 "'…' is not recognized"）。
// chcp 65001 放在文件里也救不了，因为解析从第一行就开始了。
// 中文说明一律放到 使用说明.txt。
const cmdHeader = [
  '@echo off',
  'chcp 65001 >nul 2>&1',
  'cd /d "%~dp0"',
  'setlocal',
  'set "LOG=%~dp0diag-log.txt"',
  'set "APPDIR=%APPDATA%\\Guncat Work"',
  'set "BOOTLOG=%APPDIR%\\logs\\startup.log"',
  'set "CRASH=-2147483645"',
  'set /a STEP=0'
]

function attempt(label, args) {
  return [
    'set /a STEP+=1',
    `echo. >> "%LOG%"`,
    `echo ========== [%STEP%] ${label} ========== >> "%LOG%"`,
    `echo [%STEP%] ${label}`,
    `"Guncat Work.exe" ${args} --enable-logging >> "%LOG%" 2>&1`,
    'set "CODE=%ERRORLEVEL%"',
    `echo exit code: %CODE% >> "%LOG%"`,
    'if exist "%BOOTLOG%" copy /y "%BOOTLOG%" "%~dp0startup-%STEP%.log" >nul',
    'if "%CODE%"=="0" goto done'
  ]
}

fs.writeFileSync(
  path.join(outDir, 'diagnose.cmd'),
  [
    ...cmdHeader,
    'echo ===== Guncat Work diagnostics ===== > "%LOG%"',
    'echo time: %date% %time% >> "%LOG%"',
    'echo os: %OS% %PROCESSOR_ARCHITECTURE% >> "%LOG%"',
    'echo.',
    'echo This will try 4 launch modes. Each run writes to the log file.',
    'echo If a window appears, close it and this script will continue.',
    'echo.',
    ...attempt('normal', ''),
    ...attempt('no-sandbox', '--no-sandbox --disable-gpu'),
    ...attempt('safe-mode', '--guncat-safe-mode'),
    ...attempt('diag-page', '--guncat-diag --no-sandbox --disable-gpu'),
    ':done',
    'echo. >> "%LOG%"',
    'echo ===== last exit code: %CODE% ===== >> "%LOG%"',
    'echo.',
    'echo Done. Please send these files:',
    'echo   - diag-log.txt              (this folder)',
    'echo   - startup-1.log ... startup-4.log   (this folder)',
    'echo   - %BOOTLOG%',
    'pause'
  ].join('\r\n') + '\r\n',
  'latin1'
)

// 桌面快捷方式（带应用图标；Windows 快捷方式只认 .ico）
fs.writeFileSync(
  path.join(outDir, 'create-desktop-shortcut.cmd'),
  [
    ...cmdHeader,
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut([Environment]::GetFolderPath(\'Desktop\') + \'\\Guncat Work.lnk\'); $lnk.TargetPath = \'%~dp0Guncat Work.exe\'; $lnk.WorkingDirectory = \'%~dp0\'; $lnk.IconLocation = \'%~dp0resources\\resources\\app-icon.ico\'; $lnk.Description = \'Guncat Work\'; $lnk.Save()"',
    'echo.',
    'echo A "Guncat Work" shortcut was created on your desktop.',
    'pause'
  ].join('\r\n') + '\r\n',
  'latin1'
)
step('写入 diagnose.cmd 与 create-desktop-shortcut.cmd（纯 ASCII）')

// ===== 7. 简短说明（UTF-8 带 BOM，记事本直接可读） =====
fs.writeFileSync(
  path.join(outDir, '使用说明.txt'),
  '\ufeff' +
    [
      'Guncat Work（电脑版）',
      '',
      '双击本目录下的「Guncat Work.exe」即可启动，无需安装、无需命令行。',
      '想放到桌面就从「create-desktop-shortcut.cmd」双击一次，会生成带图标的快捷方式。',
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
      '────────────────────────────────────────',
      '如果双击后窗口没有出现（白屏 / 闪退）：',
      '',
      '  双击本目录的「diagnose.cmd」。它会依次尝试四种启动方式，',
      '  每种都把输出与退出码写进本目录的 diag-log.txt，',
      '  并把应用自身的启动日志另存为 startup-1.log … startup-4.log。',
      '  把这几份文件发出来即可定位。',
      '',
      '  四种方式分别是：正常 / 禁用沙箱与 GPU / 安全模式 / 极简诊断页。',
      '  若只有「极简诊断页」能显示，说明渲染进程没问题、是界面产物加载失败；',
      '  若四种都白屏，则是渲染进程或 GPU 层的问题。',
      '────────────────────────────────────────'
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
