// Electron 主进程入口。
//
// 启动顺序很关键：必须先初始化应用路径，再触碰任何会解析 filesDir / rawfile 的模块，
// 否则技能库扫描与配置读取会拿到未初始化目录。
import { app, BrowserWindow } from 'electron'
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { registerElectronPicker } from './picker'
import { registerIpcHandlers } from './ipc'
import { SessionManager } from './session/SessionManager'
import { createMainWindow, getMainWindow } from './window'
import { resolveAppPaths } from './paths'
import type { GuncatEvent } from '../ipc/contract'

// 单实例：第二次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window: BrowserWindow | null = getMainWindow()
    if (window !== null) {
      if (window.isMinimized()) {
        window.restore()
      }
      window.focus()
    }
  })

  app.whenReady().then(() => {
    const paths = resolveAppPaths()
    initAppPaths(paths)
    clearTempDir()
    registerElectronPicker()

    const session: SessionManager = new SessionManager((event: GuncatEvent) => {
      const window: BrowserWindow | null = getMainWindow()
      if (window !== null && !window.isDestroyed()) {
        window.webContents.send('guncat:event', event)
      }
    })

    registerIpcHandlers(session)
    createMainWindow()

    // 技能库扫描 + 智能体加载放在窗口创建之后，避免拖慢首屏
    void session.bootstrap().catch((e: unknown) => {
      console.error('[guncat] bootstrap failed:', e)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
