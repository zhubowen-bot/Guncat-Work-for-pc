// 时间线：按形态决定呈现方式。
//
//   聊天模式  → 逐条气泡（MessageView）。
//   工作模式  → **一个用户请求 = 一个回合**，回合内每一轮 assistant 按发生顺序**直接陈列**：
//               思考条 → 正文 → 工具行，然后才是下一轮。轮与轮之间不做收纳，
//               思考与工具各自是可折叠的（默认收起），但它们本身就在时间线上占位。
//               —— 这正是原版 ChatPage.buildWorkTimeline + WorkTurnView 的 `section='full'`。
//   交互模式  → 一个用户请求 = 一个回合，回合里所有中间轮（思考 + 工具）**合并成一条**
//               活动折叠栏，正文只出最终答复。即原版的 `section='grouped'` / `'content'`。
//
// 为什么工作模式不能沿用交互模式那套归组（用户报障的原话：「工作模式却和交互模式一样就不对了」）：
//   交互模式的产物是**一张界面**，前面的推演过程对用户没有价值，浓缩成一条活动栏最干净；
//   工作模式的产物是**一串有序的步骤**（读文件 → 处理 → 落盘），每一步都有意义，
//   把它们糊进同一个折叠栏里，用户就再也看不出「先做了什么、后做了什么」。
//
// 为什么归组只发生在渲染层（见 turns.ts 顶部注释）：Agent Loop 的数据结构就是
// 「一条用户消息 → 若干条 assistant 消息」，把多轮并成一条会让模型看到
// 「一条 assistant 同时调了所有工具」，时序错乱。
import { useMemo, useState } from 'react'
import type { MessageDto } from '@ipc/contract'
import { AssistantBody, MessageActions, MessageView, ThinkingBar, ToolList } from './MessageView'
import { Disclosure } from './Disclosure'
import { groupTurns, formatDuration, turnStats, finalRound, STOPPED_NOTE, type Turn } from '../turns'
import { useStore } from '../store'
import { IconCheck, IconInteractive, IconWork } from '../icons'

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
            // 聊天模式的可交互性只看「是否在流式」（原版 ChatPage:1372 `uiLocked: isStreaming`）：
            // 历史回答里的界面块同样可以继续操作 —— 每条回答是一个独立的卡片，
            // 没有「只有最新那条才算当前界面」这回事（那是交互模式的规则）。
            interactive={!running}
            streaming={running && message.id === lastAssistantId}
            onEditToInput={onEditToInput}
          />
        ))}
      </>
    )
  }

  const interactiveMode = mode === 'interactive'

  return (
    <div className="loop-timeline">
      <div className="loop-head">
        <span className="loop-head__glyph">
          {interactiveMode ? <IconInteractive size={26} /> : <IconWork size={26} />}
        </span>
        <div className="loop-head__text">
          <strong>{interactiveMode ? '交互模式' : '工作模式'}</strong>
          <small>
            {running
              ? interactiveMode
                ? '正在生成界面…'
                : '任务执行中...'
              : interactiveMode
                ? 'Canvas 就绪 · 生成可交互的卡片和面板'
                : 'Harness 就绪 · 配合数十种工具和技能交付结果'}
          </small>
        </div>
      </div>

      {turns.map((turn) =>
        interactiveMode ? (
          <GroupedTurn
            key={turn.user?.id ?? `turn-${turn.index}`}
            turn={turn}
            running={running}
            lastAssistantId={lastAssistantId}
            onEditToInput={onEditToInput}
          />
        ) : (
          <WorkTurn
            key={turn.user?.id ?? `turn-${turn.index}`}
            turn={turn}
            running={running}
            onEditToInput={onEditToInput}
          />
        )
      )}
    </div>
  )
}

/** 用户任务卡（原版 buildWorkTaskCard）：任务标签 + 请求原文 + 重新编辑/复制 */
function TaskCard({
  message,
  onEditToInput
}: {
  message: MessageDto
  onEditToInput: (text: string) => void
}) {
  return (
    <div className="task-card">
      <div className="task-card__row">
        <span className="task-card__tag">任务</span>
        <div className="task-card__text">
          {message.displayContent !== '' ? message.displayContent : message.content}
        </div>
      </div>
      <div className="task-card__actions">
        <button
          className="act"
          title="填入输入框，重新编辑"
          onClick={() => onEditToInput(message.content)}
        >
          重新编辑
        </button>
        <button
          className="act"
          title="复制任务原文"
          onClick={() => {
            void navigator.clipboard.writeText(message.content)
          }}
        >
          复制
        </button>
      </div>
    </div>
  )
}

// ===== 工作模式：逐轮直接陈列（原版 section='full'） =====

export function WorkTurn({
  turn,
  running,
  onEditToInput
}: {
  turn: Turn
  running: boolean
  onEditToInput: (text: string) => void
}) {
  const thinkingExpected = useStore((s) => s.thinkingEnabled)
  const stats = turnStats(turn)

  if (turn.user === null && turn.rounds.length === 0) {
    return null
  }

  const last = turn.rounds.length > 0 ? turn.rounds[turn.rounds.length - 1] : null

  return (
    <section className="turn">
      {turn.user !== null ? <TaskCard message={turn.user} onEditToInput={onEditToInput} /> : null}

      {turn.rounds.map((round) => {
        const isLast = round === last
        const streaming = running && isLast
        const body = round.displayContent !== '' ? round.displayContent : round.content
        // 流式中即使思考还是空的，也先把思考条挂出来 —— 这样第一个字一到就能看见
        const showReasoning =
          round.reasoning.trim() !== '' || (streaming && thinkingExpected)
        const hasStats =
          round.tokenSpeed !== undefined ||
          round.cacheHitRate !== undefined ||
          round.toolCalls.length > 0

        return (
          <div className="work-round" key={round.id}>
            {showReasoning ? (
              <ThinkingBar
                reasoning={round.reasoning}
                streaming={streaming && round.toolCalls.length === 0}
                workMode
              />
            ) : null}

            {body.trim() !== '' ? (
              <div className="answer">
                {/* 工作模式同样只看是否在流式（原版 WorkTurnView 拿到的 uiLocked 就是 isStreaming）：
                    历史轮次的界面块也能继续操作，用户不必回到那轮重新跑一遍。 */}
                <AssistantBody message={round} interactive={!running} />
              </div>
            ) : null}

            {/* 工具行排在正文之后 —— 与发生顺序一致（原版 build() 里 buildSteps 在正文之后） */}
            {round.toolCalls.length > 0 ? (
              <div className="work-round__tools">
                <ToolList calls={round.toolCalls} variant="loop" streaming={streaming} />
              </div>
            ) : null}

            {isLast && !streaming && body.trim() !== '' ? (
              <MessageActions
                message={round}
                text={body}
                onEditToInput={onEditToInput}
                extra={
                  stats.toolCalls > 0 ? (
                    <span className="msg__stats">{`${stats.toolCalls} 次工具调用`}</span>
                  ) : null
                }
              />
            ) : null}

            {streaming && body.trim() !== '' && round.toolCalls.length === 0 ? (
              <div className="stream-cursor" aria-hidden="true" />
            ) : null}

            {isLast && streaming && body.trim() === '' && round.toolCalls.length === 0 ? (
              <div className="answer answer--pending">
                <span className="spinner" />
                正在执行…
              </div>
            ) : null}

            {isLast && !streaming && body.trim() === '' && round.toolCalls.length === 0 && hasStats ? (
              <div className="answer answer--pending answer--done">本轮没有正文</div>
            ) : null}
          </div>
        )
      })}

      {turn.rounds.length === 0 && running ? (
        <div className="answer answer--pending">
          <span className="spinner" />
          正在执行…
        </div>
      ) : null}
    </section>
  )
}

// ===== 交互模式：整个回合合并成一条活动折叠栏（原版 section='grouped'） =====

export function GroupedTurn({
  turn,
  running,
  lastAssistantId,
  onEditToInput
}: {
  turn: Turn
  running: boolean
  lastAssistantId: string
  onEditToInput: (text: string) => void
}) {
  const stats = turnStats(turn)
  const final = finalRound(turn)
  const prior = turn.rounds.slice(0, Math.max(0, turn.rounds.length - 1))
  const thinkingExpected = useStore((s) => s.thinkingEnabled)

  // 本轮是否还在产出（原版 isStreaming）
  const streaming = running && final !== null && final.id === lastAssistantId
  const bodyStarted =
    final !== null && (final.displayContent !== '' ? final.displayContent : final.content) !== ''

  // 开合是**纯派生**的（对齐原版 activityOpenNow）：
  //   正文还没开始输出时默认展开（让用户实时看到在思考、在调什么工具），
  //   正文一开始就自动收起；用户点过之后完全听用户的。
  //   刻意不因为「又有新工具在跑」而自动重新展开 —— 多轮之间来回开合很晃眼。
  const [touched, setTouched] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const open = touched ? manualOpen : streaming && !bodyStarted

  // 是否还有活在做（原版 activityRunning）
  const activityRunning =
    streaming &&
    (!bodyStarted ||
      (final?.toolCalls ?? []).some(
        (c) => c.durationMs < 0 && (streaming || c.preparing === true || c.started === true)
      ))

  if (turn.user === null && turn.rounds.length === 0) {
    return null
  }

  // 本回合是否出现过活动（原版 WorkTurnView.hasActivity 588-591）：
  // 前面几轮有消息、本轮有工具、**本轮有思考内容**、或流式中且期待思考，四者任一即可。
  // 此前桌面端漏了后两条 —— 一个只思考没调工具的回合会连活动栏都不出现，
  // 思考内容被整个藏起来。
  const hasActivity =
    prior.length > 0 ||
    stats.toolCalls > 0 ||
    (final !== null && final.reasoning.trim() !== '') ||
    (streaming && thinkingExpected)

  // 被手动停止的轮次：主进程在收尾时往正文末尾追加了这句标注（原版 appendTurnNote）。
  // 折叠栏据此把「已完成」改成「已停止」—— 明明被打断却写着完成是误导。
  const stopped = (final?.content ?? '').includes(STOPPED_NOTE)

  // 折叠态摘要（原版 activitySummary 636-654）：`思考 ×N + M 个工具 · 12.4s`
  // 思考与工具之间是「 + 」，耗时前面是「 · 」—— 原版就是这么接的。
  const thinkingRounds =
    prior.filter((r) => r.reasoning.trim() !== '').length +
    (final !== null && final.reasoning.trim() !== '' ? 1 : 0)
  const summaryParts: string[] = []
  if (thinkingRounds > 0) {
    summaryParts.push(thinkingRounds > 1 ? `思考 ×${thinkingRounds}` : '思考')
  }
  if (stats.toolCalls > 0) {
    summaryParts.push(`${stats.toolCalls} 个工具`)
  }
  const totalMs = turn.rounds.reduce(
    (sum, round) =>
      sum +
      round.toolCalls.reduce(
        (s, c) => s + (c.durationMs > 0 ? c.durationMs : 0),
        0
      ),
    0
  )
  const summary = summaryParts.join(' + ')
  const summaryWithMs =
    totalMs > 0
      ? summary === ''
        ? formatDuration(totalMs)
        : `${summary} · ${formatDuration(totalMs)}`
      : summary

  return (
    <section className="turn">
      {turn.user !== null ? <TaskCard message={turn.user} onEditToInput={onEditToInput} /> : null}

      {hasActivity ? (
        <Disclosure
          title={activityRunning ? '正在处理…' : stopped ? '已停止' : '已完成'}
          subtitle={summaryWithMs}
          // 完成态的对勾：正常是品牌色，**被停止的轮次转弱色** —— 表示「结束了」
          // 而不是「成功完成了」（原版 WorkTurnView.buildActivityGroup 661-676）。
          // 原版这里是一个对勾字符，本项目的渲染层禁用符号字符，改用 SVG。
          leading={
            activityRunning ? (
              <span className="spinner spinner--sm" />
            ) : (
              <span className="activity__check" data-stopped={stopped}>
                <IconCheck size={12} />
              </span>
            )
          }
          open={open}
          onToggle={(next) => {
            setManualOpen(next)
            setTouched(true)
          }}
        >
          {prior.map((round) => (
            <div className="process-round" key={round.id}>
              {round.reasoning.trim() !== '' ? (
                <ThinkingBar reasoning={round.reasoning} streaming={false} workMode />
              ) : null}
              {round.toolCalls.length > 0 ? <ToolList calls={round.toolCalls} variant="loop" streaming={streaming} /> : null}
              {(round.displayContent !== '' ? round.displayContent : round.content).trim() !== '' ? (
                <div className="process-round__text">
                  {round.displayContent !== '' ? round.displayContent : round.content}
                </div>
              ) : null}
            </div>
          ))}
          {/* 本轮思考也收进活动栏 —— 否则流式思考在交互模式里同样看不见
              （原版 buildActivityThinking）。流式中还没内容时先挂出空条。 */}
          {final !== null &&
          (final.reasoning.trim() !== '' || (streaming && thinkingExpected)) ? (
            <ThinkingBar
              reasoning={final.reasoning}
              streaming={streaming && !bodyStarted}
              workMode
            />
          ) : null}
          {final !== null && final.toolCalls.length > 0 ? (
            <ToolList calls={final.toolCalls} variant="loop" streaming={running} />
          ) : null}
        </Disclosure>
      ) : null}

      {final !== null ? (
        <div className="answer">
          <AssistantBody
            message={final}
            // 交互模式是唯一有「当前界面」概念的模式：只有**最新一轮**且不在执行中
            // 才可交互（原版 ChatPage:1521 `interactiveMode && (id !== pendingUiMessageId || isStreaming)`）
            // —— 历史界面块与执行中的界面置灰，防重复提交。
            interactive={!running && final.id === lastAssistantId}
          />
          {!running ? (
            <MessageActions
              message={final}
              text={final.displayContent !== '' ? final.displayContent : final.content}
              onEditToInput={onEditToInput}
              extra={
                stats.toolCalls > 0 ? (
                  <span className="msg__stats">{`${stats.toolCalls} 次工具调用`}</span>
                ) : null
              }
            />
          ) : null}
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

/** 兼容旧引用：工作模式与交互模式都已改用上面两个具体组件 */
export const TurnBlock = GroupedTurn
