// 工作区面板（对齐原版 WorkspaceBar：标题 + 上传/导出 + 文件清单 + 底部统计）。
//
// 用户报障「工作区上传文件有问题，找不到入口」的根因很具体：
// 桌面版此前只有「拖拽文件到窗口」这一条导入路径，而拖拽在界面上**没有任何提示**，
// 用户不可能猜到。原版 WorkspaceBar 的头部就有一颗看得见的「上传」按钮，
// 空态文案更是直接写着「工作区为空, 点击"上传"添加文件」。
// 这里把那个入口补回来，并且空态也给一颗按钮 —— 空工作区恰恰是最需要它的时候。
import { useEffect, useRef, useState } from 'react'
import type { ConversationDto, ConversationStatsDto, GoalDto } from '@ipc/contract'
import { useStore } from '../store'
import {
  IconAudio,
  IconClose,
  IconCode,
  IconDot,
  IconDownload,
  IconFile,
  IconFolder,
  IconImage,
  IconPdf,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconVideo,
  IconZip
} from '../icons'

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 目标状态的短标签（对齐原版 GoalService 的四种状态） */
const GOAL_STATUS_LABEL: Record<string, string> = {
  active: '推进中',
  paused: '已暂停',
  done: '已完成',
  blocked: '受阻'
}

/**
 * 任务用时：原版是**整数秒**（`elapsedSec + ' 秒'`，见 DetailsPanelView.ets:148）。
 * 这里收的是一个「秒」计数而不是毫秒时间戳 —— 与原版的 workElapsedSec 同口径。
 */
export function formatElapsedSec(seconds: number): string {
  return `${Math.max(0, Math.trunc(seconds))} 秒`
}

/**
 * 本轮统计卡（逐条对齐原版 DetailsPanelView.ets:143-157）：
 * 标题「本轮统计」+ 四行「标签在左、值在右」，卡片 padding 12 / 圆角 12 / 1px 描边。
 *
 * 与原版的四点一致性与差异：
 *   · 任务用时 = 整数秒（原版是 workElapsedSec 这个每秒 +1 的计数）；
 *   · 输出速度取最后一条 assistant 的 tokenSpeed 并 **Math.round**，无数据显示「—」；
 *   · 缓存命中同理；工具调用轮数 = **会话内所有 assistant 轮的 toolCalls 之和**
 *     （原版 detailToolCallTotal 的口径：只看最后一条会恒为 0，因为收尾轮是纯文本）。
 *   · 原版恒显示这张卡（没数据时值就是「—」），这里也恒显示。
 */
export function TaskStatsCard({
  elapsedSec,
  speed,
  cacheHit,
  toolCalls
}: {
  elapsedSec: number
  speed: number
  cacheHit: number
  toolCalls: number
}) {
  return (
    <div className="statcard">
      <div className="statcard__title">本轮统计</div>
      <StatRow label="任务用时" value={formatElapsedSec(elapsedSec)} />
      <StatRow label="输出速度" value={speed > 0 ? `${Math.round(speed)} 字符/秒` : '—'} />
      <StatRow label="缓存命中" value={cacheHit >= 0 ? `${Math.round(cacheHit * 100)}%` : '—'} />
      <StatRow label="工具调用轮数" value={String(toolCalls)} />
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="statrow">
      <span className="statrow__label">{label}</span>
      <span className="statrow__value">{value}</span>
    </div>
  )
}

/**
 * 底部统计行（对齐原版 WorkspaceBar.ets:205-227）：
 * 会话工作时间 `MM:SS`（≥1 小时给 `HH:MM:SS`，未跑过不显示）、生成速度 `N.N tok/s`、
 * 缓存命中 `缓存命中 N%`（**只在非流式时**显示）。
 * 前两项在流式中用次要色、停止后转三级色。
 */
export function WorkFooterStats({
  elapsedSec,
  speed,
  cacheHit,
  streaming
}: {
  elapsedSec: number
  speed: number
  cacheHit: number
  streaming: boolean
}) {
  if (elapsedSec <= 0 && speed <= 0 && (streaming || cacheHit < 0)) {
    return null
  }
  return (
    <div className="workstats">
      {elapsedSec > 0 ? (
        <span className="workstats__item" data-streaming={streaming}>
          {formatWorkTime(elapsedSec)}
        </span>
      ) : null}
      {speed > 0 ? (
        <span className="workstats__item" data-streaming={streaming}>
          {`${speed.toFixed(1)} tok/s`}
        </span>
      ) : null}
      {!streaming && cacheHit >= 0 ? (
        <span className="workstats__item">{`缓存命中 ${Math.round(cacheHit * 100)}%`}</span>
      ) : null}
    </div>
  )
}

/** 会话工作时间：MM:SS，超过一小时给 HH:MM:SS（原版 formatWorkTime） */
export function formatWorkTime(totalSec: number): string {
  const total = Math.max(0, Math.trunc(totalSec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = m < 10 ? `0${m}` : String(m)
  const ss = s < 10 ? `0${s}` : String(s)
  if (h > 0) {
    const hh = h < 10 ? `0${h}` : String(h)
    return `${hh}:${mm}:${ss}`
  }
  return `${mm}:${ss}`
}

/** 当前目标卡（对齐原版 DetailsPanelView 的目标卡）；没有目标时整张卡不显示 */
export function TaskGoalCard({ goal }: { goal: GoalDto | null }) {
  if (goal === null || goal.objective === '') {
    return null
  }
  return (
    <div className="taskgoal">
      <div className="taskgoal__head">
        <span>当前目标</span>
        <span className="taskgoal__status" data-status={goal.status}>
          {GOAL_STATUS_LABEL[goal.status] ?? goal.status}
        </span>
      </div>
      <div className="taskgoal__text">{goal.objective}</div>
      <div className="taskgoal__meta">
        第 {goal.rounds} / {goal.maxRounds} 轮
      </div>
    </div>
  )
}

/**
 * 按扩展名映射类别图标（逐组取自原版 WorkspaceFileIcons.iconFor）。
 * 未知类型回退通用文档图标 —— 一行文件列表里，能一眼分出「这是图还是表」很有用。
 */
export function workspaceFileIcon(path: string, size = 15): React.ReactElement {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
    case 'heic':
      return <IconImage size={size} />
    case 'pdf':
      return <IconPdf size={size} />
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
      return <IconZip size={size} />
    case 'docx':
    case 'doc':
    case 'rtf':
    case 'odt':
    case 'pptx':
    case 'ppt':
    case 'xlsx':
    case 'xls':
    case 'csv':
    case 'tsv':
    case 'md':
    case 'markdown':
    case 'txt':
    case 'log':
      return <IconFile size={size} />
    case 'json':
    case 'xml':
    case 'html':
    case 'htm':
    case 'css':
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'py':
    case 'java':
    case 'kt':
    case 'kts':
    case 'swift':
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'cs':
    case 'go':
    case 'rs':
    case 'rb':
    case 'php':
    case 'sql':
    case 'sh':
    case 'bat':
    case 'gradle':
    case 'yaml':
    case 'yml':
    case 'toml':
      return <IconCode size={size} />
    case 'mp3':
    case 'wav':
    case 'm4a':
    case 'aac':
    case 'flac':
    case 'ogg':
      return <IconAudio size={size} />
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'mkv':
    case 'webm':
      return <IconVideo size={size} />
    default:
      return <IconFile size={size} />
  }
}

/**
 * 会话工作时间：Agent Loop 形态下每秒 +1，切会话归零。
 *
 * 原版把这个计数放在**页面的常驻定时器**里（`ChatPage.ets:227-253`），因为详情面板
 * 随开随关、计时不能因为关面板而中断。桌面端的面板同样可以收起，所以这里用一个
 * 基于**会话开始时间**的派生值：只要还在跑，就按「从本轮开始到现在」算秒数；
 * 跑完则定格在最后一轮的用时上。这样收起再展开也不会丢时间。
 */
function useWorkElapsed(activeId: string | null): number {
  const running = useStore((s) => s.running)
  const [seconds, setSeconds] = useState(0)
  const startedAtRef = useRef(0)
  const frozenRef = useRef(0)

  useEffect(() => {
    // 切会话：计时归零（原版 lastWorkConvId 变化时 workElapsedSec = 0）
    startedAtRef.current = 0
    frozenRef.current = 0
    setSeconds(0)
  }, [activeId])

  useEffect(() => {
    if (running) {
      if (startedAtRef.current === 0) {
        startedAtRef.current = Date.now() - frozenRef.current * 1000
      }
      const tick = (): void => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
      tick()
      const timer = window.setInterval(tick, 1000)
      return () => window.clearInterval(timer)
    }
    // 停止：定格（原版「任务执行中每秒走字, 停止后定格」）
    if (startedAtRef.current !== 0) {
      frozenRef.current = Math.floor((Date.now() - startedAtRef.current) / 1000)
      setSeconds(frozenRef.current)
      startedAtRef.current = 0
    }
    return undefined
  }, [running])

  return seconds
}

/** 取最后一条「有值」的 assistant 指标（原版是倒着找第一条有值的） */
function lastAssistantValue(
  messages: WorkspacePanelMessage[],
  pick: (m: WorkspacePanelMessage) => number
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') {
      continue
    }
    const value = pick(messages[i])
    if (value > 0 || (value >= 0 && value !== 0)) {
      return value
    }
  }
  return -1
}

type WorkspacePanelMessage = ConversationDto['messages'][number]

export function WorkspacePanel() {
  const workspace = useStore((s) => s.workspace)
  const stats = useStore((s) => s.stats)
  const activeId = useStore((s) => s.activeId)
  const active = useStore((s) => s.active)
  const running = useStore((s) => s.running)
  const deleteEntry = useStore((s) => s.deleteWorkspaceEntry)
  const clear = useStore((s) => s.clearWorkspace)
  const exportZip = useStore((s) => s.exportWorkspace)
  const openFolder = useStore((s) => s.openWorkspaceFolder)
  const loadWorkspace = useStore((s) => s.loadWorkspace)
  const pickFiles = useStore((s) => s.pickWorkspaceFiles)
  const pushNotice = useStore((s) => s.pushNotice)
  const preview = useWorkspacePreview(activeId)

  // 会话工作时间（原版 ChatPage 的 workTickTimer）：只在 Agent Loop 形态下计时、
  // 流式期间每秒 +1、切换会话归零。原版把它挂在页面上（面板随开随关，计时不能中断），
  // 桌面端面板只在展开时挂载，所以这里在「没展开时也继续走」这件事上等价处理：
  // 计时状态放在组件里，展开面板时从会话开始时间起算即可（见下面 elapsedFrom）。
  const workElapsedSec = useWorkElapsed(activeId)

  const messages = active?.messages ?? []
  const toolCalls = messages.reduce((sum, m) => sum + m.toolCalls.length, 0)
  // 速度与命中取**最后一条有值的** assistant（原版 WorkspaceBar 的 getSpeedText/getCacheHitText）
  const lastSpeed = lastAssistantValue(messages, (m) => (m.tokenSpeed > 0 ? m.tokenSpeed : 0))
  const lastCacheHit = lastAssistantValue(messages, (m) => m.cacheHitRate)
  const files = workspace.filter((e) => !e.isDirectory).length

  // 原版 WorkspaceBar：任务执行中禁掉上传/导出，避免和正在跑的工具抢工作区
  const uploadDisabled = running

  return (
    <aside className="workspace">
      <div className="workspace__head">
        <span className="workspace__glyph">
          <IconFolder size={15} />
        </span>
        <strong>工作区</strong>
        <span className="workspace__live" title="会话工作区变化会实时刷新">
          <IconDot size={9} />
          实时
        </span>
        {/* 「上传」就是用户一直在找的那个入口（原版 WorkspaceBar.buildHeaderButton('上传')） */}
        <button
          className="btn btn--ghost btn--sm workspace__upload"
          disabled={uploadDisabled}
          title={uploadDisabled ? '任务执行中，稍后再上传' : '选择文件加入工作区'}
          onClick={() => void pickFiles()}
        >
          <IconPlus size={13} />
          上传
        </button>
        <button
          className="icon-btn"
          disabled={activeId === null}
          title="刷新"
          onClick={() => void loadWorkspace()}
        >
          <IconRefresh size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={activeId === null}
          title="在文件管理器中打开"
          onClick={() => void openFolder()}
        >
          <IconFolder size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={activeId === null || workspace.length === 0 || running}
          title="打包导出为 zip"
          onClick={() => void exportZip()}
        >
          <IconDownload size={15} />
        </button>
      </div>

      {/* 本轮统计卡（对齐原版 DetailsPanelView.ets:143-157）。
          任务用时用「会话工作秒数」这个每秒 +1 的计数（原版 workElapsedSec 同口径），
          所以它会**逐秒走字**；速度/命中取最后一条 assistant；
          工具调用轮数是会话内所有 assistant 轮的调用之和（原版 detailToolCallTotal）。 */}
      <TaskStatsCard
        elapsedSec={workElapsedSec}
        speed={lastSpeed}
        cacheHit={lastCacheHit}
        toolCalls={toolCalls}
      />

      {/* 当前目标卡（对齐原版 DetailsPanelView 的目标卡）。
          目标是模型用 create_goal 建的，存在工作区 .goal.json 里。 */}
      {stats !== null ? <TaskGoalCard goal={stats.goal} /> : null}

      {/* 文件卡头（原版是「文件 (N)」+ 上传 / 导出 两个文字按钮） */}
      <div className="filecard__head">
        <span className="statcard__title">{`文件 (${files})`}</span>
        <button
          className="filecard__action"
          disabled={uploadDisabled}
          title={uploadDisabled ? '任务执行中，稍后再上传' : '选择文件加入工作区'}
          onClick={() => void pickFiles()}
        >
          上传
        </button>
        <button
          className="filecard__action"
          disabled={activeId === null || workspace.length === 0 || running}
          title="打包导出为 zip"
          onClick={() => void exportZip()}
        >
          导出
        </button>
      </div>

      <div className="workspace__list">
        {workspace.length === 0 ? (
          <div className="workspace__empty">
            {running ? (
              '任务执行中…'
            ) : (
              <>
                <span>工作区为空</span>
                <span className="workspace__empty-sub">
                  点上面的「上传」添加文件，或把文件直接拖进窗口
                </span>
                <button className="btn btn--block workspace__empty-btn" onClick={() => void pickFiles()}>
                  <IconPlus size={14} />
                  上传文件
                </button>
              </>
            )}
          </div>
        ) : (
          workspace.map((entry) => (
            <div className="file-item" key={entry.path}>
              <span className="file-item__icon">
                {entry.isDirectory ? <IconFolder size={15} /> : workspaceFileIcon(entry.path)}
              </span>
              {entry.isDirectory ? (
                <span className="file-item__name" title={entry.path}>
                  {entry.path}
                </span>
              ) : (
                // 点文件名看内容（对齐原版 WorkspaceBar 的 previewWorkspaceFile）
                <button
                  className="file-item__name file-item__name--link"
                  title={`${entry.path}\n点击预览内容`}
                  disabled={running}
                  onClick={() => void preview.open(entry.path)}
                >
                  {entry.path}
                </button>
              )}
              {entry.isDirectory ? null : (
                <span className="file-item__size">
                  {preview.loading === entry.path ? '读取中…' : formatSize(entry.size)}
                </span>
              )}
              <button
                className="icon-btn file-item__del"
                title="删除"
                disabled={running}
                onClick={() => {
                  void deleteEntry(entry.path).then(() => {
                    pushNotice('info', `已删除 ${entry.path}`)
                  })
                }}
              >
                <IconTrash size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      {workspace.length > 0 ? (
        <div className="workspace__foot">
          <button
            className="btn btn--ghost btn--block btn--danger"
            disabled={running}
            onClick={() => void clear()}
          >
            <IconTrash size={14} />
            清空工作区
          </button>
        </div>
      ) : null}

      {/* 底部统计行（原版 WorkspaceBar 左下角）：会话工作时间 / tok/s / 缓存命中 */}
      <WorkFooterStats
        elapsedSec={workElapsedSec}
        speed={lastSpeed}
        cacheHit={lastCacheHit}
        streaming={running}
      />

      {/* 预览用弹层而不是挤在面板里：工作区只有 300 多像素宽，正文根本读不了 */}
      {preview.overlay}
    </aside>
  )
}

/**
 * 工作区文件预览。
 *
 * `workspace:read` 这条 IPC 一直在（主进程侧做了 2MB 上限与越界校验），
 * 原版 WorkspaceBar 是点一下文件就能看内容的 —— 桌面端此前渲染层没有调用点。
 * 抽成 hook 是因为产物汇总卡（时间线末尾）也要能点开文件预览，
 * 两处各写一份弹层与读取逻辑没有意义。
 */
export function useWorkspacePreview(activeId: string | null) {
  const pushNotice = useStore((s) => s.pushNotice)
  const [state, setState] = useState<{ path: string; text: string; truncated: boolean } | null>(
    null
  )
  const [loading, setLoading] = useState('')

  async function open(path: string): Promise<void> {
    if (activeId === null) {
      return
    }
    setLoading(path)
    try {
      const result = await window.guncat.workspace.read(activeId, path)
      setState({ path, text: result.text, truncated: result.truncated })
    } catch (e) {
      // 主进程对二进制/超限文件会给出可读原因，这里原样呈现
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    } finally {
      setLoading('')
    }
  }

  function close(): void {
    setState(null)
  }

  const overlay =
    state === null ? null : (
      <div className="preview-overlay" onClick={close}>
        <div className="preview" onClick={(e) => e.stopPropagation()}>
          <div className="preview__head">
            <strong title={state.path}>{state.path}</strong>
            {state.truncated ? <span className="preview__tag">已截断</span> : null}
            <button className="icon-btn" title="关闭预览" onClick={close}>
              <IconClose size={15} />
            </button>
          </div>
          <pre className="preview__body">{state.text}</pre>
        </div>
      </div>
    )

  return { open, close, loading, overlay }
}
