// Markdown 渲染：CommonMark + GFM 表格/任务列表 + LaTeX 公式。
// 鸿蒙版用 @luvi/lv-markdown-in 原生组件，桌面端这里用 react-markdown 达到同等覆盖面。
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

interface Props {
  text: string
}

export const Markdown = memo(function Markdown({ text }: Props) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {text}
    </ReactMarkdown>
  )
})
