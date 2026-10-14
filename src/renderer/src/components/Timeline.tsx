// 时间线：按形态决定呈现方式。
//
//   聊天模式  → 逐条气泡（MessageView）。
//   工作 / 交互模式 → 按「一个用户请求 = 一个回合」归组：
//       任务卡（用户请求）
//       过程（可折叠，收进这一回合所有中间轮的思考与工具调用）
//       最终答复（主体，带操作行与统计行；交互模式的界面块挂在这里）
//
// 为什么归组只发生在渲染层（见 turns.ts 顶部注释）：Agent Loop 的数据结构就是
// 「一条用户消息 → 若干条 assistant 消息」，把多轮并成一条会让模型看到
// 「一条 assistant 同时调了所有工具」，时序错乱。而用户看到的「一个任务下多条独立答复、
// 每条各带一个工具折叠条」正是没有归组的直接后果 —— 同一个任务的多轮本该是一个视觉整体。
import { useMemo } from 'react'
import type { MessageDto } from '@ipc/contract'
import { AssistantBody, MessageActions, MessageView, ToolList } from './MessageView'
import { Disclosure } from './Disclosure'
import { groupTurns, processTitle, turnStats, finalRound, type Turn } from '../turns'
import { IconClock, IconDot, IconInteractive, IconWork } from '../icons'

interface Props {
  messages: MessageDto[]
  mode: string
  running: boolean
  /** 最新一条 assistant 的 id：交互模式只有它的界面可交互 */
  lastAssistantId: string
  onEditToInput: (text: string) => void
}

export function Timeline({ messages, mode, running, lastAssistantId, onEditToInput }: Props) {
  const turns = useMemo(() => groupTurns(messages), [messages])

  if (mode === 'chat') {
    return (
      <>
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            interactive={!running && message.id === lastAssistantId}
            onEditToInput={onEditToInput}
          />
        ))}
      </>
    )
  }

  return (
    <div className="loop-timeline">
      <div className="loop-head">
        <span className="loop-head__glyph">
          {mode === 'interactive' ? <IconInteractive size={26} /> : <IconWork size={26} />}
        </span>
        <div className="loop-head__text">
          <strong>{mode === 'interactive' ? '交互模式' : '工作模式'}</strong>
          <small>
            {running
              ? mode === 'interactive'
                ? '正在生成界面…'
                : '任务执行中…'
              : mode === 'interactive'
                ? 'Canvas 就绪 · 生成可交互的卡片和面板'
                : 'Harness 就绪 · 配合数十种工具和技能交付结果'}
          </small>
        </div>
      </div>

      {turns.map((turn) => (
        <TurnBlock
          key={turn.user?.id ?? `turn-${turn.index}`}
          turn={turn}
          running={running}
          interactiveMode={mode === 'interactive'}
          lastAssistantId={lastAssistantId}
          onEditToInput={onEditToInput}
        />
      ))}
    </div>
  )
}

export function TurnBlock({
  turn,
  running,
  interactiveMode,
  lastAssistantId,
  onEditToInput
}: {
  turn: Turn
  running: boolean
  interactiveMode: boolean
  lastAssistantId: string
  onEditToInput: (text: string) => void
}) {
  const stats = turnStats(turn)
  const final = finalRound(turn)
  // 中间轮：思考与工具收进「过程」；正文一并收进去（原版历史轮只出正文）
  const prior = turn.rounds.slice(0, Math.max(0, turn.rounds.length - 1))

  if (turn.user === null && turn.rounds.length === 0) {
    return null
  }

  return (
    <section className="turn">
      {turn.user !== null ? (
        <div className="task-card">
          <div className="task-card__row">
            <span className="task-card__tag">任务</span>
            <div className="task-card__text">
              {turn.user.displayContent !== '' ? turn.user.displayContent : turn.user.content}
            </div>
          </div>
          <div className="task-card__actions">
            <button
              className="act"
              title="填入输入框，重新编辑"
              onClick={() => onEditToInput(turn.user !== null ? turn.user.content : '')}
            >
              重新编辑
            </button>
            <button
              className="act"
              title="复制任务原文"
              onClick={() => {
                void navigator.clipboard.writeText(turn.user !== null ? turn.user.content : '')
              }}
            >
              复制
            </button>
          </div>
        </div>
      ) : null}

      {prior.length > 0 || stats.toolCalls > 0 ? (
        <Disclosure
          title={processTitle(stats)}
          subtitle={running && stats.running ? '执行中' : ''}
          defaultOpen={running}
          leading={stats.running ? <IconDot size={12} /> : <IconClock size={14} />}
        >
          {prior.map((round) => (
            <div className="process-round" key={round.id}>
              {round.reasoning.trim() !== '' ? (
                <div className="reasoning reasoning--compact">{round.reasoning}</div>
              ) : null}
              {round.toolCalls.length > 0 ? <ToolList calls={round.toolCalls} /> : null}
              {(round.displayContent !== '' ? round.displayContent : round.content).trim() !== '' ? (
                <div className="process-round__text">
                  {round.displayContent !== '' ? round.displayContent : round.content}
                </div>
              ) : null}
            </div>
          ))}
          {final !== null && final.toolCalls.length > 0 ? (
            <ToolList calls={final.toolCalls} />
          ) : null}
        </Disclosure>
      ) : null}

      {final !== null ? (
        <div className="answer">
          <AssistantBody
            message={final}
            interactive={!running && interactiveMode && final.id === lastAssistantId}
          />
          <MessageActions
            message={final}
            text={final.displayContent !== '' ? final.displayContent : final.content}
            extra={
              stats.toolCalls > 0 ? (
                <span className="msg__stats">{`${stats.toolCalls} 次工具调用`}</span>
              ) : null
            }
          />
        </div>
      ) : running ? (
        <div className="answer answer--pending">
          <span className="spinner" />
          正在执行…
        </div>
      ) : null}
    </section>
  )
}
