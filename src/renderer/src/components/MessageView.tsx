// 单条消息的呈现。
//
// 聊天模式 = 用户气泡 + 助手气泡（原版 ChatBubbleView 的信息层级：
//   助手侧：思考条 → 工具行 → 正文/界面 → 操作行 → 统计行；用户侧：气泡 + 编辑/复制）。
// 工作 / 交互模式不使用这里的整条气泡，而是由 Timeline 把一个用户请求下的多轮
// 组装成「任务卡 + 过程 + 最终答复」，这里只提供可复用的助手正文与操作行。
import { useMemo } from 'react'
import type { MessageDto } from '@ipc/contract'
import { GuncatUiParts } from '@core/common/GuncatUiParts'
import { GuncatUiTrailer } from '@core/common/GuncatUiRuntime'
import { Markdown } from './Markdown'
import { Disclosure, ToolCallRow } from './Disclosure'
import { GuncatUiBlock } from '../guncat-ui/GuncatUiBlock'
import { docxFileName } from '../fileName'
import { useSpeech, speechTextOf } from '../speech/speechStore'
import { useStore } from '../store'
import { formatStats } from '../turns'
import {
  IconAgent,
  IconBrain,
  IconCopy,
  IconDownload,
  IconEdit,
  IconRegenerate,
  IconSpeaker
} from '../icons'

interface Props {
  message: MessageDto
  /** 是否允许交互（只有最新一轮的界面可操作，历史界面置灰） */
  interactive: boolean
  /** 是否是这一回合的最终答复（操作行只挂在最终答复上） */
  showActions?: boolean
  onEditToInput?: (text: string) => void
}

/** 助手正文里可能夹着 guncat-ui 界面程序，这里拆一次给正文与界面块共用 */
function useBody(message: MessageDto): { body: string; text: string; hasUi: boolean } {
  const body = message.displayContent !== '' ? message.displayContent : message.content
  const parts = useMemo(
    () => (message.role === 'user' ? null : GuncatUiParts.build(body, true)),
    [message.role, body]
  )
  const hasUi = parts !== null && parts.segments.some((s) => s.type === 'ui')
  return { body, text: hasUi && parts !== null ? parts.textOnly : body, hasUi }
}

/** 深度思考条（原版 buildReasoningBar）：默认收起，标题右侧给字数 */
function ReasoningBlock({ reasoning }: { reasoning: string }) {
  return (
    <Disclosure title="思考" subtitle={`${reasoning.length} 字`} leading={<IconBrain size={14} />}>
      <div className="reasoning">{reasoning}</div>
    </Disclosure>
  )
}

/** 工具调用列表（可折叠；工作/交互模式由 Timeline 决定是否默认展开） */
export function ToolList({ calls }: { calls: MessageDto['toolCalls'] }) {
  return (
    <>
      {calls.map((call) => (
        <ToolCallRow key={call.id || call.name} call={call} />
      ))}
    </>
  )
}

/** 助手回答的操作行：文本 / MD / 朗读 / Word / 重答（对齐原版 buildAIActions） */
export function MessageActions({
  message,
  text,
  onEditToInput,
  extra
}: {
  message: MessageDto
  text: string
  onEditToInput?: (text: string) => void
  extra?: React.ReactNode
}) {
  const conversationId = useStore((s) => s.activeId)
  const pushNotice = useStore((s) => s.pushNotice)
  const regenerate = useStore((s) => s.regenerate)
  const speak = useSpeech((s) => s.speak)
  const speechSupported = useSpeech((s) => s.supported)
  const stats = formatStats(message)

  function copy(value: string, label: string): void {
    void navigator.clipboard
      .writeText(value)
      .then(() => pushNotice('info', label))
      .catch((e: unknown) => pushNotice('error', `复制失败：${String(e)}`))
  }

  return (
    <div className="msg__actions">
      {stats !== '' ? <span className="msg__stats">{stats}</span> : null}
      {extra}
      <button
        className="act"
        title="复制纯文本"
        onClick={() => copy(text, '已复制')}
      >
        <IconCopy size={14} />
        文本
      </button>
      <button
        className="act"
        title="复制 Markdown 原文"
        onClick={() => copy(text, '已复制 Markdown')}
      >
        <IconCopy size={14} />
        MD
      </button>
      <button
        className="act"
        title="朗读这条回答"
        disabled={speechSupported === false}
        onClick={() => speak(message.id, speechTextOf(text))}
      >
        <IconSpeaker size={14} />
        朗读
      </button>
      <button
        className="act"
        title="导出为 Word（含 LaTeX 转原生公式）"
        onClick={() => {
          void window.guncat.messages
            .exportDocx(conversationId ?? '', message.id, docxFileName(text))
            .then((r) => {
              if (r.saved) {
                pushNotice('info', `已导出到 ${r.path ?? ''}`)
              }
            })
            .catch((e: unknown) => pushNotice('error', `导出失败：${String(e)}`))
        }}
      >
        <IconDownload size={14} />
        Word
      </button>
      <button
        className="act"
        title="重新生成这条回答"
        onClick={() => void regenerate()}
      >
        <IconRegenerate size={14} />
        重答
      </button>
      {onEditToInput !== undefined ? (
        <button
          className="act"
          title="把这条回答填回输入框"
          onClick={() => onEditToInput(text)}
        >
          <IconEdit size={14} />
          填入
        </button>
      ) : null}
    </div>
  )
}

/** 助手正文块（Markdown + 界面程序）。工作模式的最终答复也复用它 ——
 *  工具行不在这里渲染：聊天模式由 MessageView 排在上面，工作模式收进「过程」区。 */
export function AssistantBody({
  message,
  interactive
}: {
  message: MessageDto
  interactive: boolean
}) {
  const send = useStore((s) => s.send)
  const patchMessageContent = useStore((s) => s.patchMessageContent)
  const { body, text, hasUi } = useBody(message)

  return (
    <>
      {text.trim() !== '' ? (
        <div className="msg__body">
          <Markdown text={text} />
        </div>
      ) : null}
      {hasUi ? (
        <GuncatUiBlock
          content={body}
          interactive={interactive}
          onSend={(value) => void send(value)}
          onStateChange={(stateJson) => {
            // 把控件状态以尾标记追加到正文并落盘：滚动、切会话、重启后仍在。
            // GuncatUiTrailer.append 会先剥掉旧尾标记再写新的，不会重复叠加。
            void patchMessageContent(message.id, GuncatUiTrailer.append(body, stateJson))
          }}
        />
      ) : null}
    </>
  )
}

/** 聊天模式下的一条消息 */
export function MessageView({ message, interactive, showActions = true, onEditToInput }: Props) {
  const { body, text } = useBody(message)
  const isUser = message.role === 'user'
  const pushNotice = useStore((s) => s.pushNotice)

  if (isUser) {
    return (
      <div className="msg msg--user">
        <div className="bubble bubble--user">
          <div className="bubble__text">{body}</div>
          {message.attachments.length > 0 ? (
            <div className="attachments">
              {message.attachments.map((att) => (
                <span className="attachment" key={att.id} title={att.name}>
                  {att.type === 'image' && att.thumbnail !== '' ? (
                    <img className="attachment__img" src={att.thumbnail} alt={att.name} />
                  ) : (
                    <>
                      <span className="attachment__tag">FILE</span>
                      <span className="attachment__name">{att.name}</span>
                    </>
                  )}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="msg__actions msg__actions--right">
          {onEditToInput !== undefined ? (
            <button
              className="act"
              title="填入输入框，重新编辑"
              onClick={() => {
                onEditToInput(body)
                pushNotice('info', '已填入输入框')
              }}
            >
              <IconEdit size={14} />
              编辑
            </button>
          ) : null}
          <button
            className="act"
            title="复制这条消息"
            onClick={() => {
              void navigator.clipboard.writeText(body).then(
                () => pushNotice('info', '已复制'),
                (e: unknown) => pushNotice('error', `复制失败：${String(e)}`)
              )
            }}
          >
            <IconCopy size={14} />
            复制
          </button>
        </div>
      </div>
    )
  }

  const hasReasoning = message.reasoning.trim() !== ''

  // 原版 ChatBubbleView 的助手侧层级：头像 + 一列（思考条 → 工具行 → 气泡正文 → 操作行）
  return (
    <div className="msg msg--assistant">
      <span className="avatar" title="Guncat">
        <IconAgent size={18} />
      </span>
      <div className="msg__col">
        {hasReasoning ? <ReasoningBlock reasoning={message.reasoning} /> : null}
        {message.toolCalls.length > 0 ? (
          <Disclosure title="工具调用" subtitle={`${message.toolCalls.length} 次`}>
            <ToolList calls={message.toolCalls} />
          </Disclosure>
        ) : null}
        <div className="bubble bubble--ai">
          <AssistantBody message={message} interactive={interactive} />
          {text.trim() !== '' && showActions ? (
            <MessageActions message={message} text={text} onEditToInput={onEditToInput} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
