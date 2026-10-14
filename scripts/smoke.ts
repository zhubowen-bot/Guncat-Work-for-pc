// 无头冒烟验证：在纯 Node 下跑通移植过来的业务内核。
//
// 为什么需要它：Electron 的 GUI 在本机沙箱里无法启动（进程被宿主作业对象拒绝），
// 但应用真正有风险的部分是「从鸿蒙移植过来的 3.5 万行业务逻辑」，
// 而不是 Electron 外壳。这个脚本把内核按真实调用链跑一遍，
// 用可复现的方式证明移植是活的。
//
// 运行：node scripts/run-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initAppPaths } from '../src/core/platform/appPaths'
import { appContext } from '../src/core/platform/kit/AbilityKit'
import { AgentLoader } from '../src/core/service/AgentLoader'
import { WorkFileService } from '../src/core/service/WorkFileService'
import { WorkToolRunner } from '../src/core/service/WorkToolRunner'
import { WorkSkillService } from '../src/core/service/WorkSkillService'
import { StorageManager } from '../src/core/data/StorageManager'
import { ChatService, resolveEndpointUrl } from '../src/core/service/ChatService'
import { AgentLoopService } from '../src/core/service/AgentLoopService'
import { ApiConfig } from '../src/core/model/ApiConfig'
import { Conversation } from '../src/core/model/Conversation'
import { Message } from '../src/core/model/Message'
import { ToolRegistry } from '../src/core/common/ToolRegistry'
import { GuncatUiLang } from '../src/core/common/GuncatUiLang'
import { DataPipeline } from '../src/core/common/DataPipeline'
import { runJs } from '../src/core/platform/native/libguncatjs'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== '' ? ' — ' + detail : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), `guncat-smoke-${Date.now()}`)
  const resourcesRoot = path.resolve('resources')
  initAppPaths({ dataRoot: root, resourcesRoot })
  const ctx = appContext()

  console.log(`数据目录: ${root}`)
  console.log(`资源目录: ${resourcesRoot}`)

  // ===== 1. 平台路径 =====
  section('1. 平台适配层 · 应用路径')
  check('filesDir 已创建', fs.existsSync(ctx.filesDir), ctx.filesDir)
  check('tempDir 已创建', fs.existsSync(ctx.tempDir))
  check('resourceManager 可读 agents.json', ctx.resourceManager.getRawFileContentSync('agents.json').length > 0)

  // ===== 2. 智能体加载（rawfile → 文件系统） =====
  section('2. 智能体加载（rawfile 适配）')
  const agents = await AgentLoader.loadAllAgents(ctx)
  check('智能体数量 > 0', agents.length > 0, `${agents.length} 个`)
  const named = agents.filter((a) => a.name !== '')
  check('智能体均有名称', named.length === agents.length)
  const withPrompt = agents.filter((a) => a.systemPrompt.length > 200)
  check('智能体提示词已加载', withPrompt.length > 0, `${withPrompt.length}/${agents.length} 个提示词 > 200 字`)

  // ===== 3. 工具注册表 =====
  section('3. 内置工具表')
  const toolDefs = WorkFileService.toolDefs(false)
  const toolNames = toolDefs.map((d) => String((d as Record<string, unknown>)['name'] ?? ''))
  check('工具数量 > 0', toolDefs.length > 0, `${toolDefs.length} 个`)
  for (const required of ['write_file', 'read_file', 'list_files', 'run_js', 'transform_file', 'todo_write']) {
    check(`包含核心工具 ${required}`, toolNames.includes(required))
  }
  const interactive = AgentLoopService.interactiveToolDefs(false)
  check(
    '交互模式工具面被裁剪（少于工作模式）',
    interactive.length > 0 && interactive.length < toolDefs.length,
    `工作 ${toolDefs.length} → 交互 ${interactive.length}`
  )

  // ===== 4. 技能库 =====
  section('4. 技能库（rawfile 技能文档）')
  // 技能是「用到才同步进注册中心」的：先取目录文本触发一次扫描
  const skillText = WorkSkillService.listText()
  check('技能目录文本非空', skillText.length > 0, `${skillText.length} 字`)
  const skills = ToolRegistry.skillList()
  check('技能已同步进工具注册中心', skills.length > 0, `${skills.length} 项`)
  const loaded = await WorkSkillService.load(ctx, 'data', 'SKILL.md')
  check('可按需加载技能正文', loaded.length > 100, `data/SKILL.md ${loaded.length} 字`)

  // ===== 5. 沙箱工作区文件操作 =====
  section('5. 沙箱工作区')
  const convId = 'smoke-conv-1'
  WorkFileService.ensureWorkspace(ctx, convId)
  const wsRoot = WorkFileService.workspaceRoot(ctx, convId)
  check('工作区目录已建立', fs.existsSync(wsRoot), wsRoot)

  const write = await WorkToolRunner.execute(
    ctx,
    convId,
    'write_file',
    JSON.stringify({ path: 'notes/demo.txt', content: 'line1\nline2\nline3\n' })
  )
  check('write_file 成功', write.ok, write.output.slice(0, 120))

  const read = await WorkToolRunner.execute(ctx, convId, 'read_file', JSON.stringify({ path: 'notes/demo.txt' }))
  check('read_file 读回原文', read.ok && read.output.includes('line2'), read.output.slice(0, 80))

  const list = await WorkToolRunner.execute(ctx, convId, 'list_files', JSON.stringify({ path: '.' }))
  check('list_files 能列出产物', list.ok && list.output.includes('notes'))

  const tree = WorkFileService.listWorkspaceTree(ctx, convId)
  check('工作区树可用', tree.includes('notes'))

  // ===== 6. run_js 沙箱（node:vm 替代 JSVM） =====
  section('6. run_js 沙箱（node:vm 实现）')
  const js = await WorkToolRunner.execute(
    ctx,
    convId,
    'run_js',
    JSON.stringify({ code: 'const xs=[1,2,3,4]; const s=xs.reduce((a,b)=>a+b,0); ' + '"合计 " + s' })
  )
  check('run_js 执行成功', js.ok, js.output.split('\n').slice(0, 2).join(' | '))
  check('run_js 返回最后表达式值', js.output.includes('合计 10'))

  // 输入文件桥接（注意 files 的 schema 类型是 string，支持逗号分隔或 JSON 数组）
  const jsFiles = await WorkToolRunner.execute(
    ctx,
    convId,
    'run_js',
    JSON.stringify({
      files: 'notes/demo.txt',
      code: 'inputs["notes/demo.txt"].split("\\n").filter(Boolean).length'
    })
  )
  check('run_js 可读工作区输入文件', jsFiles.ok && jsFiles.output.includes('3'), jsFiles.output.slice(0, 90))

  // write() 落盘
  const jsWrite = await WorkToolRunner.execute(
    ctx,
    convId,
    'run_js',
    JSON.stringify({ code: 'write("out/gen.txt", "来自 run_js"); "written"' })
  )
  check('run_js write() 落盘', jsWrite.ok && fs.existsSync(path.join(wsRoot, 'out/gen.txt')))

  // 死循环必须被真正中断（上游用 JSVM 时做不到）
  const startedAt = Date.now()
  const loop = await runJs('while(true){}', {
    inputs: {},
    stdoutLimitKb: 8,
    outputFileLimitKb: 64,
    outputTotalLimitKb: 128,
    maxOutputFiles: 4
  })
  const elapsed = Date.now() - startedAt
  check('run_js 死循环被引擎中断而非挂死', !loop.ok && elapsed < 25_000, `${elapsed}ms, error=${loop.error.slice(0, 40)}`)

  // ===== 7. 数据管道（transform_file 底层） =====
  section('7. 数据管道 DataPipeline')
  const table = DataPipeline.parseInput('a,b\n1,2\n3,4', 'csv', ',', '')
  check('DataPipeline 可解析 CSV', table !== null && table.rows.length === 3, `${table.rows.length} 行`)
  const csvOut = DataPipeline.toCsvRows(table, true)
  check('DataPipeline 可回写 CSV', csvOut.length === 3 && csvOut[0].join(',') === 'a,b')

  // ===== 8. 持久化往返 =====
  section('8. 对话持久化往返')
  const conv = Conversation.create(agents[0]?.id ?? '', '冒烟测试', 'work')
  conv.messages.push(Message.ofUser('m1', '你好', '你好', []))
  conv.messages.push(Message.ofAssistant('m2', '收到'))
  await StorageManager.saveConversations(ctx, [conv])
  const reloaded = await StorageManager.loadConversations(ctx)
  check('对话数量往返一致', reloaded.length === 1)
  check('消息内容往返一致', reloaded[0]?.messages.length === 2 && reloaded[0]?.messages[1]?.content === '收到')
  check('模式字段往返一致', reloaded[0]?.mode === 'work')

  // ===== 9. 三协议端点解析 =====
  section('9. 三协议端点解析')
  const cases: Array<[string, string, string]> = [
    ['openai-completions', 'https://api.deepseek.com', '/chat/completions'],
    ['openai-responses', 'https://api.deepseek.com', '/responses'],
    ['anthropic-messages', 'https://api.deepseek.com/anthropic', '/messages']
  ]
  for (const [provider, baseUrl, suffix] of cases) {
    const cfg = new ApiConfig()
    cfg.provider = provider
    cfg.baseUrl = baseUrl
    const url = resolveEndpointUrl(cfg, ChatService ? (await import('../src/core/service/ChatService')).getProtocol(provider) : provider)
    check(`${provider} 端点拼接`, url.endsWith(suffix), url)
  }

  // ===== 10. 交互模式语言（guncat-ui lang） =====
  section('10. 交互模式语言解析')
  const basicProgram = 'root = Card([TextContent("你好")])'
  const parsedBasic = GuncatUiLang.parse(basicProgram)
  check('guncat-ui lang 可解析', parsedBasic !== null)

  // ===== 11. 工作区打包 =====
  section('11. 工作区 zip 打包')
  const zip = WorkFileService.zipWorkspace(ctx, convId)
  check('zipWorkspace 产出字节', zip.byteLength > 0, `${zip.byteLength} 字节`)
  check('zip 魔数正确', zip[0] === 0x50 && zip[1] === 0x4b, 'PK')

  // ===== 12. Word/Excel 生成器（export 层） =====
  section('12. Office 生成器')
  const { DocxBuilder } = await import('../src/core/export/DocxBuilder')
  const { DocParser } = await import('../src/core/export/DocModel')
  const docJson = JSON.stringify({
    title: '冒烟',
    blocks: [{ type: 'paragraph', text: '正文内容' }]
  })
  const doc = DocParser.parse(docJson)
  check('DocModel 可解析 Doc JSON', doc !== null && doc.blocks.length > 0, `${doc.blocks.length} 块`)
  const docxBytes = await DocxBuilder.buildDocxBytes(doc, {
    resolve: async () => null
  } as never)
  check('DocxBuilder 产出 zip 字节', docxBytes.byteLength > 0 && docxBytes[0] === 0x50, `${docxBytes.byteLength} 字节`)

  const { XlsxBuilder } = await import('../src/core/export/XlsxBuilder')
  const { XlsxParser } = await import('../src/core/export/XlsxModel')
  const workbookJson = JSON.stringify({
    sheets: [{ name: 'S1', rows: [['a', 'b'], [1, 2]] }]
  })
  const workbook = XlsxParser.parse(workbookJson)
  check('XlsxModel 可解析 Workbook JSON', workbook !== null && workbook.sheets.length > 0)
  const xlsxBytes = XlsxBuilder.buildXlsxBytes(workbook)
  check('XlsxBuilder 产出 zip 字节', xlsxBytes.byteLength > 0 && xlsxBytes[0] === 0x50, `${xlsxBytes.byteLength} 字节`)

  const { PptxBuilder } = await import('../src/core/export/PptxBuilder')
  const { DeckParser } = await import('../src/core/export/DeckModel')
  const deckJson = JSON.stringify({
    title: '冒烟演示',
    slides: [{ layout: 'cover', title: '你好', subtitle: '世界' }]
  })
  const deck = DeckParser.parse(deckJson)
  check('DeckModel 可解析 Deck JSON', deck !== null && deck.slides.length > 0)
  const pptxBytes = await PptxBuilder.buildPptxBytes(deck, {
    resolve: async () => null
  } as never)
  check('PptxBuilder 产出 zip 字节', pptxBytes.byteLength > 0 && pptxBytes[0] === 0x50, `${pptxBytes.byteLength} 字节`)

  // ===== 13. 交互模式：解析 → 绑定 → 动作 → 回传 =====
  section('13. 交互模式（guncat-ui lang 全链路）')
  const { GuncatUiLang: UiLang, UiNode: UiNodeRef } = await import('@core/common/GuncatUiLang')
  const { GuncatUiRuntime: UiRuntime } = await import('@core/common/GuncatUiRuntime')
  const { GuncatUiState: UiState, GuncatUiTrailer: UiTrailer } = await import(
    '@core/common/GuncatUiRuntime'
  )
  const { GuncatUiParts: UiParts } = await import('@core/common/GuncatUiParts')

  const PROGRAM = [
    '$amount = 30',
    'root = Card([',
    '  CardHeader("季度复盘", "示例界面"),',
    '  TextContent("金额 " + $amount + " 万"),',
    '  Slider("amount", "discrete", 0, 200, 5, [30], "金额", $amount),',
    '  MetricIndicatorInline("" + $amount * 2, "两倍"),',
    '  Button("按 30 天口径重算", @ToAssistant("按 30 天口径重算"))',
    '])'
  ].join('\n')

  const uiProgram = UiLang.parse(PROGRAM)
  check('程序解析无错误', uiProgram.errors.length === 0, uiProgram.errors.join('；'))
  check('入口 root 已解析', uiProgram.root !== null && uiProgram.root.type === 'Card')
  // 绑定变量的键名带 $ 前缀（与语句 id 一致）
  check(
    '$变量默认值已收集',
    uiProgram.state['$amount'] === 30,
    `keys=${Object.keys(uiProgram.state).join(',')}`
  )

  const root0 = UiLang.render(uiProgram, null)
  const cardChildren = (root0 === null ? [] : ((root0.props['children'] as unknown[]) ?? [])) as Array<{
    type: string
    props: Record<string, unknown>
  }>
  check('Card 子元素数量正确', cardChildren.length === 5, `${cardChildren.length} 个`)
  check(
    '表达式已求值（金额 30 万）',
    String(cardChildren[1].props['text']) === '金额 30 万',
    String(cardChildren[1].props['text'])
  )

  // 改绑定值 → 重新物化：表达式必须按新值重算
  const uiState = UiState.of(uiProgram, null)
  uiState.set('$amount', 45 as unknown as object)
  const root1 = UiLang.render(uiProgram, uiState.values)
  const cardChildren1 = (root1 === null ? [] : ((root1.props['children'] as unknown[]) ?? [])) as Array<{
    type: string
    props: Record<string, unknown>
  }>
  check(
    '改绑定值后表达式重算（金额 45 万）',
    String(cardChildren1[1].props['text']) === '金额 45 万',
    String(cardChildren1[1].props['text'])
  )
  check(
    '派生表达式同步更新（45*2=90）',
    String(cardChildren1[3].props['value']) === '90',
    String(cardChildren1[3].props['value'])
  )

  // 动作：@ToAssistant 需要被收集成回传文案
  const buttonSteps = UiNodeRef.actionSteps(cardChildren1[4] as never, 'action')
  check('按钮动作可解析', buttonSteps.length > 0, `${buttonSteps.length} 步`)
  check('回传文案取自 @ToAssistant', UiRuntime.collectMessages(buttonSteps)[0] === '按 30 天口径重算')

  // 状态尾标记往返
  const stateJson = JSON.stringify({ $amount: 45 })
  const withTrailer = UiTrailer.append(PROGRAM, stateJson)
  const splitTrailer = UiTrailer.split(withTrailer)
  check('尾标记可剥离', splitTrailer.body.trim() === PROGRAM.trim())
  check('尾标记可还原状态', splitTrailer.stateJson === stateJson && splitTrailer.hasState)
  const restoredState = UiState.of(uiProgram, UiState.fromJson(splitTrailer.stateJson))
  check('状态恢复后覆盖默认值', restoredState.num('$amount', 0) === 45, `amount=${restoredState.num('$amount', 0)}`)

  // 正文拆分：Markdown + 界面程序混合
  const mixed = '先看一段说明。\n\n```guncat-ui\n' + PROGRAM + '\n```\n'
  const uiParts = UiParts.build(mixed, true)
  check('拆分出界面片段', uiParts.hasUi && uiParts.segments.some((s) => s.type === 'ui'))
  check('纯文本已剥离程序', !uiParts.textOnly.includes('root = Card'), uiParts.textOnly.slice(0, 40))
  check('文本片段保留说明文字', uiParts.textOnly.includes('先看一段说明'))
  const uiSeg = uiParts.segments.find((s) => s.type === 'ui')
  check('界面片段带标题', uiSeg !== undefined && uiSeg.title === '季度复盘', uiSeg?.title ?? '')

  // 表单回传：字段值 + 提交诉求打包
  const FORM = [
    'root = Card([',
    '  Form("参数设置", Buttons([Button("重新计算", @ToAssistant("换口径重算"))]), [',
    '    FormControl("口径", Select("scope", [SelectItem("customers", "按客户"), SelectItem("orders", "按订单")], "请选择", {}, $scope)),',
    '    FormControl("周期", Slider("days", "discrete", 7, 90, 1, [30], "天数", $days))',
    '  ])',
    '])'
  ].join('\n')
  const formProgram = UiLang.parse(FORM)
  const formRoot = UiLang.render(formProgram, null)
  const formEl = ((formRoot?.props['children'] as unknown[])[0] ?? null) as never
  const formState = UiState.of(formProgram, null)
  formState.set('$scope', 'orders' as unknown as object)
  formState.set('$days', 45 as unknown as object)
  const formBody = UiRuntime.formMessage(formEl, formState)
  check(
    '表单字段值可收集',
    formBody.includes('orders') && formBody.includes('45'),
    formBody.replace(/\n/g, ' | ')
  )
  const interaction = UiRuntime.interactionText('参数设置', formBody)
  check('回传文案带交互界面标记', interaction.startsWith('【交互界面回传】'), interaction.split('\n')[0])

  // 图表数据：series/labels 能取出
  const CHART = [
    's1 = Series("本季", [120, 132, 101])',
    's2 = Series("上季", [90, 110, 95])',
    'root = Card([BarChart(["1月","2月","3月"], [s1, s2], "grouped", "月份", "万元", 200)])'
  ].join('\n')
  const chartProgram = UiLang.parse(CHART)
  const chartRoot = UiLang.render(chartProgram, null)
  const chartEl = ((chartRoot?.props['children'] as unknown[])[0] ?? null) as {
    type: string
    props: Record<string, unknown>
  } | null
  check('图表元素类型正确', chartEl !== null && chartEl.type === 'BarChart')
  check('图表 labels 可取出', (chartEl?.props['labels'] as string[])?.join(',') === '1月,2月,3月')
  check('图表 series 可取出', ((chartEl?.props['series'] as unknown[]) ?? []).length === 2)

  // 容错：流式中间态（未闭合）也应能解析出部分内容
  const partial = UiLang.parse('root = Card([TextContent("半句")')
  check('未闭合程序可容错解析', partial.root !== null, `incomplete=${partial.incomplete}`)

  // 未知组件：按上游约定「丢弃并给出诊断」，但不能影响同一块里的其它组件
  const unknownProgram = UiLang.parse('root = Card([NoSuchComp("x"), TextContent("还在")])')
  const unknownRoot = UiLang.render(unknownProgram, null)
  const unknownChildren = (unknownRoot?.props['children'] as unknown[]) ?? []
  check('未知组件被丢弃并给出诊断', unknownProgram.errors.length > 0, unknownProgram.errors.join('；'))
  check('未知组件不影响同一块的其它组件', unknownChildren.length === 1, `${unknownChildren.length} 个子元素`)

  // ===== 15. Office 工具链（走真实的工具分发，而不是直接调生成器） =====
  section('15. Office 工具链（WorkToolRunner 端到端）')

  const callTool = async (name: string, args: Record<string, unknown>) =>
    WorkToolRunner.execute(ctx, convId, name, JSON.stringify(args), null)

  // --- Word：Markdown → .docx → 读回 ---
  const docxWrite = await callTool('write_docx', {
    path: 'out/报告.docx',
    markdown: '# 季度报告\n\n正文第一段。\n\n- 要点一\n- 要点二\n\n| 区域 | 营收 |\n| --- | --- |\n| 华东 | 820 |\n',
    title: '季度报告'
  })
  check('write_docx 成功', docxWrite.ok, docxWrite.output.slice(0, 120))
  check('docx 文件已落盘', fs.existsSync(path.join(wsRoot, 'out/报告.docx')))
  const docxFileBytes = fs.existsSync(path.join(wsRoot, 'out/报告.docx'))
    ? fs.readFileSync(path.join(wsRoot, 'out/报告.docx'))
    : Buffer.alloc(0)
  check('docx 是合法 zip(PK 魔数)', docxFileBytes.length > 0 && docxFileBytes[0] === 0x50, `${docxFileBytes.length} 字节`)

  const docxRead = await callTool('read_docx', { path: 'out/报告.docx' })
  check('read_docx 可读回', docxRead.ok, docxRead.output.slice(0, 100))
  check('读回内容无损（含标题）', docxRead.output.includes('季度报告'))

  // --- Excel：Workbook JSON → .xlsx → 读回 ---
  const xlsxWrite = await callTool('write_xlsx', {
    path: 'out/营收.xlsx',
    workbook: JSON.stringify({
      name: '营收表',
      sheets: [
        {
          name: '月度',
          rows: [
            ['区域', '1月', '2月', '合计'],
            ['华东', 120, 132, '=SUM(B2:C2)'],
            ['华南', 90, 110, '=SUM(B3:C3)']
          ],
          // formats 是按列的格式数组（每列一项）
          formats: ['text', 'int', 'int', 'money'],
          colWidths: [10, 8, 8, 12],
          freeze: true
        }
      ]
    }),
    style: 'default'
  })
  check('write_xlsx 成功', xlsxWrite.ok, xlsxWrite.output.slice(0, 120))
  const xlsxRead = await callTool('read_xlsx', { path: 'out/营收.xlsx' })
  check('read_xlsx 可读回', xlsxRead.ok, xlsxRead.output.slice(0, 100))
  check('读回含公式与数据', xlsxRead.output.includes('=SUM(B2:C2)') && xlsxRead.output.includes('华东'))

  // --- PPT：Deck JSON → .pptx → 读回 ---
  const pptxWrite = await callTool('write_pptx', {
    path: 'out/汇报.pptx',
    deck: JSON.stringify({
      title: '季度汇报',
      slides: [
        { layout: 'cover', title: '季度汇报', subtitle: '2024 Q3' },
        { layout: 'content', title: '核心结论', bullets: ['营收增长 18%', '毛利持平'] }
      ]
    })
  })
  check('write_pptx 成功', pptxWrite.ok, pptxWrite.output.slice(0, 120))
  const pptxRead = await callTool('read_ppt', { path: 'out/汇报.pptx' })
  check('read_ppt 可读回', pptxRead.ok, pptxRead.output.slice(0, 100))
  check('读回含页标题', pptxRead.output.includes('核心结论'))

  // --- 结构化编辑算子：改完再读回，确认算子真的落到文件里 ---
  const docxEdit = await callTool('edit_docx', {
    path: 'out/报告.docx',
    ops: JSON.stringify([{ op: 'replace_text', find: '正文第一段', replace: '正文已被改写' }])
  })
  check('edit_docx 可应用算子', docxEdit.ok, docxEdit.output.slice(0, 100))
  const docxRead2 = await callTool('read_docx', { path: 'out/报告.docx' })
  check('edit_docx 改动已持久化', docxRead2.output.includes('正文已被改写'))

  const xlsxEdit = await callTool('edit_xlsx', {
    path: 'out/营收.xlsx',
    ops: JSON.stringify([{ op: 'set_cell', sheet: '月度', row: 1, col: 2, value: 999 }])
  })
  check('edit_xlsx 可应用算子', xlsxEdit.ok, xlsxEdit.output.slice(0, 100))
  const xlsxRead2 = await callTool('read_xlsx', { path: 'out/营收.xlsx' })
  check('edit_xlsx 改动已持久化', xlsxRead2.output.includes('999'))

  const pptxEdit = await callTool('edit_ppt', {
    path: 'out/汇报.pptx',
    ops: JSON.stringify([{ op: 'set_title', title: '已改标题' }])
  })
  check('edit_ppt 可应用算子', pptxEdit.ok, pptxEdit.output.slice(0, 100))

  // --- transform_file：真实数据管道（过滤 + 派生列）+ 导出 xlsx ---
  fs.writeFileSync(
    path.join(wsRoot, 'out/people.csv'),
    'name,age,city\n张三,17,上海\n李四,25,北京\n王五,31,上海\n',
    'utf8'
  )
  const tfPreview = await callTool('transform_file', {
    input: 'out/people.csv',
    steps: JSON.stringify([
      { op: 'filter', expr: "col('age') >= 18" },
      { op: 'derive', name: '年份', expr: "2024 - col('age')" }
    ])
  })
  check('transform_file 预览成功', tfPreview.ok, tfPreview.output.slice(0, 120))
  check('过滤条件生效（17 岁被剔除）', !tfPreview.output.includes('张三'))
  check('派生列生效', tfPreview.output.includes('年份') || tfPreview.output.includes('1999'))
  check('未给 output 时不落盘', !fs.existsSync(path.join(wsRoot, 'out/people_out.csv')))

  const tfWrite = await callTool('transform_file', {
    input: 'out/people.csv',
    steps: JSON.stringify([{ op: 'filter', expr: "col('age') >= 18" }]),
    output: 'out/people_clean.csv'
  })
  check('transform_file 可写盘', tfWrite.ok && fs.existsSync(path.join(wsRoot, 'out/people_clean.csv')))
  const cleaned = fs.readFileSync(path.join(wsRoot, 'out/people_clean.csv'), 'utf8')
  check('写盘内容正确（保留表头 + 2 行）', cleaned.includes('name,age,city') && cleaned.includes('李四') && !cleaned.includes('张三'))

  const tfXlsx = await callTool('transform_file', {
    input: 'out/people.csv',
    steps: JSON.stringify([{ op: 'filter', expr: "col('age') >= 18" }]),
    output: 'out/people_clean.xlsx'
  })
  check('transform_file 可导出 xlsx', tfXlsx.ok && fs.existsSync(path.join(wsRoot, 'out/people_clean.xlsx')))

  // --- 只读工具链：search_files 能搜到刚生成的 Office 产物 ---
  const searchOffice = await callTool('search_files', { query: '华东' })
  check('search_files 可搜 Office 产物文本', searchOffice.ok, searchOffice.output.slice(0, 100))

  // --- 文件管理类工具 ---
  const listOut = await callTool('list_files', { path: 'out' })
  check('list_files 列出产物目录', listOut.ok && listOut.output.includes('报告.docx'))
  const mkdir = await callTool('create_dir', { path: 'out/nested' })
  check('create_dir 成功', mkdir.ok, mkdir.output.slice(0, 80))
  const move = await callTool('move_file', { from: 'out/people_clean.csv', to: 'out/nested/moved.csv' })
  check('move_file 成功', move.ok && fs.existsSync(path.join(wsRoot, 'out/nested/moved.csv')))
  const del = await callTool('delete_file', { path: 'out/nested/moved.csv' })
  check('delete_file 成功', del.ok && !fs.existsSync(path.join(wsRoot, 'out/nested/moved.csv')))

  // --- todo_write：长程任务清单 ---
  const todo = await callTool('todo_write', {
    todos: JSON.stringify([{ id: '1', content: '读素材', status: 'completed' }, { id: '2', content: '出报表', status: 'in_progress' }])
  })
  check('todo_write 成功', todo.ok, todo.output.slice(0, 80))

  // ===== 16. 技能系统（工具链入口） =====
  section('16. 技能系统工具（list_skills / load_skill）')
  const listSkills = await callTool('list_skills', {})
  check('list_skills 成功', listSkills.ok, listSkills.output.slice(0, 100))
  check('技能清单含主 Skill', listSkills.output.includes('ppt') && listSkills.output.includes('docx'))
  check('技能清单含数据管道技能', listSkills.output.includes('data'))

  const loadPpt = await callTool('load_skill', { name: 'ppt' })
  check('load_skill(ppt) 成功', loadPpt.ok, loadPpt.output.slice(0, 100))
  check('技能正文已加载', loadPpt.output.length > 2000, `${loadPpt.output.length} 字`)

  // 参考文件：主 Skill 的 reference/ 子目录（docx 技能带 6 篇参考文档）
  const loadBranch = await callTool('load_skill', { name: 'docx', file: 'reference/doc-dsl.md' })
  check('可按路径加载技能参考文档', loadBranch.ok, loadBranch.output.slice(0, 90))

  const loadBadFile = await callTool('load_skill', { name: 'data', file: 'reference/recipes.md' })
  check('缺失的参考文件给出可用清单', !loadBadFile.ok && loadBadFile.output.includes('SKILL.md'), loadBadFile.output.slice(0, 70))

  const loadMissing = await callTool('load_skill', { name: 'no-such-skill' })
  check('不存在的技能给出明确错误', !loadMissing.ok, loadMissing.output.slice(0, 80))

  // ===== 结果 =====
  console.log(`\n${'─'.repeat(58)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('失败项：')
    for (const f of failures) {
      console.log(`  - ${f}`)
    }
  }
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n冒烟验证异常终止：')
  console.error(e)
  process.exit(1)
})
