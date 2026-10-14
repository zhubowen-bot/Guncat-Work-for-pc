// 构建包装脚本：先把 esbuild 的临时目录指到项目内，再调用 electron-vite。
//
// 为什么不直接写 "electron-vite build"：
//   在 Windows 上 esbuild 会在系统 TEMP 建临时文件再删，本机环境下这一步会报
//   "Access is denied"，构建在 vite:esbuild-transpile 阶段直接失败。
//   把 TMP/TEMP 指到项目内的 .tmp 即可绕开。
// 用 Node 包装而不是在 package.json 里写 `set TMP=... &&`，
// 是为了不依赖 cmd/bash 语法，Windows 与 macOS/Linux 行为一致。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { root, tempDir } from './esbuild-aliases.mjs'

const cli = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: {
    ...process.env,
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir
  }
})

process.exit(result.status === null ? 1 : result.status)
