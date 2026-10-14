// 工作区面板（对齐原版 WorkspaceBar：标题 + 上传/导出 + 文件清单 + 底部统计）。
//
// 用户报障「工作区上传文件有问题，找不到入口」的根因很具体：
// 桌面版此前只有「拖拽文件到窗口」这一条导入路径，而拖拽在界面上**没有任何提示**，
// 用户不可能猜到。原版 WorkspaceBar 的头部就有一颗看得见的「上传」按钮，
// 空态文案更是直接写着「工作区为空, 点击"上传"添加文件」。
// 这里把那个入口补回来，并且空态也给一颗按钮 —— 空工作区恰恰是最需要它的时候。
import { useState } from 'react'
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

export function WorkspacePanel() {
  const workspace = useStore((s) => s.workspace)
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

  // 文件预览。workspace:read 这条 IPC 一直在（主进程侧做了 2MB 上限与越界校验），
  // 但渲染层此前从来没有调用点 —— 原版 WorkspaceBar 是点一下文件就能看内容的。
  const [preview, setPreview] = useState<{
    path: string
    text: string
    truncated: boolean
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState('')

  async function openPreview(path: string): Promise<void> {
    if (activeId === null) {
      return
    }
    setPreviewLoading(path)
    try {
      const result = await window.guncat.workspace.read(activeId, path)
      setPreview({ path, text: result.text, truncated: result.truncated })
    } catch (e) {
      // 主进程对二进制/超限文件会给出可读原因，这里原样呈现
      pushNotice('warn', String(e instanceof Error ? e.message : e))
    } finally {
      setPreviewLoading('')
    }
  }

  const toolCalls = (active?.messages ?? []).reduce((sum, m) => sum + m.toolCalls.length, 0)
  const files = workspace.filter((e) => !e.isDirectory).length
  const dirs = workspace.length - files

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

      {workspace.length > 0 ? (
        <div className="workspace__stats">
          <span>{`${files} 个文件`}</span>
          {dirs > 0 ? <span>{`${dirs} 个目录`}</span> : null}
          <span>{`${toolCalls} 次工具调用`}</span>
        </div>
      ) : null}

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
                  onClick={() => void openPreview(entry.path)}
                >
                  {entry.path}
                </button>
              )}
              {entry.isDirectory ? null : (
                <span className="file-item__size">
                  {previewLoading === entry.path ? '读取中…' : formatSize(entry.size)}
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

      {/* 预览用弹层而不是挤在面板里：工作区只有 300 多像素宽，正文根本读不了 */}
      {preview !== null ? (
        <div className="preview-overlay" onClick={() => setPreview(null)}>
          <div className="preview" onClick={(e) => e.stopPropagation()}>
            <div className="preview__head">
              <strong title={preview.path}>{preview.path}</strong>
              {preview.truncated ? <span className="preview__tag">已截断</span> : null}
              <button
                className="icon-btn"
                title="关闭预览"
                onClick={() => setPreview(null)}
              >
                <IconClose size={15} />
              </button>
            </div>
            <pre className="preview__body">{preview.text}</pre>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
