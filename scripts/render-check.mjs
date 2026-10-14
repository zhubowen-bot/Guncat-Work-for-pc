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

// --- 会话列表：标题从哪来、时间怎么显示（用户报障的第 2 条） ---
//
// 事故回顾：主进程建会话时把「引擎名」写进了 title，而标题推导的守卫只认 ''/'新对话'，
// 于是侧栏里每条会话都顶着一个「轻简模式」。下面这些断言把正确的口径钉死。
console.log('\n15. 会话标题 / 侧栏元信息（纯函数）')
const AGENTS = [
  { id: 'guncat-3.1-flash', name: '轻简模式', description: '', shortDescription: '', icon: '', category: '通用智能体', prompt: '' },
  { id: 'guncat-3.0-pro', name: '专家模式', description: '', shortDescription: '', icon: '', category: '通用智能体', prompt: '' }
]
const ENGINES = mod.buildAgentList(AGENTS)

check(
  '引擎列表：工作 / 交互两个虚拟智能体排在最前（原版 unshift + splice）',
  ENGINES[0].id === mod.INTERACTIVE_AGENT_ID && ENGINES[1].id === mod.WORK_AGENT_ID,
  ENGINES.map((a) => a.id).join(',')
)
check('引擎列表：真实智能体一个不少且在后面', ENGINES.length === 4 && ENGINES[2].id === 'guncat-3.1-flash')

check(
  '标题：有标题就用标题',
  mod.conversationTitle({ title: '季度复盘', agentId: 'guncat-3.1-flash', mode: 'chat' }, ENGINES) ===
    '季度复盘'
)
check(
  '标题：空标题回退成「与 <引擎名> 的对话」',
  mod.conversationTitle({ title: '', agentId: 'guncat-3.1-flash', mode: 'chat' }, ENGINES) ===
    '与 轻简模式 的对话'
)
check(
  '标题：标题恰好等于引擎名（脏数据）同样回退 —— 这就是「每条都叫轻简模式」的修复点',
  mod.conversationTitle(
    { title: '轻简模式', agentId: 'guncat-3.1-flash', mode: 'chat' },
    ENGINES
  ) === '与 轻简模式 的对话'
)
check(
  '标题：工作模式会话的脏数据回退成「与 工作模式 的对话」（模式优先于 agentId）',
  mod.conversationTitle(
    { title: '工作模式', agentId: 'guncat-3.1-flash', mode: 'work' },
    ENGINES
  ) === '与 工作模式 的对话'
)
check(
  '标题：引擎完全对不上时兜底「新会话」',
  mod.conversationTitle({ title: '', agentId: 'ghost', mode: 'chat' }, ENGINES) === '新会话'
)
check(
  '归属：工作形态的会话归属 work 引擎（移植早期 agentId 还是真实智能体）',
  mod.engineIdOfConversation({ agentId: 'guncat-3.1-flash', mode: 'work' }) === mod.WORK_AGENT_ID &&
    mod.agentOfConversation({ agentId: 'guncat-3.1-flash', mode: 'work' }, ENGINES).name === '工作模式'
)
check(
  '归属：聊天形态的会话仍归属它自己的智能体',
  mod.engineIdOfConversation({ agentId: 'guncat-3.0-pro', mode: 'chat' }) === 'guncat-3.0-pro'
)
check(
  '形态 ↔ 引擎：work / interactive / chat 三向往返一致',
  mod.modeForAgentId(mod.agentIdForMode('work', AGENTS, 'guncat-3.1-flash')) === 'work' &&
    mod.modeForAgentId(mod.agentIdForMode('interactive', AGENTS, 'guncat-3.1-flash')) ===
      'interactive' &&
    mod.agentIdForMode('chat', AGENTS, 'guncat-3.0-pro') === 'guncat-3.0-pro'
)

// 时间显示：以固定「现在」断言，避免测试自己漂移
const NOW = new Date(2024, 8, 10, 15, 30, 0).getTime()
const TODAY = new Date(2024, 8, 10, 9, 5, 0).getTime()
const SAME_YEAR = new Date(2024, 2, 3, 9, 5, 0).getTime()
const OLD_YEAR = new Date(2023, 2, 3, 9, 5, 0).getTime()
check('时间：今天的只显示 时:分', mod.formatTimeLabel(TODAY, NOW) === '09:05', mod.formatTimeLabel(TODAY, NOW))
check('时间：今年其它日期显示 月/日', mod.formatTimeLabel(SAME_YEAR, NOW) === '3/3', mod.formatTimeLabel(SAME_YEAR, NOW))
check('时间：跨年显示 年/月/日', mod.formatTimeLabel(OLD_YEAR, NOW) === '2023/3/3', mod.formatTimeLabel(OLD_YEAR, NOW))
check('时间：没有时间戳时返回空串', mod.formatTimeLabel(0, NOW) === '')

check(
  '元信息：引擎名 · 时间 · 消息数（原版只有标题，桌面端宽屏补上这三个字段）',
  mod.conversationMeta(
    { agentId: 'guncat-3.1-flash', mode: 'chat', updatedAt: TODAY, messageCount: 8 },
    ENGINES,
    NOW
  ) === '轻简模式 · 09:05 · 8 条',
  mod.conversationMeta(
    { agentId: 'guncat-3.1-flash', mode: 'chat', updatedAt: TODAY, messageCount: 8 },
    ENGINES,
    NOW
  )
)
check(
  '元信息：空会话不显示「0 条」',
  mod.conversationMeta(
    { agentId: 'guncat-3.1-flash', mode: 'chat', updatedAt: 0, messageCount: 0 },
    ENGINES,
    NOW
  ) === '轻简模式'
)

// --- 工作模式的多轮归组（用户报障的第 5 条） ---
console.log('\n16. 回合归组 / 工具行（纯函数）')
function msg(role, content, extra = {}) {
  return {
    id: `${role}-${content}`,
    role,
    content,
    displayContent: '',
    reasoning: '',
    attachments: [],
    toolCalls: [],
    timestamp: 0,
    tokenSpeed: -1,
    cacheHitRate: -1,
    ...extra
  }
}

const MESSAGES = [
  msg('user', '做个复盘'),
  msg('assistant', '先读文件', {
    reasoning: '我需要先看数据',
    toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a.csv"}', result: 'ok', status: 'ok' }]
  }),
  msg('assistant', '中轮结论', {
    toolCalls: [
      { id: 'c2', name: 'write_docx', argsJson: '{"path":"r.docx"}', result: '', status: 'error' }
    ]
  }),
  msg('assistant', '最终答复', { tokenSpeed: 12.34, cacheHitRate: 0.5 }),
  msg('user', '再改一版'),
  msg('assistant', '第二版答复')
]
const TURNS = mod.groupTurns(MESSAGES)
check('归组：一个用户请求 + 其后连续 assistant = 一个回合', TURNS.length === 2, `${TURNS.length} 个回合`)
check('归组：第一回合含 3 轮 assistant', TURNS[0].rounds.length === 3)
check('归组：第二回合含 1 轮 assistant', TURNS[1].rounds.length === 1)
check('归组：回合里的 user 就是那条用户消息', TURNS[0].user.content === '做个复盘')
check(
  '归组：前导 assistant 不会被丢弃（历史数据缺 user 时的兜底）',
  mod.groupTurns([msg('assistant', '孤儿回答')])[0].user === null
)

const STATS = mod.turnStats(TURNS[0])
check('统计：工具调用数与失败数分别计数', STATS.toolCalls === 2 && STATS.failedTools === 1, JSON.stringify(STATS))
check('统计：没有 running 的工具时不算执行中', STATS.running === false)
check(
  '统计：有 running 的工具即算执行中',
  mod.turnStats({
    index: 0,
    user: null,
    rounds: [msg('assistant', 'x', { toolCalls: [{ id: 'c', name: 'bash', argsJson: '{}', result: '', status: 'running' }] })]
  }).running === true
)
check(
  '「过程」标题把轮数与工具次数说清楚',
  mod.processTitle(STATS) === '过程 · 3 轮 · 2 次工具调用 · 1 次失败',
  mod.processTitle(STATS)
)
check(
  '「过程」标题：只有一轮时省略轮数',
  mod.processTitle({ rounds: 1, toolCalls: 1, failedTools: 0, chars: 0, running: false }) ===
    '过程 · 1 次工具调用'
)
check('最终答复取回合里最后一条 assistant', mod.groupTurns(MESSAGES)[0].rounds.at(-1).content === '最终答复')

check('统计行：输出速度与缓存命中', mod.formatStats(MESSAGES[3]) === '12.3 字符/秒 · 缓存命中 50%', mod.formatStats(MESSAGES[3]))
check('统计行：无数据时为空串', mod.formatStats(MESSAGES[5]) === '')
check('耗时：小于一秒用 ms', mod.formatDuration(320) === '320ms')
check('耗时：大于一秒用 s', mod.formatDuration(2400) === '2.4s')

check('工具标题：read_file → Read', mod.toolDisplayName('read_file') === 'Read')
check('工具标题：未知工具名原样返回', mod.toolDisplayName('whatever_tool') === 'whatever_tool')
check(
  '工具参数摘要：单参数省略键名（对齐 CLI 工具行观感）',
  mod.toolArgsSummary('{"path":"docs/a.md"}') === 'docs/a.md',
  mod.toolArgsSummary('{"path":"docs/a.md"}')
)
check(
  '工具参数摘要：流式未收口的 JSON 不解析，直接截断展示',
  mod.toolArgsSummary('{"path":"docs/a.md","content":"还没写完').startsWith('{"path"'),
  mod.toolArgsSummary('{"path":"docs/a.md","content":"还没写完')
)
check('工具状态：error/running/ok 三态', mod.toolStatus({ status: 'error' }).state === 'error' && mod.toolStatus({ status: 'running' }).state === 'running' && mod.toolStatus({ status: 'ok' }).state === 'ok')
check(
  '工具图标分类：读 / 写 / 搜 / 网 各自归位',
  mod.toolIconKind('read_file') === 'read' &&
    mod.toolIconKind('write_docx') === 'write' &&
    mod.toolIconKind('grep') === 'search' &&
    mod.toolIconKind('local_web_search') === 'web'
)

// --- SVG 图标集：统一规格 + 没有 emoji ---
console.log('\n17. SVG 图标集')
const iconHtml = mod.renderIcons()
check('图标渲染为行内 SVG', iconHtml.includes('<svg'))
check('图标统一 24×24 视图框', iconHtml.includes('viewBox="0 0 24 24"'))
check('图标颜色走 currentColor', iconHtml.includes('stroke="currentColor"'))
check('图标默认描边不填充', iconHtml.includes('fill="none"'))
check('图标线宽统一 1.6', iconHtml.includes('stroke-width="1.6"'))
check(
  '图标集里没有任何 emoji / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f]/.test(
    iconHtml
  )
)

// --- 侧栏条目 + 工作模式回合的实际 DOM（SSR） ---
console.log('\n18. 侧栏条目与工作模式回合（SSR 结构）')
const shell = mod.renderShell(false)
const shellRunning = mod.renderShell(true)
check('会话条目渲染出标题与元信息结构', shell.includes('conv-item__title') && shell.includes('conv-item__meta'))
check('会话条目：有标题的会话显示标题', shell.includes('做一个季度销售复盘'))
check(
  '会话条目：脏数据（标题=引擎名）回退成「与 轻简模式 的对话」',
  shell.includes('与 轻简模式 的对话')
)
check(
  '会话条目：元信息是「引擎名 · 时间 · 消息数」（工作形态归工作模式引擎）',
  shell.includes('工作模式 · 09:05 · 3 条')
)
check('引擎条目渲染出工作模式与交互模式', shell.includes('agent-item') && shell.includes('工作模式') && shell.includes('交互模式'))
check('引擎条目带选中态（原版 sidebar_item_active）', shell.includes('data-active="true"'))
check('任务卡渲染用户请求', shell.includes('task-card') && shell.includes('做一个季度销售复盘'))
check(
  '一个任务下只有一个「过程」折叠区（修复前是每条 assistant 各挂一条工具折叠条）',
  (shell.match(/disclosure__title">过程/g) ?? []).length === 1,
  `${(shell.match(/disclosure__title">过程/g) ?? []).length} 个过程区`
)
check(
  '过程区标题把轮数与工具次数写清楚',
  shell.includes('过程') && shell.includes('3 轮') && shell.includes('1 次工具调用')
)
check('中间轮不单独成块（只有最终答复有 answer 块）', (shell.match(/class="answer"/g) ?? []).length === 1)
check('最终答复是主体并带操作行', shell.includes('这是最终答复') && shell.includes('重答'))
check('统计行口径与原版一致（字符/秒 + 缓存命中）', shell.includes('20.0 字符/秒') && shell.includes('缓存命中 50%'))
check(
  '过程区收起时不渲染工具细节（点开才展开）',
  !shell.includes('sales.csv'),
  '细节应只在展开后出现'
)
check(
  '执行中的过程区默认展开，工具行与中间轮正文都在',
  shellRunning.includes('sales.csv') && shellRunning.includes('这是中间结论') && shellRunning.includes('Read')
)
check(
  '渲染出来的 DOM 里没有 emoji / 装饰符号',
  !/[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ufe0f\u{1f000}-\u{1faff}]/u.test(
    shell + shellRunning
  )
)

console.log(`\n渲染验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
  process.exitCode = 1
}
