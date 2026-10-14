// Electron 主进程入口。
//
// 启动顺序很关键：必须先初始化应用路径，再触碰任何会解析 filesDir / rawfile 的模块，
// 否则技能库扫描与配置读取会拿到未初始化目录。
//
// 每个里程碑都写一行启动日志（见 bootlog.ts）：一旦用户机器上「启动即退」，
// 日志能指出它走到了哪一步，而不是只有「打不开」。
import { app, BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { initAppPaths, clearTempDir } from '@core/platform/appPaths'
import { registerElectronPicker } from './picker'
import { registerIpcHandlers } from './ipc'
import { collectFileArgs } from './intake'
import { SessionManager } from './session/SessionManager'
import { createMainWindow, getMainWindow, rendererDir, setPendingFlush, setRendererStalledHandler, showLoadError } from './window'
import { serveRenderer, registerAppScheme } from './protocol'
import { buildCompatArgs, SAFE_MODE_FLAG, FRESH_PROFILE_FLAG } from './compat'
import { resolveAppPaths } from './paths'
import { bootLog, bootLogPath, bootLogTail, bootFail, installCrashHandlers } from './bootlog'
import type { GuncatEvent } from '../ipc/contract'

/**
 * 安全模式与自动降级。
 *
 * 实测结论（用户机器）：只有带上
 *   --no-sandbox --disable-gpu --disable-software-rasterizer
 * 并以管理员身份运行时，渲染进程才起得来。
 * 不带这些参数时：主进程一路正常（路径、协议、IPC、窗口全部就绪），
 * 渲染进程发出 did-start-loading 后就没有下文，约 10 秒后主进程触发致命 CHECK 终止。
 *
 * 所以不该要求用户每次手动带参数、更不该要求管理员权限，而是让它自己降级：
 *   正常启动 → 渲染进程超时未就绪 → 带真实 Chromium 参数自动重启（并换干净的 profile）
 * 之后每次启动都直接走这条路（记在标记文件里），不必再白等一次超时。
 */

/** 曾经靠兼容参数起来过就记下来，下次直接照做 */
function compatMarkerPath(base: string): string {
  return path.join(base, 'safe-mode.marker')
}

/**
 * 降级后使用独立的用户数据目录（<原目录>-compat）。
 * 理由：反复崩溃会在原目录里留下半初始化的 Chromium 状态（GPUCache / Dawn* 等），
 * 那本身就可能让下一次启动继续崩 —— 换个干净目录才能打破这个循环。
 */
function applyCompatProfile(fresh: boolean): void {
  const base: string = app.getPath('userData')
  const compat: string = `${base}-compat`
  if (fresh) {
    try {
      fs.rmSync(compat, { recursive: true, force: true })
    } catch {
      // 删不掉就用现有的
    }
  }
  app.setPath('userData', compat)
}

const freshProfile: boolean = process.argv.includes(FRESH_PROFILE_FLAG)

// 先决定是否走兼容参数：命令行显式要求，或上次留下的标记
let safeMode: boolean = process.argv.includes(SAFE_MODE_FLAG)
if (!safeMode) {
  try {
    if (fs.existsSync(compatMarkerPath(app.getPath('userData')))) {
      safeMode = true
    }
  } catch {
    // 读不到就当没有
  }
}

if (safeMode) {
  // 真参数走命令行（见下 relaunch），这里再在进程内加一道，
  // 覆盖「靠标记文件直接进安全模式」这条没有命令行参数的路径
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('disable-gpu-watchdog')
  applyCompatProfile(freshProfile)
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(compatMarkerPath(app.getPath('userData')), '1')
  } catch {
    // 记不下来就每次重新降级，功能不受影响
  }
}

// app:// 必须在 app ready 之前登记为特权协议
registerAppScheme()

bootLog('=== Guncat Work 启动 ===')
bootLog(`argv: ${process.argv.join(' ')}`)
bootLog(`electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`)
bootLog(`平台=${process.platform} 打包态=${app.isPackaged}`)
bootLog(`兼容模式=${safeMode} 全新配置目录=${freshProfile}`)
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

      // 用 app:// 提供界面文件（替代 file://，详见 protocol.ts 的说明）
      try {
        serveRenderer(rendererDir())
      } catch (e: unknown) {
        bootFail('serveRenderer', e)
      }

      const session: SessionManager = new SessionManager((event: GuncatEvent) => {
        dispatch(event)
      })

      registerIpcHandlers(session)
      bootLog('IPC 通道已注册')

      // 页面加载完成后把积压的收件文件推给渲染进程（页面加载完成的监听在 window.ts 里）
      setPendingFlush(() => {
        flushPendingIntake()
      })

      // 渲染进程卡住时的自愈：安全模式已试过就如实报错，否则自动用安全模式重启一次
      setRendererStalledHandler(({ pagePath }: { pagePath: string }) => {
        const window: BrowserWindow | null = getMainWindow()
        if (safeMode) {
          bootLog('安全模式下渲染进程仍未就绪，不再重试')
          if (window !== null) {
            showLoadError(
              window,
              pagePath,
              '渲染进程在安全模式下仍未能就绪。请把启动日志发出来：' + bootLogPath()
            )
          }
          return
        }
        bootLog('→ 自动以兼容模式重启（禁用渲染沙箱 / GPU，并换用干净的用户数据目录）')
        // 关键：把**真实 Chromium 参数**作为命令行传过去，而不是只传自己的标记。
        // 这正是用户机器上唯一验证成功的那组参数；只靠进程内 appendSwitch 不可靠
        // （沙箱相关开关在进程启动早期就被读取）。
        app.relaunch({ args: buildCompatArgs(process.argv) })
        app.exit(0)
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
      const detail: string = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
      // 把日志尾部直接放进错误框：用户不必去翻文件，一眼就能看到卡在哪一步
      dialog.showErrorBox(
        'Guncat Work 启动失败',
        `错误：${detail}\n\n最近启动日志：\n${bootLogTail(16)}\n\n完整日志：${bootLogPath()}`
      )
      // 窗口已经建出来就留着（至少能看到界面或错误页），别把能用的部分一起关掉
      if (BrowserWindow.getAllWindows().length === 0) {
        app.quit()
      }
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
