// 鸿蒙侧依赖若干 ArkTS / ArkUI 的全局环境声明，端口代码直接使用它们。
// 桌面端把这些名字补成等价的全局声明，避免为装饰器逐个改动移植文件。
import type { common } from './AbilityKit'

declare global {
  /** ArkTS 的全局上下文类型（端口代码签名里写作 `context: Context`） */
  type Context = common.Context

  /**
   * ArkUI 的 `@Observed`：鸿蒙侧用于让 @ObjectLink 追踪属性变化。
   * 桌面端状态管理由渲染进程的 store 负责，这里退化为无副作用的类装饰器，
   * 保证 model 层代码（如 Message）可以原样保留装饰器写法。
   */
  const Observed: ClassDecorator
}

export {}
