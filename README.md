# Guncat Work（电脑版）

> 鸿蒙版 [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos) 的桌面移植 ——
> 用 **Electron + React + TypeScript** 复刻的 Agent Harness 客户端。

## 两个形态

| 形态 | 对标 | 说明 |
| --- | --- | --- |
| ✦ **交互模式** | GPT 的 Intelligent UI | 一句话直出可操作界面，默认零工具调用、一轮渲染，控件取值即时重算 |
| 🛠 **工作模式** | DeepSeek Harness | 多轮工具循环 + 每会话独立沙箱工作区，长程任务自主执行 |

## 技术栈

- **桌面外壳**：Electron 38
- **界面**：React 19 + TypeScript + Vite（electron-vite）
- **业务内核**：从鸿蒙版**逐字移植**的 TypeScript（约 3.5 万行），平台依赖通过 `@kit.*` 别名替换
- **打包**：electron-builder

## 快速开始

```bash
pnpm install
pnpm dev          # 开发模式（主进程 + 渲染进程热更新）
pnpm typecheck    # 类型检查（core / main / renderer）
pnpm build        # 构建产物到 out/
pnpm smoke        # 无头冒烟验证（44 项，覆盖移植过来的业务内核）
pnpm dist         # 打安装包到 release/
```

首次启动后在左下角「设置」里配置接入方式、Base URL、API Key 与模型。

> 首次 `pnpm install` 后若 Electron 二进制未下载成功（受限网络环境常见），
> 可手动执行：`cd node_modules/electron && node --use-system-ca install.js`

## 验证

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | `src/core`（移植内核）+ `src/main` + `src/preload` + `src/renderer` |
| 构建 | `pnpm build` | main / preload / renderer 三端产物 |
| 内核 | `pnpm smoke:core` | 68 项：智能体加载、45 个工具、37 项技能、沙箱工作区、`run_js` 沙箱、数据管道、持久化、三协议端点、Office 三件套生成、**交互模式全链路**（解析 / `$绑定`重算 / 动作回传 / 状态尾标记 / 表单打包） |
| 渲染 | `pnpm smoke:render` | 26 项：用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML 并逐项断言 |
| 全部 | `pnpm smoke` | 上面两套一起跑 |

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
