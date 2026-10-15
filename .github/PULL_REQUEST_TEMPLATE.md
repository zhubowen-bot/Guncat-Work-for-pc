## 改了什么

<!-- 一两句话说清这个 PR 做了什么。关联的 Issue 请写 "Closes #123"。 -->

## 为什么

<!-- 解决什么问题？为什么用这种做法？ -->

## 验证方式

请勾选你实际**跑过**的项（跑不了就说明原因，别勾没跑过的）：

- [ ] 类型检查：`npm run typecheck`
- [ ] 全部无头冒烟：`npm run smoke`（= build + 内核 + 渲染 + IPC 契约 + 启动链路 + 禁用字符扫描）
- [ ] 只跑了相关的那几套：`npm run smoke:core` / `smoke:render` / `smoke:ipc` / `smoke:startup`
- [ ] 打包产物：`npm run dist`，并双击 `release/Guncat Work/Guncat Work.exe` 实际开一次窗口
- [ ] 界面改动：附改动前后截图

> 改了 `src/core/**` 的移植内核，**必须同步补/改 `scripts/smoke.ts` 的断言** —— 这个仓库的习惯是「修一处缺陷，加一组断言」。
> 改了 `src/ipc/contract.ts`，`scripts/ipc-check.mjs` 会立刻要求对应的处理器与 preload 导出都到位。

## 影响面

- [ ] 改了 `src/core/**` 移植内核（**注意：这会与上游鸿蒙版产生分歧，需登记进 `docs/PORTING.md` 的移植补丁清单**）
- [ ] 改了系统提示词正文（注意：交互模式与工作模式的工具面与行为纪律边界有断言守着）
- [ ] 改了 `src/main/**`（窗口、IPC、会话与 Agent Loop 编排）
- [ ] 改了 `src/renderer/**`（React 界面；**不要引入 emoji 或当图标用的符号**，`check-emoji.mjs` 会拦）
- [ ] 改了 `resources/skills/**` 或 `resources/agents.json` 等随包资源
- [ ] 改了 `scripts/**` 验证脚本
- [ ] 仅文档 / 注释

## 自查

- [ ] 没有引入新的权限、新的网络出口或新的数据落盘位置
- [ ] 没有把 `out/`、`release/`、`.smoke/`、`.tmp/` 等生成物带进提交
- [ ] 提交信息符合仓库约定（`feat(scope): 中文描述`）
