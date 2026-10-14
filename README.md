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
pnpm dist         # 打安装包到 release/
```

> 首次 `pnpm install` 后若 Electron 二进制未下载成功（受限网络环境常见），
> 可手动执行：`cd node_modules/.pnpm/electron@*/node_modules/electron && node --use-system-ca install.js`

## 目录结构

```text
src/
├── core/         # 鸿蒙版业务内核（逐字移植）+ 平台适配层
├── main/         # Electron 主进程（窗口、IPC、服务编排）
├── preload/      # contextBridge 安全桥
└── renderer/     # React 界面
resources/        # 随包资源：agents.json、智能体提示词、技能库
docs/PORTING.md   # ★ 移植策略、平台适配对照、与上游的分歧清单
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [移植说明](docs/PORTING.md) | 移植策略、`@kit.*` 适配对照、移植补丁清单、阶段四计划 |

## 授权

[Apache License 2.0](LICENSE)
