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
  const program = 'root = Card([TextContent("你好")])'
  const parsed = GuncatUiLang.parse(program)
  check('guncat-ui lang 可解析', parsed !== null)

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
