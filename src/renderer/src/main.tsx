import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import 'katex/dist/katex.min.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('找不到 #root 挂载点')
}

// 清掉 index.html 里的加载占位（窗口是立刻显示的，占位会一直显示到 React 接管为止）
container.replaceChildren()

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
