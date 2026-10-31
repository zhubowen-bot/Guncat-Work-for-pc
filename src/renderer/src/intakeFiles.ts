// 拖拽 / 粘贴进来的文件 → 本机绝对路径。
//
// 为什么需要单独一层：
//   · 开启 contextIsolation 后 File 对象上没有 path，必须经 preload 的 webUtils.getPathForFile
//     换算；
//   · 从浏览器、截图工具、微信等来源复制/拖进来的图片只有内存字节，拿不到磁盘路径 ——
//     这类要走 files:stageTemp 先落进应用临时目录，后面的导入/解析链路才认得它。
// 拖拽与粘贴走的是同一条换算逻辑，放在这里免得两处各写一份、只修好其中一处。

/** 剪贴板事件里真正带文件的条目（优先 dataTransfer.files，回退 items） */
export function clipboardFiles(dt: DataTransfer | null): File[] {
  if (dt === null) {
    return []
  }
  const direct = Array.from(dt.files ?? [])
  if (direct.length > 0) {
    return direct
  }
  const out: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') {
      continue
    }
    const file = item.getAsFile()
    if (file !== null) {
      out.push(file)
    }
  }
  return out
}

/** 无文件名的内存文件（截图粘贴常见）按 MIME 补一个能落盘的名字 */
function fallbackName(file: File, prefix: string): string {
  const name = (file.name ?? '').trim()
  if (name !== '') {
    return name
  }
  const type = (file.type ?? '').toLowerCase()
  if (type.startsWith('image/')) {
    const raw = type.slice('image/'.length).split('+')[0]
    const ext = raw === 'jpeg' ? 'jpg' : raw === 'svg' ? 'svg' : raw
    if (ext !== '') {
      return `${prefix}.${ext}`
    }
  }
  return prefix
}

/**
 * 从一组 File 提取本机绝对路径。
 * 优先取磁盘路径；只有内存字节的来源先 stageTemp 落盘（落盘目录每次都不重名，不需要去重）。
 */
export async function extractFilePaths(files: File[], prefix = 'intake-file'): Promise<string[]> {
  const paths: string[] = []
  for (const file of files) {
    const direct = window.guncat.files.pathForFile(file)
    if (direct !== '') {
      paths.push(direct)
      continue
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength > 0) {
        const staged = await window.guncat.files.stageTemp(fallbackName(file, prefix), bytes)
        if (staged !== '') {
          paths.push(staged)
        }
      }
    } catch {
      // 忽略无法读取的条目：其余文件照常加入
    }
  }
  return paths
}
