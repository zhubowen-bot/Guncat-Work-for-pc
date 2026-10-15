// 可折叠区块与工具行。
//
// 对齐原版：WorkTurnView 的工具行是「dsh 24px 单行」规格 ——
// [16 图标] · [标题] · [参数摘要] · [状态]，点击才展开参数/结果的 IO 卡片。
// 折叠箭头用 SVG chevron（原版 sys.symbol.chevron_down/up），不再用实心三角这类字符。
import { useState } from 'react'
import type { ToolCallRecordDto } from '@ipc/contract'
import {
  IconArrowRight,
  IconCalendar,
  IconChart,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconCircle,
  IconCopy,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconGlobe,
  IconInfo,
  IconList,
  IconSearch,
  IconStar,
  IconTrash,
  IconUser
} from '../icons'
import {
  toolArgsSummary,
  toolDisplayName,
  toolIconKind,
  toolStatus,
  capText,
  firstLineOf,
  formatDuration,
  type ToolIconKind
} from '../turns'

export function IconForKind({ kind, size = 15 }: { kind: ToolIconKind; size?: number }) {
  switch (kind) {
    case 'read':
      return <IconFile size={size} />
    case 'write':
      return <IconEdit size={size} />
    case 'edit':
      return <IconEdit size={size} />
    case 'search':
      return <IconSearch size={size} />
    case 'web':
      return <IconGlobe size={size} />
    case 'fetch':
      return <IconGlobe size={size} />
    case 'ask':
      return <IconUser size={size} />
    case 'schedule':
      return <IconCalendar size={size} />
    case 'goal':
      return <IconStar size={size} />
    case 'spawn':
      return <IconCopy size={size} />
    case 'skill':
      return <IconList size={size} />
    case 'image':
      return <IconChart size={size} />
    case 'shell':
      return <IconArrowRight size={size} />
    case 'list':
      return <IconList size={size} />
    case 'trash':
      return <IconTrash size={size} />
    case 'move':
      return <IconFolder size={size} />
    case 'download':
      return <IconDownload size={size} />
    case 'check':
      return <IconCheck size={size} />
    default:
      return <IconInfo size={size} />
  }
}

export function Disclosure({
  title,
  subtitle,
  children,
  defaultOpen = false,
  leading,
  open: controlledOpen,
  onToggle
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  defaultOpen?: boolean
  leading?: React.ReactNode
  /** 受控开合：给定时完全以它为准（派生状态由调用方算，如原版 activityOpenNow） */
  open?: boolean
  onToggle?: (next: boolean) => void
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolled
  return (
    <div className="disclosure" data-open={open}>
      <button
        className="disclosure__head"
        onClick={() => {
          const next = !open
          if (onToggle !== undefined) {
            onToggle(next)
          } else {
            setUncontrolled(next)
          }
        }}
      >
        <span className="disclosure__caret">
          <IconChevronDown size={14} />
        </span>
        {leading !== undefined ? <span className="disclosure__leading">{leading}</span> : null}
        <span className="disclosure__title">{title}</span>
        {subtitle !== undefined && subtitle !== '' ? (
          <span className="disclosure__subtitle">{subtitle}</span>
        ) : null}
      </button>
      {open ? <div className="disclosure__body">{children}</div> : null}
    </div>
  )
}

/** 工具调用行：单行摘要 + 点开看结构化卡片（diff / 任务清单），拿不到结构就退回原始 IO */
export function ToolCallRow({
  call,
  defaultExpanded = false
}: {
  call: ToolCallRecordDto
  /** 初始展开状态（对应原版的 expandedStepId；渲染验证要能看到卡片内容） */
  defaultExpanded?: boolean
}) {
  const [open, setOpen] = useState(defaultExpanded)
  const status = toolStatus(call)
  // edit / str_replace_editor 的改动行、todo_write 的清单都已经被工具层结构化好了
  // （见 core/common/DiffUtil 与 todo_write 的结果格式），直接渲染成卡片，
  // 不必让用户去读转义 JSON —— 原版 WorkTurnView 就是这么做的。
  //
  // 与原版一致：这三种形态是**互斥**的 —— 有清单/卡片就不再叠一份原始参数与结果。
  const useTodo = call.name === 'todo_write' && status.state !== 'error' && call.result !== ''
  const diff = useTodo ? null : parseFileDiff(call.diff)
  const todos = useTodo ? parseTodoRows(call.result) : []
  // 执行中用转圈代替图标，并且不给耗时与展开箭头（原版以「durationMs 是否为负」为唯一判据）
  const finished = call.durationMs >= 0
  const failed = status.state === 'error'
  // 出错时摘要改成**结果的首行**（80 字截断）—— 原版 WorkTurnView.ets:972-978 就是这么做的：
  // 参数摘要这时候没意义，用户要看的是「哪儿错了」。
  const summary = failed ? capText(firstLineOf(call.result), 80) : toolArgsSummary(call.argsJson)

  return (
    <div className="tool" data-state={status.state}>
      <button className="tool__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool__icon">
          {finished ? <IconForKind kind={toolIconKind(call.name)} size={13} /> : <span className="spinner" />}
        </span>
        <span className="tool__name">{toolDisplayName(call.name)}</span>
        {/* 原版这里是「·」分隔符 + 参数摘要；摘要可能为空，那时连分隔符一起省掉 */}
        {summary !== '' ? (
          <>
            <span className="tool__dot">·</span>
            <span className="tool__args">{summary}</span>
          </>
        ) : null}
        {diff !== null ? (
          <span className="tool__counts">
            <span className="diff-stat__add">+{diff.adds}</span>
            <span className="diff-stat__del">-{diff.dels}</span>
          </span>
        ) : null}
        {todos.length > 0 ? (
          <span className="tool__counts">
            {todos.filter((t) => t.status === 'completed').length}/{todos.length}
          </span>
        ) : null}
        {/* 右端：错误显示「失败」，否则显示耗时；执行中两者都不显示 */}
        {status.state === 'error' ? (
          <span className="tool__status" data-state="error">
            失败
          </span>
        ) : finished ? (
          <span className="tool__duration">{formatDuration(call.durationMs)}</span>
        ) : null}
        {finished ? (
          <span className="tool__caret" data-open={open}>
            <IconChevronDown size={12} />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="tool__body">
          {diff !== null ? (
            <DiffCard diff={diff} isError={status.state === 'error'} />
          ) : todos.length > 0 ? (
            <TodoChecklist rows={todos} />
          ) : (
            /* 未命中结构化卡片时退回原始 IO。截断口径逐字对齐原版 WorkStepFormat.capText
               （参数 600 / 结果 800）—— 截太多会把长参数里最关键的尾部丢掉。 */
            <div className="tool__detail">
              <div className="io">
                <div className="io__label">参数</div>
                <pre className="io__pre">{capText(call.argsJson !== '' ? call.argsJson : '(无)', 600)}</pre>
              </div>
              <div className="io">
                <div className="io__label" data-error={status.state === 'error'}>
                  {status.state === 'error' ? '错误' : '结果'}
                </div>
                <pre className="io__pre" data-error={status.state === 'error'}>
                  {capText(
                    call.result === ''
                      ? status.state === 'running'
                        ? '(执行中...)'
                        : '(尚无输出)'
                      : call.result,
                    800
                  )}
                </pre>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ===== diff / todo 卡片 =====

interface DiffRowDto {
  type: string
  text: string
  header: string
}

interface ParsedDiff {
  path: string
  adds: number
  dels: number
  truncated: boolean
  rows: DiffRowDto[]
}

interface TodoRowDto {
  status: string
  content: string
}

/**
 * 解析工具结果 meta 里的 FileDiff。
 * 结构由 `core/common/DiffUtil.FileDiff.toJsonObject()` 产生（行用短键 t/x 存）。
 * 任何解析失败一律返回 null → 退回原来的 IO 卡片，绝不让界面因为卡片渲染不出来而空掉。
 */
export function parseFileDiff(meta: string): ParsedDiff | null {
  if (meta === '' || meta === undefined) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(meta)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const obj = raw as Record<string, unknown>
  const hunks = obj.hunks
  if (!Array.isArray(hunks)) {
    return null
  }
  const rows: DiffRowDto[] = []
  for (const hunkRaw of hunks) {
    if (typeof hunkRaw !== 'object' || hunkRaw === null) {
      continue
    }
    const hunk = hunkRaw as Record<string, unknown>
    const header = typeof hunk.header === 'string' ? hunk.header : ''
    const lines = hunk.lines
    if (!Array.isArray(lines)) {
      continue
    }
    for (const lineRaw of lines) {
      if (typeof lineRaw !== 'object' || lineRaw === null) {
        continue
      }
      const line = lineRaw as Record<string, unknown>
      rows.push({
        type: typeof line.t === 'string' ? line.t : 'same',
        text: typeof line.x === 'string' ? line.x : '',
        header
      })
    }
  }
  return {
    path: typeof obj.path === 'string' ? obj.path : '',
    adds: typeof obj.adds === 'number' ? obj.adds : 0,
    dels: typeof obj.dels === 'number' ? obj.dels : 0,
    truncated: obj.truncated === true,
    rows
  }
}

/**
 * 解析 `todo_write` 的结果文本。
 * 工具层输出的是逐行状态标记（`[已完成]/[进行中]/[待开始]`，也兼容 `[x]/[~]/[ ]`），
 * 里面还带着清单序号（`1. `），渲染前把它去掉。
 */
export function parseTodoRows(result: string): TodoRowDto[] {
  if (result === '') {
    return []
  }
  const rows: TodoRowDto[] = []
  for (const rawLine of result.split('\n')) {
    const line = rawLine.trim()
    let status = ''
    let content = ''
    const marks: Array<[string, string]> = [
      ['[已完成]', 'completed'],
      ['[进行中]', 'in_progress'],
      ['[待开始]', 'pending'],
      ['[x]', 'completed'],
      ['[X]', 'completed'],
      ['[~]', 'in_progress'],
      ['[ ]', 'pending']
    ]
    for (const [prefix, mapped] of marks) {
      if (line.startsWith(prefix)) {
        status = mapped
        content = line.slice(prefix.length).trim()
        break
      }
    }
    if (status === '' || content === '') {
      continue
    }
    const dot = content.indexOf('. ')
    if (dot > 0 && dot <= 3 && !Number.isNaN(Number.parseInt(content.slice(0, dot), 10))) {
      content = content.slice(dot + 2)
    }
    rows.push({ status, content })
  }
  return rows
}

/** dsh DiffBlock 风格：代码底色 + 增删行着色 + 底部统计 */
function DiffCard({ diff, isError }: { diff: ParsedDiff; isError: boolean }) {
  return (
    <div className="diffcard">
      <div className="diffcard__head" data-error={isError}>
        {isError ? 'ERROR' : diff.path}
      </div>
      <div className="diffcard__body">
        {diff.rows.map((row, index) => (
          <div className="diffrow" data-type={row.type} key={`${index}-${row.type}`}>
            <span className="diffrow__sign">
              {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
            </span>
            <span className="diffrow__text">{row.text}</span>
          </div>
        ))}
      </div>
      <div className="diffcard__stat">
        └ <span className="diff-stat__add">+{diff.adds}</span>{' '}
        <span className="diff-stat__del">-{diff.dels}</span>
        {diff.truncated ? ' · 已折叠' : ''}
      </div>
    </div>
  )
}

/** todo_write 的任务清单卡：勾选状态 + 完成项划线 */
function TodoChecklist({ rows }: { rows: TodoRowDto[] }) {
  return (
    <div className="todocard">
      {rows.map((row, index) => (
        <div className="todorow" data-status={row.status} key={`${index}-${row.content}`}>
          <span className="todorow__mark">
            {row.status === 'completed' ? <IconCheckCircle size={14} /> : <IconCircle size={14} />}
          </span>
          <span className="todorow__text">{row.content}</span>
        </div>
      ))}
    </div>
  )
}
