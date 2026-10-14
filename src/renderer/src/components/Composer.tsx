import { useEffect, useRef, useState } from 'react'
import type { PickedAttachmentDto } from '@ipc/contract'
import { useAutoResize } from '../hooks/useAutoResize'
import { useVoiceInput } from '../speech/useVoiceInput'
import { useStore } from '../store'
import { MODE_HINT } from '../conversations'
import { IconClose, IconFile, IconMic, IconPaperclip, IconSend, IconSteer, IconStop, IconStopCircle } from '../icons'

interface Props {
  running: boolean
  mode: string
  /** 发送。附件只在聊天模式有意义（工作/交互模式走的是工作区，不是附件直传） */
  onSend(text: string, attachmentPaths: string[]): void
  /** 执行中插话（工作/交互模式）；返回是否被接受 */
  onSteer(text: string): Promise<boolean>
  onAbort(): void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function Composer({ running, mode, onSend, onSteer, onAbort }: Props) {
  const [text, setText] = useState('')
  // 已选附件。原版输入区就是这样一条预览带：缩略图 + 文件名 + 逐项删除。
  // 桌面端此前**完全没有附件入口** —— ChatSendRequest.attachmentPaths 一直没人赋值。
  const [attachments, setAttachments] = useState<PickedAttachmentDto[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoResize(ref, text)

  const pendingDraft = useStore((s) => s.pendingDraft)
  const consumeDraft = useStore((s) => s.consumeDraft)
  const pushNotice = useStore((s) => s.pushNotice)

  // 消息操作行的「编辑 / 重新编辑」把文本塞进这里，并聚焦回输入框
  useEffect(() => {
    if (pendingDraft === null) {
      return
    }
    setText(pendingDraft.text)
    consumeDraft()
    const element = ref.current
    if (element !== null) {
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    }
  }, [pendingDraft, consumeDraft])

  const voice = useVoiceInput((spoken) => {
    setText((prev) => (prev.trim() === '' ? spoken : `${prev}${spoken}`))
  })

  // 切模式时清空草稿与附件，避免误发到别的会话
  useEffect(() => {
    setText('')
    setAttachments([])
  }, [mode])

  async function pickAttachments(): Promise<void> {
    try {
      const picked = await window.guncat.attachments.pick()
      if (picked.length === 0) {
        return
      }
      // 同名同路径去重，避免重复点两次加进来两份
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.path))
        return [...prev, ...picked.filter((a) => !seen.has(a.path))]
      })
    } catch (e) {
      pushNotice('error', `选择附件失败：${String(e)}`)
    }
  }

  function submit(): void {
    const value = text.trim()
    if (value === '' && attachments.length === 0) {
      return
    }
    // 执行中按回车也要有意义（对齐原版 sendMessage）：工作模式会变成插话，
    // 其他形态由 store 提示「AI 正在回复中，请稍候」。所以这里不再因为 running 直接吞掉输入。
    onSend(value, attachments.map((a) => a.path))
    setText('')
    setAttachments([])
  }

  /**
   * 执行中插话：文本进插话队列，在**下一轮开始前**并入消息（不打断当前请求）。
   * 主进程说「当前没在跑」时就退回普通发送，免得文本挂在队列里等下一次任务。
   */
  async function steer(): Promise<void> {
    const value = text.trim()
    if (value === '') {
      return
    }
    const accepted = await onSteer(value)
    setText('')
    if (!accepted) {
      onSend(value, [])
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const placeholder =
    mode === 'chat'
      ? '输入消息，Enter 发送，Shift+Enter 换行'
      : mode === 'interactive'
        ? '描述你想要的界面，例如「做一个季度销售复盘仪表盘」'
        : '描述任务，工作模式会自主调用工具并交付产物'

  return (
    <div className="composer">
      {attachments.length > 0 ? (
        <div className="composer__attachments">
          {attachments.map((att) => (
            <span className="attachment" key={att.path} title={att.path}>
              {att.thumbnail !== '' ? (
                <img className="attachment__img" src={att.thumbnail} alt={att.name} />
              ) : (
                <>
                  <span className="attachment__tag">
                    <IconFile size={12} />
                  </span>
                  <span className="attachment__name">{att.name}</span>
                </>
              )}
              <span className="attachment__size">{formatSize(att.size)}</span>
              <button
                className="attachment__del"
                title="移除这个附件"
                onClick={() => setAttachments((prev) => prev.filter((a) => a.path !== att.path))}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="composer__inner">
        <textarea
          ref={ref}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />

        {/* 附件入口只在聊天模式给：工作/交互模式的素材入口是工作区（上传/拖拽），
            那两条路本来就是「文件进沙箱、模型用工具读」，与附件直传是两件事。 */}
        {mode === 'chat' ? (
          <button
            type="button"
            className="composer__clip"
            title="添加图片或文档（发送给模型直接查看）"
            disabled={running}
            onClick={() => void pickAttachments()}
          >
            <IconPaperclip size={18} />
          </button>
        ) : null}

        <button
          type="button"
          className="composer__mic"
          data-recording={voice.state === 'recording'}
          title={
            voice.state === 'recording'
              ? '点击结束录音并转写'
              : voice.state === 'transcribing'
                ? '正在转写…'
                : '语音输入（点击开始录音）'
          }
          disabled={voice.state === 'transcribing'}
          onClick={voice.toggle}
        >
          {voice.state === 'recording' ? <IconStop size={18} /> : <IconMic size={18} />}
        </button>

        {running ? (
          <>
            {/* 插话只在 Agent Loop 的两种形态给：聊天模式的请求是「一问一答」，
                中途补话没有「下一轮」可挂，只能中止重来（原版也是这么分的）。 */}
            {mode !== 'chat' ? (
              <button
                className="composer__send composer__send--steer"
                title="插话（不打断当前执行，在下一轮生效）"
                disabled={text.trim() === ''}
                onClick={() => void steer()}
              >
                <IconSteer size={18} />
                <span className="composer__send-label">插话</span>
              </button>
            ) : null}
            <button className="composer__send composer__send--stop" title="停止生成" onClick={onAbort}>
              <IconStopCircle size={20} />
              <span className="composer__send-label">停止</span>
            </button>
          </>
        ) : (
          <button
            className="composer__send"
            title="发送（Enter）"
            onClick={submit}
            disabled={text.trim() === '' && attachments.length === 0}
          >
            <IconSend size={18} />
            <span className="composer__send-label">发送</span>
          </button>
        )}
      </div>
      {voice.error !== '' ? (
        <div className="composer__hint" style={{ color: 'var(--warn)' }}>
          {voice.error}
        </div>
      ) : null}
      <div className="composer__hint">
        <span>{MODE_HINT[mode] ?? ''}</span>
        <span>
          {attachments.length > 0 ? `${attachments.length} 个附件 · ` : ''}
          {text.length > 0 ? `${text.length} 字` : ''}
        </span>
      </div>
    </div>
  )
}
