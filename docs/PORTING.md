# 移植说明：鸿蒙 Guncat Work → 电脑版 Guncat Work

本文记录「鸿蒙版 → 电脑版」的移植策略、已完成的适配、以及**对上游移植文件做过的手术**。
日后与上游同步时，先看本文的「移植补丁清单」。

上游参考仓库：`Guncat-Work-for-hmos`（ArkTS / ArkUI，API 24）

## 0. 阶段状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 三协议流式对话 + 工作模式 Agent Loop + 沙箱工作区 + 核心工具 | ✅ 已完成 |
| 二 | 交互模式：guncat-ui lang 渲染（76 个组件 + `$绑定` + 动作回传） | ✅ 已完成，见 [交互模式实现说明](INTERACTIVE-MODE.md) |
| 三 | Office 生成器接入工具链 + 技能系统 | ✅ 已完成（生成→读回→算子编辑端到端验证） |
| 四 | 端侧增强：朗读 / 文件收件 / 导出 Word | 🚧 已完成主体；语音**输入**待定方案（见下） |

验证方式见 [README 的验证矩阵](../README.md#验证)：`pnpm typecheck` / `pnpm build` /
`pnpm smoke`（内核 105 项 + 渲染 26 项 + 契约 43 项）。

### 阶段四：哪些照搬、哪些必须换思路

| 鸿蒙能力 | 桌面端做法 | 说明 |
| --- | --- | --- |
| CoreSpeechKit 朗读 | ✅ 渲染进程 Web Speech API（`speechSynthesis`） | 音色取自系统 voice 列表；不再需要 AVSession 与后台长时任务（桌面端没有这些概念）；进度用 `onboundary` 逐词近似 |
| 系统分享接收 | ✅ 命令行参数 / 第二实例 / 窗口拖拽 | 桌面端的「分享」等价入口。文件进**沙箱工作区**（由模型用文件工具读取），不自动当附件送出 —— 与鸿蒙版行为一致 |
| 导出回答为 Word | ✅ 复用移植的 `DocxBuilder` | 含 LaTeX → OMML 原生公式；交互模式的界面程序会被剥离，只导出文本 |
| 语音**输入**（ASR） | ⏳ 待定 | Chromium 的 `SpeechRecognition` 在 Electron 里依赖 Google 语音服务凭据，默认不可用。可行路径是「录音 + 调用所配置服务商的转写接口」，但那是产品决策（引入新的接口约定），不宜擅自定；`VoiceInputService` 仍留在 `porting/deferred/` |

### 阶段三说明：Office 工具链为何无需改动

`write_docx` / `write_xlsx` / `write_pptx` 及其读回与算子编辑（`read_*` / `edit_*`）
在鸿蒙侧本来就走 `WorkToolRunner` 分发到 `export/` 下的纯 TS 生成器。
平台层把 `fileIo` / `util` / `zlib` 补齐之后，这条链在桌面端**原样可用**：

- 生成器本身不依赖任何 ArkUI（已确认 `export/` 下零装饰器）；
- `zlib.decompressFile` 实为 zip 解包，已用 `fflate` 对齐；
- 内嵌 JSON 源的无损读回机制不涉及平台差异。

`transform_file`（数据管道）同样是纯逻辑，CSV/TSV/JSON/Markdown/XLSX 互转直接可用。

技能系统（`list_skills` / `load_skill`）只依赖 `resourceManager.getRawFileContent`，
已映射到随包 `resources/` 目录，37 项技能与参考文档均可按需加载。

**仍未完成**：PDF 解析（`parse_document`）后端。接口已在 `platform/kit/PDFKit.ts` 就位，
但 PDF.js 的 `getDocument()` 是异步的、而端口代码的取文本链路是同步的，
需要一次针对性的异步改造，尚未动手；当前会返回清晰报错而非静默失败。

---

## 1. 核心策略：**别名替换，而不是改写代码**

鸿蒙侧的 110 个源文件里，只有约 15% 是真正的 ArkUI 界面代码，其余是纯业务逻辑。
这些逻辑文件里的平台依赖**全部收敛在 `import ... from '@kit.*'` 这一行**。

因此电脑版没有去逐个改写这些文件，而是：

1. 把上游 `entry/src/main/ets/{common,model,service,export,data}` 原样复制到 `src/core/`，
   **保持目录结构与相对 import 路径完全一致**；
2. 在 `src/core/platform/kit/` 下实现 `@kit.*` 的桌面等价物；
3. 在 `electron.vite.config.ts` 与 `tsconfig.node.json` 里把 `@kit.*` 别名指过去。

于是 `src/core/` 下的移植文件**几乎不需要改动 import**，上游更新时可以整体覆盖再重跑类型检查。

```ts
// 端口代码里保持原样：
import { http } from '@kit.NetworkKit'
import { fileIo } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'
// 由 bundler 别名解析到：
//   src/core/platform/kit/NetworkKit.ts（基于 fetch 的流式实现）
//   src/core/platform/kit/CoreFileKit.ts（基于 node:fs）
//   src/core/platform/kit/ArkTS.ts（基于 node:util）
```

### 另外两个别名

| 上游 | 电脑版实现 | 说明 |
| --- | --- | --- |
| `libguncatjs.so`（JSVM-API 原生模块） | `src/core/platform/native/libguncatjs.ts` | 改用 `node:vm`，见第 4 节 |
| `.ets` 扩展名 | 一律重命名为 `.ts` | 上游 `export/`、`service/` 下的 `.ets` **没有任何 ArkUI 装饰器**，是纯 TypeScript，重命名即可编译 |

---

## 2. 分层与目录

```text
src/
├── core/                      # 上游业务逻辑（几乎逐字移植，禁止放界面代码）
│   ├── common/                # 提示词、工具注册表、guncat-ui lang、数据管道、diff…
│   ├── model/                 # Message / Conversation / ApiConfig / Agent…
│   ├── service/               # 三协议 SSE、Agent Loop、工具执行、技能、沙箱工作区…
│   ├── export/                # Docx / Xlsx / Pptx / Svg 生成器与导入器
│   ├── data/                  # StorageManager
│   └── platform/              # ★ 电脑版新增：平台适配层
│       ├── appPaths.ts        #   应用沙箱目录（对应鸿蒙 filesDir）
│       ├── kit/               #   @kit.* 的桌面等价实现
│       └── native/            #   libguncatjs.so 的 node:vm 实现
├── main/                      # Electron 主进程：窗口、IPC、服务编排
├── preload/                   # contextBridge 安全桥
└── renderer/                  # React 界面（对应上游 views/ + pages/）
```

---

## 3. 平台适配层逐一对照

| 鸿蒙 `@kit.*` | 电脑版实现 | 关键差异处理 |
| --- | --- | --- |
| `@kit.NetworkKit`（http） | `platform/kit/NetworkKit.ts` | `createHttp()` 的 `request` / `requestInStream` + `on('dataReceive'/'dataEnd')` 事件模型完整还原；底层用全局 `fetch` 按 Web Streams 逐块读取。上游 SSE 链路用 `dataEnded` 标志做了双向兼容，因此「状态码先到」或「dataEnd 先到」都不会丢事件 |
| `@kit.CoreFileKit`（fileIo / picker） | `platform/kit/CoreFileKit.ts` | 上游只用到三种打开模式（`READ_ONLY`、`RW\|CREATE\|TRUNC`、`RW\|CREATE\|APPEND`），与 POSIX 常量一一对应，因此**数值标志直接透传** `fs.openSync`；`picker` 通过 `registerPickerHost` 注入 Electron dialog，实现延迟到启动时绑定 |
| `@kit.ArkTS`（util） | `platform/kit/ArkTS.ts` | `TextEncoder/TextDecoder/Base64Helper` 用 `node:util` 对齐；`TextDecoder.create(...)` 的流式 `{stream:true}` 语义保留 |
| `@kit.BasicServicesKit`（zlib） | `platform/kit/BasicServicesKit.ts` | ⚠️ 名字叫 zlib，实际语义是「把 zip 解包到目录」（docx/xlsx/pptx 都是 zip），因此用 `fflate.unzipSync` 而不是 `zlib.inflate`；已加防目录穿越校验 |
| `@kit.AbilityKit`（common） | `platform/kit/AbilityKit.ts` | `context.filesDir/cacheDir/tempDir` 由 `appPaths` 提供，**保持 `<filesDir>/workspaces/<会话ID>` 等全部子路径结构不变**；`resourceManager.getRawFileContent()` 映射到随包 `resources/` 目录 |
| `@kit.ArkData`（preferences） | `platform/kit/ArkData.ts` | 落成 `<filesDir>/preferences/<name>.json`，保留「`put` 不落盘、`flush` 才落盘」的语义 |
| `@kit.ImageKit`（image） | `platform/kit/ImageKit.ts` | 用 Electron 内置 `nativeImage` 实现解码/缩放/重编码，**零额外原生依赖** |
| `@kit.PDFKit`（pdfService） | `platform/kit/PDFKit.ts` | ⚠️ **接口已就位、后端待接**（阶段三）。PDF.js 的 `getDocument()` 是异步的，而端口代码的取文本链路是同步的，因此保留 `setPdfBackend()` 注入点 |
| `@kit.PerformanceAnalysisKit`（hilog） | `platform/kit/PerformanceAnalysisKit.ts` | 归一 `%{public}s` 格式串后走 console |

### 编译器设置对齐

ArkTS 与 TS 在空值上语义不同（ArkTS 的 `Object` 接受 `null`），
因此 `tsconfig.node.json` 里关闭了 `strictNullChecks` / `strictFunctionTypes`，
但**保留 `noImplicitAny`**，以便新写的代码仍能抓到真正的错误。
被移植的 35k 行代码本来就由 ArkTS 编译器与上游 521 项回归测试验证过。

---

## 4. 桌面端相对上游的**能力增强**

### 4.1 `run_js`：死循环可以被真正中断

上游用 JSVM-API，注释里明确写了：

> JSVM 引擎没有中断接口，这段代码仍在后台线程里运行

于是上游只能「超时放弃等待」，并累计 `abandoned` 计数、两次后停用本会话的 `run_js`。

电脑版改用 `node:vm` 的 `runInContext(code, ctx, { timeout })`，**引擎会真正中断**执行，
并且把调用方给出的 `timeout_ms` 直接作为 vm 的中断预算
（`JsCodeService` 里新增一行 `timeoutMs: timeoutMs` 透传）。因此：

- 死循环会在**调用方预算内**被终止，而不是「放弃等待但后台继续烧 CPU」；
- `abandoned` 计数在桌面端**永不触发**（代码保留以兼容上游）；
- 脚本的「最后一条表达式的值即返回值」语义由 `vm` 的完成值天然满足，与上游契约一致。

沙箱边界与上游完全一致：无网络、无文件系统、无 `require`/`import`；
文件只能通过 `inputs` / `read()` 进、`write()` 出。

> 冒烟脚本里有一条针对性的回归：`while(true){}` 必须在 10 秒左右被中断并返回超时错误。

### 4.2 rawfile 访问带目录穿越防护

上游直接读应用内 rawfile；电脑版读的是真实文件系统，
因此 `ResourceManager.resolve()` 强制校验解析后的路径必须落在资源目录内。

---

## 5. 移植补丁清单（与上游的唯一分歧）

以下是对**上游移植文件**做过的修改。同步上游时按此清单重新施加即可。

| 文件 | 补丁 | 原因 |
| --- | --- | --- |
| `core/common/Utils.ts` | 删除 `@kit.ArkTS` 的 `util` import，改用 Web 标准 `TextDecoder` | 该文件同时被渲染进程使用，必须保持平台无关 |
| `core/model/Message.ts` | 删除类上的 `@Observed` 装饰器 | `@Observed` 是 ArkUI 的追踪装饰器；编译产物会引用这个全局符号，桌面端不存在它（**不删会在运行时直接崩**）。桌面端状态刷新由渲染进程 store 负责 |
| `core/common/ToolExecutionGuard.ts` | `timer`/`poller` 类型 `number` → `ReturnType<typeof setTimeout/Interval> \| null`，哨兵 `-1` → `null` | Node 的定时器返回 `Timeout` 对象而非 `number` |
| `core/service/SubagentService.ts` | 同上（`abortPoller`，2 处哨兵比较） | 同上 |
| `core/service/JsCodeService.ts` | ① `timer` 类型同上；② `JsRunOptions` 里新增 `timeoutMs` 透传 | ①同上；②让 vm 按调用方预算硬中断（见 4.1） |
| `core/service/FileUploadService.ts` | `stringToBuffer()` 返回值加 `as ArrayBuffer` | TS 的 `Uint8Array.buffer` 类型是 `ArrayBufferLike`（含 `SharedArrayBuffer`） |

> 除上表外，`src/core/` 下**没有**对上游逻辑做过任何语义修改。

---

## 5.1 平台层踩到的两个真坑（值得记下来）

### Windows 上不能把鸿蒙 OpenMode 的数值直接透传给 `fs.openSync`

最初的做法是「鸿蒙 OpenMode 取值与 POSIX 常量一致，所以数值直接透传」。
这在 Linux/macOS 成立，在 **Windows 上会直接 `EINVAL`**：
Node 在 Windows 把数值标志交给 CRT 的 `_open`，而 CRT 的 `_O_CREAT`/`_O_TRUNC`
取值与 POSIX 的 `O_CREAT`/`O_TRUNC` **并不相同**（`0x0100` vs `0o100`）。

现在 `CoreFileKit.toNodeFlags()` 统一把位组合翻译成 Node 的字符串标志
（`r` / `r+` / `w` / `w+` / `a` / `a+`），由 Node 自己跨平台归一。

> 这个 bug 是被 `npm run smoke` 抓出来的：`write_file` 报
> `EINVAL: invalid argument, open '…'`，随即对话持久化、工作区打包全部连带失败。

### `@kit.*` 的延迟解析

`ImageKit` 里的 `nativeImage` 用 `createRequire` 延迟到真正解码像素时才解析，
这样本模块（以及依赖它的 `WorkFileService`）可以在**纯 Node 环境**下被导入，
无头冒烟验证才能覆盖工作区与工具链。

---

## 6. 阶段四（已从构建中移出，等待后续接入）

以下服务是鸿蒙端侧强绑定的能力，桌面端需要**换实现思路**而不是照搬，
因此暂时移到 `porting/deferred/`，不参与编译：

| 文件 | 鸿蒙能力 | 电脑版计划 |
| --- | --- | --- |
| `TextReaderService.ts` | CoreSpeechKit TTS + AVSession + 后台长时任务 | 渲染进程 Web Speech API（`speechSynthesis`） |
| `VoiceInputService.ts` | CoreSpeechKit ASR + AudioKit 采集 | 渲染进程 `MediaRecorder` + Web Speech `SpeechRecognition` |
| `BackgroundReaderService.ts` | AVSession 媒体会话 | 桌面端无对应概念，朗读直接在前台/后台继续 |
| `BackgroundTaskService.ts` | 后台任务申请 | 桌面端无对应概念，整体废弃 |
| `PluginHotLoader.ts` | 基于沙箱目录的热加载 | 阶段三随插件系统一并接入 |

同理，`entry/src/main/resources/rawfile/玩转应用`（32.5MB 静态教程站，ArkWeb 承载）
未纳入随包资源。
