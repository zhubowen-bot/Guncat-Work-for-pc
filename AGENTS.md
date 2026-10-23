# 项目约定

本文件记录人类维护者对 Agent 的长期约定，每轮随运行时快照注入，按此工作。

## 构建与打包

- **每次任务完成后，必须重新打包安装包**：执行 `npm run dist:setup`。
  - 该脚本（`scripts/package-installer.mjs`）默认会先跑 `scripts/build.mjs build` 重新构建 `out/`，再组装 payload、压缩 7z、编译 WPF 安装程序，产物为 `release/Guncat-Work-<version>-setup.exe`。
  - 因此**不要**加 `--skip-build`——那会用旧的 `out/` 打包，源码修复进不去安装包。
- 打包完成后向用户报告产物路径、版本号与体积；打包失败时如实报告失败步骤与原始输出，不要谎报成功。

## 代码与提交

- 使用 git 管理项目。完成任务后提交，提交信息用 `type(scope): 中文摘要` 的形式（如 `fix(command): ...`）。
- 面向用户阅读的交付物用 .docx/.xlsx/.pptx；代码与配置保持源格式。
- `.smoke/`、`.tmp/`、`out/` 等属本地产物，已在 gitignore 内，不要提交。

## 危险命令审批（CommandGuard）

- 判定层在 `src/core/service/CommandGuard.ts`，审批链路在 `src/core/service/CommandService.ts`。
- 改动判定规则后，必须同步在 `scripts/ipc-check.mjs` 补回归用例（判定层 + 集成层各一组），并确保「正常命令不被误伤」。
- 交付前跑 `npm run typecheck:node` 与 `node --check scripts/ipc-check.mjs`。
