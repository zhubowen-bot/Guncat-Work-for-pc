// Electron 主窗口：单窗口 + 外链走系统浏览器 + 应用图标。
import { BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resource } from '@core/platform/appPaths'

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

export function createMainWindow(): BrowserWindow {
  const window: BrowserWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    title: 'Guncat Work',
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程需要 Web Speech API（朗读/语音输入）
      spellcheck: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // 外链一律交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    mainWindow = null
  })

  mainWindow = window
  return window
}
