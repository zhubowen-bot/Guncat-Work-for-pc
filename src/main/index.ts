// Electron 主进程入口。
//
// 启动顺序很关键：必须先初始化应用路径，再触碰任何会解析 filesDir / rawfile 的模块，
// 否则技能库扫描与配置读取会拿到未初始化目录。
import { app, BrowserWindow } from 'electron'
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { registerElectronPicker } from './picker'
import { registerIpcHandlers } from './ipc'
import { collectFileArgs } from './intake'
import { SessionManager } from './session/SessionManager'
import { createMainWindow, getMainWindow } from './window'
import { resolveAppPaths } from './paths'
import type { GuncatEvent } from '../ipc/contract'

/** 待收件的外部文件（窗口还没就绪时先攒着，页面加载完再推） */
const pendingIntake: string[] = []

function dispatch(event: GuncatEvent): void {
  const window: BrowserWindow | null = getMainWindow()
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send('guncat:event', event)
  }
}

/** 把外部文件排进队列；窗口就绪时立即推送，否则等 did-finish-load */
function enqueueIntake(paths: string[]): void {
  if (paths.length === 0) {
    return
  }
  const window: BrowserWindow | null = getMainWindow()
  if (window === null || window.isDestroyed()) {
    pendingIntake.push(...paths)
    return
  }
  dispatch({ type: 'files:pending', paths })
}

function flushPendingIntake(): void {
  if (pendingIntake.length === 0) {
    return
  }
  const paths: string[] = pendingIntake.splice(0, pendingIntake.length)
  dispatch({ type: 'files:pending', paths })
}

// 单实例：第二次启动时聚焦已有窗口，并把它的文件参数接过来
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv: string[]) => {
    const window: BrowserWindow | null = getMainWindow()
    if (window !== null) {
      if (window.isMinimized()) {
        window.restore()
      }
      window.focus()
    }
    enqueueIntake(collectFileArgs(argv))
  })

  // macOS：从访达「打开方式」进来
  app.on('open-file', (event: Electron.Event, filePath: string) => {
    event.preventDefault()
    enqueueIntake([filePath])
  })

  app.whenReady().then(() => {
    const paths = resolveAppPaths()
    initAppPaths(paths)
    clearTempDir()
    registerElectronPicker()

    const session: SessionManager = new SessionManager((event: GuncatEvent) => {
      dispatch(event)
    })

    registerIpcHandlers(session)
    const window: BrowserWindow = createMainWindow()

    // 页面加载完再把启动时的文件参数推过去，避免事件早于渲染进程订阅
    window.webContents.on('did-finish-load', () => {
      flushPendingIntake()
    })

    // 启动时若带文件参数（双击关联文件 / 拖到图标上），先入队
    enqueueIntake(collectFileArgs(process.argv))

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
