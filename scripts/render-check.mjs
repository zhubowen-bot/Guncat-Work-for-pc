// 交互模式渲染器的无头验证：用 react-dom/server 把界面程序渲染成 HTML 字符串，
// 断言关键组件确实出现在产物里。
//
// 为什么值得做：Electron GUI 在本机跑不起来，但「元素树 → React 组件树」这一段
// 完全可以在 Node 里跑通（SSR 不执行 useEffect，因此不依赖 ResizeObserver / window）。
// 这样阶段二最核心的渲染器就不会只停留在「类型检查通过」。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { root, alias } from './esbuild-aliases.mjs'

const dir = path.join(root, '.smoke')
fs.mkdirSync(dir, { recursive: true })
const outfile = path.join(dir, 'render.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/render-entry.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: ['electron'],
  // react / react-dom / markdown 依赖链里有 CJS 内部 require，
  // 打进 ESM 会失败，交给 Node 自己解析更稳。
  packages: 'external',
  alias: { ...alias, '@renderer': path.join(root, 'src/renderer/src') },
  // SSR 不需要样式：把 CSS 置空，避免 Node 解析 CSS
  loader: { '.css': 'empty' },
  logLevel: 'error'
})

const mod = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

console.log('\n14. 交互模式渲染器（React SSR）')
const html = mod.renderProgram()

check('渲染产出非空 HTML', html.length > 800, `${html.length} 字符`)
check('卡片外壳已渲染', html.includes('class="gui"'))
check('卡片标题正确', html.includes('季度销售复盘'))
check('副标题正确', html.includes('2024 Q3'))
check('$绑定表达式已求值', html.includes('金额 30 万'))
check('指标卡已渲染', html.includes('1,284'))
check('趋势方向已渲染', html.includes('gui-trend--up'))
check('滑块已渲染', html.includes('type="range"'))
check('滑块默认值正确', html.includes('value="30"'))
check('柱状图 SVG 已渲染', html.includes('<svg'))
check('柱状图图例已渲染', html.includes('本季') && html.includes('上季'))
check('表格已渲染', html.includes('<table') && html.includes('华东') && html.includes('820'))
check('选项卡已渲染', html.includes('概览') && html.includes('明细'))
check('折叠面板已渲染', html.includes('更多说明'))
check('步骤条已渲染', html.includes('立项') && html.includes('进行中'))
check('标签块已渲染', html.includes('标签甲'))
check('Callout 变体已渲染', html.includes('gui-callout--warn'))
check('代码块已渲染', html.includes('gui-code'))
check('饼图已渲染', html.includes('<path'))
check('键值清单已渲染', html.includes('合计'))
check('表单已渲染', html.includes('gui-form') && html.includes('口径'))
check('下拉框已渲染', html.includes('<select'))
check('按钮文案已渲染', html.includes('重算'))
check('界面块本身不吞正文（正文由外层渲染）', !html.includes('说明文字在前'))

// 裸程序（无围栏）也应可渲染；只读态应带置灰标记
const bareHtml = mod.renderBare()
check('裸程序（无围栏）可渲染', bareHtml.includes('季度销售复盘') && bareHtml.includes('class="gui gui--stale"'))

// MessageView 的组合方式：正文 Markdown + 界面块，两者都要在
const composedHtml = mod.renderComposed()
check(
  '正文与界面可共存（MessageView 组合方式）',
  composedHtml.includes('说明文字在前') && composedHtml.includes('季度销售复盘')
)

// --- 导出 Word 的文件名推导 ---
// 事故（用户实测）：最初直接拿正文前 20 个字符当文件名，而正文里几乎必然带换行 ——
// Windows 的保存对话框直接报「文件名无效」，导出功能等于不可用。
// 这类 bug 无法靠「看着像对的」发现，必须逐类非法字符断言。
const name = mod.docxFileName
check(
  '文件名：正文里的换行被折叠（这是本次事故的直接原因）',
  !/[\r\n]/.test(name('第一行\n第二行\n\n第三行')),
  name('第一行\n第二行')
)
check('文件名：制表符等空白也被折叠', !/\s{2,}/.test(name('甲\t乙  丙')), name('甲\t乙  丙'))
check('文件名：去掉 Windows 禁止的九个字符', !/[\\/:*?"<>|]/.test(name('a\\b/c:d*e?f"g<h>i|j')), name('a\\b/c:d*e?f"g<h>i|j'))
check('文件名：去掉控制字符', !/[\u0000-\u001f\u007f]/.test(name('甲\u0001乙\u007f丙')))
check(
  '文件名：不以点或空格结尾（Win32 会静默丢弃它们）',
  (() => {
    const n = name('结尾有点......   ')
    return !/\.docx$/.test(n) || n === '结尾有点.docx'
  })(),
  name('结尾有点......   ')
)
check('文件名：以 .docx 结尾', name('任意正文').endsWith('.docx'))
check('文件名：超长正文被截断', name('甲'.repeat(200)).length < 60, `${name('甲'.repeat(200)).length} 字符`)
check('文件名：正文全是非法字符时回退到默认名', name('\\/:*?"<>|') === 'Guncat 回答.docx', name('\\/:*?"<>|'))
check('文件名：空正文回退到默认名', name('') === 'Guncat 回答.docx')
// 用户实际踩到的那一条：正文以「如下」开头且带换行
const realCase = name('沙箱测试完成，各项能力逐项验证如下\n\n1. 文件读写\n2. CSV 转换')
check(
  '文件名：复现用户的实际场景（带换行的长正文）',
  !/[\r\n]/.test(realCase) && realCase.endsWith('.docx') && realCase.length < 60,
  realCase
)

console.log(`\n渲染验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
  process.exitCode = 1
}
