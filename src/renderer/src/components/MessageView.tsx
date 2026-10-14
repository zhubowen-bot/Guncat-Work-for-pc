import type { MessageDto } from '@ipc/contract'
import { Markdown } from './Markdown'
import { Disclosure, ToolCallRow } from './Disclosure'

interface Props {
  message: MessageDto
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

export function MessageView({ message }: Props) {
  const isUser = message.role === 'user'
  const body = message.displayContent !== '' ? message.displayContent : message.content
  const stats = formatStats(message)

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
        <Disclosure title={`工具调用（${message.toolCalls.length}）`} defaultOpen>
          {message.toolCalls.map((call) => (
            <ToolCallRow key={call.id || call.name} call={call} />
          ))}
        </Disclosure>
      ) : null}

      {body !== '' ? (
        <div className="msg__body">
          <Markdown text={body} />
        </div>
      ) : null}

      {stats !== '' ? <div className="msg__stats">{stats}</div> : null}
    </div>
  )
}
