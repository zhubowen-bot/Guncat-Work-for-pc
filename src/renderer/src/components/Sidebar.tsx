// 侧边栏（对齐鸿蒙原版 views/DswSidebar.ets 的信息层级）：
//   品牌行 → 新建会话 → 引擎（智能体）区 → 会话区（带条数）→ 底部（工作区 / 设置）。
// 折叠态是 56px 图标栏（原版 dsh collapse rail 的等价物）。
import { useState } from 'react'
import type { AgentDto, ConversationSummaryDto } from '@ipc/contract'
import {
  INTERACTIVE_AGENT_ID,
  MODE_LABEL,
  WORK_AGENT_ID,
  conversationMeta,
  conversationTitle
} from '../conversations'
import { useStore } from '../store'
import {
  IconAgent,
  IconChat,
  IconInteractive,
  IconPlus,
  IconSettings,
  IconSidebar,
  IconTrash,
  IconWork
} from '../icons'

const VIRTUAL_ICON: Record<string, typeof IconWork> = {
  [WORK_AGENT_ID]: IconWork,
  [INTERACTIVE_AGENT_ID]: IconInteractive
}

/** 真实智能体的头像：用名字首字做字母标，避免依赖渲染进程拿不到的资源路径 */
function AgentAvatar({ agent }: { agent: AgentDto }) {
  const Virtual = VIRTUAL_ICON[agent.id]
  if (Virtual !== undefined) {
    return <Virtual size={20} className="agent-item__glyph" />
  }
  return (
    <span className="agent-avatar" title={agent.name}>
      {agent.name.slice(0, 1)}
    </span>
  )
}

/**
 * 「引擎」区的一行（原版 buildAgentItem）。
 * 拆成纯 props 组件是为了能在无头环境里直接渲染断言（见 scripts/render-check.mjs）。
 */
export function AgentItem({
  agent,
  active,
  onSelect
}: {
  agent: AgentDto
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      className="agent-item"
      data-active={active}
      title={agent.description}
      onClick={() => onSelect(agent.id)}
    >
      <AgentAvatar agent={agent} />
      <span className="agent-item__name">{agent.name}</span>
      {agent.category !== '系统' ? (
        <span className="agent-item__tag">{agent.category.replace('智能体', '')}</span>
      ) : null}
    </button>
  )
}

/**
 * 会话条目（原版 buildConvItem）：标题 + 元信息 + 删除按钮。
 * 标题口径全在 conversationTitle 里 —— 那是用户报障「每条都叫轻简模式」的修复点。
 */
export function ConvItem({
  summary,
  engines,
  active,
  now,
  onSelect,
  onDelete
}: {
  summary: ConversationSummaryDto
  engines: AgentDto[]
  active: boolean
  now: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const title = conversationTitle(summary, engines)
  const meta = conversationMeta(summary, engines, now)
  return (
    <div className="conv-item" data-active={active}>
      <button
        className="conv-item__main"
        title={summary.lastPreview !== '' ? `${title}\n${summary.lastPreview}` : title}
        onClick={() => onSelect(summary.id)}
      >
        <span className="conv-item__title">{title}</span>
        {meta !== '' ? <span className="conv-item__meta">{meta}</span> : null}
      </button>
      <button
        className="icon-btn conv-item__del"
        title="删除会话"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(summary.id)
        }}
      >
        <IconTrash size={14} />
      </button>
    </div>
  )
}

export function Sidebar() {
  const engines: AgentDto[] = useStore((s) => s.engines)
  const summaries: ConversationSummaryDto[] = useStore((s) => s.summaries)
  const activeId = useStore((s) => s.activeId)
  const activeAgentId = useStore((s) => s.activeAgentId)
  const mode = useStore((s) => s.mode)
  const selectAgent = useStore((s) => s.selectAgent)
  const setMode = useStore((s) => s.setMode)
  const selectConversation = useStore((s) => s.selectConversation)
  const createConversation = useStore((s) => s.createConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)
  const openSettings = useStore((s) => s.openSettings)
  const running = useStore((s) => s.running)

  const [collapsed, setCollapsed] = useState(false)
  const now = Date.now()

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--rail">
        <button
          className="rail__btn"
          title="展开侧边栏"
          onClick={() => setCollapsed(false)}
        >
          <IconSidebar size={19} />
        </button>
        <button
          className="rail__btn"
          title="新建会话"
          onClick={() => void createConversation()}
        >
          <IconPlus size={19} />
        </button>
        <div className="rail__spacer" />
        <button className="rail__btn" title="设置" onClick={() => openSettings(true)}>
          <IconSettings size={19} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <IconAgent size={26} className="sidebar__logo" />
        <div className="sidebar__brand-text">
          <span>Guncat Work</span>
          <small>{MODE_LABEL[mode] ?? ''}</small>
        </div>
        <button className="icon-btn" title="折叠侧边栏" onClick={() => setCollapsed(true)}>
          <IconSidebar size={18} />
        </button>
      </div>

      <div className="sidebar__section">
        <button
          className="btn btn--block sidebar__new"
          disabled={running}
          onClick={() => void createConversation()}
        >
          <IconPlus size={15} />
          新建会话
        </button>
      </div>

      <div className="sidebar__label">引擎</div>
      <div className="sidebar__engines">
        {engines.map((agent) => (
          <AgentItem
            key={agent.id}
            agent={agent}
            active={activeAgentId === agent.id}
            onSelect={(id) => void selectAgent(id)}
          />
        ))}
      </div>

      <div className="sidebar__label sidebar__label--row">
        <span>会话</span>
        <span className="sidebar__count">{summaries.length}</span>
      </div>

      <div className="sidebar__list">
        {summaries.length === 0 ? (
          <div className="sidebar__empty">还没有会话</div>
        ) : (
          summaries.map((s) => (
            <ConvItem
              key={s.id}
              summary={s}
              engines={engines}
              active={s.id === activeId}
              now={now}
              onSelect={(id) => void selectConversation(id)}
              onDelete={(id) => void deleteConversation(id)}
            />
          ))
        )}
      </div>

      <div className="sidebar__footer">
        <button
          className="foot-btn"
          title="切到聊天模式"
          data-active={mode === 'chat'}
          onClick={() => setMode('chat')}
        >
          <IconChat size={17} />
          <span>聊天</span>
        </button>
        <button
          className="foot-btn"
          title="切到交互模式"
          data-active={mode === 'interactive'}
          onClick={() => setMode('interactive')}
        >
          <IconInteractive size={17} />
          <span>交互</span>
        </button>
        <button
          className="foot-btn"
          title="切到工作模式"
          data-active={mode === 'work'}
          onClick={() => setMode('work')}
        >
          <IconWork size={17} />
          <span>工作</span>
        </button>
        <button className="foot-btn" title="设置" onClick={() => openSettings(true)}>
          <IconSettings size={17} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
