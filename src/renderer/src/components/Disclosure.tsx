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
  IconChevronDown,
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

/** 工具调用行：单行摘要 + 点开看参数/结果 */
export function ToolCallRow({ call }: { call: ToolCallRecordDto }) {
  const [open, setOpen] = useState(false)
  const status = toolStatus(call)
  const summary = toolArgsSummary(call.argsJson)

  return (
    <div className="tool" data-state={status.state}>
      <button className="tool__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool__icon">
          <IconForKind kind={toolIconKind(call.name)} />
        </span>
        <span className="tool__name">{toolDisplayName(call.name)}</span>
        {summary !== '' ? <span className="tool__args">{summary}</span> : null}
        {status.state !== 'ok' ? (
          <span className="tool__status" data-state={status.state}>
            {status.label}
          </span>
        ) : null}
        <span className="tool__caret">
          <IconChevronDown size={14} />
        </span>
      </button>
      {open ? (
        <div className="tool__body">
          <div className="io">
            <div className="io__label">参数</div>
            <pre className="io__pre">{call.argsJson !== '' ? call.argsJson : '(无)'}</pre>
          </div>
          <div className="io">
            <div className="io__label" data-error={status.state === 'error'}>
              {status.state === 'error' ? '错误' : '结果'}
            </div>
            <pre className="io__pre">
              {call.result !== ''
                ? call.result.length > 6000
                  ? `${call.result.slice(0, 6000)}\n…(已截断)`
                  : call.result
                : status.state === 'running'
                  ? '(执行中…)'
                  : '(尚无输出)'}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}
