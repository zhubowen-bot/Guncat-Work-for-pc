import { useEffect, useRef, useState } from 'react'
import { useAutoResize } from '../hooks/useAutoResize'
import { useVoiceInput } from '../speech/useVoiceInput'

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

  const voice = useVoiceInput((spoken) => {
    setText((prev) => (prev.trim() === '' ? spoken : `${prev}${spoken}`))
  })

  // 切会话/切模式时清空草稿，避免误发到别的会话
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
          className="btn btn--ghost composer__mic"
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
          {voice.state === 'recording' ? '⏺ 停止' : voice.state === 'transcribing' ? '…' : '🎤'}
        </button>

        {running ? (
          <button className="btn btn--danger" onClick={onAbort}>
            停止
          </button>
        ) : (
          <button className="btn btn--primary" onClick={submit} disabled={text.trim() === ''}>
            发送
          </button>
        )}
      </div>
      {voice.error !== '' ? (
        <div className="composer__hint" style={{ color: 'var(--warn)' }}>
          {voice.error}
        </div>
      ) : null}
      <div className="composer__hint">
        <span>
          {mode === 'chat'
            ? '聊天模式'
            : mode === 'interactive'
              ? '交互模式 · 一句话直出可操作界面'
              : '工作模式 · 多轮工具循环 + 沙箱工作区'}
        </span>
        <span>{text.length > 0 ? `${text.length} 字` : ''}</span>
      </div>
    </div>
  )
}
