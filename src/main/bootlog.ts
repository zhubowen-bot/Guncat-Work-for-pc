// 启动诊断日志。
//
// 目的：一旦应用在用户机器上「启动即退」，要能拿到证据，而不是只有一句「打不开」。
//
// 两个刻意的设计：
//   1) 不依赖任何 Electron API —— 用 %APPDATA% 直接定位日志文件。
//      如果崩溃发生在 app 可用之前，Electron 的路径 API 本身就不可靠。
//   2) 每个启动里程碑都记一行。这样即使最终崩了，日志能告诉我们它走到了哪一步，
//      是「还没到 JS」还是「死在窗口创建」。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let logPath = ''
let stream: fs.WriteStream | null = null

function resolveLogPath(): string {
  const base: string =
    process.env.APPDATA !== undefined && process.env.APPDATA !== ''
      ? process.env.APPDATA
      : path.join(os.homedir(), '.config')
  return path.join(base, 'Guncat Work', 'logs', 'startup.log')
}

export function bootLogPath(): string {
  if (logPath === '') {
    logPath = resolveLogPath()
  }
  return logPath
}

/** 写入一行启动日志。任何失败都必须被吞掉 —— 诊断不该反过来弄崩应用。 */
export function bootLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    if (stream === null) {
      const file = bootLogPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // 每次启动重写，避免日志无限增长
      stream = fs.createWriteStream(file, { flags: 'w' })
    }
    stream.write(line)
  } catch {
    // 忽略
  }
  // 同时写 stderr：带 --enable-logging 从终端启动时能直接看到
  try {
    process.stderr.write(line)
  } catch {
    // 忽略
  }
}

/** 记录一个致命错误，并把它留在日志里 */
export function bootFail(where: string, error: unknown): void {
  const detail =
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  bootLog(`✗ 致命错误 @ ${where}\n${detail}`)
}

/**
 * 装上兜底处理器：未捕获异常与未处理的 Promise 拒绝都要落到日志里，
 * 否则 Electron 会静默退出，用户只看到「闪一下就没了」。
 * onFatal 用于弹一个错误框（app 可用时才有意义）。
 */
export function installCrashHandlers(onFatal: (text: string) => void): void {
  process.on('uncaughtException', (error: Error) => {
    bootFail('uncaughtException', error)
    onFatal(`未捕获异常：${error.message}`)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    bootFail('unhandledRejection', reason)
    onFatal(`未处理的 Promise 拒绝：${String(reason)}`)
  })
}
