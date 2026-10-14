// SSR 渲染验证的入口：把一份有代表性的界面程序渲染成 HTML 字符串。
// 由 scripts/render-check.mjs 打包执行。
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { GuncatUiBlock } from '@renderer/guncat-ui/GuncatUiBlock'
import { GuncatUiParts } from '@core/common/GuncatUiParts'

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
