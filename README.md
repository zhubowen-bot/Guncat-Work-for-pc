# Guncat Work（电脑版）

> 鸿蒙版 [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos) 的桌面移植 ——
> 用 **Electron + React + TypeScript** 复刻的 Agent Harness 客户端。

## 怎么启动

> 本项目用 **npm**（不是 pnpm）。装依赖：`npm install`

### 给用户：双击就能开

打包一次，然后把整个文件夹拷给对方，**双击里面的 `Guncat Work.exe` 即可**，
不需要装 Node、不需要命令行：

```bash
npm install
npm run dist       # 产出 release/Guncat Work/
```

产物：

```
release/Guncat Work/
├── Guncat Work.exe            ← 双击这个
├── 创建桌面快捷方式.cmd        ← 想放桌面就双击一次（带应用图标）
├── 诊断启动.cmd                ← 起不来时双击它，会留下日志
├── 使用说明.txt
└── resources/                 ← 应用代码 + 随包资源（不要单独移动）
```

首次打开后，点左下角「设置」填入接入方式、Base URL、API Key 与模型，即可开始对话。
数据（对话历史、沙箱工作区、配置）存在 `%APPDATA%\Guncat Work`，不在程序目录里。

**如果双击后窗口没有出现**：双击 `诊断启动.cmd`，它会带日志启动并留下两份日志 ——
程序目录下的 `启动日志.txt`（Electron 自身输出与退出码）与
`%APPDATA%\Guncat Work\logs\startup.log`（应用逐里程碑的启动日志）。
把这两份发出来即可定位。

### 给开发：改代码即时生效

```bash
npm install
npm run dev        # 主进程 + 渲染进程热更新
```

## 两个形态

| 形态 | 对标 | 说明 |
| --- | --- | --- |
| ✦ **交互模式** | GPT 的 Intelligent UI | 一句话直出可操作界面，默认零工具调用、一轮渲染，控件取值即时重算 |
| 🛠 **工作模式** | DeepSeek Harness | 多轮工具循环 + 每会话独立沙箱工作区，长程任务自主执行 |
| 聊天模式 | — | 纯对话，不带沙箱工作区 |

## 技术栈

- **桌面外壳**：Electron 38（应用代码用 vite 全量打进 `out/`，产物**没有运行时 node_modules**）
- **界面**：React 19 + TypeScript + Vite（electron-vite）
- **业务内核**：从鸿蒙版**逐字移植**的 TypeScript（约 3.5 万行），平台依赖通过 `@kit.*` 别名替换
- **打包**：自带的 `scripts/package-portable.mjs`（见下方「关于打包」）

### 关于打包

`npm run dist` 用的是仓库自带的组装脚本，而不是 electron-builder。原因很具体：
electron-builder 的 pnpm 依赖收集器拿不到 `pnpm list --json` 的输出，会在打包中途
报 `No JSON content found in output`。而本应用的运行时代码已被 vite 全部打进 `out/`，
**打包时本来就没有 node_modules 需要收集** —— 那一步是多余的。
自带的脚本按 Electron 标准应用目录结构直接组装，结果更可控也更快。

唯一的例外是 PDF 后端：`pdfjs-dist` 与 `@napi-rs/canvas`（原生 `.node`）都不能进 bundle
（前者内部有 worker / wasm / 字体的动态路径，后者根本打不进），因此它们由组装脚本
手工拷进 `resources/app/node_modules/`，PDF 的标准字体 / CMap / wasm 解码器拷进
`resources/resources/pdfjs/`。缺任何一块都不会「报文件损坏」：文本抽取退化成缺字体度量，
渲染退化成一条明确的「缺渲染后端」提示。见 `src/core/platform/native/pdfBackend.ts`。

`electron-builder.yml` 保留在仓库里，供将来需要**签名安装包 / 自动更新**时使用。

### 关于构建期的两个坑（已固化处理）

1. **esbuild 的临时目录**：Windows 上 esbuild 会在系统 `TEMP` 里建临时文件再删除，
   本机环境下这一步会报 `Access is denied`，构建在 `vite:esbuild-transpile` 阶段直接失败。
   现在统一把 `TMP/TEMP` 指到项目内的 `.tmp`（见 `scripts/esbuild-aliases.mjs`
   与 `scripts/build.mjs`）。**这很可能也是之前 pnpm 反复报错的同源原因。**
2. **构建入口**：`npm run build` 走 `scripts/build.mjs` 包装脚本而不是直接调 `electron-vite`，
   为的就是在启动子进程前把上面的临时目录设好；用 Node 包装而不是 `set TMP=... &&`，
   是为了不依赖 cmd/bash 语法。

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
| 内核 | `npm run smoke:core` | 105 项：智能体加载、45 个工具、37 项技能、沙箱工作区、`run_js` 沙箱、数据管道、持久化、三协议端点、**Office 工具链端到端**（生成→读回→算子编辑）、**技能系统工具**、**交互模式全链路**（解析 / `$绑定`重算 / 动作回传 / 状态尾标记 / 表单打包） |
| 渲染 | `npm run smoke:render` | 26 项：用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML 并逐项断言 |
| 契约 | `npm run smoke:ipc` | 55 项：用 electron 替身把渲染进程会调用的**每个 IPC 通道**真实 invoke 一遍（注册完整性、设置往返、会话生命周期、事件推送、越界与目录穿越拒绝、护栏提示、**文件收件**、**导出 Word**、**语音转写配置与端点拼接**） |
| 启动 | `npm run smoke:startup` | 19 项：用 electron 替身跑**真实入口** `src/main/index.ts`，断言单实例锁 → whenReady → 建窗口 → 注册 IPC 依次发生，且 **preload 路径与 index.html 都指向真实存在的文件**、数据目录已建、全程无异常 |
| 全部 | `npm run smoke` | 上面四套一起跑（205 项） |

`npm run smoke` 把风险最高的移植内核拉到纯 Node 下按真实调用链跑一遍，
并用 esbuild 施加与 `electron.vite.config.ts` **完全相同**的别名规则 ——
验证的是构建产物真实依赖的那套解析规则，而不是另起一套近似配置。

渲染验证的意义：Electron 窗口在本机起不来，但「元素树 → React 组件树」这一段
在 Node 里可以完整跑通（SSR 不执行 `useEffect`，因此不依赖 `ResizeObserver` / `window`），
阶段二最核心的渲染器因此不会只停留在「类型检查通过」。

## 已知环境限制

**本机的 Electron 二进制无法启动任何 GUI 进程**：`electron.exe --version` 直接返回
`STATUS_BREAKPOINT`（同一个二进制在别处可用，已核对过文件大小与重新下载后的副本一致，
因此不是二进制损坏）。这意味着在本会话里 `npm run dev` 与打包产物都打不开窗口 ——
是宿主进程环境的限制，不是代码问题；同一台机器上的其他 Electron 应用运行正常。

为此启动链路与 IPC 契约都做了无头验证（见上表「启动」「契约」两行），
并且应用会在 `%APPDATA%\Guncat Work\logs\startup.log` 逐里程碑写启动日志，
产物里也附了 `诊断启动.cmd`。

## 目录结构

```text
src/
├── core/         # 鸿蒙版业务内核（逐字移植）+ 平台适配层
├── main/         # Electron 主进程（窗口、IPC、会话与 Agent Loop 编排）
├── preload/      # contextBridge 安全桥
├── renderer/     # React 界面
└── ipc/          # 主进程 ↔ 渲染进程的共享契约
resources/        # 随包资源：agents.json、智能体提示词、技能库
scripts/          # 无头冒烟验证
docs/PORTING.md   # ★ 移植策略、平台适配对照、与上游的分歧清单
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [移植说明](docs/PORTING.md) | 移植策略、`@kit.*` 适配对照、移植补丁清单、阶段四计划 |
| [交互模式实现说明](docs/INTERACTIVE-MODE.md) | guncat-ui lang 数据流、76 个组件覆盖、容错设计、两层无头验证 |

## 授权

[Apache License 2.0](LICENSE)
