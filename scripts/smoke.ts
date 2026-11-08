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
import { appContext, common } from '../src/core/platform/kit/AbilityKit'
import { AgentLoader } from '../src/core/service/AgentLoader'
import { WorkFileService } from '../src/core/service/WorkFileService'
import { WorkToolRunner } from '../src/core/service/WorkToolRunner'
import { WorkSkillService } from '../src/core/service/WorkSkillService'
import { PluginHotLoader } from '../src/core/service/PluginHotLoader'
import type { PluginManifestResult } from '../src/core/common/PluginManifestLoader'
import { filesDir, cacheDir, tempDir } from '../src/core/platform/appPaths'
import { StorageManager } from '../src/core/data/StorageManager'
import { ChatService, resolveEndpointUrl } from '../src/core/service/ChatService'
import { AgentLoopService, LoopMessage, ToolImageAttachment } from '../src/core/service/AgentLoopService'
import { ApiConfig } from '../src/core/model/ApiConfig'
import { Conversation } from '../src/core/model/Conversation'
import { Message } from '../src/core/model/Message'
import { ToolRegistry } from '../src/core/common/ToolRegistry'
import { GuncatUiLang } from '../src/core/common/GuncatUiLang'
import { GuncatUiLibrary } from '../src/core/common/GuncatUiLibrary'
import { GuncatUiPrompt } from '../src/core/common/GuncatUiPrompt'
import { PromptBuilder } from '../src/core/common/PromptBuilder'
import { InteractiveTiers } from '../src/core/common/InteractiveTiers'
import { InteractiveTierPrompt } from '../src/core/common/InteractiveTierPrompt'
import { InteractiveTierPrompts } from '../src/core/common/InteractiveTierPrompts'
import { PersonalInstruction } from '../src/core/model/PersonalInstruction'
import { PersonalInstructionPrompt } from '../src/core/common/PersonalInstructionPrompt'
import { PersonalInstructionStore } from '../src/core/service/PersonalInstructionStore'
import { DataPipeline } from '../src/core/common/DataPipeline'
import { runJs } from '../src/core/platform/native/libguncatjs'
import { http as guncatHttp } from '../src/core/platform/kit/NetworkKit'
import {
  installPdfJsBackend,
  renderPdfPageToPng,
  itemsToText,
  itemsToObjects
} from '../src/core/platform/native/pdfBackend'

/**
 * 造一个最小但结构完整的 PDF（未压缩内容流 + Helvetica + WinAnsi）。
 *
 * 为什么要自己造：工作区与上游鸿蒙项目里都没有现成的 PDF 文件，而「PDF 解析」
 * 恰恰是最需要回归保护的一段（它曾经对任何 PDF 都报「文档结构损坏」）。
 * 夹具只用 ASCII —— WinAnsi 单字节编码写不进中文，硬塞进去会得到乱码，
 * 反而让断言变得不可信。
 */
function makeTestPdf(lines: string[]): Buffer {
  const content = lines.map((t, i) => `BT /F1 24 Tf 72 ${720 - i * 40} Td (${t}) Tj ET`).join('\n')
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ]
  // xref 的偏移必须逐字节准确，否则解析器会判结构损坏 —— 这也正是夹具自身的有效性检查
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

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

  // ===== 插件热加载 =====
  //
  // `WorkToolRunner` 早就会分发插件工具、随包也有 plugins/plugin_list.json，
  // 但一直没有加载器 —— 于是插件工具一律返回「插件未实现」。
  // 这里用一份临时的插件目录把「读清单 → 解析 → 注册进 ToolRegistry」这条链跑通。
  section('插件热加载（plugin_list.json → ToolRegistry）')
  const pluginRoot = path.join(root, 'plugin-resources')
  fs.mkdirSync(path.join(pluginRoot, 'plugins'), { recursive: true })
  fs.writeFileSync(
    path.join(pluginRoot, 'plugins', 'plugin_list.json'),
    JSON.stringify(['demo.json', 'broken.json', 'missing.json']),
    'utf8'
  )
  fs.writeFileSync(
    path.join(pluginRoot, 'plugins', 'demo.json'),
    JSON.stringify({
      id: 'demo_plugin',
      version: '1',
      category: 'plugin',
      permissions: [],
      tools: [
        {
          name: 'demo_plugin_tool',
          description: '示例插件工具',
          parameters: { type: 'object', properties: {} },
          readOnly: true,
          mutating: false,
          timeoutMs: 5000,
          maxRetries: 1
        }
      ],
      skills: []
    }),
    'utf8'
  )
  // 一份解析不了的 manifest：应当只影响这一个插件
  fs.writeFileSync(path.join(pluginRoot, 'plugins', 'broken.json'), '{ 这不是 JSON', 'utf8')
  // 直接用一份指向临时插件目录的上下文（appContext 是进程级单例，不能再换根目录）
  const pluginCtx = new common.UIAbilityContext(filesDir(), cacheDir(), tempDir(), pluginRoot)
  const pluginResults: PluginManifestResult[] = await PluginHotLoader.loadAll(pluginCtx)
  check(
    '插件清单里声明的插件被加载（loadAll 此前零调用点）',
    PluginHotLoader.loadedCount() === 1,
    PluginHotLoader.loadedSummary()
  )
  check(
    '插件工具真的注册进了工具表（否则调用时只会返回「插件未实现」）',
    ToolRegistry.defs('').some((d) => (d as unknown as Record<string, unknown>).name === 'demo_plugin_tool'),
    PluginHotLoader.loadedSummary()
  )
  check(
    '坏掉的 manifest 只让那一个插件失败，不影响其他',
    pluginResults.filter((r) => !r.ok).length === 2 &&
      pluginResults.some((r) => r.error.indexOf('parse_failed') === 0) &&
      pluginResults.some((r) => r.error.indexOf('read_failed') === 0),
    pluginResults.map((r) => r.error || 'ok').join(' | ')
  )
  PluginHotLoader.unloadAll()
  check('卸载后工具表里不再有插件工具（unloadAll 幂等）', PluginHotLoader.loadedCount() === 0)
  const noListCtx = new common.UIAbilityContext(filesDir(), cacheDir(), tempDir(), root)
  const noList: PluginManifestResult[] = await PluginHotLoader.loadAll(noListCtx)
  check('没有插件清单时视为没有插件（不抛错、不阻断启动）', noList.length === 0)


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

  // ===== 3b. 交互模式「能力调度」 =====
  // 这一节钉住的是移植自鸿蒙版的九档能力调度: 档位元数据、分层组装（轻简档必须与旧四段组装
  // 逐字节一致）、档位工具面只增不删、以及组件清单修正（RadarChart / 列表与追问分组）。
  section('3b. 交互模式 · 能力调度（九档 / 分层组装 / 工具面 / 组件清单）')
  const tierIds = InteractiveTiers.ALL.map((t) => t.id).join(',')
  check(
    '九档齐全且顺序稳定（轻简→效率→专家→经典→论文→法律→研究→筛滤→评估）',
    tierIds === 'lite,efficiency,expert,classic,paper,legal,research,sift,eval',
    tierIds
  )
  check(
    '默认档与回退档都是轻简，未知/脏值回退轻简',
    InteractiveTiers.DEFAULT_ID === 'lite' &&
      InteractiveTiers.LITE_ID === 'lite' &&
      InteractiveTiers.normalize('') === 'lite' &&
      InteractiveTiers.normalize('shanzhai') === 'lite' &&
      InteractiveTiers.normalize('expert') === 'expert'
  )
  check(
    '轻简档没有主体文件，其余八档都有',
    InteractiveTiers.ALL.filter((t) => t.promptFile !== '').length === 8 &&
      InteractiveTiers.byId('lite').promptFile === ''
  )
  check(
    '每档推荐思考强度合法（off / low / high）',
    InteractiveTiers.ALL.every((t) => InteractiveTiers.isValidEffort(t.defaultEffort)),
    InteractiveTiers.ALL.map((t) => `${t.id}:${t.defaultEffort}`).join(' ')
  )
  check(
    '档位标签/说明/来源非空（设置页与导出文档直接渲染它们）',
    InteractiveTiers.ALL.every(
      (t) => t.name !== '' && t.tagline !== '' && t.description !== '' && t.sourceAgent !== ''
    )
  )

  const toolIndexOf = (tierId: string): string =>
    PromptBuilder.buildToolNameIndex(
      ToolRegistry.interactiveWhitelist(tierId).map((name) => ({ name }))
    )
  const liteToolIndex = toolIndexOf(InteractiveTiers.LITE_ID)
  const liteLegacy = PromptBuilder.assembleInteractiveSystemPrompt(
    GuncatUiPrompt.promptSection(),
    '',
    liteToolIndex,
    GuncatUiPrompt.INTERACTIVE_DUTY
  )
  const liteNew = InteractiveTierPrompt.assemble(
    InteractiveTiers.LITE_ID,
    '',
    '',
    liteToolIndex
  )
  check(
    '轻简档 = 旧四段组装逐字节一致（行为与速度不变）',
    liteLegacy === liteNew,
    `${liteLegacy.length} 字符`
  )

  // 档位主体在 SessionManager.bootstrap() 里随 agents 一起加载; 这里按同一入口加载一次。
  await AgentLoader.loadInteractiveTierPrompts(ctx)
  const loadedTierIds = InteractiveTierPrompts.loadedIds()
  check(
    '八档主体提示词均已从 resources/ 加载（轻简档不登记）',
    loadedTierIds.length === 8 && loadedTierIds.join(',') ===
      'classic,efficiency,eval,expert,legal,paper,research,sift',
    loadedTierIds.join(',')
  )
  const expertBody = InteractiveTierPrompts.body('expert')
  check(
    '专家档主体为非空的长提示词（原聊天引擎提示词主体）',
    expertBody.length > 50000,
    `${expertBody.length} 字符`
  )

  const litePrompt = AgentLoopService.buildInteractiveSystemPrompt(InteractiveTiers.LITE_ID)
  const expertPrompt = AgentLoopService.buildInteractiveSystemPrompt('expert')
  // 服务层组装会带上真实技能索引，所以对照组的组装也要用同一份 skillsSection（否则差异只是技能段）。
  const liteWithSkills = InteractiveTierPrompt.assemble(
    InteractiveTiers.LITE_ID,
    '',
    WorkSkillService.interactiveIndex(),
    liteToolIndex
  )
  check(
    '轻简档系统提示词 = 原交互模式提示词（含原丰富度计量）',
    litePrompt === liteWithSkills && litePrompt.includes(GuncatUiPrompt.RICHNESS_LITE_QUANTITY)
  )
  check(
    '非轻简档系统提示词以档位声明开头（唯一一级标题）',
    expertPrompt.startsWith('# 专家 · 能力调度档位（交互模式 · 移植自 Guncat 3.0-Pro）')
  )
  check(
    '非轻简档把档位主体整段拼进系统提示词',
    expertPrompt.includes(expertBody)
  )
  check(
    '非轻简档把丰富度数量口径换成「越多越好」（结构与轻简档共用）',
    expertPrompt.includes(GuncatUiPrompt.RICHNESS_TIER_QUANTITY) &&
      !expertPrompt.includes(GuncatUiPrompt.RICHNESS_LITE_QUANTITY)
  )
  check(
    '档位提示词按档缓存且互不串味',
    expertPrompt !== litePrompt &&
      AgentLoopService.buildInteractiveSystemPrompt('expert') === expertPrompt &&
      AgentLoopService.buildInteractiveSystemPrompt('legal') !== expertPrompt
  )

  const liteWhitelist = ToolRegistry.interactiveWhitelist(InteractiveTiers.LITE_ID)
  const expertWhitelist = ToolRegistry.interactiveWhitelist('expert')
  const efficiencyWhitelist = ToolRegistry.interactiveWhitelist('efficiency')
  check(
    '轻简档工具面 = 基础白名单（28 个），不含 record_search / todo_write',
    liteWhitelist.length === 28 &&
      !liteWhitelist.includes('record_search') &&
      !liteWhitelist.includes('todo_write'),
    `${liteWhitelist.length} 个`
  )
  check(
    '专家/法律/研究/评估档追加 record_search + todo_write（基础之后）',
    expertWhitelist.length === 30 &&
      expertWhitelist.slice(-2).join(',') === 'record_search,todo_write' &&
      ['legal', 'research', 'eval'].every(
        (id) => ToolRegistry.interactiveWhitelist(id).length === 30
      )
  )
  check(
    '效率/经典/信息筛滤档只追加 record_search',
    ['efficiency', 'classic', 'sift'].every(
      (id) => ToolRegistry.interactiveWhitelist(id).length === 29 &&
        ToolRegistry.interactiveWhitelist(id).slice(-1)[0] === 'record_search'
    ),
    `效率 ${efficiencyWhitelist.length} 个`
  )
  check(
    '长程与维护类工具在任何档位都不下发',
    !ToolRegistry.interactiveWhitelist('lite').includes('todo_write') &&
      ['edit', 'delete_file', 'move_file', 'ask_user_question', 'subagent',
        'schedule_create', 'goal_create'].every(
        (name) => !ToolRegistry.interactiveWhitelist('expert').includes(name)
      )
  )
  const expertDefs = AgentLoopService.interactiveToolDefs(false, 'expert')
  const expertDefNames = expertDefs.map((d) => String((d as Record<string, unknown>)['name'] ?? ''))
  check(
    '按档位裁剪真实工具定义：专家档下发 record_search / todo_write',
    expertDefNames.includes('record_search') &&
      expertDefNames.includes('todo_write') &&
      expertDefNames.length === 30,
    `${expertDefNames.length} 个`
  )

  // 组件清单修正: GROUP_ORDER 与 g1~g9 逐字一致（否则整组从提示词里消失）, 列表与雷达图可见。
  const componentSection = GuncatUiLibrary.promptSection()
  const missingGroups = GuncatUiLibrary.GROUP_ORDER.filter(
    (group) => !componentSection.includes('### ' + group)
  )
  check(
    '组件清单每个分组都出现在提示词里（GROUP_ORDER 与分组表一致）',
    missingGroups.length === 0,
    missingGroups.join(',')
  )
  check(
    'ListBlock / ListItem 首次进入组件清单（「列表」→「列表与追问」修正）',
    componentSection.includes('ListBlock(') && componentSection.includes('ListItem(')
  )
  check(
    'RadarChart 已登记（多维对比可实际落地）',
    GuncatUiLibrary.def('RadarChart') !== null && componentSection.includes('RadarChart(')
  )

  // ===== 3c. 个性化指令 =====
  // 设置页维护的长期偏好，按生效范围拼进系统提示词末尾。这一节钉住的是纯内核部分：
  // 坏存档只丢条目（不抛错）、显示名/摘要、三种范围的过滤、包裹格式与 XML 属性转义，
  // 以及最关键的「原提示词前缀逐字节不变」—— 它决定相邻轮次能否命中模型侧 KV 缓存。
  section('3c. 个性化指令（解析 / 包裹 / 范围 / 预算 / 追加语义）')

  // --- 解析：坏数据只丢条目，设置页不会因存档损坏打不开 ---
  check(
    '坏 JSON / 空串 / 非数组都按空列表处理（不抛错）',
    PersonalInstruction.parseList('').length === 0 &&
      PersonalInstruction.parseList('   ').length === 0 &&
      PersonalInstruction.parseList('{oops').length === 0 &&
      PersonalInstruction.parseList('{"id":"a","content":"x"}').length === 0 &&
      PersonalInstruction.parseList('"just a string"').length === 0
  )
  const dirtyParsed = PersonalInstruction.parseList(JSON.stringify([
    { id: '', content: '缺 id' },
    { content: '缺 id 字段' },
    { id: 'no-content', content: '' },
    { id: 'blank-content', content: '   \n  ' },
    { id: 'ok', content: '留下我' },
    null,
    42,
    'x',
    ['array-item']
  ]))
  check(
    '缺 id / 空正文 / 非对象条目被逐条丢弃（只留合法的那一条）',
    dirtyParsed.length === 1 && dirtyParsed[0].id === 'ok',
    `${dirtyParsed.length} 条`
  )
  const scopeParsed = PersonalInstruction.parseList(JSON.stringify([
    { id: 's1', content: '非数组 scopes 按空处理', scopes: 'work' },
    { id: 's2', content: '数组里的脏值被过滤', scopes: [1, ' work ', '', 'work', 'interactive', null] }
  ]))
  check(
    '非数组 scopes 按空处理；数组内非字符串与重复项被过滤（去空白后去重）',
    scopeParsed.length === 2 &&
      scopeParsed[0].scopes.length === 0 &&
      scopeParsed[1].scopes.join(',') === 'work,interactive',
    scopeParsed.map((p) => p.scopes.join('|')).join(' / ')
  )
  check(
    '缺名称按空串处理；缺 updatedAt 补当前时间（列表排序不退化）',
    scopeParsed[0].name === '' && scopeParsed[0].updatedAt > 0
  )

  // --- 建 / 往返 / 定位 ---
  const createdPi = PersonalInstruction.create(
    '  我的风格  ',
    '  ## 正文\n- 用中文  ',
    [' work ', 'work', '', 'interactive']
  )
  check(
    'create 去首尾空白、名称/正文分别按 40 / 8000 字符封顶、范围去重去空',
    createdPi.name === '我的风格' &&
      createdPi.content === '## 正文\n- 用中文' &&
      createdPi.scopes.join(',') === 'work,interactive' &&
      PersonalInstruction.create('n'.repeat(80), 'c'.repeat(9000), []).name.length === 40 &&
      PersonalInstruction.create('', 'c'.repeat(9000), []).content.length === 8000,
    `${createdPi.name.length} / ${createdPi.content.length}`
  )
  const roundTrippedPi = PersonalInstruction.parseList(JSON.stringify([createdPi.toJson()]))
  check(
    'toJson → JSON 字符串 → parseList 往返一致（id / 名称 / 正文 / 范围 / 时间）',
    roundTrippedPi.length === 1 &&
      roundTrippedPi[0].id === createdPi.id &&
      roundTrippedPi[0].name === createdPi.name &&
      roundTrippedPi[0].content === createdPi.content &&
      roundTrippedPi[0].scopes.join(',') === createdPi.scopes.join(',') &&
      roundTrippedPi[0].updatedAt === createdPi.updatedAt
  )
  check(
    'indexOfId 能定位、未命中返回 -1',
    PersonalInstruction.indexOfId(roundTrippedPi, createdPi.id) === 0 &&
      PersonalInstruction.indexOfId(roundTrippedPi, 'pi-not-there') === -1
  )
  check(
    'sortScopesByOrder：模式在前、未登记的旧范围保留在末尾（不静默丢数据）',
    PersonalInstruction.sortScopesByOrder(
      ['old-engine', 'work', 'interactive'],
      ['interactive', 'work']
    ).join(',') === 'interactive,work,old-engine'
  )

  // --- 列表显示名 / 摘要 ---
  check(
    'displayName 优先用名称；无名称时取正文首行并去掉 Markdown 标题/列表记号',
    PersonalInstruction.create('命名了', '正文', []).displayName() === '命名了' &&
      PersonalInstruction.create('', '# 风格标题\n正文', []).displayName() === '风格标题' &&
      PersonalInstruction.create('', '- 列表项\n正文', []).displayName() === '列表项'
  )
  const longTitlePi = PersonalInstruction.create('', '很长的一行标题'.repeat(10), [])
  check(
    'displayName 对超长首行截断到 24 字符（列表不被撑破）',
    longTitlePi.displayName().length === 24,
    `${longTitlePi.displayName().length} 字符`
  )
  check(
    '无名称又没有正文时显示「未命名指令」（防御性兜底）',
    new PersonalInstruction().displayName() === '未命名指令'
  )
  check(
    'summary 把多行/连续空白压成一行，超长截到 80 字符',
    PersonalInstruction.create('', '第一行\n\n第二行   第三行', []).summary() === '第一行 第二行 第三行' &&
      PersonalInstruction.create('', 'x'.repeat(120), []).summary().length === 80
  )

  // --- 生效范围：三种 scope 各自只选中对应条目 ---
  const piA = PersonalInstruction.create('A 交互', '交互模式只用中文。', ['interactive'])
  const piB = PersonalInstruction.create('B 工作', '工作模式先给结论，再给依据。', ['work'])
  const piC = PersonalInstruction.create('C 引擎', '代码块标注语言。', ['guncat-3.0-pro'])
  const piStore = [piA, piB, piC]
  const piIds = (items: PersonalInstruction[]): string => items.map((p) => p.id).join(',')
  check(
    '范围常量与预算契约稳定（interactive / work / 16000 / 标签名 / 标题）',
    PersonalInstructionPrompt.SCOPE_INTERACTIVE === 'interactive' &&
      PersonalInstructionPrompt.SCOPE_WORK === 'work' &&
      PersonalInstructionPrompt.MAX_TOTAL_CHARS === 16000 &&
      PersonalInstructionPrompt.TAG === 'personal-instruction' &&
      PersonalInstructionPrompt.SECTION_TITLE !== '' &&
      PersonalInstructionPrompt.TRUNCATED_NOTE !== ''
  )
  check('hasScope 按勾选范围精确匹配', piA.hasScope('interactive') && !piA.hasScope('work') && !piA.hasScope(''))
  check(
    'matches：空 scope / 空正文 / 未勾选都不生效',
    !PersonalInstructionPrompt.matches(piA, '') &&
      !PersonalInstructionPrompt.matches(PersonalInstruction.create('', '   ', ['work']), 'work') &&
      !PersonalInstructionPrompt.matches(piA, 'work') &&
      PersonalInstructionPrompt.matches(piA, 'interactive')
  )
  check(
    '三种生效范围各自只选中对应条目（交互 / 工作 / 具体引擎），未知范围为空',
    piIds(PersonalInstructionPrompt.effective(PersonalInstructionPrompt.SCOPE_INTERACTIVE, piStore)) === piA.id &&
      piIds(PersonalInstructionPrompt.effective(PersonalInstructionPrompt.SCOPE_WORK, piStore)) === piB.id &&
      piIds(PersonalInstructionPrompt.effective('guncat-3.0-pro', piStore)) === piC.id &&
      PersonalInstructionPrompt.effective('unknown-engine', piStore).length === 0
  )
  check(
    '未知 scope 组装出空段（调用方据此不追加任何字符）',
    PersonalInstructionPrompt.section('unknown-engine', piStore) === ''
  )

  // --- 包裹格式：标签 / 名称属性 / 用户正文原样 ---
  check(
    '包裹格式：有名称进 name 属性、无名称只有标签，正文在中间',
    PersonalInstructionPrompt.wrap(piB) ===
      '<' + PersonalInstructionPrompt.TAG + ' name="B 工作">\n' +
        piB.content + '\n</' + PersonalInstructionPrompt.TAG + '>' &&
      PersonalInstructionPrompt.wrap(PersonalInstruction.create('', '纯正文', ['work'])) ===
        '<' + PersonalInstructionPrompt.TAG + '>\n纯正文\n</' + PersonalInstructionPrompt.TAG + '>'
  )
  check(
    'name 进 XML 属性时转义 & < > "（中文原样保留）',
    PersonalInstructionPrompt.escapeAttribute('a&b<c>d"e中文') === 'a&amp;b&lt;c&gt;d&quot;e中文' &&
      PersonalInstructionPrompt.wrap(PersonalInstruction.create('x"y', '正文', ['work']))
        .includes('name="x&quot;y"')
  )
  const markdownPi = '## 我的风格\n\n- 用中文\n  - 缩进保留\n\n```ts\nconst a = 1\n```'
  check(
    '用户 Markdown 正文原样保留（不二次转义、不折叠缩进）',
    PersonalInstructionPrompt.wrap(PersonalInstruction.create('', markdownPi, ['work']))
      .includes(markdownPi) &&
      PersonalInstructionPrompt.section('work', [PersonalInstruction.create('', markdownPi, ['work'])])
        .includes(markdownPi)
  )
  check(
    'fixedScopeLabel 给两个模式中文名，聊天引擎交给渲染层补',
    PersonalInstructionPrompt.fixedScopeLabel('interactive') === '交互模式' &&
      PersonalInstructionPrompt.fixedScopeLabel('work') === '工作模式' &&
      PersonalInstructionPrompt.fixedScopeLabel('guncat-3.0-pro') === ''
  )
  const workSectionPi = PersonalInstructionPrompt.section('work', piStore)
  check(
    '段落自带标题、说明与成对标签（模型能读成独立的偏好段）',
    workSectionPi.startsWith(
      PersonalInstructionPrompt.SECTION_TITLE + '\n' + PersonalInstructionPrompt.SECTION_INTRO
    ) &&
      workSectionPi.includes('<' + PersonalInstructionPrompt.TAG + ' name="B 工作">') &&
      workSectionPi.includes('</' + PersonalInstructionPrompt.TAG + '>')
  )
  check(
    '多条按存储顺序拼接（用户添加顺序就是提示词里的顺序）',
    (() => {
      const second = PersonalInstruction.create('B2', '第二条工作指令。', ['work'])
      const multi = PersonalInstructionPrompt.section('work', [piB, second])
      return multi.indexOf(PersonalInstructionPrompt.wrap(piB)) <
        multi.indexOf(PersonalInstructionPrompt.wrap(second))
    })()
  )

  // --- 追加语义：前缀逐字节不变（KV 缓存前提） ---
  const piBase = '你是测试助手。\n第二行：保持原样。  '
  check(
    'append：原提示词前缀逐字节不变，只在其后追加「换行 + 段落」',
    PersonalInstructionPrompt.append(piBase, 'work', piStore) ===
      piBase + '\n\n' + workSectionPi &&
      PersonalInstructionPrompt.append(piBase, 'work', piStore)
        .substring(0, piBase.length) === piBase
  )
  check(
    '空 / 纯空白原提示词直接返回段落（聊天引擎提示词为空也能带上）',
    PersonalInstructionPrompt.append('', 'work', piStore) === workSectionPi &&
      PersonalInstructionPrompt.append('   \n', 'work', piStore) === workSectionPi &&
      PersonalInstructionPrompt.appendSection('  ', workSectionPi) === workSectionPi
  )
  check(
    '无生效条目时原样返回原提示词（一个字符都不加）',
    PersonalInstructionPrompt.append(piBase, 'interactive', [piB]) === piBase &&
      PersonalInstructionPrompt.append('', 'work', []) === '' &&
      PersonalInstructionPrompt.appendSection(piBase, '') === piBase
  )

  // --- 总预算：16000 字符截断 + 省略标注 ---
  const bigPiItems = [
    PersonalInstruction.create('长1', 'a'.repeat(6000), ['work']),
    PersonalInstruction.create('长2', 'b'.repeat(6000), ['work']),
    PersonalInstruction.create('长3', 'c'.repeat(6000), ['work'])
  ]
  const bigPiSection = PersonalInstructionPrompt.section('work', bigPiItems)
  check(
    '总预算 16000：超出后截断内容并标注省略说明（少数长指令不能吃满上下文）',
    bigPiSection.includes(PersonalInstructionPrompt.TRUNCATED_NOTE) &&
      bigPiSection.length <=
        PersonalInstructionPrompt.MAX_TOTAL_CHARS +
          PersonalInstructionPrompt.SECTION_TITLE.length +
          PersonalInstructionPrompt.SECTION_INTRO.length +
          PersonalInstructionPrompt.TRUNCATED_NOTE.length + 64,
    `${bigPiSection.length} 字符`
  )
  check(
    '截断发生在预算边界上：前两条完整、第三条被切（不再有闭合标签）',
    (bigPiSection.match(/<personal-instruction/g) ?? []).length === 3 &&
      (bigPiSection.match(/<\/personal-instruction>/g) ?? []).length === 2
  )

  // --- 持久化往返：走真实偏好存储（临时数据目录，不污染其它偏好断言） ---
  const storeSeedPi = [
    PersonalInstruction.create('风格', '用中文回答。', ['interactive', 'work']),
    PersonalInstruction.create('', '代码块标注语言。', ['guncat-3.0-pro'])
  ]
  await PersonalInstructionStore.save(ctx, storeSeedPi)
  const storeLoadedPi = await PersonalInstructionStore.load(ctx)
  check(
    'PersonalInstructionStore 往返：save → load 字段一致（走真实偏好文件）',
    storeLoadedPi.length === 2 &&
      storeLoadedPi[0].name === '风格' &&
      storeLoadedPi[1].content === '代码块标注语言。' &&
      storeLoadedPi[0].scopes.join(',') === 'interactive,work' &&
      storeLoadedPi[1].scopes.join(',') === 'guncat-3.0-pro',
    `${storeLoadedPi.length} 条`
  )
  await PersonalInstructionStore.save(ctx, [])
  check(
    'PersonalInstructionStore 清空后读回空列表',
    (await PersonalInstructionStore.load(ctx)).length === 0
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

  // 公式回归: 命令后的上下标必须绑定到命令原子(\\mu_0 / \\bar{I}^2 曾被吞成空 m:t)
  const { OmmlConverter } = await import('../src/core/export/OmmlConverter')
  OmmlConverter.beginAudit()
  const muXml = OmmlConverter.inline('\\mu_0')
  const alphaXml = OmmlConverter.inline('\\alpha_2')
  const barXml = OmmlConverter.inline('\\bar{I}^2')
  const mathAudit = OmmlConverter.takeAudit()
  check('\\mu_0 生成下标', muXml.includes('<m:sSub>') && muXml.includes('>0<'), muXml)
  check('\\alpha_2 生成下标', alphaXml.includes('<m:sSub>') && alphaXml.includes('>2<'), alphaXml)
  check('\\bar{I}^2 上标绑定到重音组', barXml.includes('<m:sSup>') && barXml.includes('>2<'), barXml)
  check('\\bar 只生成一层上划线', (barXml.match(/<m:bar>/g) ?? []).length === 1 &&
    !barXml.includes('<m:acc>'), barXml)
  check('正常公式不产生空 m:t', !muXml.includes('<m:t/>') && !alphaXml.includes('<m:t/>'), muXml)
  check('正常公式无未识别命令', mathAudit.unknownCommands.length === 0, mathAudit.unknownCommands.join(','))

  // 真机自检报告里的 8 类公式问题(与鸿蒙版共用同一解析器)
  const bmatrixXml = OmmlConverter.inline('\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}')
  const casesXml = OmmlConverter.inline('\\begin{cases} x & y \\\\ z & w \\end{cases}')
  const alignedXml = OmmlConverter.inline('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}')
  const mathbbXml = OmmlConverter.inline('\\mathbb{R}^n')
  const mathrmXml = OmmlConverter.inline('\\mathrm{m/s^2}')
  const normXml = OmmlConverter.inline('\\|\\mathbf{x}\\|_2')
  const floorXml = OmmlConverter.inline('\\lfloor x\\rfloor')
  const midXml = OmmlConverter.inline('\\mid')
  const transposeXml = OmmlConverter.inline('\\mathbf{w}^T')
  const arraySpecXml = OmmlConverter.inline('\\begin{array}{ll} a & b \\\\ c & d \\end{array}')
  const tagXml = OmmlConverter.inline('\\tag{1} x')
  check('bmatrix 右定界符正确', bmatrixXml.includes('<m:endChr m:val="]"/>'), bmatrixXml)
  check('cases 生成左大括号', casesXml.includes('<m:begChr m:val="{"/>') &&
    casesXml.includes('<m:endChr m:val=""/>'), casesXml)
  check('aligned 使用 eqArr', alignedXml.includes('<m:eqArr>'), alignedXml)
  check('mathbb 保留双线体与上标', mathbbXml.includes('ℝ') && mathbbXml.includes('<m:sSup>'), mathbbXml)
  check('mathrm 解析组内上标', mathrmXml.includes('<m:sSup>') && !mathrmXml.includes('^'), mathrmXml)
  check('范数双竖线且下标绑定', normXml.includes('‖') && normXml.includes('<m:sSub>'), normXml)
  check('lfloor/rfloor 映射为符号', floorXml.includes('⌊') && floorXml.includes('⌋'), floorXml)
  check('mid 映射为符号', midXml.includes('∣'), midXml)
  check('mathbf 后的上标不再丢失', transposeXml.includes('<m:sSup>'), transposeXml)
  check('array 列格式不泄漏', !arraySpecXml.includes('ll'), arraySpecXml)
  check('tag 参数被消费', !tagXml.includes('tag'), tagXml)

  // 自检: 未知命令必须拒绝写盘, 而不是静默生成坏文件
  const { DocxAudit } = await import('../src/core/export/DocxAudit')
  const badAudit = DocxAudit.scan('<w:document><w:p><m:oMath><m:r><m:t>\\foo</m:t></m:r></m:oMath></w:p></w:document>',
    ['foo'], [], 1)
  let rejected = false
  try {
    badAudit.assertClean()
  } catch (e) {
    rejected = true
  }
  check('未知命令被自检拒绝', rejected, badAudit.report())
  check('docx_render 工具已注册', WorkFileService.findToolDef('docx_render') !== null)

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

  // --- Word 公式：命令上下标 + 生成后自检 + 坏公式拒绝写盘 ---
  const formulaWrite = await callTool('write_docx', {
    path: 'out/公式.docx',
    doc: JSON.stringify({
      title: '公式',
      blocks: [
        { type: 'paragraph', text: '$\\mu_0$、$\\alpha_2$、$\\bar{I}^2$、$Uₐ$' },
        { type: 'paragraph', text: '$$\\sum_{i=1}^{n} x_i$$' }
      ]
    })
  })
  check('公式文档生成成功', formulaWrite.ok, formulaWrite.output.slice(0, 160))
  check('返回值含公式自检证据', formulaWrite.output.includes('空 m:t 节点 0') &&
    formulaWrite.output.includes('oMathPara 父元素合规'), formulaWrite.output)
  const badFormulaPath = path.join(wsRoot, 'out/坏公式.docx')
  const badFormulaWrite = await callTool('write_docx', {
    path: 'out/坏公式.docx',
    doc: JSON.stringify({
      title: '坏公式',
      blocks: [{ type: 'paragraph', text: '$\\foo{x}$' }]
    })
  })
  check('未识别命令被拒绝写盘', !badFormulaWrite.ok && !fs.existsSync(badFormulaPath),
    badFormulaWrite.output.slice(0, 160))

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

  // ===== 17. PDF（用户报障：三个 PDF 工具对任何来源都报「文档结构损坏」） =====
  //
  // 根因不是文件坏了，而是平台适配层的 PDF 后端**从来没被装上** ——
  // backend === null 时 loadDocument 只能返回 PARSE_ERROR_FORMAT，
  // 而它的文案正是「PDF 格式解析失败(文档结构损坏)」。这一节把整条链路钉住。
  section('17. PDF 解析（PDF.js 后端）')
  installPdfJsBackend()
  const pdfDir = path.join(wsRoot, 'docs')
  fs.mkdirSync(pdfDir, { recursive: true })
  fs.writeFileSync(
    path.join(pdfDir, 'probe.pdf'),
    makeTestPdf([
      'Guncat Work PDF smoke line one',
      'second line with digits 12345',
      'third line about revenue'
    ])
  )

  const parsed = await WorkToolRunner.execute(
    ctx,
    convId,
    'parse_document',
    JSON.stringify({ path: 'docs/probe.pdf' })
  )
  check(
    'parse_document 不再报「文档结构损坏」（这是后端缺席的症状，不是文件问题）',
    parsed.ok && !parsed.output.includes('文档结构损坏'),
    parsed.output.slice(0, 120)
  )
  check('parse_document 取到第一行正文', parsed.output.includes('Guncat Work PDF smoke line one'))
  check('parse_document 行不粘连（hasEOL 让相邻行各占一行）', parsed.output.includes('\n'))

  const searched = await WorkToolRunner.execute(
    ctx,
    convId,
    'search_pdf',
    JSON.stringify({ path: 'docs/probe.pdf', query: 'digits' })
  )
  check('search_pdf 命中关键词', searched.ok && searched.output.includes('digits'), searched.output.slice(0, 120))
  check('search_pdf 给出页码', searched.ok && searched.output.includes('第 1 页'), searched.output.slice(0, 80))

  const searchMiss = await WorkToolRunner.execute(
    ctx,
    convId,
    'search_pdf',
    JSON.stringify({ path: 'docs/probe.pdf', query: '这个关键词不存在于文档中' })
  )
  check('search_pdf 无命中时如实报告', searchMiss.ok && !searchMiss.output.includes('文档结构损坏'))

  const parseMissing = await WorkToolRunner.execute(
    ctx,
    convId,
    'parse_document',
    JSON.stringify({ path: 'docs/没有这个文件.pdf' })
  )
  check('不存在的 PDF 给出「文件不存在」而不是「结构损坏」', !parseMissing.ok, parseMissing.output.slice(0, 80))

  // 页面渲染：走纯函数（不经过 Electron 的 nativeImage），因此无头环境也能真的验证像素产出
  const png = await renderPdfPageToPng(path.join(pdfDir, 'probe.pdf'), 1, 600)
  check('PDF 页面可渲染成图（PNG 字节非空）', png.length > 1000, `${png.length} 字节`)
  check(
    '渲染产物确实是 PNG（魔数校验）',
    png[0] === 0x89 && png.toString('ascii', 1, 4) === 'PNG'
  )
  check(
    '渲染尺寸按目标宽等比缩放',
    png.readUInt32BE(16) === 600,
    `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
  )

  // 两个纯函数的边界：行标记与坐标映射
  check(
    'itemsToText：只有 hasEOL 才换行',
    itemsToText([
      { str: '甲' },
      { str: '乙', hasEOL: true },
      { str: '丙' }
    ]) === '甲乙\n丙'
  )
  check(
    'itemsToObjects：x/y 取自变换矩阵的 e/f（y 从页底算，与鸿蒙侧一致）',
    (() => {
      const objs = itemsToObjects([{ str: '甲', transform: [1, 0, 0, 1, 72, 700], width: 10, height: 12 }])
      return objs.length === 1 && objs[0].x === 72 && objs[0].y === 700
    })()
  )

  // ===== 18. SVG 栅格化 =====
  //
  // 用户报障：「write_svg 能保存 SVG 源码，但预览栅格化在本机失败，导致 docx/pptx 也不能引用 svg」。
  // 根因是那条栅格化走的是 Electron 的 nativeImage —— 它**只解码位图**，喂 SVG 必然失败。
  // 现在改走 @napi-rs/canvas（底层 resvg）。这一节把预览与两条引用路径都钉住。
  section('18. SVG 栅格化（write_svg 预览 / docx 与 pptx 引用 svg）')
  const svgSource =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
    '<rect width="200" height="100" rx="12" fill="#0A7AFF"/>' +
    '<circle cx="60" cy="50" r="24" fill="#ffffff"/>' +
    '<path d="M110 30 L170 50 L110 70 Z" fill="#FFD166"/></svg>'
  const svgWrite = await callTool('write_svg', { path: 'art/badge.svg', svg: svgSource, width: 512 })
  check('write_svg 成功', svgWrite.ok, svgWrite.output.slice(0, 140))
  check(
    'write_svg 这次真的生成了预览 PNG（此前这一步必然失败）',
    svgWrite.ok && svgWrite.output.includes('预览已生成'),
    svgWrite.output.split('\n').slice(1, 3).join(' | ')
  )
  const previewFile = path.join(wsRoot, 'art/badge_preview.png')
  check('预览 PNG 已落盘', fs.existsSync(previewFile))
  const previewBytes = fs.existsSync(previewFile) ? fs.readFileSync(previewFile) : Buffer.alloc(0)
  check('预览是合法 PNG（魔数）', previewBytes.length > 100 && previewBytes.toString('ascii', 1, 4) === 'PNG')
  check(
    '预览宽度按 width 参数、高度按 viewBox 等比',
    previewBytes.readUInt32BE(16) === 512 && previewBytes.readUInt32BE(20) === 256,
    `${previewBytes.readUInt32BE(16)}x${previewBytes.readUInt32BE(20)}`
  )

  // ===== 18b. view_image：真图必须带 dataUrl，假图必须报错 =====
  //
  // 用户报障：有效 PNG 只得到一句固定文案、模型收不到任何像素；而 131 字节纯文本
  // 改名 .png 也照样“成功”。根因有两层，这里分别钉住：
  //   1) 工具侧不再“扩展名对了就成功”，必须按字节探测/解码出真实图片；
  //   2) 循环侧必须把 imageDataUrl 作为下一条 user 多模态消息追加进历史。
  section('18b. view_image 内容校验与视觉注入')
  const viewValid = await callTool('view_image', { path: 'art/badge_preview.png' })
  check('view_image 对真实 PNG 成功', viewValid.ok, viewValid.output.slice(0, 160))
  check(
    'view_image 返回了真实图片 dataUrl（而不是只有成功文案）',
    viewValid.imageDataUrl.startsWith('data:image/png;base64,') && viewValid.imageDataUrl.length > 1000,
    `${viewValid.imageDataUrl.length} 字符`
  )
  check(
    '成功文案包含真实尺寸（来自解码结果）',
    viewValid.output.includes('512×256'),
    viewValid.output.slice(0, 160)
  )

  // 伪装的“图片”：纯文本改名 .png，必须在工具层被拒绝
  fs.writeFileSync(path.join(wsRoot, 'art/fake_image.png'), 'this is plain text, not a png\n', 'utf8')
  const viewFake = await callTool('view_image', { path: 'art/fake_image.png' })
  check('view_image 拒绝纯文本伪装的 .png', !viewFake.ok, viewFake.output.slice(0, 160))
  check('伪装文件不会返回 dataUrl', viewFake.imageDataUrl === '')
  check(
    '伪装文件报错说明原因（不是静默成功）',
    viewFake.output.includes('不是有效的图片'),
    viewFake.output.slice(0, 160)
  )

  // 只有 PNG 魔数/文件头的半截假图也必须失败（缺 IDAT/IEND）
  fs.writeFileSync(
    path.join(wsRoot, 'art/truncated.png'),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
    ])
  )
  const viewTruncated = await callTool('view_image', { path: 'art/truncated.png' })
  check('view_image 拒绝只有文件头的截断 PNG', !viewTruncated.ok, viewTruncated.output.slice(0, 160))

  // 循环侧注入：模拟工具执行完后的历史，确认图片进入 LoopMessage 且与工具结果相邻
  const injectionMessages: LoopMessage[] = [
    LoopMessage.system('system'),
    LoopMessage.assistant('', [])
  ]
  const attachment: ToolImageAttachment = new ToolImageAttachment()
  attachment.toolName = 'view_image'
  attachment.argsJson = '{"path":"art/badge_preview.png"}'
  attachment.imageDataUrl = viewValid.imageDataUrl
  attachment.note = viewValid.output
  const injected = AgentLoopService.appendToolImageMessages(injectionMessages, [attachment])
  check('循环把工具图片追加为一条 user 消息', injected === 1 && injectionMessages.length === 3)
  check(
    '注入消息带图片 dataUrl 且说明里保留真实路径',
    injectionMessages[2].role === 'user' &&
      injectionMessages[2].imageDataUrl === viewValid.imageDataUrl &&
      injectionMessages[2].content.includes('art/badge_preview.png'),
    injectionMessages[2].content.slice(0, 100)
  )
  check(
    '没有图片时不动历史（不破坏前缀缓存）',
    AgentLoopService.appendToolImageMessages(injectionMessages, []) === 0 &&
      injectionMessages.length === 3
  )

  // pptx 直接引用 .svg：走 imageResolver 的自动栅格化
  const pptxSvg = await callTool('write_pptx', {
    path: 'out/图形汇报.pptx',
    deck: JSON.stringify({
      title: '图形汇报',
      slides: [{ layout: 'image', title: '徽标', image: 'art/badge.svg' }]
    })
  })
  check('write_pptx 可引用 .svg（自动栅格化）', pptxSvg.ok, pptxSvg.output.slice(0, 120))
  const pptxSvgBytes = fs.existsSync(path.join(wsRoot, 'out/图形汇报.pptx'))
    ? fs.readFileSync(path.join(wsRoot, 'out/图形汇报.pptx'))
    : Buffer.alloc(0)
  check(
    'pptx 里确实嵌入了图片（zip 内含 ppt/media）',
    pptxSvgBytes.includes(Buffer.from('ppt/media/'))
  )

  // docx 引用预览 PNG（工具说明要求 docx 引用预览而不是 .svg）
  const docxSvg = await callTool('write_docx', {
    path: 'out/图形报告.docx',
    markdown: '# 图形\n\n![徽标](art/badge_preview.png)\n'
  })
  check('write_docx 可引用预览 PNG', docxSvg.ok, docxSvg.output.slice(0, 120))
  const docxSvgBytes = fs.existsSync(path.join(wsRoot, 'out/图形报告.docx'))
    ? fs.readFileSync(path.join(wsRoot, 'out/图形报告.docx'))
    : Buffer.alloc(0)
  check('docx 里确实嵌入了图片（zip 内含 word/media）', docxSvgBytes.includes(Buffer.from('word/media/')))

  // ===== 19. HTTP 读空闲超时 =====
  //
  // 回归防线：平台层的 buildSignal 曾经把鸿蒙的「读空闲超时」当成一次性整段超时
  // （请求开始后 N 毫秒无条件 abort）。而端口代码传的正是读空闲语义 ——
  // 工作模式 300000、聊天 180000，于是**只要一轮流式超过 5 分钟就必然以网络错误中断**，
  // 哪怕数据一直在流。这一节用本地服务把两种情形分别钉住。
  section('19. HTTP 读空闲超时（长流式不该被掐断）')
  const nodeHttp = await import('node:http')

  async function startStreamServer(
    gapMs: number,
    blocks: number,
    stall: boolean
  ): Promise<{ server: import('node:http').Server; url: string }> {
    const server = nodeHttp.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      if (stall) {
        // 先给一块再静止：证明「有没有数据」才是判据，而不是「有没有开始」
        res.write('first')
        return
      }
      let sent = 0
      const timer = setInterval(() => {
        res.write('chunk' + String(sent))
        sent++
        if (sent >= blocks) {
          clearInterval(timer)
          res.end()
        }
      }, gapMs)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { server, url: 'http://127.0.0.1:' + String(port) + '/' }
  }

  function stopServer(server: import('node:http').Server): void {
    // 停滞那条的 socket 还挂着，先掐连接再关，避免冒烟脚本卡在 close 上
    server.closeAllConnections?.()
    server.close()
  }

  // A) 总时长（约 720ms）远超读超时（300ms），但块与块之间只隔 60ms —— 读空闲语义下这是正常长流式
  //
  // 允许多试两次：这一段验证的是**超时语义**，不是连通性。本机上偶发过
  // 「fetch failed / 0 块」的连接层抖动（上一轮的 socket 还没完全释放），
  // 那与读超时无关。只在**完全没收到任何数据**时才重试，语义断言不受影响。
  let errorA = ''
  let chunksA: string[] = []
  let endedA = false
  let tries = 0
  while (tries < 3) {
    tries++
    const streamed = await startStreamServer(60, 12, false)
    const httpA = guncatHttp.createHttp()
    chunksA = []
    endedA = false
    errorA = ''
    httpA.on('dataReceive', (data: ArrayBuffer) => {
      chunksA.push(Buffer.from(data).toString('utf8'))
    })
    httpA.on('dataEnd', () => {
      endedA = true
    })
    try {
      await httpA.requestInStream(streamed.url, {
        method: guncatHttp.RequestMethod.GET,
        readTimeout: 300,
        connectTimeout: 3000
      })
    } catch (e) {
      errorA = String((e as Error)?.message ?? e)
    }
    stopServer(streamed.server)
    if (errorA === '' || chunksA.length > 0) {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
  }
  check(
    '长流式：总时长超过读超时、但一直在读 —— 不该被中断',
    errorA === '' && endedA,
    `${chunksA.length} 块 / 第 ${tries} 次 / 错误=${errorA === '' ? '无' : errorA.slice(0, 50)}`
  )
  const expectedA = Array.from({ length: 12 }, (_v, i) => 'chunk' + String(i)).join('')
  check('长流式：数据一块不落', chunksA.join('') === expectedA, `${chunksA.join('').length} 字节`)

  // B) 拿到响应头后不再发数据 —— 这才应该由读空闲超时掐断
  const stalled = await startStreamServer(0, 0, true)
  const httpB = guncatHttp.createHttp()
  let endedB = false
  httpB.on('dataEnd', () => {
    endedB = true
  })
  let errorB = ''
  const beganAt = Date.now()
  try {
    await httpB.requestInStream(stalled.url, {
      method: guncatHttp.RequestMethod.GET,
      readTimeout: 300,
      connectTimeout: 3000
    })
  } catch (e) {
    errorB = String((e as Error)?.message ?? e)
  }
  const waitedB = Date.now() - beganAt
  check(
    '停滞的连接：读空闲超时会掐断它（不能一直挂着）',
    errorB !== '' && waitedB < 5000,
    `${waitedB}ms / 错误=${errorB.slice(0, 50)}`
  )
  check('掐断时仍然派发 dataEnd，端口代码不会停在半途', endedB)
  stopServer(stalled.server)

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
