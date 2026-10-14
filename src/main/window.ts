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
import { bootLog } from './bootlog'

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
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // 渲染进程的 console 只有落进启动日志，才可能看到 CSP / 脚本加载这类错误
    bootLog(`[渲染控制台 ${level}] ${message} (${sourceId}:${line})`)
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

  // 外链一律交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    bootLog(`加载开发态页面: ${process.env.ELECTRON_RENDERER_URL}`)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    bootLog('加载打包态页面（loadFile）')
    void window.loadFile(pagePath)
  }

  window.on('closed', () => {
    mainWindow = null
  })

  mainWindow = window
  return window
}
