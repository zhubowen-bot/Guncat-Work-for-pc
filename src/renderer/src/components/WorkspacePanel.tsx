// 工作区面板（对齐原版 DetailsPanelView：面板头 + 本轮统计 + 文件清单）。
//
// 原版是右侧详情列：标题 + 「实时」标记 + 刷新 + 收起；下面是统计卡与文件卡。
// 桌面端右列宽度有限，这里保留标题/实时标记/刷新与文件清单，统计卡用一行紧凑指标。
import { useStore } from '../store'
import { IconDot, IconDownload, IconFile, IconFolder, IconRefresh, IconTrash } from '../icons'

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function WorkspacePanel() {
  const workspace = useStore((s) => s.workspace)
  const activeId = useStore((s) => s.activeId)
  const active = useStore((s) => s.active)
  const deleteEntry = useStore((s) => s.deleteWorkspaceEntry)
  const clear = useStore((s) => s.clearWorkspace)
  const exportZip = useStore((s) => s.exportWorkspace)
  const openFolder = useStore((s) => s.openWorkspaceFolder)
  const loadWorkspace = useStore((s) => s.loadWorkspace)
  const pushNotice = useStore((s) => s.pushNotice)

  const disabled = activeId === null
  const toolCalls = (active?.messages ?? []).reduce((sum, m) => sum + m.toolCalls.length, 0)
  const files = workspace.filter((e) => !e.isDirectory).length
  const dirs = workspace.length - files

  return (
    <aside className="workspace">
      <div className="workspace__head">
        <strong>工作区</strong>
        <span className="workspace__live" title="会话工作区变化会实时刷新">
          <IconDot size={9} />
          实时
        </span>
        <button
          className="icon-btn"
          disabled={disabled}
          title="刷新"
          onClick={() => void loadWorkspace()}
        >
          <IconRefresh size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={disabled}
          title="在文件管理器中打开"
          onClick={() => void openFolder()}
        >
          <IconFolder size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={disabled || workspace.length === 0}
          title="打包导出为 zip"
          onClick={() => void exportZip()}
        >
          <IconDownload size={15} />
        </button>
      </div>

      {!disabled ? (
        <div className="workspace__stats">
          <span>{`${files} 个文件`}</span>
          {dirs > 0 ? <span>{`${dirs} 个目录`}</span> : null}
          <span>{`${toolCalls} 次工具调用`}</span>
        </div>
      ) : null}

      <div className="workspace__list">
        {disabled ? (
          <div className="workspace__empty">先新建一个会话</div>
        ) : workspace.length === 0 ? (
          <div className="workspace__empty">
            工作区还是空的
            <br />
            <span className="workspace__empty-sub">
              工作 / 交互模式下，工具产出的文件都会落在这里
            </span>
          </div>
        ) : (
          workspace.map((entry) => (
            <div className="file-item" key={entry.path}>
              <span className="file-item__icon">
                {entry.isDirectory ? <IconFolder size={15} /> : <IconFile size={15} />}
              </span>
              <span className="file-item__name" title={entry.path}>
                {entry.path}
              </span>
              {entry.isDirectory ? null : (
                <span className="file-item__size">{formatSize(entry.size)}</span>
              )}
              <button
                className="icon-btn file-item__del"
                title="删除"
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

      {!disabled && workspace.length > 0 ? (
        <div className="workspace__foot">
          <button className="btn btn--ghost btn--block btn--danger" onClick={() => void clear()}>
            <IconTrash size={14} />
            清空工作区
          </button>
        </div>
      ) : null}
    </aside>
  )
}
