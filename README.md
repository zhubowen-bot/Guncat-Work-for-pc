# Guncat Work（电脑版）

[中文](README.md) | [English](README_EN.md)

> **桌面端 Agent Harness 客户端**，用 **Electron + React + TypeScript** 实现：三协议流式对话、
> 多轮工具循环与沙箱工作区、一句话直出的交互界面、桌面直出 Office，以及一条**经过系统安全审计的
> 命令执行链路**。
> 
> 鸿蒙版见 [Guncat Work（鸿蒙版）](https://github.com/zhubowen-bot/Guncat-Work-for-hmos)（ArkTS / ArkUI）。
> 
> 安卓版见 [Guncat Work（安卓版）](https://github.com/zhubowen-bot/Guncat-Work-for-android)（Java 壳 + WebView（SPA））。

<!-- 演示位（可选升级）：一段 30–60 秒的录屏 —— 进入工作模式 → 一句话生成 PPT → 产物卡片展开 → 切到交互模式拖滑块重算。动态 GIF 比静态截图更有说服力。 -->

![Electron](https://img.shields.io/badge/Electron-38-blue)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![version](https://img.shields.io/badge/version-7.0.0-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![forms](https://img.shields.io/badge/Agent%20Forms-Intelligent%20UI%20%2B%20Harness-blueviolet)
![tools](https://img.shields.io/badge/%E5%86%85%E7%BD%AE%E5%B7%A5%E5%85%B7-45-informational)
![skills](https://img.shields.io/badge/%E6%8A%80%E8%83%BD-37-informational)
![shell audit](https://img.shields.io/badge/shell%20audit-163%20rules-red)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![CI](https://github.com/zhubowen-bot/Guncat-Work-for-pc/actions/workflows/ci.yml/badge.svg)](https://github.com/zhubowen-bot/Guncat-Work-for-pc/actions/workflows/ci.yml)

## 三个形态

| 形态          | 对标                                           | 说明                                      |
| ----------- | -------------------------------------------- | --------------------------------------- |
| ✦ **交互模式**  | GPT 的 **Intelligent UI**                     | 一句话直出可操作界面，默认零工具调用、一轮渲染，控件取值即时重算        |
| 🛠 **工作模式** | **DeepSeek Harness**（dsh，Codex 式 Agent Loop） | 多轮工具循环 + 每会话独立沙箱工作区 + 45 个内置工具，长程任务自主执行 |
| 聊天模式        | —                                            | 纯对话，不带沙箱工作区                             |

工作模式与交互模式**共用同一套 Agent Loop 与沙箱工作区**，差别在行为纪律与**下发的工具面** ——
工作模式是「45 个内置工具全量 + 多轮工具循环 + 长程交付」，交互模式只下发 **27 个**
（读素材 / 算真实数字 / 核实外部事实 / 出文件），长程工具（`todo_write` / `goal_*` /
`schedule_*` / `subagent`）根本不出现在它的请求里，所以是「快车道、一轮直出界面」。
`run_command` 同样不在交互模式的工具面里：能跑命令的形态，必须有地方让人看见与批准。

## 能力概览

- **终端执行带安全审计**：工作模式可以在真实工程里跑构建、测试、git 与本机 CLI，但每一条命令都要
  过判定层——毁灭性操作**直接拒绝、不给审批入口**，有外溢风险的操作按档位弹卡请人批准，工作区
  越界、脚本内藏动作、编码载荷与解释器内联代码一律拦住。详见
  [Shell 安全审计](#shell-安全审计commandguard)。
- **两种当红 Agent 形态**：交互模式对标 GPT 的 Intelligent UI —— 回答不再是纯文本，而是一份
  **界面程序**，由应用渲染成可拖、可点、能改参数并即时重算的界面（柱状 / 折线 / 面积 /
  横向条 / 饼环 / 径向 / 雷达 / 堆叠条 8 种图表、表格、指标卡、图片墙、选项卡 / 折叠面板 /
  步骤条 / 卡片块，以及整套表单控件）；工作模式把 DeepSeek Harness 的核心 Agent Loop
  带进桌面端。
- **三协议接入**：OpenAI Completions（`/chat/completions`）、OpenAI Responses（`/responses`）、
  Anthropic Messages（`/messages`），均支持图片直传；深度思考与联网搜索按各协议显式控制。
- **内置本地联网搜索**：软件内置、无需手动开关，工作模式与聊天模式都能调用，
  不受制于服务端联网开关。
- **桌面端直出 Office**：PPT / Word / Excel / SVG 由本地生成器产出，基于 JSON 中间层，
  文档可**无损读回、算子式编辑**；PDF 与 Office 全部本地解析，**不消耗多模态配额**。
- **45 个内置工具**：文件增删改查与模式匹配搜索、任务清单、图片查看、网络下载、PDF 解析、
  Office 读写、数据管道清洗转换与格式互转、命令执行与后台任务，以及基于 `node:vm` 的
  `run_js` 代码沙箱（不联网、不读写文件系统，**死循环可被引擎硬中断**）。
- **37 项技能**：5 个主 Skill 路由 + 7 个格式分支 + 25 个领域分支，命中即按需加载；
  PPT / Word / Excel 三个技能采用「门」式约束，交付前生成可核对的自检报告。
- **原生 Markdown**：代码高亮、表格、任务列表、LaTeX 行内与块级公式、Mermaid 图表
  （导图规范按**桌面宽屏**口径，可横向滚动），深浅色主题自动适配。
- **附件与导出**：图片 / 文档直传或预解析、文件拖进窗口即导入工作区、导出 Markdown 回答为
  Word（含 LaTeX → OMML 原生公式）。
- **语音**：朗读（Web Speech API，可切换系统音色与倍速）+ 语音输入（录音 + 服务商转写接口）。
- **多套 API 配置**：保存并切换多套接入方式 / Base URL / Key / 模型；顶栏胶囊不进设置就能换模型。
- **自适应界面**：宽屏展开对话栏，窄屏单列；跟随系统切换深浅色主题。

## Shell 安全审计（CommandGuard）

> 一个能替你敲命令的 Agent，最坏的结果不是答错，而是**模型写出的某条命令把用户磁盘上的东西删掉**。
> 这条能力从落地起就带着审计交付：判定层 `src/core/service/CommandGuard.ts`（1700+ 行纯逻辑，
> 不碰进程）、审批链路 `src/core/service/CommandService.ts`，外加一套独立的判定语料。
> 测试版的最后一段（`0.2.0` → `0.2.1`）几乎全部花在这里：十余轮对抗式实测、二十余处绕过逐条关闭，
> 每一处都先复现再修，每一处都补了回归。

### 威胁模型

模型输出是**不可信输入**；`run_command` 一旦失手，代价不是「改错一个文件」，而是不可回滚的数据
丢失。所以这里的目标不是「拦住一眼就坏的写法」，而是**换一种拼法也拦得住**。

### 第一道闸：硬禁不给审批入口

`forbidden` 档直接拒绝，连「允许」按钮都不给——因为**用户手滑点「允许」本身就是必须防住的失败
模式**。硬禁只收真正不可逆、且智能体没有任何正当理由去做的事：格式化磁盘、写裸设备、删卷影副本
与系统备份、固件/控制器级擦除、关闭 Defender 与防火墙、清审计日志、导出 lsass 凭据或 EFS 恢复
密钥……共 37 条规则。

### 第二道闸：四档审批，改的是「谁来判断」

| 档位             | 危险命令由谁裁决                        |
| -------------- | ------------------------------- |
| `ask`          | 每条命令都要人批准                       |
| `ask-risk`（默认） | 危险命令弹卡请人批准，其余直接执行               |
| `auto`         | 先让模型审一轮；判 low/medium 且明确放行才静默执行 |
| `full-access`  | 不审不问，只剩硬禁兜底                     |

`auto` 不是「全自动」：模型判 high、结论自相矛盾、不按契约回 JSON、超时、没配模型——**一律退回
人工卡，机器没有终审权**。模型审阅只看环境、用户原话与命令原文；智能体自己的解释与思考不进上下
文，否则它先说一句「这是安全的」就能说服审阅器。`full-access` 也只关掉审阅，硬禁表排在它前面，
四档都碰不到。

### 六张规则表，163 条规则

37 条硬禁 + 77 条危险 + 27 条「意图读不出」+ 11 条脚本内容 + 2 条命令位硬禁 + 9 条命令位危险。
规则登记的是**语义**，不是词的形状。

### 三层独立判定，缺一层就会被绕过

1. **还原文本的关键词**：cmd 的 `^`、拆词的引号、`@` 前缀、`%ComSpec%`、括号与管道里的第二段——
   执行时都会变回原样，所以判定文本是「原文 ∪ 还原后 ∪ 拆出来的内层命令」。归一化只去掉伪装，
   从不改写语义，派生文本只会**多出**命中。
2. **意图读不出（OPAQUE）**：解释器内联代码、stdin 与重定向喂进去的代码、`for` 循环变量当命令
   执行、Base64 载荷、命令替换、脚本宿主与系统组件加载器、WSL / ssh 一类「把决定权交给别处」的
   通道。这类命令文本里天生没有危险词，关键词表永远追不上，所以按「读不出要做什么」一刀切。
3. **位置越界**：绝对路径、`..` 上跳、环境变量展开出的路径、盘根写法（`\data\a.txt` 就是
   `C:\data\a.txt`）、UNC 网络路径、`\\?\` 前缀。这一层与写法无关，是最硬的一层。

### 脚本同审：读的是「要执行的那个文件」，不是后缀

`cscript //E:` 能把 `.txt` 当 VBS 跑，`cmd` 会按 PATHEXT 给裸名补后缀，`%~dp0` / `$PSScriptRoot`
会换基准目录，`npm run x` 跑的是 `package.json` 里那段字符串。所以：

- 按**进程 cwd + 脚本自身目录**逐个基准解析引用，命中几个审几个；
- 无后缀的裸名按 PATHEXT 找到真实存在的文件再读；
- `npm --prefix` / `yarn --cwd` / `pnpm -C` 换包目录后，读的是**换过去之后**那份 `package.json`；
- 先用 `copy` / 重定向改写脚本再执行，同样进审批——同审读到的是改写前的旧内容；
- 定位不到、文件不存在、超出审阅层级上限，一律**转审批而不是静默放过**。

### 命令位判定：同一件事换个名字不算新命令

`npx` 与 `npm exec` / `npm x` / `pnpm exec` / `pnpm dlx` / `yarn dlx` / `bunx` 是同一件事；
`format` 是格式化磁盘，还是 `npm run format` 里的一个词，取决于它是否位于命令位。规则按
「这个动作做了什么」登记，而不是按名字枚举——否则改一个拼写就绕过一整张表。

### 进程层也一起收紧

工作目录锚定会话工作区（越界直接拒绝，不会在用户别的目录里跑起来）；子进程环境按白名单净化，
主进程里的 API Key 不会透传给命令；超时、取消、无人应答一律 fail-closed——**沉默不等于同意**。

### 审计方法与回归

- **先复现，再修**：每一轮都拿真实报告对着生产代码跑，用真实 `CommandGuard.assess` 与真实
  `run_command` 复现出「零审批直通」，确认成立才改。
- **两层回归**：判定层（危险项必判危险 + 日常写法不得误伤）与集成层（弹卡 → 卡上写明命中理由 →
  点拒绝 → 文件还在）。
- **独立语料**：`scripts/guard-corpus.mjs` 覆盖 117 条硬禁用例、90 条危险用例、47 条正常写法，
  外加 250 条 `^` 转义变体与 111 条「词间插 `^`」变体，断言**换写法不会降低档位**。
- **明确取舍**：不采纳白名单式改造（会让 `npm run build` 天天弹卡，安全收益换不来可用性）；
  接受字符串误报（`git commit -m "rm -rf / 的说明"` 也会被问一次）——漏判的代价是用户的数据，
  误报的代价只是多点一次。

取向一句话：**宁可多问一次，不可漏判一次。**

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
release/Guncat Work-7.0.0/
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
- **业务内核**：TypeScript（约 3.5 万行），平台差异通过 `@kit.*` 别名适配到桌面运行时
- **命令安全**：`CommandGuard`（纯判定逻辑）+ `CommandService`（审批与执行链路），
  判定层可脱离真实进程做断言
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

图标沿用同一套品牌资源：`AppScope/resources/base/media/layered_image.json` 里分层图标的
background 与 foreground **都指向 `cat_avatar.png`**，所以它才是真正的应用图标。
由 `scripts/make-icon.py` 生成两种格式：`app-icon.png`（256²，窗口与任务栏图标）
与 `app-icon.ico`（7 种尺寸，桌面快捷方式用）。

## 验证

一条命令跑完全部：**`npm run verify`**（= typecheck + smoke，smoke 内部会先构建）。

| 层    | 命令                                          | 覆盖                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型   | `npm run typecheck`                         | `src/core`（业务内核）+ `src/main` + `src/preload` + `src/renderer`                                                                                                                                                                                                                                                                                                                    |
| 构建   | `npm run build`                             | main / preload / renderer 三端产物                                                                                                                                                                                                                                                                                                                                                   |
| 内核   | `npm run smoke:core`                        | **504 项**：智能体加载、45 个工具、37 项技能、沙箱工作区、`run_js` 沙箱、数据管道、持久化、三协议端点、**Office 工具链端到端**（生成→读回→算子编辑）、**技能系统工具**、**交互模式全链路**（解析 / `$绑定`重算 / 动作回传 / 状态尾标记 / 表单打包）、**PDF 解析**（文本 / 搜索 / 页面转图）、**SVG 栅格化**（预览 PNG / docx 与 pptx 引用）、**插件热加载**、**HTTP 读空闲超时**，另含端侧增强 156 项、语音输入 12 项、聊天多轮与界面补助 20 项、运行时快照 10 项、`ask_user_question` 26 项、**命令执行与安全边界 423 项（累计）**、编辑前读取守卫、`@` 文件引用、凭据落盘加密、跨轮上下文 |
| 渲染   | `npm run smoke:render`                      | **309 项**：用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML 并逐项断言（含工作模式与交互模式各自的编排方式、Markdown 的 LaTeX / 代码块 / mermaid 三条链路、工作区面板的上传入口与文件分类图标、输入区的附件入口与插话按钮、侧栏的引擎分组与工作区开关、工具行的 diff / 任务清单卡、任务统计卡与目标卡、产物汇总卡、表格提取面板）                                                                                                                                                                      |
| 契约   | `npm run smoke:ipc`                         | **504 项**：用 electron 替身把渲染进程会调用的**每个 IPC 通道**真实 invoke 一遍（注册完整性、设置往返、会话生命周期、事件推送、越界与目录穿越拒绝、护栏提示、**命令审批全链路**（弹卡 / 拒绝 / 本次任务全部允许 / auto 档模型审阅 / 四档语义）、**文件收件与工作区上传**、**导出 Word**、**语音转写**、**本地联网搜索**、**配置方案**、**聊天附件**、**定时提醒推进**、**推理强度透传**、**执行中插话**、**任务统计与目标**、**产物汇总**、**表格提取**与模型输出清洗）                                                                                       |
| 安全语料 | `node scripts/guard-corpus.mjs`             | **43 组断言 / 615 条用例**：117 条硬禁、90 条危险、47 条正常写法，250 条 `^` 转义变体与 111 条「词间插 `^`」变体；并自检六张规则表的每条正则都能被语料叫出来、每条用例真的落到该档                                                                                                                                                                                                                                                                   |
| 启动   | `npm run smoke:startup`                     | **150 项**（Windows；其他平台 145 项，见下注）：用 electron 替身跑**真实入口** `src/main/index.ts`，断言单实例锁 → whenReady → 建窗口 → 注册 IPC 依次发生，且 **preload 路径与 index.html 都指向真实存在的文件**、数据目录已建、全程无异常；另有任务栏身份、菜单栏、窗口图标、定时提醒推进的拉起与打包脚本的图标写入断言                                                                                                                                                                  |
| 字符   | `node scripts/check-emoji.mjs src/renderer` | 渲染层不得出现 emoji，也不得出现当图标用的符号（改用 SVG 组件）                                                                                                                                                                                                                                                                                                                                            |
| 全部   | `npm run smoke`                             | 上面四套冒烟 + 安全语料 + 字符扫描（Windows 上共约 1467 项断言）                                                                                                                                                                                                                                                                                                                                       |

`npm run smoke` 把风险最高的内核代码拉到纯 Node 下按真实调用链跑一遍，
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
├── core/         # 业务内核（TypeScript）+ 桌面平台适配层
│   ├── common/   #   提示词、工具注册表、guncat-ui lang、数据管道、diff…
│   ├── model/    #   Message / Conversation / ApiConfig / Agent…
│   ├── service/  #   三协议 SSE、Agent Loop、工具执行、技能、沙箱工作区、
│   │             #   CommandGuard 判定与命令审批链路…
│   ├── export/   #   Docx / Xlsx / Pptx / Svg 生成器与导入器
│   ├── data/     #   StorageManager
│   └── platform/ #   桌面平台适配层：@kit.* 的等价实现
├── main/         # Electron 主进程（窗口、IPC、会话与 Agent Loop 编排）
├── preload/      # contextBridge 安全桥
├── renderer/     # React 界面
└── ipc/          # 主进程 ↔ 渲染进程的共享契约
resources/        # 随包资源：agents.json、智能体提示词、技能库
scripts/          # 无头冒烟验证、命令判定语料与打包脚本
docs/PORTING.md   # 平台适配策略、与鸿蒙版的差异清单
```

## 文档

| 文档                                           | 内容                                      |
| -------------------------------------------- | --------------------------------------- |
| [平台适配与差异说明](docs/PORTING.md)                 | 桌面平台适配层、`@kit.*` 适配对照、**与鸿蒙版的实现差异清单**   |
| [命令安全审计](src/core/service/CommandGuard.ts)   | 威胁模型、六张规则表、四档审批与每一条绕过的理由（源码头部注释即设计文档）   |
| [交互模式实现说明](docs/INTERACTIVE-MODE.md)         | guncat-ui lang 数据流、76 个组件覆盖、容错设计、两层无头验证 |
| [启动排障与兼容模式](docs/STARTUP-TROUBLESHOOTING.md) | 崩溃根因、14 组对照实验、白屏真凶、6 档诊断阶梯、崩溃转储分析       |
| [参与贡献](CONTRIBUTING.md)                      | 环境要求、验证矩阵、编码约定与红线、PR 流程                 |
| [更新记录](CHANGELOG.md)                         | 全部版本变更                                  |

鸿蒙版的研究材料：[open-intelligent-ui 规格](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/open-intelligent-ui-spec.md) ·
[openui-lang 规范](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/openui-lang-spec.md)。

## 隐私说明

- API Key 与应用配置保存在本机用户数据目录（`%APPDATA%\Guncat Work`），由系统凭据保险库加密。
- 聊天请求和附件只会发送到用户配置的模型服务。
- 工作模式的文件读写全部在应用沙箱工作区内完成；**没有额外的权限申请**。
- 命令执行必须经过安全审计：毁灭性操作直接拒绝；需要批准的命令会展示工作目录、风险与命令原文，
  你点拒绝、跳过或超时未答，都按拒绝处理；子进程环境按白名单净化，主进程的密钥不会透传。
- 从命令行参数、第二实例或窗口拖拽收到的文件会进入**沙箱工作区**（由模型用文件工具读取），
  不会自动作为附件送出。
- 网络请求使用 HTTPS，实际数据处理政策以所配置的模型服务商为准。

## 常见问题

遇到问题先看 [启动排障与兼容模式](docs/STARTUP-TROUBLESHOOTING.md)，
涵盖窗口没出现 / 白屏 / 闪退、`-2147483645` 退出码、白屏的真凶、
诊断脚本怎么用、崩溃转储怎么看。

命令为什么被拒 / 为什么要我批准，见 [命令安全审计](src/core/service/CommandGuard.ts)
里的规则表与理由，以及 [Shell 安全审计](#shell-安全审计commandguard) 这一节。

## 贡献

欢迎提交 Issue 和 Pull Request。开发环境、编码约定（含「内核默认不许改」这条硬约束）、
验证矩阵怎么跑、PR 流程 → **[CONTRIBUTING.md](CONTRIBUTING.md)**。

1. Fork 仓库。
2. 创建功能分支。
3. 完成修改，并跑通对应的验证层（改了 `src/core/**` 必须同步补断言，改了命令判定规则必须同步补
   `scripts/guard-corpus.mjs` 与 `scripts/ipc-check.mjs` 的判定层、集成层用例）。
4. 确保 `npm run verify` 通过。
5. 提交 Pull Request，并说明修改内容及验证方式。

## 授权

本项目基于 [Apache License 2.0](LICENSE) 开源，与鸿蒙版采用同一许可证。
