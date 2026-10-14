// WorkArtifactsCard: 工作模式产物汇总卡（Codex 风格 Changes）
//
// 逐字对齐原版 views/WorkArtifactsCard.ets：
//   · 折叠头：产物数量 + 总增减统计，默认展开；
//   · 每个文件一行：图标 + 路径（可点开预览）+ 该文件的 +N -M；
//   · 行级 diff 缩略（最多 8 行，保留增删着色）**独立折叠、默认收起**；
//   · 「预览」按钮打开文件内容。
//
// 为什么值得一张卡：一轮工作跑完，用户最想知道的就是「这轮产出了/改了哪些文件、各加了多少行」。
// 数据来自已移植但此前零引用的 core/common/WorkArtifacts（由主进程汇总后下发），
// 桌面端在此之前只能去工作区列表里自己找。
import { useState } from 'react'
import type { ArtifactFileDto, WorkArtifactsDto } from '@ipc/contract'
import { IconChevronDown, IconFile } from '../icons'

interface Props {
  artifacts: WorkArtifactsDto
  /** 点「预览」或文件名时打开内容（复用工作区的预览弹层） */
  onPreview(path: string): void
}

export function WorkArtifactsCard({ artifacts, onPreview }: Props) {
  const [expanded, setExpanded] = useState(true)
  // 每个文件的 diff 缩略独立折叠，默认收起（对齐原版 expandedDiffFiles 的初值）
  const [openDiffs, setOpenDiffs] = useState<string[]>([])

  if (artifacts.files.length === 0) {
    return null
  }

  function toggleDiff(path: string): void {
    setOpenDiffs((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    )
  }

  return (
    <div className="artifacts">
      <button className="artifacts__head" onClick={() => setExpanded((v) => !v)}>
        <span className="artifacts__icon">
          <IconFile size={16} />
        </span>
        <span className="artifacts__title">
          <strong>产物</strong>
          <small>
            {`${artifacts.files.length} 个文件 · `}
            <span className="diff-stat__add">+{artifacts.totalAdds}</span>{' '}
            <span className="diff-stat__del">-{artifacts.totalDels}</span>
          </small>
        </span>
        <span className="artifacts__caret" data-open={expanded}>
          <IconChevronDown size={13} />
        </span>
      </button>

      {expanded ? (
        <div className="artifacts__list">
          {artifacts.files.map((file) => (
            <ArtifactFileRow
              key={file.path}
              file={file}
              diffOpen={openDiffs.includes(file.path)}
              onToggleDiff={() => toggleDiff(file.path)}
              onPreview={() => onPreview(file.path)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ArtifactFileRow({
  file,
  diffOpen,
  onToggleDiff,
  onPreview
}: {
  file: ArtifactFileDto
  diffOpen: boolean
  onToggleDiff(): void
  onPreview(): void
}) {
  return (
    <div className="artifact">
      <div className="artifact__row">
        <button className="artifact__path" title={file.path} onClick={onPreview}>
          <IconFile size={14} />
          <span className="artifact__name">{file.path}</span>
        </button>
        {file.adds > 0 || file.dels > 0 ? (
          <span className="artifact__counts">
            <span className="diff-stat__add">+{file.adds}</span>{' '}
            <span className="diff-stat__del">-{file.dels}</span>
          </span>
        ) : null}
        {file.hasDiff && file.rows.length > 0 ? (
          <button
            className="artifact__caret"
            data-open={diffOpen}
            title={diffOpen ? '收起改动' : '展开改动'}
            onClick={onToggleDiff}
          >
            <IconChevronDown size={12} />
          </button>
        ) : null}
        <button className="artifact__preview" onClick={onPreview}>
          预览
        </button>
      </div>

      {diffOpen && file.rows.length > 0 ? (
        <div className="artifact__diff">
          {file.rows.map((row, index) => (
            <div className="diffrow" data-type={row.type} key={`${index}-${row.type}`}>
              <span className="diffrow__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}
              </span>
              <span className="diffrow__text">{row.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
