import { useMemo } from 'react'
import type { MessageDto } from '@ipc/contract'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { GuncatUiTrailer } from '@core/common/GuncatUiRuntime'
import { Markdown } from './Markdown'
import { Disclosure, ToolCallRow } from './Disclosure'
import { GuncatUiBlock } from '../guncat-ui/GuncatUiBlock'
import { useSpeech, speechTextOf } from '../speech/speechStore'
import { useStore } from '../store'

interface Props {
  message: MessageDto
  /** 是否允许交互（只有最新一轮的界面可操作，历史界面置灰） */
  interactive: boolean
}

function formatStats(message: MessageDto): string {
  const parts: string[] = []
  if (message.tokenSpeed !== undefined && message.tokenSpeed > 0) {
    parts.push(`${message.tokenSpeed.toFixed(1)} tok/s`)
  }
  if (message.cacheHitRate !== undefined && message.cacheHitRate >= 0) {
    parts.push(`缓存命中 ${(message.cacheHitRate * 100).toFixed(0)}%`)
  }
  return parts.join(' · ')
}

export function MessageView({ message, interactive }: Props) {
  const isUser = message.role === 'user'
  const isAssistant = !isUser
  const send = useStore((s) => s.send)
  const patchMessageContent = useStore((s) => s.patchMessageContent)
  const conversationId = useStore((s) => s.activeId)
  const pushNotice = useStore((s) => s.pushNotice)
  const speak = useSpeech((s) => s.speak)
  const speechSupported = useSpeech((s) => s.supported)
  const body = message.displayContent !== '' ? message.displayContent : message.content
  const stats = formatStats(message)

  // 交互模式：正文里可能夹着 guncat-ui 界面程序。
  // 这里用移植过来的 GuncatUiParts 拆分，界面片段交给 GuncatUiBlock 渲染，
  // 其余文本照常走 Markdown。
  const parts = useMemo(() => (isUser ? null : GuncatUiParts.build(body, true)), [isUser, body])
  const hasUi = parts !== null && parts.segments.some((s) => s.type === 'ui')
  const textToRender = hasUi && parts !== null ? parts.textOnly : body

  if (isUser) {
    return (
      <div className="msg msg--user">
        <div className="msg__role">你</div>
        <div className="msg__body">{body}</div>
      </div>
    )
  }

  const hasTools = message.toolCalls.length > 0
  const hasReasoning = message.reasoning.trim() !== ''

  return (
    <div className="msg msg--assistant">
      <div className="msg__role">Guncat</div>

      {hasReasoning ? (
        <Disclosure title={`深度思考（${message.reasoning.length} 字）`}>
          {message.reasoning}
        </Disclosure>
      ) : null}

      {hasTools ? (
        <Disclosure title={`工具调用（${message.toolCalls.length}）`} defaultOpen={interactive}>
          {message.toolCalls.map((call) => (
            <ToolCallRow key={call.id || call.name} call={call} />
          ))}
        </Disclosure>
      ) : null}

      {textToRender.trim() !== '' ? (
        <div className="msg__body">
          <Markdown text={textToRender} />
        </div>
      ) : null}

      {hasUi ? (
        <GuncatUiBlock
          content={body}
          interactive={interactive}
          onSend={(text) => void send(text)}
          onStateChange={(stateJson) => {
            // 把控件状态以尾标记追加到正文并落盘：滚动、切会话、重启后仍在。
            // GuncatUiTrailer.append 会先剥掉旧尾标记再写新的，不会重复叠加。
            void patchMessageContent(message.id, GuncatUiTrailer.append(body, stateJson))
          }}
        />
      ) : null}

      {stats !== '' || isAssistant ? (
        <div className="msg__actions">
          {stats !== '' ? <span className="msg__stats">{stats}</span> : null}

          <button
            className="btn btn--ghost btn--sm"
            title="朗读这条回答"
            disabled={speechSupported === false}
            onClick={() => speak(message.id, speechTextOf(textToRender || body))}
          >
            🔊 朗读
          </button>

          <button
            className="btn btn--ghost btn--sm"
            title="导出为 Word（含 LaTeX → 原生公式）"
            onClick={() => {
              void window.guncat.messages
                .exportDocx(
                  conversationId ?? '',
                  message.id,
                  `${(textToRender || body).slice(0, 20).replace(/[\\/:*?"<>|]/g, '') || 'Guncat 回答'}.docx`
                )
                .then((r) => {
                  if (r.saved) {
                    pushNotice('info', `已导出到 ${r.path ?? ''}`)
                  }
                })
                .catch((e: unknown) => pushNotice('error', `导出失败：${String(e)}`))
            }}
          >
            ⤓ Word
          </button>
        </div>
      ) : null}
    </div>
  )
}
