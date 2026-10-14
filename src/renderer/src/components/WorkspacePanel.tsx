import { useStore } from '../store'

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
  const deleteEntry = useStore((s) => s.deleteWorkspaceEntry)
  const clear = useStore((s) => s.clearWorkspace)
  const exportZip = useStore((s) => s.exportWorkspace)
  const openFolder = useStore((s) => s.openWorkspaceFolder)
  const pushNotice = useStore((s) => s.pushNotice)

  const disabled = activeId === null

  return (
    <aside className="workspace">
      <div className="workspace__head">
        <strong>工作区</strong>
        <button
          className="btn btn--ghost"
          style={{ padding: '2px 6px', fontSize: 12 }}
          disabled={disabled}
          title="在文件管理器中打开"
          onClick={() => void openFolder()}
        >
          打开
        </button>
        <button
          className="btn btn--ghost"
          style={{ padding: '2px 6px', fontSize: 12 }}
          disabled={disabled}
          title="打包导出为 zip"
          onClick={() => void exportZip()}
        >
          导出
        </button>
      </div>

      <div className="workspace__list">
        {disabled ? (
          <div className="workspace__empty">先新建一个对话</div>
        ) : workspace.length === 0 ? (
          <div className="workspace__empty">
            工作区还是空的
            <br />
            <span style={{ fontSize: 11 }}>
              工作模式 / 交互模式下，工具产出的文件都会落在这里
            </span>
          </div>
        ) : (
          workspace.map((entry) => (
            <div className="file-item" key={entry.path}>
              <span>{entry.isDirectory ? '📁' : '📄'}</span>
              <span className="file-item__name" title={entry.path}>
                {entry.path}
              </span>
              {entry.isDirectory ? null : (
                <span className="file-item__size">{formatSize(entry.size)}</span>
              )}
              <button
                className="file-item__del"
                title="删除"
                onClick={() => {
                  void deleteEntry(entry.path).then(() => {
                    pushNotice('info', `已删除 ${entry.path}`)
                  })
                }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {!disabled && workspace.length > 0 ? (
        <div style={{ borderTop: '1px solid var(--border)', padding: 8 }}>
          <button
            className="btn btn--ghost btn--block btn--danger"
            style={{ fontSize: 12 }}
            onClick={() => void clear()}
          >
            清空工作区
          </button>
        </div>
      ) : null}
    </aside>
  )
}
