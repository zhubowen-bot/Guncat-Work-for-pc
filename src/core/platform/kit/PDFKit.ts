// 平台适配层：鸿蒙 `@kit.PDFKit` 的等价实现（Node 侧）
//
// ⚠️ 阶段状态：**接口已就位，后端待接**（阶段三补齐）
//
// 鸿蒙侧 pdfService 提供「同步加载 + 按页取文本/版面对象/渲染成图」的完整能力，
// 桌面端最合适的后端是 PDF.js（pdfjs-dist）——它的文本抽取与页面渲染质量都很高。
// 但 PDF.js 的 `getDocument()` 是**异步**的，而端口代码里
//   loadDocument() → getPageCount() → getPage(i).getTextContent()
// 是一条同步调用链（见 service/PdfTextExtractor.ts）。
//
// 因此这里分两步走：
//   1. 本文件先按鸿蒙签名把类型与结构完整搭好，默认后端返回 PARSE_ERROR_FORMAT，
//      使 PDF 路径在桌面上「报错清晰」而不是「静默崩」；
//   2. 阶段三接入 pdfjs-dist 时，把 PdfTextExtractor 的取文本路径改成异步
//      （这是平台差异导致的一次性改动，其余调用方不受影响）。
//
// 想提前启用后端，调用 setPdfBackend() 注入实现即可。
import type { image } from './ImageKit'

export namespace pdfService {
  export enum ParseResult {
    PARSE_SUCCESS = 0,
    PARSE_ERROR_HANDLER = 1,
    PARSE_ERROR_FILE = 2,
    PARSE_ERROR_FORMAT = 3,
    PARSE_ERROR_PASSWORD = 4,
    PARSE_ERROR_CERT = 5
  }

  export enum GraphicsObjectType {
    OBJECT_UNKNOWN = 0,
    OBJECT_TEXT = 1,
    OBJECT_PATH = 2,
    OBJECT_IMAGE = 3,
    OBJECT_SHADING = 4,
    OBJECT_FORMXOBJECT = 5
  }

  export interface PdfRect {
    left: number
    top: number
    right: number
    bottom: number
  }

  export interface GraphicsObject {
    type: GraphicsObjectType
    x: number
    y: number
    width: number
    height: number
  }

  export interface TextObject extends GraphicsObject {
    text: string
    charRects: PdfRect[]
  }

  export interface SearchOptions {
    isMatchCase: boolean
    contextStringLength: number
  }

  export interface SearchResultData {
    pageIndex: number
    contextString: string
  }

  export type SearchKeyCallback = (results: SearchResultData[]) => boolean

  /**
   * 对齐鸿蒙 PDFKit 的 PdfMatrix：描述「页面坐标系里要渲染的矩形 + 旋转」。
   * 端口代码按 x/y/width/height/rotate 逐字段赋值（见 PdfTextExtractor.renderOnePage）。
   */
  export class PdfMatrix {
    x: number = 0
    y: number = 0
    width: number = 0
    height: number = 0
    rotate: number = 0
  }

  /** 单页抽象：由后端实现 */
  export interface PdfPageBackend {
    getTextContent(): string
    getGraphicsObjects(): GraphicsObject[]
    /** 页面原始宽高（点） */
    getWidth(): number
    getHeight(): number
    renderToPixelMap(width: number, height: number): Promise<image.PixelMap>
  }

  /** 文档抽象：由后端实现 */
  export interface PdfDocumentBackend {
    getPageCount(): number
    getPage(index: number): PdfPageBackend
    searchKey?(
      keyword: string,
      listener: SearchKeyCallback,
      options: SearchOptions
    ): Promise<void>
    release(): void
  }

  export interface PdfBackend {
    /**
     * 打开文档。返回 null 表示无法解析（由 PdfDocument 归因为 PARSE_ERROR_FORMAT）。
     * 可通过抛出携带 code 的错误来表达加密等具体原因。
     */
    open(absPath: string): PdfDocumentBackend | null
  }

  let backend: PdfBackend | null = null

  /** 阶段三接入 PDF.js 后由 bootstrap 调用；也便于测试注入假后端 */
  export function setPdfBackend(next: PdfBackend | null): void {
    backend = next
  }

  export function hasPdfBackend(): boolean {
    return backend !== null
  }

  export class PdfPage implements PdfPageBackend {
    private inner: PdfPageBackend

    constructor(inner: PdfPageBackend) {
      this.inner = inner
    }

    getTextContent(): string {
      return this.inner.getTextContent()
    }

    getGraphicsObjects(): GraphicsObject[] {
      return this.inner.getGraphicsObjects()
    }

    /** 对齐鸿蒙 PdfPage.getWidth() / getHeight()（页面原始尺寸，单位点） */
    getWidth(): number {
      return this.inner.getWidth()
    }

    getHeight(): number {
      return this.inner.getHeight()
    }

    /** 对齐鸿蒙的 getPagePixelMap(默认分辨率) */
    getPagePixelMap(): image.PixelMap {
      throw new Error('PDF 页面渲染尚未在桌面端启用（阶段三）')
    }

    /** 对齐鸿蒙的 getAreaPixelMapWithOptions */
    getAreaPixelMapWithOptions(
      _matrix: PdfMatrix,
      _width: number,
      _height: number
    ): image.PixelMap {
      throw new Error('PDF 页面渲染尚未在桌面端启用（阶段三）')
    }

    async renderToPixelMap(width: number, height: number): Promise<image.PixelMap> {
      return this.inner.renderToPixelMap(width, height)
    }

    release(): void {
      // 后端自行管理页对象生命周期
    }
  }

  export class PdfDocument {
    private inner: PdfDocumentBackend | null = null
    private opened: boolean = false

    loadDocument(absPath: string): ParseResult {
      if (backend === null) {
        return ParseResult.PARSE_ERROR_FORMAT
      }
      try {
        const doc: PdfDocumentBackend | null = backend.open(absPath)
        if (doc === null) {
          return ParseResult.PARSE_ERROR_FORMAT
        }
        this.inner = doc
        this.opened = true
        return ParseResult.PARSE_SUCCESS
      } catch (e) {
        const code: number | undefined = (e as { code?: number }).code
        if (code === ParseResult.PARSE_ERROR_PASSWORD || code === ParseResult.PARSE_ERROR_CERT) {
          return code
        }
        return ParseResult.PARSE_ERROR_FORMAT
      }
    }

    getPageCount(): number {
      return this.inner === null ? 0 : this.inner.getPageCount()
    }

    getPage(index: number): PdfPage {
      if (this.inner === null) {
        throw new Error('PDF 文档尚未加载')
      }
      return new PdfPage(this.inner.getPage(index))
    }

    async searchKey(
      keyword: string,
      listener: SearchKeyCallback,
      options: SearchOptions
    ): Promise<void> {
      if (this.inner !== null && this.inner.searchKey !== undefined) {
        await this.inner.searchKey(keyword, listener, options)
        return
      }
      throw new Error('后端未实现 searchKey，请走逐页子串扫描兜底')
    }

    releaseDocument(): void {
      if (this.inner !== null && this.opened) {
        this.inner.release()
      }
      this.inner = null
      this.opened = false
    }
  }
}
