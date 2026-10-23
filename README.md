# Guncat Work（电脑版）

> 鸿蒙版 [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos) 的桌面移植 ——
> 用 **Electron + React + TypeScript** 复刻的 Agent Harness 客户端。
> 业务内核（Agent Loop、三协议流式对话、45 个内置工具、37 项技能、Office 生成器、
> `guncat-ui lang` 渲染器）从 ArkTS 逐字移植而来。

<!-- 演示位（可选升级）：一段 30–60 秒的录屏 —— 进入工作模式 → 一句话生成 PPT → 产物卡片展开 → 切到交互模式拖滑块重算。动态 GIF 比静态截图更有说服力。 -->

![Electron](https://img.shields.io/badge/Electron-38-blue)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![version](https://img.shields.io/badge/version-0.2.1-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![forms](https://img.shields.io/badge/Agent%20Forms-Intelligent%20UI%20%2B%20Harness-blueviolet)
![tools](https://img.shields.io/badge/%E5%86%85%E7%BD%AE%E5%B7%A5%E5%85%B7-45-informational)
![skills](https://img.shields.io/badge/%E6%8A%80%E8%83%BD-37-informational)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![CI](https://github.com/zhubowen-bot/Guncat-Work-for-pc/actions/workflows/ci.yml/badge.svg)](https://github.com/zhubowen-bot/Guncat-Work-for-pc/actions/workflows/ci.yml)

## 三个形态

| 形态 | 对标 | 说明 |
| --- | --- | --- |
| ✦ **交互模式** | GPT 的 **Intelligent UI** | 一句话直出可操作界面，默认零工具调用、一轮渲染，控件取值即时重算 |
| 🛠 **工作模式** | **DeepSeek Harness**（dsh，Codex 式 Agent Loop） | 多轮工具循环 + 每会话独立沙箱工作区 + 45 个内置工具，长程任务自主执行 |
| 聊天模式 | — | 纯对话，不带沙箱工作区 |

工作模式与交互模式**共用同一套 Agent Loop 与沙箱工作区**，差别在行为纪律与**下发的工具面** ——
工作模式是「45 个内置工具全量 + 多轮工具循环 + 长程交付」，交互模式只下发 **27 个**
（读素材 / 算真实数字 / 核实外部事实 / 出文件），长程工具（`todo_write` / `goal_*` /
`schedule_*` / `subagent`）根本不出现在它的请求里，所以是「快车道、一轮直出界面」。

## 能力概览

- **两种当红 Agent 形态**：交互模式对标 GPT 的 Intelligent UI —— 回答不再是纯文本，而是一份
  **界面程序**，由应用渲染成可拖、可点、能改参数并即时重算的界面（柱状 / 折线 / 面积 /
  横向条 / 饼环 / 径向 / 雷达 / 堆叠条 8 种图表、表格、指标卡、图片墙、选项卡 / 折叠面板 /
  步骤条 / 卡片块，以及整套表单控件）；工作模式把 DeepSeek Harness 的核心 Agent Loop
  完整移植到桌面端。
- **三协议接入**：OpenAI Completions（`/chat/completions`）、OpenAI Responses（`/responses`）、
  Anthropic Messages（`/messages`），均支持图片直传；深度思考与联网搜索按各协议显式控制。
- **内置本地联网搜索**：软件内置、无需手动开关，工作模式与聊天模式都能调用，
  不受制于服务端联网开关。
- **桌面端直出 Office**：PPT / Word / Excel / SVG 由本地生成器产出，基于 JSON 中间层，
  文档可**无损读回、算子式编辑**；PDF 与 Office 全部本地解析，**不消耗多模态配额**。
- **45 个内置工具**：文件增删改查与模式匹配搜索、任务清单、图片查看、网络下载、PDF 解析、
  Office 读写、数据管道清洗转换与格式互转，以及基于 `node:vm` 的 `run_js` 代码沙箱
  （不联网、不读写文件系统，**死循环可被引擎硬中断**）。
- **37 项技能**：5 个主 Skill 路由 + 7 个格式分支 + 25 个领域分支，命中即按需加载；
  PPT / Word / Excel 三个技能采用「门」式约束，交付前生成可核对的自检报告。
- **原生 Markdown**：代码高亮、表格、任务列表、LaTeX 行内与块级公式、Mermaid 图表
  （导图规范按**桌面宽屏**口径，可横向滚动），深浅色主题自动适配。
- **附件与导出**：图片 / 文档直传或预解析、文件拖进窗口即导入工作区、导出 Markdown 回答为
  Word（含 LaTeX → OMML 原生公式）。
- **语音**：朗读（Web Speech API，可切换系统音色与倍速）+ 语音输入（录音 + 服务商转写接口）。
- **多套 API 配置**：保存并切换多套接入方式 / Base URL / Key / 模型；顶栏胶囊不进设置就能换模型。
- **自适应界面**：宽屏展开对话栏，窄屏单列；跟随系统切换深浅色主题。

## 快速开始

> 本项目用 **npm**（**不是 pnpm**）。装依赖：`npm install`

### 给用户：双击就能开

打包一次，然后把整个文件夹拷给对方，**双击里面的 `Guncat Work.exe` 即可**，
不需要装 Node、不需要命令行：

```bash
npm install
npm run dist       # 产出 release/Guncat Work-<版本>/
```

产物：

```text
release/Guncat Work-0.2.1/
├── Guncat Work.exe              ← 双击这个
├── create-desktop-shortcut.cmd  ← 想放桌面就双击一次（带应用图标）
├── run-compat.cmd               ← 不提权，直接带 --no-sandbox 启动
├── run-as-admin.cmd             ← 以管理员身份启动（会弹 UAC 提权确认）
├── enable-admin-mode.cmd        ← 让普通双击自动提权；撤销用 disable-admin-mode.cmd
├── diagnose.cmd / diagnose.ps1  ← 起不来时双击它，一次跑 6 档并逐档给出结论
├── 使用说明.txt
├── LICENSE
└── resources/                   ← 应用代码 + 随包资源（不要单独移动）
```

首次打开后，点左下角「设置」填入接入方式、Base URL、API Key 与模型，即可开始对话。
数据（对话历史、沙箱工作区、配置）存在 `%APPDATA%\Guncat Work`，不在程序目录里 ——
删除程序目录不影响已有数据。

**双击后进程「闪一下又起来」是预期行为**：win32 打包态会在启动第一刻自我重启一次，
把 `--no-sandbox` 放到真实命令行上（原因见下面的「已知环境限制」）。

**如果双击后窗口没有出现**：双击 `diagnose.cmd`，它会一次跑 6 档、每档用独立用户数据目录，
结果写进 `diag-log.txt`。也可以双击 `run-compat.cmd` 直接以兼容模式启动。
完整的排查路径见 **[启动排障](docs/STARTUP-TROUBLESHOOTING.md)**。

### 给用户：一个安装包，装完从开始菜单打开

不想发文件夹、想要一个能直接发给别人的 `.exe`，用安装包：

```bash
npm run dist:setup   # 产出 release/Guncat-Work-<版本>-setup.exe（单文件，约 105 MB）
```

双击即装。**这是「为所有用户安装」**：默认装到 `C:\Program Files\Guncat Work`，
登记在机器级 `HKLM`，快捷方式放公共桌面 / 公共开始菜单 —— 所以安装和卸载各会弹**一次 UAC**
请求管理员授权（点「是」即可）。装完自带卸载程序，可勾选是否连本地数据一起删。

界面是自绘的现代风格（无边框圆角窗 + 渐变），不是 Win32 向导。
安装与卸载的界面各四页，可以离屏渲染成 PNG 直接看：

```bash
npm run dist:setup:ui   # → .tmp/installer-shots/*.png
```

实现说明、静默安装参数与工具链约束见 **[installer/README.md](installer/README.md)**。

### 给开发：改代码即时生效

```bash
npm install
npm run dev        # 主进程 + 渲染进程热更新
```

## 技术栈

- **桌面外壳**：Electron 38（应用代码用 vite 全量打进 `out/`，产物**没有运行时 node_modules**）
- **界面**：React 19 + TypeScript + Vite（electron-vite）
- **业务内核**：从鸿蒙版**逐字移植**的 TypeScript（约 3.5 万行），平台依赖通过 `@kit.*` 别名替换
- **打包**：自带的 `scripts/package-portable.mjs`（见下方「关于打包」）

### 关于打包

`npm run dist` 用的是仓库自带的组装脚本，而不是 electron-builder。原因很具体：
electron-builder 的依赖收集器在部分环境下拿不到包管理器列表的 JSON 输出，会在打包中途
报 `No JSON content found in output`。而本应用的运行时代码已被 vite 全部打进 `out/`，
**打包时本来就没有 node_modules 需要收集** —— 那一步是多余的。
自带的脚本按 Electron 标准应用目录结构直接组装，结果更可控也更快。

唯一的两处例外是 PDF 后端：`pdfjs-dist` 与 `@napi-rs/canvas`（原生 `.node`）都不能进 bundle
（前者内部有 worker / wasm / 字体的动态路径，后者根本打不进），因此它们由组装脚本
手工拷进**产物目录**下的 `Guncat Work-<版本>/resources/app/node_modules/`，
PDF 的标准字体 / CMap / wasm 解码器拷进 `Guncat Work-<版本>/resources/resources/pdfjs/`。
缺任何一块都不会「报文件损坏」：文本抽取退化成缺字体度量，
渲染退化成一条明确的「缺渲染后端」提示。见 `src/core/platform/native/pdfBackend.ts`。

`electron-builder.yml` 保留在仓库里，供将来需要**签名安装包 / 自动更新**时使用。

### 关于构建期的两个坑（已固化处理）

1. **esbuild 的临时目录**：Windows 上 esbuild 会在系统 `TEMP` 里建临时文件再删除，
   部分环境下这一步会报 `Access is denied`，构建在 `vite:esbuild-transpile` 阶段直接失败。
   现在统一把 `TMP`/`TEMP` 指到项目内的 `.tmp`（见 `scripts/esbuild-aliases.mjs`
   与 `scripts/build.mjs`）。
2. **构建入口**：`npm run build` 走 `scripts/build.mjs` 包装脚本而不是直接调 `electron-vite`，
   为的就是在启动子进程前把上面的临时目录设好，并剔除会破坏 Electron 启动的
   `ELECTRON_RUN_AS_NODE`；用 Node 包装而不是 `set TMP=... &&`，是为了不依赖 cmd/bash 语法。

### 应用图标

取自鸿蒙原项目：`AppScope/resources/base/media/layered_image.json` 里分层图标的
background 与 foreground **都指向 `cat_avatar.png`**，所以它才是真正的应用图标。
由 `scripts/make-icon.py` 生成两种格式：`app-icon.png`（256²，窗口与任务栏图标）
与 `app-icon.ico`（7 种尺寸，桌面快捷方式用）。

## 验证

一条命令跑完全部：**`npm run verify`**（= typecheck + smoke，smoke 内部会先构建）。

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | `src/core`（移植内核）+ `src/main` + `src/preload` + `src/renderer` |
| 构建 | `npm run build` | main / preload / renderer 三端产物 |
| 内核 | `npm run smoke:core` | **341 项**：智能体加载、45 个工具、37 项技能、沙箱工作区、`run_js` 沙箱、数据管道、持久化、三协议端点、**Office 工具链端到端**（生成→读回→算子编辑）、**技能系统工具**、**交互模式全链路**（解析 / `$绑定`重算 / 动作回传 / 状态尾标记 / 表单打包）、**PDF 解析**（文本 / 搜索 / 页面转图）、**SVG 栅格化**（预览 PNG / docx 与 pptx 引用）、**插件热加载**（清单 → 解析 → 注册进工具表）、**HTTP 读空闲超时**（长流式不被掐断 / 停滞连接被掐断），另含端侧增强 138 项、语音输入 12 项、聊天多轮与界面补助 20 项、运行时快照 10 项、`ask_user_question` 26 项 |
| 渲染 | `npm run smoke:render` | **272 项**：用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML 并逐项断言（含工作模式与交互模式各自的编排方式、Markdown 的 LaTeX / 代码块 / mermaid 三条链路、工作区面板的上传入口与文件分类图标、输入区的附件入口与插话按钮、侧栏的引擎分组与工作区开关、工具行的 diff / 任务清单卡、任务统计卡与目标卡、产物汇总卡、表格提取面板） |
| 契约 | `npm run smoke:ipc` | **247 项**：用 electron 替身把渲染进程会调用的**每个 IPC 通道**真实 invoke 一遍（注册完整性、设置往返、会话生命周期、事件推送、越界与目录穿越拒绝、护栏提示、**文件收件与工作区上传**、**导出 Word**、**语音转写配置与端点拼接**、**本地联网搜索配置与绑定**、**协议路径后缀开关往返**、**配置方案**（迁移 / 新建 / 切换 / 保存 / 删除保护）、**聊天附件**（真的把内容填进消息）、**定时提醒推进**、**推理强度透传**、**执行中插话**、**任务统计与目标**、**产物汇总**、**表格提取**与模型输出清洗） |
| 启动 | `npm run smoke:startup` | **150 项**（Windows；其他平台 145 项，见下注）：用 electron 替身跑**真实入口** `src/main/index.ts`，断言单实例锁 → whenReady → 建窗口 → 注册 IPC 依次发生，且 **preload 路径与 index.html 都指向真实存在的文件**、数据目录已建、全程无异常；另有任务栏身份、菜单栏、窗口图标、定时提醒推进的拉起与打包脚本的图标写入断言 |
| 字符 | `node scripts/check-emoji.mjs src/renderer` | 渲染层不得出现 emoji，也不得出现当图标用的符号（改用 SVG 组件） |
| 全部 | `npm run smoke` | 上面四套冒烟 + 字符扫描（Windows 上共约 1010 项断言） |

`npm run smoke` 把风险最高的移植内核拉到纯 Node 下按真实调用链跑一遍，
并用 esbuild 施加与 `electron.vite.config.ts` **完全相同**的别名规则 ——
验证的是构建产物真实依赖的那套解析规则，而不是另起一套近似配置。

> **计数以 Windows 为准。** 有一批断言是 win32 专属的（窗口优先用 `.ico`、
> 打包态默认开 Chromium 日志、打包态自我重启带 `--no-sandbox`），在 Linux / macOS 上会少 5 项 ——
> CI 跑在 Linux 上，所以那里的启动套件是 **145 项**。
> 这些断言是**按平台分支写的、两边各有明确期望值**，而不是「非 Windows 就跳过」：
> 跳过的断言在没有 Windows 的 CI 上永远不会失败，等于假防线。

渲染验证的意义：Electron 窗口在部分开发机上起不来，但「元素树 → React 组件树」这一段
在 Node 里可以完整跑通（SSR 不执行 `useEffect`，因此不依赖 `ResizeObserver` / `window`），
渲染器因此不会只停留在「类型检查通过」。

CI 覆盖类型检查、三端构建与四套冒烟，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。
**打包产物必须在本地跑一次并双击核对** —— 托管 runner 上不适合以窗口方式运行 Electron。

## 已知环境限制

**部分 Windows 开发机上，带沙箱启动的 Electron 无法创建 GPU 子进程**：Chromium 判定
「GPU process isn't usable」后执行 `LOG(FATAL)` 自杀，退出码 `-2147483645`
（即 `0x80000003` / `STATUS_BREAKPOINT`）。14 组对照实验证明只有 `--no-sandbox` 能改变结果。

因此：

- **打包产物是免疫的** —— win32 打包态会在启动第一刻自我重启，把 `--no-sandbox`
  放到真实命令行上（所以「进程闪一下又起来」是预期行为）。
- **`npm run dev` 刻意保留沙箱**，因此在受影响的机器上开发态可能开不出窗口。
  这是刻意的：留一条能复现根因的路径。

详细的根因、对照实验、白屏真凶与诊断阶梯见
**[启动排障与兼容模式](docs/STARTUP-TROUBLESHOOTING.md)**。

无论哪种形态，应用都会在 `%APPDATA%\Guncat Work\logs\startup.log` 逐里程碑写启动日志，
产物里也附了 `diagnose.cmd`。

## 目录结构

```text
src/
├── core/         # 鸿蒙版业务内核（逐字移植）+ 平台适配层
│   ├── common/   #   提示词、工具注册表、guncat-ui lang、数据管道、diff…
│   ├── model/    #   Message / Conversation / ApiConfig / Agent…
│   ├── service/  #   三协议 SSE、Agent Loop、工具执行、技能、沙箱工作区…
│   ├── export/   #   Docx / Xlsx / Pptx / Svg 生成器与导入器
│   ├── data/     #   StorageManager
│   └── platform/ # ★ 电脑版新增：@kit.* 的桌面等价实现
├── main/         # Electron 主进程（窗口、IPC、会话与 Agent Loop 编排）
├── preload/      # contextBridge 安全桥
├── renderer/     # React 界面
└── ipc/          # 主进程 ↔ 渲染进程的共享契约
resources/        # 随包资源：agents.json、智能体提示词、技能库
scripts/          # 无头冒烟验证与打包脚本
docs/PORTING.md   # ★ 移植策略、平台适配对照、与上游的分歧清单
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [移植说明](docs/PORTING.md) | 移植策略、`@kit.*` 适配对照、**与上游的分歧清单**（同步上游时按此逐条重新施加） |
| [交互模式实现说明](docs/INTERACTIVE-MODE.md) | guncat-ui lang 数据流、76 个组件覆盖、容错设计、两层无头验证 |
| [启动排障与兼容模式](docs/STARTUP-TROUBLESHOOTING.md) | 崩溃根因、14 组对照实验、白屏真凶、6 档诊断阶梯、崩溃转储分析 |
| [参与贡献](CONTRIBUTING.md) | 环境要求、验证矩阵、编码约定与红线、PR 流程 |
| [更新记录](CHANGELOG.md) | 全部版本变更 |

上游（鸿蒙版）的研究材料：[open-intelligent-ui 规格](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/open-intelligent-ui-spec.md) ·
[openui-lang 规范](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/openui-lang-spec.md)。

## 隐私说明

- API Key 与应用配置保存在本机用户数据目录（`%APPDATA%\Guncat Work`）。
- 聊天请求和附件只会发送到用户配置的模型服务。
- 工作模式的文件读写全部在应用沙箱工作区内完成；**没有额外的权限申请**。
- 从命令行参数、第二实例或窗口拖拽收到的文件会进入**沙箱工作区**（由模型用文件工具读取），
  不会自动作为附件送出。
- 网络请求使用 HTTPS，实际数据处理政策以所配置的模型服务商为准。

## 常见问题

遇到问题先看 [启动排障与兼容模式](docs/STARTUP-TROUBLESHOOTING.md)，
涵盖窗口没出现 / 白屏 / 闪退、`-2147483645` 退出码、白屏的真凶、
诊断脚本怎么用、崩溃转储怎么看。

## 贡献

欢迎提交 Issue 和 Pull Request。开发环境、编码约定（含「移植内核默认不许改」这条硬约束）、
验证矩阵怎么跑、PR 流程 → **[CONTRIBUTING.md](CONTRIBUTING.md)**。

1. Fork 仓库。
2. 创建功能分支。
3. 完成修改，并跑通对应的验证层（改了 `src/core/**` 必须同步补断言）。
4. 确保 `npm run verify` 通过。
5. 提交 Pull Request，并说明修改内容及验证方式。

## 授权

本项目基于 [Apache License 2.0](LICENSE) 开源，与上游鸿蒙版一致。
