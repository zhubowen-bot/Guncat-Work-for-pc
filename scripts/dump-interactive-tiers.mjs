// 导出「交互模式 · 能力调度」九个档位的完整系统提示词（分段结构 + 全文）。
//
// 用法：node scripts/dump-interactive-tiers.mjs
// 产物：docs/prompts/interactive-tiers/01-lite.md ~ 09-eval.md + README.md（档位索引）
//       docs/interactive-prompt-preview.md（轻简档结构与全文预览）
//
// 为什么要有这个脚本（而不是手写文档）：档位提示词 = 代码共享层（InteractiveTierPrompt 等）
// + resources/ 档位主体 md 的组合，散在代码与资源里，无法直接比对。这里从**真实模块**组装
// （与运行时同一个 InteractiveTierPrompt.assemble() 入口），把"最终发给模型的提示词"原样导出，
// 既能 review 也能回归：轻简档的组装结果必须与旧四段组装逐字节一致（脚本里有断言）。
//
// 实现方式与 scripts/dump-components.mjs 一致：用 esbuild 把 @core 别名下的真实 TS 模块打成
// 一个临时 ESM bundle 再 import，避免在 node 里直接跑 TS。
//
// 受限环境（没有子进程权限、esbuild JS API 起不来）的兜底：
//   1) DUMP_TIERS_ENTRY_ONLY=1 node scripts/dump-interactive-tiers.mjs
//      只生成 esbuild 入口 .smoke/dump-tiers-entry.ts 并退出；
//   2) 用 esbuild CLI 手动打包该入口（别名表见 scripts/esbuild-aliases.mjs），例如：
//      ./node_modules/@esbuild/win32-x64/esbuild.exe .smoke/dump-tiers-entry.ts \
//        --bundle --platform=node --format=esm --target=node22 --external:electron \
//        --alias:@core=./src/core --alias:@ipc=./src/ipc \
//        --outfile=.smoke/dump-tiers-bundle.mjs
//   3) DUMP_TIERS_BUNDLE=.smoke/dump-tiers-bundle.mjs node scripts/dump-interactive-tiers.mjs
//      跳过后台打包，直接 import 预打包产物。正常环境不需要这三步。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { root, alias } from './esbuild-aliases.mjs'

const repoRoot = root
const resourcesDir = path.join(repoRoot, 'resources')
const outDir = path.join(repoRoot, 'docs', 'prompts', 'interactive-tiers')
const smokeDir = path.join(repoRoot, '.smoke')
const entry = path.join(smokeDir, 'dump-tiers-entry.ts')
const bundle = path.join(smokeDir, 'dump-tiers-bundle.mjs')

// esbuild 入口：只做"从真实模块组装 + 自检"，不碰文件系统（档位主体由外层脚本读好后传入）。
// 写成纯 JS 是因为 esbuild 只转译不做类型检查；这里也不该有平台依赖。
const entrySource = `import { InteractiveTiers } from '@core/common/InteractiveTiers'
import { InteractiveTierPrompt } from '@core/common/InteractiveTierPrompt'
import { GuncatUiPrompt } from '@core/common/GuncatUiPrompt'
import { GuncatUiLibrary } from '@core/common/GuncatUiLibrary'
import { PromptBuilder } from '@core/common/PromptBuilder'
import { PromptBudget } from '@core/common/PromptBudget'
import { ToolRegistry } from '@core/common/ToolRegistry'
import { SkillDirectoryFormatter } from '@core/common/SkillDirectoryFormatter'

// 与运行时 SkillDirectoryFormatter.interactiveIndex() 同源：五支格式技能（不含正文，导出只用到目录行）。
const skillList = [
  { id: 'ppt', name: 'PPT 制作与编辑', description: '', files: [] },
  { id: 'docx', name: 'Word 文档制作与编辑', description: '', files: [] },
  { id: 'xlsx', name: 'Excel 表格制作与编辑', description: '', files: [] },
  { id: 'svg', name: 'SVG 矢量绘图（生图）', description: '', files: [] },
  { id: 'data', name: '数据清洗与转换', description: '', files: [] }
]

// 工具名索引：取该档位白名单对应的工具名，再按 buildToolNameIndex 排序（与运行时的名字口径一致；
// 差别只有插件动态工具，旧导出脚本也是这样处理的）。
function toolIndexFor(tierId) {
  const names = ToolRegistry.interactiveWhitelist(tierId).map((n) => ({ name: n }))
  return PromptBuilder.buildToolNameIndex(names)
}

// 档位元数据（外层脚本据此读 resources/ 下的档位主体）。与运行时同一份 InteractiveTiers.ALL。
export function tierMeta() {
  return InteractiveTiers.ALL.map((t) => ({ id: t.id, promptFile: t.promptFile }))
}

export function dump(bodies) {
  const skills = SkillDirectoryFormatter.interactiveIndex(skillList)

  // 轻简档回归：组装结果必须与旧四段组装逐字节一致（改坏共享层会立刻被这个断言拦住）。
  const liteToolIndex = toolIndexFor(InteractiveTiers.LITE_ID)
  const liteOld = PromptBuilder.assembleInteractiveSystemPrompt(
    GuncatUiPrompt.promptSection(), skills, liteToolIndex, GuncatUiPrompt.INTERACTIVE_DUTY)
  const liteNew = InteractiveTierPrompt.assemble(InteractiveTiers.LITE_ID, '', skills, liteToolIndex)
  if (liteOld !== liteNew) {
    throw new Error('轻简档组装结果与旧四段组装不一致（应逐字节相同）: ' +
      liteOld.length + ' vs ' + liteNew.length)
  }

  const tiers = []
  for (let i = 0; i < InteractiveTiers.ALL.length; i++) {
    const tier = InteractiveTiers.ALL[i]
    const body = tier.promptFile === '' ? '' : (bodies[tier.id] === undefined ? '' : bodies[tier.id])
    if (tier.promptFile !== '' && String(body).trim() === '') {
      throw new Error('档位主体为空或缺失: resources/' + tier.promptFile + '（档位 ' + tier.id + '）')
    }
    const toolIndex = toolIndexFor(tier.id)
    const assembled = InteractiveTierPrompt.assemble(tier.id, body, skills, toolIndex)
    const segs = InteractiveTierPrompt.segments(tier.id, body, skills, toolIndex)
    // 自检：段拼接必须等于 assemble() 结果（防止"导出的结构"与"运行时拼接"分叉）。
    const rebuilt = segs.filter((s) => s.text !== '').map((s) => s.text).join('\\n\\n')
    if (rebuilt !== assembled) {
      throw new Error('档位 ' + tier.id + ': segments 拼接与 assemble 结果不一致')
    }
    tiers.push({
      id: tier.id,
      name: tier.name,
      sourceAgent: tier.sourceAgent,
      tagline: tier.tagline,
      sourceFile: tier.sourceFile,
      promptFile: tier.promptFile,
      defaultEffort: tier.defaultEffort,
      extraTools: tier.extraTools,
      toolCount: ToolRegistry.interactiveWhitelist(tier.id).length,
      chars: assembled.length,
      tokens: PromptBudget.estimateTokens(assembled),
      segs: segs.map((s) => ({ name: s.name, source: s.source, text: s.text }))
    })
  }

  const names = GuncatUiLibrary.names()
  let visible = 0
  for (let i = 0; i < names.length; i++) {
    const def = GuncatUiLibrary.def(names[i])
    if (def && !def.promptHidden) visible++
  }
  return {
    library: {
      registered: names.length,
      visible: visible,
      promptSectionChars: GuncatUiLibrary.promptSection().length
    },
    tiers: tiers
  }
}
`

function formatChars(n) {
  return n.toLocaleString('en-US')
}

const entryOnly = process.env.DUMP_TIERS_ENTRY_ONLY === '1'
const bundleOverride = process.env.DUMP_TIERS_BUNDLE || ''

fs.mkdirSync(smokeDir, { recursive: true })
fs.writeFileSync(entry, entrySource, 'utf8')
if (entryOnly) {
  console.log('已生成 esbuild 入口:', path.relative(repoRoot, entry))
  process.exit(0)
}

if (bundleOverride === '') {
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    alias,
    logLevel: 'error'
  })
}

const bundlePath = bundleOverride === '' ? bundle : path.resolve(repoRoot, bundleOverride)
if (!fs.existsSync(bundlePath)) {
  throw new Error('找不到预打包产物: ' + bundlePath + '（可先设 DUMP_TIERS_ENTRY_ONLY=1 生成入口）')
}
const mod = await import(pathToFileURL(bundlePath).href + '?t=' + Date.now())

// 档位主体从 resources/ 读取（node 侧）；缺失/为空直接抛错，绝不导出"没有业务主体的空壳档位"。
const bodies = {}
const tierMeta = mod.tierMeta()
for (const tier of tierMeta) {
  if (tier.promptFile === '') continue
  const file = path.join(resourcesDir, tier.promptFile)
  if (!fs.existsSync(file)) {
    throw new Error('档位主体缺失: resources/' + tier.promptFile + '（档位 ' + tier.id + '）')
  }
  const text = fs.readFileSync(file, 'utf8')
  if (text.trim() === '') {
    throw new Error('档位主体为空: resources/' + tier.promptFile + '（档位 ' + tier.id + '）')
  }
  bodies[tier.id] = text
}

const data = mod.dump(bodies)
if (data.tiers.length !== 9) {
  throw new Error('档位数量应为 9，实际 ' + data.tiers.length)
}

fs.mkdirSync(outDir, { recursive: true })

const indexRows = []
for (let ti = 0; ti < data.tiers.length; ti++) {
  const tier = data.tiers[ti]
  const seq = String(ti + 1).padStart(2, '0')
  const out = []
  out.push('# 交互模式 · 能力调度档位「' + tier.name + '」系统提示词（完整导出）')
  out.push('')
  out.push('> 本文件由 `scripts/dump-interactive-tiers.mjs` 从**真实模块 + resources/ 档位主体**组装导出，' +
    '与运行时 `AgentLoopService` 组装交互模式系统提示词走同一个 `InteractiveTierPrompt.assemble()` 入口。')
  out.push('> 与本机运行时的差别只有两处：技能段用真实的 5 支格式技能；工具名索引取该档位白名单对应的工具名' +
    '（插件动态工具不在其中）。')
  out.push('')
  out.push('## 档位元数据')
  out.push('')
  out.push('| 项 | 值 |')
  out.push('| --- | --- |')
  out.push('| 档位 id | `' + tier.id + '` |')
  out.push('| 名称 | ' + tier.name + ' |')
  out.push('| 移植来源 | ' + (tier.sourceFile !== '' ? '`' + tier.sourceFile + '`' : '无（轻简档复用原交互模式提示词）') + ' |')
  out.push('| 档位主体文件 | ' + (tier.promptFile !== '' ? '`resources/' + tier.promptFile + '`' : '无') + ' |')
  out.push('| 默认思考强度 | `' + tier.defaultEffort + '` |')
  out.push('| 档位追加工具 | ' + (tier.extraTools.length > 0
    ? tier.extraTools.map((n) => '`' + n + '`').join(' / ') : '无') + ' |')
  out.push('| 交互工具面 | ' + tier.toolCount + ' 个工具 |')
  out.push('| 字符数 | ' + formatChars(tier.chars) + ' |')
  out.push('| 估算 tokens | 约 ' + formatChars(tier.tokens) + ' |')
  out.push('')
  out.push('## 结构一览（按拼接顺序）')
  out.push('')
  out.push('| # | 段 | 来源 | 字符 |')
  out.push('| ---: | --- | --- | ---: |')
  for (let i = 0; i < tier.segs.length; i++) {
    out.push('| ' + (i + 1) + ' | ' + tier.segs[i].name + ' | `' + tier.segs[i].source + '` | ' +
      formatChars(tier.segs[i].text.length) + ' |')
  }
  out.push('| | **合计** | | **' + formatChars(tier.chars) + '** |')
  out.push('')
  out.push('---')
  out.push('')
  for (let i = 0; i < tier.segs.length; i++) {
    if (tier.segs[i].text === '') continue
    out.push('## ' + tier.segs[i].name + '　`' + formatChars(tier.segs[i].text.length) + ' 字符`')
    out.push('')
    out.push('```text')
    out.push(tier.segs[i].text)
    out.push('```')
    out.push('')
  }
  const file = seq + '-' + tier.id + '.md'
  fs.writeFileSync(path.join(outDir, file), out.join('\n'), 'utf8')
  indexRows.push('| ' + (ti + 1) + ' | ' + tier.name + ' | ' +
    (tier.sourceFile !== '' ? '`' + tier.sourceFile.replace('.md', '') + '`' : '—（原交互模式提示词）') +
    ' | ' + (tier.promptFile !== '' ? '`' + tier.promptFile + '`' : '—') +
    ' | `' + tier.defaultEffort + '` | ' + tier.toolCount + ' | ' + formatChars(tier.chars) + ' | [查看](' + file + ') |')
  console.log('导出', file, tier.chars, '字符,', tier.tokens, 'tokens, ' + tier.toolCount + ' 工具')
}

// README 索引
const readme = []
readme.push('# 交互模式 · 能力调度档位提示词（完整导出）')
readme.push('')
readme.push('> 这些文件是**运行时真正拼出来的系统提示词**，不是设计稿。重新生成：')
readme.push('> `node scripts/dump-interactive-tiers.mjs`')
readme.push('')
readme.push('## 档位一览')
readme.push('')
readme.push('| # | 档位 | 移植来源 | 档位主体 | 默认思考 | 工具面 | 字符数 | 全文 |')
readme.push('| ---: | --- | --- | --- | --- | ---: | ---: | --- |')
for (const row of indexRows) readme.push(row)
readme.push('')
readme.push('## 分层结构（九个档位共用同一套骨架）')
readme.push('')
readme.push('| 段 | 内容 | 轻简 | 其余八档 |')
readme.push('| --- | --- | --- | --- |')
readme.push('| ① 档位声明 | 身份 + 第一纪律 + 工具面政策 + 思考政策 + 丰富度口径（唯一的一级标题） | ' +
  '原 `interactivePrime()`（逐字节复用） | `InteractiveTierPrompt.tierPrime()` 按档生成 |')
readme.push('| ②~⑨ 界面语言契约 | guncat-ui 语法 / 组件清单（库内注册 ' + data.library.registered +
  '、清单可见 ' + data.library.visible + '；由 GuncatUiLibrary 生成）/ 丰富度 / 交互闭环 / 流式顺序 / 示例 / 反例 | ' +
  '原文 | 原文（丰富度数量口径换为「越多越好」） |')
readme.push('| ⑩ 档位主体 | 原聊天引擎提示词的适配版（角色/思维链/工作流/反幻觉/模板/知识库） | 无 | ' +
  '`resources/interactive-tier-*.md` |')
readme.push('| ⑪~⑭ 环境底座 | 工作区 / 本档工具面 / 真实数据纪律 / 技能索引 | 素材区口径 | 素材区 + 产出区口径 |')
readme.push('| ⑮ 起手式 | 进入执行的最后一句引导 | 原句 | 档位版 |')
readme.push('| ⑯ 交付形态职责 | 程序之外不写文字 / 往丰富一侧 / 冲突裁决（最后解释权） | 原文 | 档位版 |')
readme.push('')
readme.push('> 组装顺序由 `InteractiveTierPrompt.segments()` 单一事实源固定；轻简档的组装结果与旧的四段组装' +
  '**逐字节一致**（导出脚本里有断言）。分层设计与适配说明见 [提示词适配说明](../interactive-tier-adaptation.md)。')
fs.writeFileSync(path.join(outDir, 'README.md'), readme.join('\n'), 'utf8')

// 轻简档预览（保持 docs/interactive-prompt-preview.md 与当前实现同步）
const liteTier = data.tiers[0]
if (liteTier.id !== 'lite') {
  throw new Error('第一档应为轻简档（lite），实际 ' + liteTier.id)
}
const preview = []
preview.push('# 交互模式系统提示词 · 实际结构与全文（轻简档 / 能力调度默认档）')
preview.push('')
preview.push('> 由 `scripts/dump-interactive-tiers.mjs` 从真实模块导出。轻简档 = 原交互模式提示词，' +
  '与旧四段组装逐字节一致；其余档位见 [能力调度档位导出](prompts/interactive-tiers/README.md)。')
preview.push('')
preview.push('## 结构一览（按拼接顺序）')
preview.push('')
preview.push('| # | 段 | 来源 | 字符 |')
preview.push('| ---: | --- | --- | ---: |')
for (let i = 0; i < liteTier.segs.length; i++) {
  preview.push('| ' + (i + 1) + ' | ' + liteTier.segs[i].name + ' | `' + liteTier.segs[i].source + '` | ' +
    formatChars(liteTier.segs[i].text.length) + ' |')
}
preview.push('| | **合计** | | **' + formatChars(liteTier.chars) + '** |')
preview.push('')
preview.push('> 拼接方式：`InteractiveTierPrompt.assemble(\'lite\', \'\', skills, toolIndex)` —— 顺序由 ' +
  '`InteractiveTierPrompt.segments()` 固定，段间以空行相连，整体静态、进程内按档位缓存一次。')
preview.push('')
preview.push('---')
preview.push('')
for (let i = 0; i < liteTier.segs.length; i++) {
  if (liteTier.segs[i].text === '') continue
  preview.push('## ' + liteTier.segs[i].name + '　`' + formatChars(liteTier.segs[i].text.length) + ' 字符`')
  preview.push('')
  preview.push('```text')
  preview.push(liteTier.segs[i].text)
  preview.push('```')
  preview.push('')
}
fs.writeFileSync(path.join(repoRoot, 'docs', 'interactive-prompt-preview.md'), preview.join('\n'), 'utf8')
console.log('导出 docs/interactive-prompt-preview.md（轻简档 ' + formatChars(liteTier.chars) + ' 字符）')
console.log('完成: 共 ' + data.tiers.length + ' 个档位；组件库注册 ' + data.library.registered +
  '、提示词可见 ' + data.library.visible + '；组件清单段 ' + formatChars(data.library.promptSectionChars) + ' 字符')
