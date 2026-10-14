// Electron 的测试替身：让主进程的启动链路与 IPC 契约都能在纯 Node 下被真实调用。
//
// 为什么值得做：本机跑不起 Electron 窗口（electron.exe 连 --version 都是
// STATUS_BREAKPOINT），但「index.ts → whenReady → createMainWindow → loadFile」
// 这条链路完全可以在 Node 里跑，并断言路径解析、preload 是否存在、有无异常。
type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const sentEvents: Array<{ channel: string; payload: unknown }> = []
const calls: Array<{ fn: string; args: unknown[] }> = []

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
    calls.push({ fn: 'ipcMain.handle', args: [channel] })
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  }
}

export async function __invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) {
    throw new Error(`IPC 通道未注册: ${channel}`)
  }
  return await handler({}, ...args)
}

export function __channels(): string[] {
  return [...handlers.keys()].sort()
}

export function __events(): Array<{ channel: string; payload: unknown }> {
  return sentEvents
}

export function __calls(): Array<{ fn: string; args: unknown[] }> {
  return calls
}

export function __reset(): void {
  handlers.clear()
  sentEvents.length = 0
  calls.length = 0
}

class FakeWebContents {
  private listeners: Map<string, Array<(...a: unknown[]) => void>> = new Map()

  send(channel: string, payload: unknown): void {
    sentEvents.push({ channel, payload })
  }

  setWindowOpenHandler(handler: (...a: unknown[]) => unknown): void {
    calls.push({ fn: 'setWindowOpenHandler', args: [handler] })
  }

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    calls.push({ fn: 'webContents.on', args: [event] })
    return this
  }

  /** 测试用：模拟页面加载完成 */
  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb()
    }
  }
}

export class BrowserWindow {
  options: Record<string, unknown>
  webContents: FakeWebContents = new FakeWebContents()
  private destroyed: boolean = false

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
    calls.push({ fn: 'new BrowserWindow', args: [options] })
  }

  static getAllWindows(): BrowserWindow[] {
    return []
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return false
  }

  restore(): void {}
  focus(): void {}
  show(): void {
    calls.push({ fn: 'window.show', args: [] })
  }
  setWindowOpenHandler(handler: unknown): void {
    calls.push({ fn: 'setWindowOpenHandler', args: [handler] })
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    calls.push({ fn: 'window.on', args: [event] })
    return this
  }
  async loadURL(url: string): Promise<void> {
    calls.push({ fn: 'loadURL', args: [url] })
  }
  async loadFile(file: string): Promise<void> {
    calls.push({ fn: 'loadFile', args: [file] })
  }
  close(): void {
    this.destroyed = true
  }
}

export const app = {
  isPackaged: false,
  getName(): string {
    return 'Guncat Work'
  },
  getVersion(): string {
    return '0.1.0-test'
  },
  getPath(name: string): string {
    return name === 'userData' ? '/tmp/guncat-test-userdata' : '/tmp'
  },
  getAppPath(): string {
    return process.cwd()
  },
  requestSingleInstanceLock(): boolean {
    calls.push({ fn: 'requestSingleInstanceLock', args: [] })
    return true
  },
  quit(): void {
    calls.push({ fn: 'app.quit', args: [] })
  },
  whenReady(): Promise<void> {
    calls.push({ fn: 'app.whenReady', args: [] })
    return Promise.resolve()
  },
  on(event: string, cb: (...a: unknown[]) => void): void {
    calls.push({ fn: 'app.on', args: [event] })
  },
  setAppUserModelId(id: string): void {
    calls.push({ fn: 'setAppUserModelId', args: [id] })
  }
}

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true }
  },
  showErrorBox(title: string, content: string): void {
    calls.push({ fn: 'dialog.showErrorBox', args: [title, content] })
  }
}

export const shell = {
  async openExternal(): Promise<void> {},
  async openPath(): Promise<string> {
    return ''
  }
}

export const webUtils = {
  getPathForFile(_file: unknown): string {
    return ''
  }
}

export const nativeImage = {
  createFromBuffer(): never {
    throw new Error('测试替身不提供像素解码')
  }
}
