import { useEffect, useRef, useState } from 'react'
import { useAutoResize } from '../hooks/useAutoResize'
import { useVoiceInput } from '../speech/useVoiceInput'
import { useStore } from '../store'
import { MODE_HINT } from '../conversations'
import { IconMic, IconSend, IconStop, IconStopCircle } from '../icons'

interface Props {
  running: boolean
  mode: string
  onSend(text: string): void
  onAbort(): void
}

export function Composer({ running, mode, onSend, onAbort }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoResize(ref, text)

  const pendingDraft = useStore((s) => s.pendingDraft)
  const consumeDraft = useStore((s) => s.consumeDraft)

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

  // 切模式时清空草稿，避免误发到别的会话
  useEffect(() => {
    setText('')
  }, [mode])

  function submit(): void {
    const value = text.trim()
    if (value === '' || running) {
      return
    }
    onSend(value)
    setText('')
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
      <div className="composer__inner">
        <textarea
          ref={ref}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />

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
          <button className="composer__send composer__send--stop" title="停止生成" onClick={onAbort}>
            <IconStopCircle size={20} />
            <span className="composer__send-label">停止</span>
          </button>
        ) : (
          <button
            className="composer__send"
            title="发送（Enter）"
            onClick={submit}
            disabled={text.trim() === ''}
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
        <span>{text.length > 0 ? `${text.length} 字` : ''}</span>
      </div>
    </div>
  )
}
