// Electron 的测试替身：让主进程的 IPC 契约可以在纯 Node 下被真实调用。
//
// 为什么值得做：本机跑不起 Electron 窗口，但「渲染进程会调用的每一个通道」
// 其实是可以在 Node 里逐个 invoke 并断言的。用一个最小替身把 electron 换掉，
// 就能验证注册、参数、返回值与事件推送这条链路，而不是只验证底层服务。
type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const sentEvents: Array<{ channel: string; payload: unknown }> = []

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  }
}

/** 测试用：按通道名调用已注册的处理器（模拟渲染进程 invoke） */
export async function __invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) {
    throw new Error(`IPC 通道未注册: ${channel}`)
  }
  return await handler({}, ...args)
}

/** 测试用：当前已注册的通道名 */
export function __channels(): string[] {
  return [...handlers.keys()].sort()
}

/** 测试用：主进程推给渲染进程的事件 */
export function __events(): Array<{ channel: string; payload: unknown }> {
  return sentEvents
}

export function __reset(): void {
  handlers.clear()
  sentEvents.length = 0
}

class FakeWebContents {
  send(channel: string, payload: unknown): void {
    sentEvents.push({ channel, payload })
  }
}

export class BrowserWindow {
  webContents: FakeWebContents = new FakeWebContents()
  private destroyed: boolean = false

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
  show(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  on(): void {}
  close(): void {
    this.destroyed = true
  }
}

export const app = {
  isPackaged: false,
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
    return true
  },
  quit(): void {},
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  on(): void {}
}

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true }
  }
}

export const shell = {
  async openExternal(): Promise<void> {},
  async openPath(): Promise<string> {
    return ''
  }
}

export const nativeImage = {
  createFromBuffer(): never {
    throw new Error('测试替身不提供像素解码')
  }
}
