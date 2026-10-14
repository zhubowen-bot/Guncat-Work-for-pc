import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import 'katex/dist/katex.min.css'
import { reportStage, describeError } from './bootReport'

// 启动诊断的第一层：脚本级异常。
// 模块顶层抛错、脚本被 CSP 拦掉、import 失败这类问题会先落到这里；
// 而它们在白屏上跟「React 挂载失败」长得一模一样，只有上报能区分。
window.addEventListener('error', (event) => {
  reportStage('error', `window.onerror: ${event.message} @ ${event.filename}:${event.lineno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  reportStage('error', `unhandledrejection: ${describeError(event.reason)}`)
})

const container = document.getElementById('root')
if (container === null) {
  // 连挂载点都没有：这是最彻底的白屏，必须留下证据（而不是抛一句没人看见的异常）
  reportStage('error', '找不到 #root 挂载点')
  throw new Error('找不到 #root 挂载点')
}

// 清掉 index.html 里的加载占位（窗口是立刻显示的，占位会一直显示到 React 接管为止）。
// 注意这一步的代价：占位一清，React 若没渲染出来就是纯白 —— 所以下面两个回调必须在上报链路上。
container.replaceChildren()

ReactDOM.createRoot(container, {
  /**
   * React 19 的根级错误回调。
   * 没有它，渲染期抛出的异常只会走浏览器 console，而用户的启动日志里一条都不会有 ——
   * 这正是这次排查中最要命的缺口：日志显示「加载完成」，窗口一片白，却没有任何错误。
   */
  onUncaughtError: (error) => {
    reportStage('error', describeError(error))
  }
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
