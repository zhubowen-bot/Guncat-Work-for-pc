// 交互模式的顶层渲染块。
//
// 职责边界：
//   - 解析界面程序（GuncatUiLang.parse）
//   - 持有 $绑定值（GuncatUiState），用户改控件时重算并重渲染
//   - 把 $绑定值以尾标记写回消息（持久化，滚动/重启后仍在）
//   - 把回传动作交给上层发给模型
//
// 对应鸿蒙版 views/GuncatUiView.ets 的组件外壳部分。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GuncatUiLang, UiProgram, UiElement } from '@core/common/GuncatUiLang'
import { GuncatUiState, GuncatUiTrailer } from '@core/common/GuncatUiRuntime'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { renderNode, type RenderCtx } from './nodes'

import './guncat-ui.css'

export interface GuncatUiBlockProps {
  /** 消息正文（含可能的 guncat-ui 围栏与状态尾标记） */
  content: string
  /** 该条消息是否允许交互（只有最新一轮可交互，历史置灰） */
  interactive: boolean
  /** 把回传文案发给模型 */
  onSend(text: string): void
  /** 绑定值变化（用于把状态写回消息） */
  onStateChange?(stateJson: string): void
}

/** 外部链接交给主进程用系统浏览器打开（见 main/window.ts 的 setWindowOpenHandler） */
function openExternal(url: string): void {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    window.open(url, '_blank', 'noopener')
  }
}

export function GuncatUiBlock({ content, interactive, onSend, onStateChange }: GuncatUiBlockProps) {
  // 拆出纯文本与界面程序片段（GuncatUiParts 是移植过来的纯逻辑，浏览器里可直接跑）
  const parts = useMemo(() => GuncatUiParts.build(content, true), [content])

  const uiSegs = useMemo(
    () => parts.segments.filter((s) => s.type === 'ui'),
    [parts]
  )

  if (uiSegs.length === 0) {
    return null
  }

  return (
    <>
      {uiSegs.map((seg, i) => (
        <GuncatUiSegment
          key={`${seg.renderKey}-${i}`}
          source={seg.raw}
          title={seg.title}
          stateJson={seg.stateJson !== '' ? seg.stateJson : parts.stateJson}
          complete={seg.complete}
          truncated={seg.truncated}
          interactive={interactive}
          onSend={onSend}
          onStateChange={onStateChange}
        />
      ))}
    </>
  )
}

interface SegmentProps {
  source: string
  title: string
  stateJson: string
  complete: boolean
  truncated: boolean
  interactive: boolean
  onSend(text: string): void
  onStateChange?(stateJson: string): void
}

function GuncatUiSegment({
  source,
  title,
  stateJson,
  complete,
  truncated,
  interactive,
  onSend,
  onStateChange
}: SegmentProps) {
  const program: UiProgram = useMemo(() => GuncatUiLang.parse(source), [source])

  // 恢复上次的绑定值（尾标记里带着），否则用程序里的默认值
  const saved = useMemo(() => GuncatUiState.fromJson(stateJson), [stateJson])
  const state: GuncatUiState = useMemo(() => GuncatUiState.of(program, saved), [program, saved])

  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  // 绑定值变化时把状态写回消息（去抖，避免拖动滑块时刷屏）
  const timerRef = useRef<number | null>(null)
  useEffect(() => {
    if (onStateChange === undefined) {
      return
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }
    timerRef.current = window.setTimeout(() => {
      onStateChange(JSON.stringify(state.values))
    }, 400)
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
    // tick 变化代表用户动过控件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, state, onStateChange])

  // 用当前绑定值重新物化：表达式里的 $变量要按新值重算
  const root: UiElement | null = useMemo(
    () => GuncatUiLang.render(program, state.values),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [program, state, tick]
  )

  const ctx: RenderCtx = useMemo(
    () => ({
      state,
      refresh,
      send: onSend,
      openUrl: openExternal,
      stale: !interactive
    }),
    [state, refresh, onSend, interactive]
  )

  if (root === null) {
    return (
      <div className="gui">
        {program.errors.length > 0 ? (
          <div className="gui__diag">{program.errors.join('\n')}</div>
        ) : (
          <div className="gui-empty">界面程序为空</div>
        )}
      </div>
    )
  }

  return (
    <div className={`gui${interactive ? '' : ' gui--stale'}`}>
      {!interactive ? (
        <div className="gui__banner">
          <span>历史界面（只读）</span>
          {title !== '' ? <span>· {title}</span> : null}
        </div>
      ) : !complete ? (
        <div className="gui__banner">
          <span>{truncated ? '界面未写完（输出被截断）' : '界面生成中…'}</span>
        </div>
      ) : null}

      {renderNode(root, ctx, 'root')}

      {program.errors.length > 0 ? (
        <div className="gui__diag">诊断：{program.errors.join('；')}</div>
      ) : null}
    </div>
  )
}

/** 生成带状态尾标记的正文（回写消息时使用） */
export function appendState(content: string, stateJson: string): string {
  return GuncatUiTrailer.append(content, stateJson)
}
