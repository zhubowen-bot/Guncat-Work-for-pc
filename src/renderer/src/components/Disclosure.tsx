import { useState } from 'react'
import type { ToolCallRecordDto } from '@ipc/contract'

/** 可折叠区块（思考过程、工具详情共用） */
export function Disclosure({
  title,
  children,
  defaultOpen = false
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="disclosure" data-open={open}>
      <button className="disclosure__head" onClick={() => setOpen((v) => !v)}>
        <span className="disclosure__caret">▶</span>
        <span>{title}</span>
      </button>
      {open ? <div className="disclosure__body">{children}</div> : null}
    </div>
  )
}

/** 工具调用行：名称 + 状态 + 结果展开 */
export function ToolCallRow({ call }: { call: ToolCallRecordDto }) {
  const [open, setOpen] = useState(false)
  const state =
    call.status === 'error' ? 'error' : call.status === 'running' ? 'running' : 'ok'
  const label = state === 'error' ? '失败' : state === 'running' ? '执行中' : '完成'

  let argsPreview = ''
  try {
    const parsed: unknown = JSON.parse(call.argsJson || '{}')
    argsPreview = JSON.stringify(parsed)
  } catch {
    argsPreview = call.argsJson
  }
  if (argsPreview.length > 90) {
    argsPreview = argsPreview.slice(0, 90) + '…'
  }

  return (
    <div>
      <button className="tool" onClick={() => setOpen((v) => !v)} style={{ width: '100%' }}>
        <span className="disclosure__caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
          ▶
        </span>
        <span className="tool__name">{call.name}</span>
        <span className="tool__status" data-state={state}>
          {label}
        </span>
        <span className="tool__status" style={{ flex: 1, textAlign: 'left' }}>
          {argsPreview}
        </span>
      </button>
      {open ? (
        <pre>
          {call.result !== ''
            ? call.result.length > 6000
              ? call.result.slice(0, 6000) + '\n…(已截断)'
              : call.result
            : '(尚无输出)'}
        </pre>
      ) : null}
    </div>
  )
}
