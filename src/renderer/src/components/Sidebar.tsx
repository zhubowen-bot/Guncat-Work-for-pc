import type { AgentDto, AgentMode, ConversationSummaryDto } from '@ipc/contract'
import { useStore } from '../store'

const MODES: Array<{ id: AgentMode; label: string }> = [
  { id: 'interactive', label: '✦ 交互模式' },
  { id: 'work', label: '🛠 工作模式' },
  { id: 'chat', label: '聊天模式' }
]

function timeLabel(ts: number): string {
  if (ts <= 0) {
    return ''
  }
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return sameDay ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : `${date.getMonth() + 1}/${date.getDate()}`
}

export function Sidebar() {
  const agents: AgentDto[] = useStore((s) => s.agents)
  const summaries: ConversationSummaryDto[] = useStore((s) => s.summaries)
  const activeId = useStore((s) => s.activeId)
  const active = useStore((s) => s.active)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const selectConversation = useStore((s) => s.selectConversation)
  const createConversation = useStore((s) => s.createConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)
  const openSettings = useStore((s) => s.openSettings)

  const currentAgent: AgentDto | undefined =
    active !== null ? agents.find((a) => a.id === active.agentId) : undefined

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        Guncat Work
        <small>电脑版 · Agent Harness</small>
      </div>

      <div className="sidebar__section">
        <div className="sidebar__label">形态</div>
        <div className="mode-switch">
          {MODES.map((m) => (
            <button
              key={m.id}
              data-active={mode === m.id}
              onClick={() => {
                setMode(m.id)
              }}
              title={
                m.id === 'chat'
                  ? '纯对话，不带沙箱工作区'
                  : m.id === 'work'
                    ? '多轮工具循环 + 沙箱工作区'
                    : '一句话直出可操作界面'
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar__section" style={{ paddingBottom: 0 }}>
        <button
          className="btn btn--block"
          onClick={() => {
            void createConversation()
          }}
        >
          ＋ 新建对话
        </button>
      </div>

      <div className="sidebar__section" style={{ paddingBottom: 0 }}>
        <div className="sidebar__label">对话</div>
      </div>

      <div className="sidebar__list">
        {summaries.length === 0 ? (
          <div style={{ padding: '10px 6px', fontSize: 12, color: 'var(--text-faint)' }}>
            还没有对话
          </div>
        ) : (
          summaries.map((s) => (
            <div key={s.id} style={{ position: 'relative' }}>
              <button
                className="conv-item"
                data-active={s.id === activeId}
                onClick={() => {
                  void selectConversation(s.id)
                }}
              >
                <div className="conv-item__title">{s.title || '未命名'}</div>
                <div className="conv-item__meta">
                  {timeLabel(s.updatedAt)} · {s.messageCount} 条
                </div>
              </button>
              <button
                className="btn btn--ghost"
                style={{
                  position: 'absolute',
                  right: 4,
                  top: 6,
                  padding: '2px 6px',
                  fontSize: 12
                }}
                title="删除对话"
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteConversation(s.id)
                }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sidebar__footer">
        <button
          className="btn btn--ghost"
          style={{ flex: 1, textAlign: 'left' }}
          onClick={() => openSettings(true)}
        >
          ⚙ 设置
        </button>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            alignSelf: 'center',
            maxWidth: 110,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={currentAgent?.name ?? ''}
        >
          {currentAgent?.shortDescription ?? currentAgent?.name ?? ''}
        </span>
      </div>
    </aside>
  )
}
