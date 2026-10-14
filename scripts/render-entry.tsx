// SSR 渲染验证的入口：把一份有代表性的界面程序渲染成 HTML 字符串。
// 由 scripts/render-check.mjs 打包执行。
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { GuncatUiBlock } from '@renderer/guncat-ui/GuncatUiBlock'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { docxFileName } from '@renderer/fileName'
import {
  WORK_AGENT_ID,
  INTERACTIVE_AGENT_ID,
  agentIdForMode,
  agentOfConversation,
  buildAgentList,
  conversationMeta,
  conversationTitle,
  engineIdOfConversation,
  formatTimeLabel,
  modeForAgentId
} from '@renderer/conversations'
import {
  formatDuration,
  formatStats,
  groupTurns,
  processTitle,
  toolArgsSummary,
  toolDisplayName,
  toolIconKind,
  toolStatus,
  turnStats
} from '@renderer/turns'
import {
  IconBrain,
  IconClose,
  IconDownload,
  IconInteractive,
  IconMic,
  IconSend,
  IconSettings,
  IconStopCircle,
  IconTrash,
  IconWork
} from '@renderer/icons'
import { AgentItem, ConvItem } from '@renderer/components/Sidebar'
import { GroupedTurn, WorkTurn } from '@renderer/components/Timeline'
import { Markdown } from '@renderer/components/Markdown'
import { Composer } from '@renderer/components/Composer'
import { WorkspacePanel, workspaceFileIcon } from '@renderer/components/WorkspacePanel'
import { marqueeText } from '@renderer/components/MessageView'
import type { MessageDto } from '@ipc/contract'

/** 导出文件名推导 —— 纯函数，可直接断言 */
export { docxFileName }

/** 会话列表与引擎选择的纯函数（对应原版 DswSidebar.getConvTitle / selectAgent） */
export {
  WORK_AGENT_ID,
  INTERACTIVE_AGENT_ID,
  agentIdForMode,
  agentOfConversation,
  buildAgentList,
  conversationMeta,
  conversationTitle,
  engineIdOfConversation,
  formatTimeLabel,
  modeForAgentId
}

/** 回合归组与工具行展示的纯函数（对应原版 buildWorkTimeline / WorkStepFormat） */
export {
  formatDuration,
  formatStats,
  groupTurns,
  processTitle,
  toolArgsSummary,
  toolDisplayName,
  toolIconKind,
  toolStatus,
  turnStats
}

export { renderIcons }

/**
 * 工作模式的单回合渲染（原版 section='full'）：思考条 / 正文 / 工具行**逐轮直接陈列**，
 * 不做整回合收纳。这与交互模式的 GroupedTurn 是两套布局，必须分别钉住。
 */
export function renderWorkTurn(running = false): string {
  return renderToStaticMarkup(
    createElement(WorkTurn, {
      turn: groupTurns(SHELL_MESSAGES)[0],
      running,
      onEditToInput: () => {}
    })
  )
}

/** 交互模式的单回合渲染（原版 section='grouped'）：整个回合收进一条活动折叠栏。
 *  pendingBody=true 模拟「正文还没开始输出」的流式中间态 —— 此时折叠栏默认展开。 */
export function renderGroupedTurn(running = false, pendingBody = false): string {
  let messages = SHELL_MESSAGES
  if (pendingBody) {
    messages = SHELL_MESSAGES.map((m) => (m.id === 'm3' ? { ...m, content: '', displayContent: '' } : m))
  }
  return renderToStaticMarkup(
    createElement(GroupedTurn, {
      turn: groupTurns(messages)[0],
      running,
      lastAssistantId: 'm3',
      onEditToInput: () => {}
    })
  )
}

/** 思考跑马灯取文本末尾 400 字并压成单行（原版 getMarqueeText） */
export { marqueeText }
export { workspaceFileIcon }

/**
 * 工作区面板（SSR 下 zustand 读初始状态：没有会话、工作区为空）。
 * 用户报障「工作区上传文件找不到入口」——这里钉住那个入口在**空态**下也存在。
 */
export function renderWorkspacePanel(): string {
  return renderToStaticMarkup(createElement(WorkspacePanel))
}

/** 工作区文件行的扩展名图标：返回「扩展名 → 渲染出来的 SVG」映射，供断言分类是否生效 */
export function renderWorkspaceFileIcons(): Record<string, string> {
  const names = ['a.png', 'a.pdf', 'a.zip', 'a.py', 'a.mp4', 'a.mp3', 'a.unknown']
  const out: Record<string, string> = {}
  for (const name of names) {
    out[name] = renderToStaticMarkup(workspaceFileIcon(name))
  }
  return out
}

/**
 * 输入区。附件入口（回形针）只在聊天模式给 —— 工作/交互模式的素材入口是工作区，
 * 两条路是不同的事，这里把这条分界钉住。
 */
export function renderComposer(mode: string): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      running: false,
      mode,
      onSend: () => {},
      onAbort: () => {}
    })
  )
}

/** Markdown 渲染：断言脚注回跳不是第三方默认的「↩」符号 */
export function renderMarkdown(): string {
  return renderToStaticMarkup(
    createElement(Markdown, { text: '正文有一处脚注[^1]。\n\n[^1]: 这是脚注内容。\n' })
  )
}

/**
 * Markdown 的三项重能力（用户报障：mermaid 画不出、代码块不正常、LaTeX 不渲染）。
 * 逐项覆盖：行内/块级公式、带语言的围栏代码块（含高亮）、mermaid 围栏、裸围栏。
 */
export function renderMarkdownFeatures(): string {
  const text = [
    '行内公式 $E = mc^2$ 就写在这里。',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '```python',
    'def hello(name):',
    '    return f"hi {name}"',
    '```',
    '',
    '```mermaid',
    'flowchart TD',
    '  A[开始] --> B[结束]',
    '```',
    '',
    '```',
    '没有语言标记的围栏',
    '```',
    ''
  ].join('\n')
  return renderToStaticMarkup(createElement(Markdown, { text }))
}

/**
 * 侧栏条目 + 工作模式单个回合的 SSR 渲染。
 *
 * 为什么渲染这两个「纯 props 组件」而不是整页：
 *   zustand v5 在 SSR 里刻意读 getInitialState()（保证水合一致），
 *   所以整页 SSR 只会看到 store 的初始值，塞不进夹具状态。
 *   把布局里最需要钉住的两块（会话条目、回合归组）做成 props 驱动，
 *   就能在无头环境里断言「标题落到 DOM 上了没有」「一个任务下是不是只有一个过程区」——
 *   恰好就是用户报障的第 2 条和第 5 条。
 */
export function renderShell(running = false): string {
  const engines = buildAgentList(AGENT_FIXTURE)
  const now = new Date(2024, 8, 10, 15, 30, 0).getTime()

  const convRows = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ConvItem, {
        summary: {
          id: 'conv-a',
          title: '做一个季度销售复盘',
          agentId: 'guncat-3.1-flash',
          mode: 'work',
          updatedAt: new Date(2024, 8, 10, 9, 5, 0).getTime(),
          messageCount: 3,
          lastPreview: '这是最终答复'
        },
        engines,
        active: true,
        now,
        onSelect: () => {},
        onDelete: () => {}
      }),
      // 移植早期的脏数据：标题被写成了引擎名
      createElement(ConvItem, {
        summary: {
          id: 'conv-b',
          title: '轻简模式',
          agentId: 'guncat-3.1-flash',
          mode: 'chat',
          updatedAt: 0,
          messageCount: 0,
          lastPreview: ''
        },
        engines,
        active: false,
        now,
        onSelect: () => {},
        onDelete: () => {}
      }),
      createElement(AgentItem, { agent: engines[0], active: false, onSelect: () => {} }),
      createElement(AgentItem, { agent: engines[1], active: true, onSelect: () => {} })
    )
  )

  const timeline = renderToStaticMarkup(
    createElement(
      'div',
      { className: 'loop-timeline' },
      createElement(WorkTurn, {
        turn: groupTurns(SHELL_MESSAGES)[0],
        running,
        onEditToInput: () => {}
      })
    )
  )

  return convRows + timeline
}

const AGENT_FIXTURE = [
  {
    id: 'guncat-3.1-flash',
    name: '轻简模式',
    description: '日常聊天智能体',
    shortDescription: 'Guncat 3.1-Flash',
    icon: '',
    category: '通用智能体',
    prompt: ''
  }
]

function shellMessage(
  id: string,
  role: string,
  content: string,
  extra: Record<string, unknown> = {}
): MessageDto {
  return {
    id,
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
  } as MessageDto
}

/** 一个用户请求 + 两轮 assistant（工具行只在第一轮）+ 最终答复 */
const SHELL_MESSAGES: MessageDto[] = [
  shellMessage('m0', 'user', '做一个季度销售复盘'),
  shellMessage('m1', 'assistant', '先把数据读进来', {
    reasoning: '需要先看原始数据',
    toolCalls: [
      {
        id: 't1',
        name: 'read_file',
        argsJson: '{"path":"sales.csv"}',
        result: 'ok',
        status: 'ok',
        startedAt: 0,
        finishedAt: 0,
        diff: ''
      }
    ]
  }),
  shellMessage('m2', 'assistant', '这是中间结论'),
  shellMessage('m3', 'assistant', '这是最终答复', { tokenSpeed: 20, cacheHitRate: 0.5 })
]

/** 把全部图标渲染成 HTML：断言统一规格（viewBox / currentColor / 无 emoji） */
function renderIcons(): string {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(IconWork, { size: 20 }),
      createElement(IconInteractive, { size: 20 }),
      createElement(IconMic, {}),
      createElement(IconSend, {}),
      createElement(IconStopCircle, {}),
      createElement(IconDownload, {}),
      createElement(IconTrash, {}),
      createElement(IconSettings, {}),
      createElement(IconClose, {}),
      createElement(IconBrain, {})
    )
  )
}


const PROGRAM = [
  '$amount = 30',
  'root = Card([',
  '  CardHeader("季度销售复盘", "2024 Q3"),',
  '  TextContent("金额 " + $amount + " 万"),',
  '  MetricIndicatorInline("1,284", "同比", {direction: "up", value: 18.6}),',
  '  Slider("amount", "discrete", 0, 200, 5, [30], "金额", $amount),',
  '  BarChart(["1月","2月","3月"], [Series("本季", [120, 132, 101]), Series("上季", [90, 110, 95])], "grouped", "月份", "万元", 200),',
  '  Table([Col("区域", ["华东","华南"]), Col("营收", [820, 464], "number")]),',
  '  Tabs([TabItem("a", "概览", [TextContent("概览内容")]), TabItem("b", "明细", [TextContent("明细内容")])]),',
  '  Accordion([AccordionItem("k", "更多说明", [TextContent("折叠里的字")])]),',
  '  Steps([StepsItem("立项","已完成"), StepsItem("开发","进行中")]),',
  '  TagBlock(["标签甲","标签乙"]),',
  '  Callout("warn", "注意", "这是一条提醒"),',
  '  CodeBlock("json", "{\\"a\\": 1}"),',
  '  PieChart(["A","B"], [60, 40], "donut"),',
  '  EntityList([{left: "合计", right: "1,284"}]),',
  '  Form("参数", Buttons([Button("重算", @ToAssistant("换口径重算"))]), [',
  '    FormControl("口径", Select("scope", [SelectItem("customers","按客户")], "请选择", {}, $scope)),',
  '    FormControl("周期", Slider("days","discrete",7,90,1,[30],"天数",$days))',
  '  ]),',
  '  Button("仅本地按钮", @ToAssistant("点了按钮"))',
  '])'
].join('\n')

const FENCE = '```'

export function renderProgram(): string {
  const content = '说明文字在前。\n\n' + FENCE + 'guncat-ui\n' + PROGRAM + '\n' + FENCE + '\n'
  return renderToStaticMarkup(
    createElement(GuncatUiBlock, {
      content,
      interactive: true,
      onSend: () => {}
    })
  )
}

/** 裸程序（不带围栏、不带前置说明），验证围栏可选 */
export function renderBare(): string {
  return renderToStaticMarkup(
    createElement(GuncatUiBlock, {
      content: PROGRAM,
      interactive: false,
      onSend: () => {}
    })
  )
}

/**
 * 复现 MessageView 的组合方式：纯文本片段走 Markdown，界面片段走 GuncatUiBlock。
 * 界面块本身只负责界面，正文里的说明文字由外层渲染 —— 这条组合关系值得单独钉住。
 */
export function renderComposed(): string {
  const content = '说明文字在前。\n\n' + FENCE + 'guncat-ui\n' + PROGRAM + '\n' + FENCE + '\n'
  const parts = GuncatUiParts.build(content, true)
  const text = createElement('div', { className: 'msg__body' }, parts.textOnly)
  const block = createElement(GuncatUiBlock, {
    content,
    interactive: true,
    onSend: () => {}
  })
  return renderToStaticMarkup(createElement('div', null, text, block))
}
