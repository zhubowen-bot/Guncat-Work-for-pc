// 代码块与 Mermaid 图 —— 对齐鸿蒙原版 @luvi/lv-markdown-in 内建的三项能力
// （CommonMark + GFM、代码高亮、Mermaid；LaTeX 走 rehype-katex，见 Markdown.tsx）。
//
// 为什么自己写而不是再引一个 markdown 组件库：渲染层已经用 react-markdown 撑起
// GFM 与 LaTeX 两条链路，缺的只是「围栏代码块要真的高亮 + 要能点一下复制」和
// 「mermaid 围栏要画成图」这两件具体的事；把这两件事做成两个小组件，比换掉整条链路可控。
//
// 语言注册刻意只挑常用的一批：highlight.js 全量包（190+ 语言）会把渲染层产物撑大一倍，
// 而这里之外的围栏退回纯文本展示 —— 视觉上仍然是正常的代码块，只是没有着色。
import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
}

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition)
}

// 围栏里常见的别名 → 已注册语言名（模型写 ts / ets / yml 的都不少）
const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  // ArkTS（鸿蒙原项目的语言）：语法上是 TypeScript 方言
  ets: 'typescript',
  py: 'python',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  vue: 'xml',
  md: 'markdown',
  cs: 'csharp',
  kt: 'kotlin',
  rs: 'rust',
  golang: 'go',
  jsonc: 'json',
  'json5': 'json',
  patch: 'diff'
}

/** 归一化围栏语言标记；不认识的一律返回空串（= 不着色） */
export function normalizeLanguage(raw: string): string {
  const name = raw.trim().toLowerCase()
  if (name === '') {
    return ''
  }
  if (name === 'mermaid') {
    return 'mermaid'
  }
  const mapped = ALIASES[name] ?? name
  return hljs.getLanguage(mapped) !== undefined ? mapped : ''
}

/** 高亮后的 HTML。highlight.js 会转义源码，只插入它自己的 span，因此可安全注入。 */
function highlight(code: string, language: string): string {
  if (language === '' || language === 'mermaid') {
    return escapeHtml(code)
  }
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 代码块：语言标签 + 复制按钮 + 高亮正文 */
export function CodeBlock({ language, code }: { language: string; code: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  const normalized = normalizeLanguage(language)
  const html = useMemo(() => highlight(code, normalized), [code, normalized])

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
      }
    },
    []
  )

  function copy(): void {
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true)
        if (timer.current !== null) {
          window.clearTimeout(timer.current)
        }
        timer.current = window.setTimeout(() => setCopied(false), 1600)
      },
      () => setCopied(false)
    )
  }

  return (
    <div className="code-block">
      <div className="code-block__head">
        <span className="code-block__lang">{language.trim() === '' ? '文本' : language.trim()}</span>
        <button className="code-block__copy" type="button" title="复制这段代码" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="code-block__pre">
        <code
          className={normalized !== '' && normalized !== 'mermaid' ? `hljs language-${normalized}` : 'hljs'}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  )
}

/** 跟随系统深浅色（应用主题就是 prefers-color-scheme，见 styles.css）。
 *  无头渲染（SSR 冒烟验证）里没有 window，这里必须能安全降级为浅色。 */
function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(prefersDark)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handle = (event: MediaQueryListEvent): void => setDark(event.matches)
    query.addEventListener('change', handle)
    return () => query.removeEventListener('change', handle)
  }, [])
  return dark
}

/**
 * Mermaid 围栏 → 真正的图。
 *
 * 两条刻意的取舍：
 *   1. mermaid 体积大（含解析器与各图种布局），只在页面上**真的出现** mermaid 围栏时才动态引入，
 *      纯聊天会话不为此付出启动成本；
 *   2. securityLevel 保持 'strict'（mermaid 默认），图里注入的 HTML/脚本会被拦掉 ——
 *      图是模型给的文本，不该有比正文更高的话语权。
 */
export function MermaidBlock({ code }: { code: string }): React.ReactElement {
  const dark = useDarkMode()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    let cancelled = false
    seq.current += 1
    const id = `guncat-mermaid-${seq.current}-${Date.now()}`
    // mermaid 在渲染期间会往 body 里塞临时节点（`#d<id>` / `#<id>`），
    // 失败时**不一定清干净** —— 用户看到页面最底下冒出一串
    // 「Syntax error in text / mermaid version 11.17.2」就是这些残留节点。
    // 所以这里渲染前先记账、渲染后一律清掉（成功失败都清）。
    const cleanupNodes = (): void => {
      for (const stray of [id, `d${id}`]) {
        document.getElementById(stray)?.remove()
      }
    }
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          // 关键：不让 mermaid 自己把「错误图」画进页面
          // （默认行为就是往 DOM 里插一张写着 Syntax error 的图）
          suppressErrorRendering: true,
          fontFamily:
            '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
        })
        // 先解析再渲染：语法不过关时根本不要走 render（render 报错就会留下上面那些节点）
        const parsed = await mermaid
          .parse(code, { suppressErrors: true })
          .then(() => true)
          .catch(() => false)
        if (!parsed) {
          throw new Error('语法检查未通过')
        }
        const result = await mermaid.render(id, code)
        cleanupNodes()
        if (!cancelled) {
          setSvg(result.svg)
          setError('')
        }
      } catch (e) {
        cleanupNodes()
        if (!cancelled) {
          setSvg('')
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
      cleanupNodes()
    }
  }, [code, dark])

  if (error !== '') {
    // 画不出来时**静默**退回源码：不给红色报错横幅。
    // 用户明确要求隐藏报错提示 —— mermaid 的报错经常是「其实画出来了」的误报，
    // 一屏红字只会让人以为页面坏了；源码本身还在，用户能看出模型写了什么。
    return <CodeBlock language="mermaid" code={code} />
  }

  if (svg === '') {
    return (
      <div className="mermaid-block mermaid-block--pending">
        <span className="spinner spinner--sm" />
        正在绘图…
      </div>
    )
  }

  return (
    <div
      className="mermaid-block__canvas"
      // mermaid 自己产出的 SVG（securityLevel: 'strict' 已禁用其内部脚本与外链）
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
