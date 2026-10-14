// 平台适配层：鸿蒙 `@kit.ArkData` 的等价实现（Node 侧）
//
// 端口代码只用 preferences 存配置类小数据（API 配置 / 开关 / 朗读偏好），
// 语义是「键值 + 显式 flush」的异步接口。这里落成
// <filesDir>/preferences/<name>.json，put 先改内存再在 flush 时写盘，
// 与鸿蒙侧「put 不落盘、flush 才落盘」的行为保持一致。
import fs from 'node:fs'
import path from 'node:path'
import { filesDir } from '../appPaths'

type PrefValue = string | number | boolean | object

export namespace preferences {
  export interface Options {
    name?: string
  }

  export class Preferences {
    private readonly filePath: string
    private data: Record<string, PrefValue> = {}
    private dirty: boolean = false

    constructor(filePath: string) {
      this.filePath = filePath
      this.load()
    }

    private load(): void {
      try {
        if (fs.existsSync(this.filePath)) {
          const raw: string = fs.readFileSync(this.filePath, 'utf8')
          const parsed: unknown = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') {
            this.data = parsed as Record<string, PrefValue>
          }
        }
      } catch {
        // 配置损坏时按空配置启动，不阻塞应用
        this.data = {}
      }
    }

    async get(key: string, defValue: PrefValue): Promise<PrefValue> {
      const value: PrefValue | undefined = this.data[key]
      return value === undefined ? defValue : value
    }

    async getAll(): Promise<Record<string, PrefValue>> {
      return { ...this.data }
    }

    async has(key: string): Promise<boolean> {
      return Object.prototype.hasOwnProperty.call(this.data, key)
    }

    async put(key: string, value: PrefValue): Promise<void> {
      this.data[key] = value
      this.dirty = true
    }

    async delete(key: string): Promise<void> {
      if (Object.prototype.hasOwnProperty.call(this.data, key)) {
        delete this.data[key]
        this.dirty = true
      }
    }

    async clear(): Promise<void> {
      this.data = {}
      this.dirty = true
      await this.flush()
    }

    async flush(): Promise<void> {
      if (!this.dirty) {
        return
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp: string = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
      fs.renameSync(tmp, this.filePath)
      this.dirty = false
    }
  }

  const instances: Map<string, Preferences> = new Map()

  export async function getPreferences(
    _context: unknown,
    name: string = 'default'
  ): Promise<Preferences> {
    const existing: Preferences | undefined = instances.get(name)
    if (existing !== undefined) {
      return existing
    }
    const dir: string = path.join(filesDir(), 'preferences')
    fs.mkdirSync(dir, { recursive: true })
    const created: Preferences = new Preferences(path.join(dir, `${name}.json`))
    instances.set(name, created)
    return created
  }

  export async function removePreferencesFromCache(_context: unknown, name: string): Promise<void> {
    instances.delete(name)
  }

  export async function deletePreferences(_context: unknown, name: string): Promise<void> {
    const dir: string = path.join(filesDir(), 'preferences')
    const file: string = path.join(dir, `${name}.json`)
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
    instances.delete(name)
  }
}

/** 对齐 @ohos.data.uniformTypeDescriptor（文件 MIME 判定，阶段四分享使用） */
export namespace uniformTypeDescriptor {
  export function getTypeDescriptor(_type: string): { type: string } {
    return { type: _type }
  }
}
