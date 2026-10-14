// Electron 主进程入口。
//
// 启动顺序很关键：必须先初始化应用路径，再触碰任何会解析 filesDir / rawfile 的模块，
// 否则技能库扫描与配置读取会拿到未初始化目录。
//
// 每个里程碑都写一行启动日志（见 bootlog.ts）：一旦用户机器上「启动即退」，
// 日志能指出它走到了哪一步，而不是只有「打不开」。
import { app, BrowserWindow, dialog } from 'electron'
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { registerElectronPicker } from './picker'
import { registerIpcHandlers } from './ipc'
import { collectFileArgs } from './intake'
import { SessionManager } from './session/SessionManager'
import { createMainWindow, getMainWindow, setPendingFlush } from './window'
import { resolveAppPaths } from './paths'
import { bootLog, bootLogPath, bootFail, installCrashHandlers } from './bootlog'
import type { GuncatEvent } from '../ipc/contract'

bootLog('=== Guncat Work 启动 ===')
bootLog(`argv: ${process.argv.join(' ')}`)
bootLog(`electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`)
bootLog(`平台=${process.platform} 打包态=${app.isPackaged}`)
bootLog(`日志文件: ${bootLogPath()}`)

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

installCrashHandlers((text) => {
  // app 可用时弹框；不可用时 dialog 会抛，吞掉即可（日志已经写下了）
  try {
    dialog.showErrorBox('Guncat Work 启动出错', `${text}\n\n详细信息见：\n${bootLogPath()}`)
  } catch {
    // 忽略
  }
})

// 单实例：第二次启动时聚焦已有窗口，并把它的文件参数接过来
if (!app.requestSingleInstanceLock()) {
  bootLog('另一个实例已在运行，本次启动退出')
  app.quit()
} else {
  bootLog('单实例锁已获取')

  app.on('second-instance', (_event, argv: string[]) => {
    bootLog('收到 second-instance')
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
    bootLog(`收到 open-file: ${filePath}`)
    enqueueIntake([filePath])
  })

  app
    .whenReady()
    .then(() => {
      bootLog('app ready')

      const paths = resolveAppPaths()
      bootLog(`数据目录=${paths.dataRoot}`)
      bootLog(`资源目录=${paths.resourcesRoot}`)
      initAppPaths(paths)
      clearTempDir()
      bootLog('应用路径已初始化')

      registerElectronPicker()
      bootLog('文件选择器已注册')

      const session: SessionManager = new SessionManager((event: GuncatEvent) => {
        dispatch(event)
      })

      registerIpcHandlers(session)
      bootLog('IPC 通道已注册')

      // 页面加载完成后把积压的收件文件推给渲染进程（页面加载完成的监听在 window.ts 里）
      setPendingFlush(() => {
        flushPendingIntake()
      })

      const window: BrowserWindow = createMainWindow()
      bootLog('主窗口已创建（立刻可见，不依赖渲染进程）')

      // 启动时若带文件参数（双击关联文件 / 拖到图标上），先入队
      enqueueIntake(collectFileArgs(process.argv))

      // 技能库扫描 + 智能体加载放在窗口创建之后，避免拖慢首屏
      void session
        .bootstrap()
        .then(() => {
          bootLog('会话与技能库初始化完成')
        })
        .catch((e: unknown) => {
          bootFail('bootstrap', e)
        })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow()
        }
      })
    })
    .catch((e: unknown) => {
      bootFail('whenReady', e)
      dialog.showErrorBox(
        'Guncat Work 启动失败',
        `${String(e)}\n\n详细信息见：\n${bootLogPath()}`
      )
      app.quit()
    })

  app.on('window-all-closed', () => {
    bootLog('所有窗口已关闭')
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    bootLog('=== 退出 ===')
  })
}
