# Guncat Work（电脑版）

> 鸿蒙版 [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos) 的桌面移植 ——
> 用 **Electron + React + TypeScript** 复刻的 Agent Harness 客户端。

## 怎么启动

### 给用户：双击就能开

打包一次，然后把整个文件夹拷给对方，**双击里面的 `Guncat Work.exe` 即可**，
不需要装 Node、不需要命令行：

```bash
pnpm install
pnpm dist          # 产出 release/Guncat Work/
```

产物：

```
release/Guncat Work/
├── Guncat Work.exe      ← 双击这个
├── 使用说明.txt
└── resources/           ← 应用代码 + 随包资源（不要单独移动）
```

首次打开后，点左下角「设置」填入接入方式、Base URL、API Key 与模型，即可开始对话。
数据（对话历史、沙箱工作区、配置）存在 `%APPDATA%\Guncat Work`，不在程序目录里。

### 给开发：改代码即时生效

```bash
pnpm install
pnpm dev           # 主进程 + 渲染进程热更新
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

`pnpm dist` 用的是仓库自带的组装脚本，而不是 electron-builder。原因很具体：
本机的 pnpm 依赖收集器拿不到 `pnpm list --json` 的输出，electron-builder 会在打包中途
报 `No JSON content found in output`。而本应用的运行时代码已被 vite 全部打进 `out/`，
**打包时本来就没有 node_modules 需要收集** —— 那一步是多余的。
自带的脚本按 Electron 标准应用目录结构直接组装，结果更可控也更快。

`electron-builder.yml` 保留在仓库里，供将来需要**签名安装包 / 自动更新**时使用。

## 验证

一条命令跑完全部：**`pnpm verify`**（= typecheck + build + smoke）。

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | `src/core`（移植内核）+ `src/main` + `src/preload` + `src/renderer` |
| 构建 | `pnpm build` | main / preload / renderer 三端产物 |
| 内核 | `pnpm smoke:core` | 105 项：智能体加载、45 个工具、37 项技能、沙箱工作区、`run_js` 沙箱、数据管道、持久化、三协议端点、**Office 工具链端到端**（生成→读回→算子编辑）、**技能系统工具**、**交互模式全链路**（解析 / `$绑定`重算 / 动作回传 / 状态尾标记 / 表单打包） |
| 渲染 | `pnpm smoke:render` | 26 项：用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML 并逐项断言 |
| 契约 | `pnpm smoke:ipc` | 55 项：用 electron 替身把渲染进程会调用的**每个 IPC 通道**真实 invoke 一遍（注册完整性、设置往返、会话生命周期、事件推送、越界与目录穿越拒绝、护栏提示、**文件收件**、**导出 Word**、**语音转写配置与端点拼接**） |
| 全部 | `pnpm smoke` | 上面三套一起跑（186 项） |

`pnpm smoke` 把风险最高的移植内核拉到纯 Node 下按真实调用链跑一遍，
并用 esbuild 施加与 `electron.vite.config.ts` **完全相同**的别名规则 ——
验证的是构建产物真实依赖的那套解析规则，而不是另起一套近似配置。

渲染验证的意义：Electron 窗口在本机起不来，但「元素树 → React 组件树」这一段
在 Node 里可以完整跑通（SSR 不执行 `useEffect`，因此不依赖 `ResizeObserver` / `window`），
阶段二最核心的渲染器因此不会只停留在「类型检查通过」。

## 已知环境限制

在某些受限的桌面会话里，Electron 进程会被宿主作业对象拒绝启动
（`electron.exe --version` 直接返回 `STATUS_BREAKPOINT`），此时 `pnpm dev` / `pnpm build`
产出都无法打开窗口。这是宿主环境限制而非代码问题 ——
同一台机器上的其他 Electron 应用可以正常启动。
此时用 `pnpm smoke` 仍然可以完整验证业务内核与界面渲染。

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
