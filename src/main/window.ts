// Electron 主窗口。
//
// 一条血泪教训（真实事故）：窗口原先用 show:false 建，只在 ready-to-show 时才显示。
// 结果一旦渲染进程因任何原因没加载完，窗口就**永远不出现** —— 用户看到的现象是
// 「双击了，什么都没发生」。首屏要加载 1.5MB JS 加 KaTeX 字体，新 profile 下要好几秒，
// 用户根本等不到。
//
// 现在的策略：
//   1) 窗口**立刻显示**（配合 backgroundColor 与 index.html 里的加载占位，不会白屏闪烁）；
//   2) 渲染进程的每个生命周期事件都写进启动日志，出问题能一眼看出卡在哪；
//   3) 页面加载慢也不影响窗口可见性 —— 可见性永不依赖渲染进程。
import { BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resource } from '@core/platform/appPaths'
import { bootLog, bootLogPath } from './bootlog'

const __dirname: string = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * 应用图标（取自鸿蒙原项目的 cat_avatar）。
 * 打包态落在 resources/resources/ 下，与会话资源同处一地。
 * 取不到就交给 Electron 用默认图标，不能让窗口因为图标起不来。
 */
function resolveIcon(): string | undefined {
  try {
    const file: string = resource('app-icon.png')
    return fs.existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

/** 把渲染进程的生命周期完整记进日志 —— 出问题时这是唯一的线索来源 */
function traceWebContents(window: BrowserWindow, preloadPath: string, pagePath: string): void {
  const wc = window.webContents

  bootLog(`preload 路径: ${preloadPath}（存在=${fs.existsSync(preloadPath)}）`)
  bootLog(`页面路径: ${pagePath}（存在=${fs.existsSync(pagePath)}）`)

  wc.on('did-start-loading', () => bootLog('渲染进程: 开始加载'))
  wc.on('did-start-navigation', (_e, url) => bootLog(`渲染进程: 开始导航 ${url}`))
  wc.on('dom-ready', () => bootLog('渲染进程: DOM 就绪'))
  wc.on('did-finish-load', () => {
    bootLog('渲染进程: 加载完成')
    flushPending()
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    bootLog(`✗ 渲染进程加载失败: code=${code} desc=${desc} url=${url} 主框架=${isMainFrame}`)
  })
  wc.on('did-fail-provisional-load', (_e, code, desc, url) => {
    bootLog(`✗ 渲染进程预加载失败: code=${code} desc=${desc} url=${url}`)
  })
  wc.on('preload-error', (_e, preloadPath2, error) => {
    bootLog(`✗ preload 执行出错: ${preloadPath2}\n${error?.stack ?? String(error)}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    bootLog(`✗ 渲染进程退出: ${JSON.stringify(details)}`)
  })
  wc.on('unresponsive', () => bootLog('✗ 渲染进程无响应'))

  // 渲染进程的 console 只有落进启动日志，才可能看到 CSP / CORS / 脚本加载这类错误。
  // 注意：Electron 37 起这个事件从「位置参数」改成了「单个事件对象」，
  // 只按旧签名解构会拿到一堆 undefined —— 那等于把唯一的线索吞掉了。
  wc.on('console-message', (...args: unknown[]) => {
    const first: unknown = args[0]
    if (typeof first === 'object' && first !== null && 'message' in first) {
      const e = first as {
        level?: unknown
        message?: unknown
        lineNumber?: unknown
        sourceId?: unknown
      }
      bootLog(`[渲染控制台 ${String(e.level)}] ${String(e.message)} (${String(e.sourceId)}:${String(e.lineNumber)})`)
    } else {
      const [, level, message, line, sourceId] = args
      bootLog(`[渲染控制台 ${String(level)}] ${String(message)} (${String(sourceId)}:${String(line)})`)
    }
  })
}

/** 待收件的外部文件（页面还没加载完时先攒着） */
let pendingFlush: () => void = () => {}

export function setPendingFlush(fn: () => void): void {
  pendingFlush = fn
}

function flushPending(): void {
  try {
    pendingFlush()
  } catch {
    // 忽略
  }
}

/** 渲染进程就绪的看门狗：超时未就绪则判定卡住，交给上层处理（通常是安全模式重启） */
let stalledHandler: (info: { pagePath: string; preloadPath: string }) => void = () => {}
let watchdogMs = 10000

export function setRendererStalledHandler(
  fn: (info: { pagePath: string; preloadPath: string }) => void
): void {
  stalledHandler = fn
}

export function setWatchdogMs(ms: number): void {
  watchdogMs = ms
}

export function createMainWindow(): BrowserWindow {
  const preloadPath: string = path.join(__dirname, '../preload/index.mjs')
  const pagePath: string = path.join(__dirname, '../renderer/index.html')

  const window: BrowserWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 620,
    // 立刻显示：可见性不依赖渲染进程是否加载成功
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    title: 'Guncat Work',
    icon: resolveIcon(),
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程需要 Web Speech API（朗读/语音输入）
      spellcheck: false
    }
  })

  traceWebContents(window, preloadPath, pagePath)

  // 看门狗：渲染进程若在超时内没有任何「就绪」信号，说明它卡住了。
  // 现象是窗口一直停在加载占位页、且没有任何失败事件 —— 只能靠超时判定。
  let settled = false
  const timer = setTimeout(() => {
    if (settled || window.isDestroyed()) {
      return
    }
    bootLog(`✗ 渲染进程在 ${watchdogMs / 1000} 秒内没有就绪，判定为卡住`)
    stalledHandler({ pagePath, preloadPath })
  }, watchdogMs)
  const markReady = (): void => {
    settled = true
    clearTimeout(timer)
  }
  window.webContents.once('dom-ready', markReady)
  window.webContents.once('did-fail-load', markReady)
  window.webContents.once('render-process-gone', markReady)
  window.on('closed', () => {
    settled = true
    clearTimeout(timer)
  })

  // 外链一律交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    bootLog(`加载开发态页面: ${process.env.ELECTRON_RENDERER_URL}`)
    window.loadURL(process.env.ELECTRON_RENDERER_URL).catch((e: unknown) => {
      onLoadFailed(window, process.env.ELECTRON_RENDERER_URL ?? '', e)
    })
  } else {
    bootLog('加载打包态页面（loadFile）')
    window.loadFile(pagePath).catch((e: unknown) => {
      onLoadFailed(window, pagePath, e)
    })
  }

  window.on('closed', () => {
    mainWindow = null
  })

  mainWindow = window
  return window
}

/**
 * 页面加载失败时的兜底。
 *
 * 两个都必须做，缺一个都会让用户面对「一片空白 + 毫无线索」：
 *   1) 把失败写进启动日志（含真实错误）；
 *   2) 在窗口里**显示**失败原因 —— 空白窗口比错误信息更难排查。
 *
 * 另外：loadFile 返回的 Promise 必须显式 catch。只写 `void window.loadFile(...)`
 * 会让失败变成 unhandledRejection，被兜底处理器抓成「未处理的 Promise 拒绝」，
 * 反而掩盖了真正的原因。
 */
function onLoadFailed(window: BrowserWindow, target: string, error: unknown): void {
  const message: string = error instanceof Error ? error.message : String(error)
  bootLog(`✗ 页面加载失败: ${target}\n${message}`)
  showLoadError(window, target, message)
}

/** 在窗口里直接显示失败原因 —— 空白窗口比错误信息更难排查 */
export function showLoadError(window: BrowserWindow, target: string, message: string): void {
  if (window.isDestroyed()) {
    return
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Guncat Work</title></head>
<body style="margin:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f5f7;color:#1c1c1e">
<div style="max-width:640px;margin:80px auto;padding:0 24px">
  <h2 style="font-size:18px;margin:0 0 12px">界面加载失败</h2>
  <p style="color:#6b6b73;font-size:13px;line-height:1.7;margin:0 0 16px">
    应用本身已启动，但界面没能加载。把下面这段信息发出来即可定位。
  </p>
  <div style="background:#fff;border:1px solid #e0e0e4;border-radius:8px;padding:14px;
              font-family:Consolas,monospace;font-size:12px;line-height:1.6;word-break:break-all">
    <div style="color:#6b6b73">目标文件</div>
    <div style="margin-bottom:10px">${escapeHtml(target)}</div>
    <div style="color:#6b6b73">错误</div>
    <div style="color:#c0392b">${escapeHtml(message)}</div>
  </div>
  <p style="color:#6b6b73;font-size:12px;margin-top:16px">
    完整启动日志：${escapeHtml(bootLogPath())}
  </p>
</div></body></html>`
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {
    // 连错误页都加载不了就只能空着了，日志里已经有记录
  })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
