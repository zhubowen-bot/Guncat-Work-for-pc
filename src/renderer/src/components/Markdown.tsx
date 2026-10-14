// Markdown 渲染：CommonMark + GFM 表格/任务列表 + LaTeX 公式 + 代码高亮 + Mermaid。
// 鸿蒙原版用 @luvi/lv-markdown-in 原生组件，它的四项内建能力就是这四项；
// 桌面端用 react-markdown 撑解析，缺的三项分别补齐：
//   · LaTeX   → remark-math + rehype-katex，**并且必须引入 katex 的样式表**
//               （只引插件不引样式，公式会被渲染成一堆错位的裸 span，看起来就是「没渲染」）；
//   · 代码高亮 → components/CodeBlock（highlight.js，对齐原版 CodeHighlight 配色）；
//   · Mermaid  → components/CodeBlock 的 MermaidBlock（围栏语言为 mermaid 时画成图）。
//
// 脚注的两处默认文案被显式覆盖：
//   remark-rehype 的脚注回跳链接默认内容是一个箭头符号（U+21A9），它会真的渲染进界面 ——
//   与「界面里不出现符号当图标」的口径冲突，因此换成中文「返回」，脚注区标题写成「脚注」。
import { isValidElement, memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CodeBlock, MermaidBlock } from './CodeBlock'

interface Props {
  text: string
}

/** 透传给 remark-rehype 的脚注文案（不含任何符号） */
export const REHYPE_OPTIONS = {
  footnoteBackContent: '返回',
  footnoteBackLabel: '返回正文',
  footnoteLabel: '脚注'
} as const

/** 从 `language-xxx` 类名里取围栏语言标记 */
export function fenceLanguage(className: unknown): string {
  const match = /language-([^\s]+)/.exec(typeof className === 'string' ? className : '')
  return match === null ? '' : match[1]
}

const COMPONENTS: Components = {
  // react-markdown 把围栏/缩进代码块渲染成 <pre><code class="language-x">。
  // 「块级还是行内」只有在 pre 这一层才区分得出来（两者的 code 长一样），
  // 所以块级代码的接管放在 pre 上：解析出子 code 的语言与正文，交给 CodeBlock/MermaidBlock，
  // 并且**不再输出 pre 外壳** —— 否则会把块级组件压成单行。
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement(child)) {
      const props = child.props as { className?: unknown; children?: React.ReactNode }
      const language = fenceLanguage(props.className)
      const code = String(props.children ?? '').replace(/\n$/, '')
      if (language.toLowerCase() === 'mermaid') {
        return <MermaidBlock code={code} />
      }
      return <CodeBlock language={language} code={code} />
    }
    return <pre>{children}</pre>
  },
  // 走到这里的只剩行内代码
  code({ node: _node, className, children, ...rest }) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  }
}

export const Markdown = memo(function Markdown({ text }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      remarkRehypeOptions={REHYPE_OPTIONS}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  )
})
