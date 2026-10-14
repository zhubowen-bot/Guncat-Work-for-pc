import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { reportStage } from './bootReport'
import { Sidebar } from './components/Sidebar'
import { Composer } from './components/Composer'
import { Timeline } from './components/Timeline'
import { WorkspacePanel } from './components/WorkspacePanel'
import { SettingsDialog } from './components/SettingsDialog'
import { SpeechBar } from './components/SpeechBar'
import { MODE_HINT, agentById } from './conversations'
import { AgentGlyph } from './components/AgentGlyph'
import { IconBrain, IconClose, IconGlobe } from './icons'

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
    <div className="notice" data-level={notice.level}>
      <span>{notice.text}</span>
      <button className="icon-btn" title="关闭提示" onClick={dismiss}>
        <IconClose size={14} />
      </button>
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
  const fillDraft = useStore((s) => s.fillDraft)
  const engines = useStore((s) => s.engines)
  const activeAgentId = useStore((s) => s.activeAgentId)
  const showWorkspace = mode !== 'chat'

  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const intakeFiles = useStore((s) => s.intakeFiles)

  // 最新一条 assistant 才是「可交互的那一轮」
  const lastAssistantId = (() => {
    const messages = active?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return messages[i].id
      }
    }
    return ''
  })()

  const engine = agentById(engines, activeAgentId)

  useEffect(() => {
    void init()
    // 只在挂载时初始化一次：init 内部已订阅事件并做幂等处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 启动诊断：把「React 挂载成功」与「浏览器真的产出了一帧」分开上报。
  //
  // 理由：主进程能自己观察到的最后一站是「页面加载完成」。用户机器上那一站是正常的，
  // 窗口却什么都没有 —— 说明失败发生在这之后。有了这两个信号，日志就能把
  //   DOM 就绪 / 加载完成 / React 已挂载 / 已产出首帧
  // 四个状态分开；缺哪一步，问题就锁定在哪一步：
  //   · 缺 mounted      → 界面产物没跑起来（脚本/CSP/React 抛异常，后者会走 error 上报）
  //   · 有 mounted 无 painted → React 进 DOM 了，但合成器产不出帧（光栅化被关掉等）
  useEffect(() => {
    reportStage('mounted')
    // requestAnimationFrame 只在浏览器真要产出下一帧时回调 ——
    // 它恰好是「能不能画出来」最接近的可用信号。
    const handle = window.requestAnimationFrame(() => {
      reportStage('painted')
    })
    return () => {
      window.cancelAnimationFrame(handle)
    }
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
          <div className="topbar__title">
            <strong>{active?.title || engine?.name || '新会话'}</strong>
            <small title={engine?.description ?? ''}>
              {engine !== undefined ? `${engine.name} · ` : ''}
              {MODE_HINT[mode] ?? ''}
            </small>
          </div>

          <button
            className="toggle"
            data-on={thinkingEnabled}
            onClick={() => setThinking(!thinkingEnabled)}
            title="深度思考（按各协议显式控制）"
          >
            <IconBrain size={14} />
            深度思考
          </button>
          <button
            className="toggle"
            data-on={webSearchEnabled}
            onClick={() => setWebSearch(!webSearchEnabled)}
            title="服务端联网搜索（本地内置搜索工具始终可用）"
          >
            <IconGlobe size={14} />
            联网搜索
          </button>
        </div>

        <div className="timeline" ref={scrollRef}>
          <div className="timeline__inner">
            {active === null || active.messages.length === 0 ? (
              <div className="empty">
                <div className="empty__hero">
                  {/* 新会话空态图标 = **当前智能体自己的标识**（侧栏引擎区同一枚）：
                      交互模式是画框加星火、工作模式是机器人、聊天智能体是它的原图。
                      电脑版没有原版的启动飞入动画，这里就没有必要再借用应用头像。 */}
                  <AgentGlyph agent={engine} size={48} title={engine?.name ?? 'Guncat Work'} />
                </div>
                <h1>{engine?.name ?? 'Guncat Work'}</h1>
                <p>
                  {mode === 'chat'
                    ? '三协议流式对话。配置好 API 后直接开始。'
                    : mode === 'interactive'
                      ? '回答即界面，可视可交互。适用于生活中的大部分场景。'
                      : '数十种工具和技能，端到端交付成果。适用于对质量要求较高的复杂长程任务。'}
                </p>
                <p className="empty__hint">
                  {mode === 'chat'
                    ? '提示：在左下角「设置」里配置接入方式、Base URL、API Key 与模型；在左侧「引擎」里切换智能体。'
                    : '当前共 45 个内置工具；工作区文件可直接打开所在文件夹查看。'}
                </p>
              </div>
            ) : (
              <Timeline
                messages={active.messages}
                mode={mode}
                running={running}
                lastAssistantId={lastAssistantId}
                onEditToInput={fillDraft}
              />
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
