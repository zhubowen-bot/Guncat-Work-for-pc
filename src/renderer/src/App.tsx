import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Composer } from './components/Composer'
import { MessageView } from './components/MessageView'
import { WorkspacePanel } from './components/WorkspacePanel'
import { SettingsDialog } from './components/SettingsDialog'
import { SpeechBar } from './components/SpeechBar'

function Notice() {
  const notice = useStore((s) => s.notice)
  const dismiss = useStore((s) => s.dismissNotice)

  useEffect(() => {
    if (notice === null) {
      return
    }
    const timer = setTimeout(dismiss, 6000)
    return () => clearTimeout(timer)
  }, [notice, dismiss])

  if (notice === null) {
    return null
  }
  return (
    <div className="notice" data-level={notice.level} onClick={dismiss}>
      <span>{notice.text}</span>
      <span style={{ color: 'var(--text-faint)', cursor: 'pointer' }}>✕</span>
    </div>
  )
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const active = useStore((s) => s.active)
  const mode = useStore((s) => s.mode)
  const running = useStore((s) => s.running)
  const thinkingEnabled = useStore((s) => s.thinkingEnabled)
  const webSearchEnabled = useStore((s) => s.webSearchEnabled)
  const setThinking = useStore((s) => s.setThinking)
  const setWebSearch = useStore((s) => s.setWebSearch)
  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const showWorkspace = mode !== 'chat'

  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const intakeFiles = useStore((s) => s.intakeFiles)

  // 最新一条 assistant 消息才是「可交互的那一轮」
  const lastAssistantIndex = (() => {
    const messages = active?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return i
      }
    }
    return -1
  })()

  useEffect(() => {
    void init()
    // 只在挂载时初始化一次：init 内部已订阅事件并做幂等处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 流式输出时保持滚动到底部
  const messageCount = active?.messages.length ?? 0
  const lastLength = active?.messages[active.messages.length - 1]?.content.length ?? 0
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) {
      return
    }
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 160
    if (nearBottom || lastLength === 0) {
      element.scrollTop = element.scrollHeight
    }
  }, [messageCount, lastLength])

  if (!ready) {
    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          height: '100%',
          color: 'var(--text-faint)'
        }}
      >
        正在启动…
      </div>
    )
  }

  return (
    <div
      className={showWorkspace ? 'app with-workspace' : 'app'}
      onDragOver={(e) => {
        // 只有真的拖了文件才提示；拖文本不拦截
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDragging(false)
        }
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) {
          return
        }
        e.preventDefault()
        setDragging(false)
        // contextIsolation 下 File 没有 path，必须经 preload 的 webUtils 换算
        const paths: string[] = Array.from(e.dataTransfer.files)
          .map((f) => window.guncat.files.pathForFile(f))
          .filter((p) => p !== '')
        void intakeFiles(paths)
      }}
    >
      {dragging ? (
        <div className="dropzone">
          <div className="dropzone__box">松开即可把文件导入当前会话工作区</div>
        </div>
      ) : null}
      <Sidebar />

      <main className="main">
        <div className="topbar">
          <div className="topbar__title">{active?.title || '新对话'}</div>

          <button
            className="toggle"
            data-on={thinkingEnabled}
            onClick={() => setThinking(!thinkingEnabled)}
            title="深度思考（按各协议显式控制）"
          >
            🧠 深度思考
          </button>
          <button
            className="toggle"
            data-on={webSearchEnabled}
            onClick={() => setWebSearch(!webSearchEnabled)}
            title="服务端联网搜索（本地内置搜索工具始终可用）"
          >
            🌐 联网搜索
          </button>
        </div>

        <div className="timeline" ref={scrollRef}>
          <div className="timeline__inner">
            {active === null || active.messages.length === 0 ? (
              <div className="empty">
                <h1>Guncat Work</h1>
                <p>
                  {mode === 'chat'
                    ? '三协议流式对话。配置好 API 后直接开始。'
                    : mode === 'interactive'
                      ? '说一句话，拿到一个能拖、能点、能改参数并即时重算的界面。'
                      : '描述任务，工作模式会自主拆解、调用工具，并把产物落在右侧工作区。'}
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {mode === 'chat'
                    ? '提示：先在左下角「设置」里配置接入方式、Base URL、API Key 与模型。'
                    : '当前共 45 个内置工具；工作区文件可直接打开所在文件夹查看。'}
                </p>
              </div>
            ) : (
              active.messages.map((message, index) => (
                <MessageView
                  key={message.id}
                  message={message}
                  // 只有最新一轮的界面可操作，历史界面置灰（与鸿蒙版行为一致）
                  interactive={
                    !running &&
                    mode === 'interactive' &&
                    index === lastAssistantIndex &&
                    message.role === 'assistant'
                  }
                />
              ))
            )}
          </div>
        </div>

        <Composer
          running={running}
          mode={mode}
          onSend={(text) => void send(text)}
          onAbort={() => void abort()}
        />
      </main>

      {showWorkspace ? <WorkspacePanel /> : null}

      <SettingsDialog />
      <SpeechBar />
      <Notice />
    </div>
  )
}
