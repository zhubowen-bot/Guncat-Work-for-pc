import { useEffect, useRef, useState } from 'react'
import type { PickedAttachmentDto } from '@ipc/contract'
import { useAutoResize } from '../hooks/useAutoResize'
import { useVoiceInput } from '../speech/useVoiceInput'
import { useStore } from '../store'
import { MODE_HINT } from '../conversations'
import { AttachmentBar } from './AttachmentBar'
import { IconMic, IconPaperclip, IconRefresh, IconSend, IconSteer, IconStop, IconStopCircle } from '../icons'

interface Props {
  running: boolean
  mode: string
  /** 发送。附件只在聊天模式有意义（工作/交互模式走的是工作区，不是附件直传） */
  onSend(text: string, attachmentPaths: string[]): void
  /** 执行中插话（工作/交互模式）；返回是否被接受 */
  onSteer(text: string): Promise<boolean>
  onAbort(): void
}

export function Composer({ running, mode, onSend, onSteer, onAbort }: Props) {
  const [text, setText] = useState('')
  // 已选附件。原版输入区就是这样一条预览带：缩略图 + 文件名 + 逐项删除。
  // 状态改为三态（解析中 / 已就绪 / 解析失败）：pick 立刻返回的是「解析中」，
  // 真正的解析结果由主进程的 attachment:parsed 事件推进（见下面的订阅）。
  // 附件仍然只放在这里，不进 store —— 它只在这个组件里被消费。
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

  // 订阅主进程的附件解析结果：选完文件返回的是「解析中」，解析是后台逐个做的，
  // 不订阅这条事件，卡片会永远停在「解析中...」（既发不出去，也没有失败原因）。
  useEffect(() => {
    return window.guncat.onEvent((event) => {
      if (event.type !== 'attachment:parsed') {
        return
      }
      setAttachments((prev) =>
        prev.map((a) =>
          a.path === event.path ? { ...a, status: event.status, error: event.error } : a
        )
      )
    })
  }, [])

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

  /** 还有附件在主进程后台解析时：既不能发，也不能再叠加新文件 */
  const parsing = attachments.some((a) => a.status === 'parsing')

  function submit(): void {
    const value = text.trim()
    if (value === '' && attachments.length === 0) {
      return
    }
    // 原版 sendMessage 的守卫：文件还在解析时不允许发送（提示语逐字一致）。
    // 「解析失败」的仍然带上：主进程对它做过兜底（先行解析失败会退回 Base64 内联），
    // 真正不可用的（文件没了/读不出来）由主进程跳过并给出提示 —— 这里看不出来是哪一种，
    // 一律丢掉会让用户连一张本来能直传的图片都发不出去。
    if (parsing) {
      pushNotice('warn', '文件解析中，请稍候')
      return
    }
    // 执行中按回车也要有意义（对齐原版 sendMessage）：工作模式会变成插话，
    // 其他形态由 store 提示「AI 正在回复中，请稍候」。所以这里不再因为 running 直接吞掉输入。
    onSend(
      value,
      attachments.map((a) => a.path)
    )
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
    // 与发送同一道守卫：解析中不插话（插话会立刻并入下一轮，附件却还没就绪）
    if (parsing) {
      pushNotice('warn', '文件解析中，请稍候')
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
      <AttachmentBar
        attachments={attachments}
        onRemove={(target) => setAttachments((prev) => prev.filter((a) => a.path !== target))}
      />

      <div className="composer__inner">
        {/* 元素顺序逐条对齐原版 MessageInputView.build（55-66）：
            语音、输入框、上传(附件)、发送依次排列（拍照是手机专属，不移植）。
            语音在输入框**左侧**是这个原版设计的一部分，不是随口排的。 */}
        <button
          type="button"
          className="composer__mic"
          data-recording={voice.state === 'recording'}
          title={
            voice.state === 'recording'
              ? '点击结束录音并转写'
              : voice.state === 'transcribing'
                ? '正在转写…'
                : running
                  ? '生成中，暂不能录音'
                  : parsing
                    ? '文件解析中，暂不能录音'
                    : '语音输入（点击开始录音）'
          }
          // 原版的门禁是 `!isStreaming && !isParsing`（MessageInputView.ets:83）：
          // 生成中与解析中都不该再起一段录音，否则转写结果会插到正在跑的轮次里
          disabled={voice.state === 'transcribing' || running || parsing}
          onClick={voice.toggle}
        >
          {voice.state === 'recording' ? <IconStop size={18} /> : <IconMic size={18} />}
        </button>

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
            className={`composer__clip${parsing ? ' composer__clip--parsing' : ''}`}
            title={parsing ? '文件解析中，请稍候' : '添加图片或文档（发送给模型直接查看）'}
            // 解析中不可点（对齐原版 buildUploadButton 的 `!isParsing`）：此时再加一批文件
            // 只会让「哪张卡对应哪次解析」变得难懂，也让解析队列越排越长。
            // 录音中同样不可点（原版还多一个 `!isListening`）。
            disabled={running || parsing || voice.state !== 'idle'}
            onClick={() => void pickAttachments()}
          >
            {/* 解析中：回形针变成旋转的刷新图标 + 品牌浅底（原版是 16ms 转 6° 的旋转） */}
            {parsing ? (
              <IconRefresh size={18} className="icon-spin" />
            ) : (
              <IconPaperclip size={18} />
            )}
          </button>
        ) : null}

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
            // 解析中/转写中不给发（原版发送钮同条件变灰，点击也直接 return）
            disabled={parsing || voice.state !== 'idle' || (text.trim() === '' && attachments.length === 0)}
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