// Markdown 渲染：CommonMark + GFM 表格/任务列表 + LaTeX 公式。
// 鸿蒙版用 @luvi/lv-markdown-in 原生组件，桌面端这里用 react-markdown 达到同等覆盖面。
//
// 脚注的两处默认文案被显式覆盖：
//   remark-rehype 的脚注回跳链接默认内容是一个箭头符号（U+21A9），它会真的渲染进界面 ——
//   与「界面里不出现符号当图标」的口径冲突，因此换成中文「返回」，脚注区标题写成「脚注」。
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

interface Props {
  text: string
}

/** 透传给 remark-rehype 的脚注文案（不含任何符号） */
export const REHYPE_OPTIONS = {
  footnoteBackContent: '返回',
  footnoteBackLabel: '返回正文',
  footnoteLabel: '脚注'
} as const

export const Markdown = memo(function Markdown({ text }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      remarkRehypeOptions={REHYPE_OPTIONS}
    >
      {text}
    </ReactMarkdown>
  )
})
