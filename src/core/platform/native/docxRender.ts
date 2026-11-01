// docx_render 的平台后端: .docx -> PDF -> PNG。
//
// 为什么需要它: write_docx 的自检只能证明 XML 结构没坏, 不能回答「生成的东西长什么样」。
// 以前模型要自己找 LibreOffice/Word、写命令、再想办法转图, 每一步都可能失败。
// 现在工具自己出图: 模型直接 view_image 逐页查看, 版式/公式/字体问题在交付前就能发现。
//
// 转换器优先级:
//   1. LibreOffice headless(跨平台、无 UI、不依赖 Office 授权)
//   2. Microsoft Word COM(Windows, 仅当 LibreOffice 不可用/失败)
// 转出 PDF 后复用 PDF.js + @napi-rs/canvas 渲染成 PNG(与 pdf_to_images 同一条链路)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { renderPdfPagesToPng, PdfPngBatchResult } from './pdfBackend'

export class DocxRenderResult {
  files: string[] = []
  pageCount: number = 0
  startPage: number = 0
  endPage: number = 0
  nextStartPage: number = 0
  converter: string = ''
  pdfPath: string = ''
}

class ProcResult {
  ok: boolean = false
  output: string = ''
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve: (r: ProcResult) => void): void => {
    execFile(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    }, (err: Error | null, stdout: string, stderr: string): void => {
      const r: ProcResult = new ProcResult()
      r.ok = err === null
      let parts: string[] = []
      if (stderr !== '') {
        parts.push(stderr)
      }
      if (stdout !== '') {
        parts.push(stdout)
      }
      if (err !== null) {
        parts.push(err.message)
      }
      r.output = parts.join('\n').trim()
      resolve(r)
    })
  })
}

function tail(text: string, maxChars: number): string {
  let t: string = text.trim()
  return t.length <= maxChars ? t : '...' + t.substring(t.length - maxChars)
}

function libreOfficeCandidates(): string[] {
  let out: string[] = []
  let env: string | undefined = process.env.GUNCAT_SOFFICE
  if (env !== undefined && env.trim() !== '') {
    out.push(env.trim())
  }
  if (process.platform === 'win32') {
    out.push('C:\\Program Files\\LibreOffice\\program\\soffice.exe')
    out.push('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe')
    let local: string | undefined = process.env.LOCALAPPDATA
    if (local !== undefined) {
      out.push(path.join(local, 'Programs', 'LibreOffice', 'program', 'soffice.exe'))
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/LibreOffice.app/Contents/MacOS/soffice')
  } else {
    out.push('/usr/bin/soffice')
    out.push('/usr/local/bin/soffice')
  }
  out.push('soffice')
  return out
}

function pdfNameFor(docxAbs: string): string {
  let base: string = path.basename(docxAbs)
  if (/\.docx$/i.test(base)) {
    base = base.substring(0, base.length - 5)
  }
  return base + '.pdf'
}

async function convertWithLibreOffice(docxAbs: string, pdfOutDir: string,
  profileDir: string): Promise<{ pdfPath: string; converter: string }> {
  let candidates: string[] = libreOfficeCandidates()
  let tried: string[] = []
  let lastOutput: string = ''
  for (let i: number = 0; i < candidates.length; i++) {
    let cmd: string = candidates[i]
    if (cmd !== 'soffice' && !fs.existsSync(cmd)) {
      continue
    }
    tried.push(cmd)
    let args: string[] = [
      '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
      '-env:UserInstallation=' + pathToFileURL(profileDir).href,
      '--convert-to', 'pdf:writer_pdf_Export',
      '--outdir', pdfOutDir,
      docxAbs
    ]
    let r: ProcResult = await runProcess(cmd, args, 90000)
    lastOutput = r.output
    let pdfPath: string = path.join(pdfOutDir, pdfNameFor(docxAbs))
    if (r.ok && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0) {
      return { pdfPath: pdfPath, converter: 'LibreOffice' }
    }
    // 装是装了但这次转换失败(文件损坏/被占用), 换 Word 再试; 不要在这里直接放弃
  }
  if (tried.length === 0) {
    throw new Error('未找到 LibreOffice(可设置环境变量 GUNCAT_SOFFICE 指向 soffice 可执行文件)')
  }
  throw new Error('LibreOffice 转换失败' + (lastOutput !== '' ? ': ' + tail(lastOutput, 600) : ''))
}

function psQuote(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'"
}

async function convertWithWord(docxAbs: string, pdfPath: string): Promise<{ pdfPath: string; converter: string }> {
  if (process.platform !== 'win32') {
    throw new Error('当前平台没有 Microsoft Word COM')
  }
  let script: string = [
    "$ErrorActionPreference = 'Stop'",
    '$word = $null',
    '$doc = $null',
    'try {',
    '  $word = New-Object -ComObject Word.Application',
    '  $word.Visible = $false',
    '  $word.DisplayAlerts = 0',
    '  try { $word.AutomationSecurity = 3 } catch {}',
    '  $doc = $word.Documents.Open(' + psQuote(docxAbs) + ', $false, $true)',
    '  $doc.ExportAsFixedFormat(' + psQuote(pdfPath) + ', 17)',
    '} finally {',
    '  if ($doc -ne $null) { try { $doc.Close($false) } catch {} }',
    '  if ($word -ne $null) { try { if ($word.Documents.Count -eq 0) { $word.Quit() } } catch {} }',
    '  if ($doc -ne $null) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) } catch {} }',
    '  if ($word -ne $null) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {} }',
    '}'
  ].join('\n')
  let encoded: string = Buffer.from(script, 'utf16le').toString('base64')
  let r: ProcResult = await runProcess('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], 90000)
  if (!r.ok || !fs.existsSync(pdfPath) || fs.statSync(pdfPath).size <= 0) {
    throw new Error('Microsoft Word 转换失败' + (r.output !== '' ? ': ' + tail(r.output, 600) : ''))
  }
  return { pdfPath: pdfPath, converter: 'Microsoft Word' }
}

// .docx -> PDF; 依次尝试 LibreOffice / Word, 都失败时把两边的原始输出带回去
async function convertDocxToPdf(docxAbs: string, workDir: string): Promise<{ pdfPath: string; converter: string }> {
  let pdfOutDir: string = path.join(workDir, 'pdf')
  fs.mkdirSync(pdfOutDir, { recursive: true })
  let errors: string[] = []
  try {
    return await convertWithLibreOffice(docxAbs, pdfOutDir, path.join(workDir, 'lo-profile'))
  } catch (e) {
    errors.push('LibreOffice: ' + (e instanceof Error ? e.message : String(e)))
  }
  try {
    return await convertWithWord(docxAbs, path.join(pdfOutDir, pdfNameFor(docxAbs)))
  } catch (e) {
    errors.push('Word: ' + (e instanceof Error ? e.message : String(e)))
  }
  throw new Error('无法把 .docx 转成 PDF, docx_render 需要本机安装 LibreOffice 或 Microsoft Word。\n- ' +
    errors.join('\n- '))
}

// 渲染入口: 输出 outDir/pNNN.png, 返回与 pdf_to_images 一致的分页信息
export async function renderDocxToPng(docxAbs: string, outDir: string, startPage: number,
  maxPages: number, targetWidth: number): Promise<DocxRenderResult> {
  let workDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'guncat-docx-render-'))
  try {
    let converted = await convertDocxToPdf(docxAbs, workDir)
    let batch: PdfPngBatchResult = await renderPdfPagesToPng(converted.pdfPath, outDir,
      startPage, maxPages, targetWidth)
    let r: DocxRenderResult = new DocxRenderResult()
    r.files = batch.files
    r.pageCount = batch.pageCount
    r.startPage = batch.startPage
    r.endPage = batch.endPage
    r.nextStartPage = batch.nextStartPage
    r.converter = converted.converter
    r.pdfPath = converted.pdfPath
    return r
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch (e) {
      // 临时目录清理失败不影响渲染结果
    }
  }
}
