# 更新记录

> [← 返回 README](README.md)

本文件记录 Guncat Work（电脑版）的版本变更。电脑版是
[鸿蒙版 Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos)的桌面移植，
两条产品线的版本号**各自独立**。

---

## 0.1.0（首次公开）

首个公开版本。从零到「双击即可用」的全部工作都在这一版里完成。

### 一、移植：鸿蒙业务内核 → 桌面端（阶段一 ~ 三）

- **建立工程骨架**，把上游 `entry/src/main/ets/{common,model,service,export,data}` 的
  **约 3.5 万行** TypeScript 逐字移植到 `src/core/`，保持目录结构与相对 import 路径完全一致。
- **别名替换，而不是改写代码**：平台依赖全部收敛在 `import ... from '@kit.*'` 一行，
  由 `electron.vite.config.ts` 与 `tsconfig.node.json` 解析到 `src/core/platform/kit/` 下的
  桌面等价物（NetworkKit / CoreFileKit / ArkTS / BasicServicesKit / AbilityKit / ArkData /
  ImageKit / PDFKit / PerformanceAnalysisKit）。上游更新时可整体覆盖再重跑类型检查。
- **打通可运行闭环**：Electron 外壳 + 会话与 Agent Loop 编排 + React 界面；
  三协议流式对话（Chat / Responses / Anthropic）进统一的协议适配层。
- **交互模式（阶段二）**：`guncat-ui lang` 渲染器落地 —— 词法 / 语法 / 物化求值 / 围栏切分
  从上游零改动移植，把 ArkUI 的「画」换成 DOM + SVG，覆盖全部 **76 个组件**、
  `$绑定`重算与动作回传。
- **Office 工具链与技能系统（阶段三）**：`write_docx` / `write_xlsx` / `write_pptx` 及读回与
  算子式编辑在桌面端**原样可用**（生成器本身不依赖 ArkUI）；37 项技能按需加载。
- **端侧增强（阶段四）**：朗读改用渲染进程 Web Speech API；语音输入换实现（`MediaRecorder`
  录音 + 服务商 `/audio/transcriptions` 转写）；系统分享接收改为命令行参数 / 第二实例 /
  窗口拖拽；导出回答为 Word（含 LaTeX → OMML 原生公式）。

### 二、平台后端补完（阶段五）

两处「后端缺席」的故障此前都被包装成了「文件损坏」，这一版把它们接上了：

- **PDF 解析**：接上 PDF.js + `@napi-rs/canvas`。此前 `backend === null` 会返回
  「PDF 格式解析失败(文档结构损坏)」，于是**任何** PDF、任何来源都得到同一句话。
- **SVG 栅格化**：改用 `@napi-rs/canvas` 的 `loadImage`（底层 resvg）。
  此前走 Electron 的 `nativeImage`，而它**只解码位图**，喂 SVG 必然失败。
- `run_js` 沙箱从 JSVM-API 换成 `node:vm`：**死循环可以被引擎真正中断**，
  不再需要「放弃等待但后台继续烧 CPU」的兜底。

### 三、补上「内核已移植、但没有任何调用点」的那一批（阶段六）

不是「没实现」，而是「实现了但没人用」—— 这类问题比功能缺失更隐蔽，
因为代码看起来是齐的，用户却会遇到「模型说会提醒，到点什么都不发生」。

- **聊天模式附件**：回形针 + 预览条 + `attachments:pick`；发送路径上真正读文件、
  先行解析、大文件走 Files API。此前加附件等于没加。
- **定时提醒**：每秒推进，到期注入提醒并唤醒工作循环。此前模型会说「5 分钟后提醒你」，
  然后**到点什么都不发生**。
- **产物汇总**：对话流末尾的 Changes 卡（改了哪些文件、各加减多少行）。
- **表格提取**：补上原版唯一不依赖对话的独立工具页；识别结果是模型生成的 HTML，
  主进程按白名单重建后才交给渲染层。
- **插件热加载**：补上此前从未移植的 `PluginHotLoader`，随包清单终于有人读。
- **当前目标卡**、**自动朗读**、**工作区文件预览**、**配置方案（多套 API 配置）**、
  侧栏**引擎分组**、执行中**插话**、工具行的 **diff 卡与任务清单卡**。

同时修掉三处**会真的伤到用户**的缺陷：

| 缺陷 | 后果 | 修法 |
| --- | --- | --- |
| `NetworkKit` 把 `readTimeout` 当整段超时 | 工作模式流式超 5 分钟、聊天超 3 分钟**必然以网络错误中断**，哪怕数据一直在流 | 改成**读空闲**计时（每收到一块数据重置），`connectTimeout` 单独覆盖「未拿到响应头」那一段 |
| 推理强度被写死在主进程 | 工作模式永远拿不到 Max 档，也没法选 Low 提速 | 契约加 `reasoningEffort` + 顶栏档位选择器（按形态分键持久化） |
| 提示词把桌面版描述成手机/鸿蒙应用 | 模型自称「在 HarmonyOS 平台原生构建」、说「无法访问手机其他目录」，mermaid 按手机竖屏排版 | 22 处平台语义改为桌面端措辞 |

### 四、逐项对标审计后的第二轮补齐（阶段七）

阶段六解决的是「内核有能力、没人调用」。阶段七换了方法：**逐文件对照原版的
`@Builder` 参数、守卫条件与状态语义**做一次全量审计，凡是「原版有、桌面端没有或口径不同」
的都记进清单再逐条修。这一轮补出来的大多不是新功能，而是**语义与规格的差异**：

- **会话标题**：首轮交付后用模型起一个不超过 12 字的标题（每会话一次，失败静默）。
  此前 `generateSessionTitle` 已移植但**零调用点**。
- **图片查看**：全屏遮罩灯箱；并修掉 react-markdown 默认 `urlTransform`
  把正文里 `data:` 图片**静默剥掉**的问题。
- **停止 / 上限 / 失败**：在轮次正文末尾追加标注，折叠栏标题改「已停止」。
  此前停止后的回答和「正常答完」一模一样。
- **上下文预算**：三级策略（修剪早期工具结果 → 摘要压缩重建 → 从最旧处裁剪）接入工作循环。
  此前 `WORK_PRUNE_*` / `WORK_COMPACT_*` 常量零调用点，`messages` **只增不减**。
- **工具行**：两种形态、右端多分支状态文案（执行中 / 生成调用中 / 等待中 / 已中断 / 失败 / 耗时）。
- **界面块可交互性**与**回传滚动语义**：区分 `action`（要重算，滚到底）与
  `state`（只本地调参，**不动滚动**）。
- **设置面板**：三块可折叠区、按接入方式变化的占位符与提示、多模态字段整组显隐。
- **统计与详情**：「本轮统计」四行（整数秒 / 字符每秒 / 缓存命中 / 工具调用轮数）+ 会话工作时间。
- **`ask_user_question` 恢复**：工具 + 挂起等待 + 生命周期通知 + 提问卡片 + 回填 + 取消，
  四处同时到位才成立。此前它被下线，改成「一律用默认假设继续」。
- **Mermaid 导图规范从手机竖屏改为桌面宽屏**：结构与分支限制放开、允许 `flowchart LR` /
  `mindmap` / `gantt` / `pie` / `quadrantChart`、可横向滚动。
- 流式光标、思考跑马灯跟随、提示条规格、附件在发送前就被解析、开关与档位的完整语义、
  破坏性操作确认、顶栏模型胶囊、输入区元素顺序与按钮规格、语音门禁。

### 五、桌面外壳、打包与启动

- **自带打包脚本**（`scripts/package-portable.mjs`）按 Electron 标准应用目录结构直接组装，
  产出 `release/Guncat Work-<version>/`：双击 exe 即可用，无需安装、无需命令行。
  不用 electron-builder 的原因很具体：本应用的运行时代码已被 vite 全部打进 `out/`，
  **打包时本来就没有 node_modules 需要收集**，那一步是多余的。
- **产物里固化了一整套入口**：桌面快捷方式、兼容模式启动、提权启动、
  管理兼容性层开关，以及一次跑 6 档的**诊断阶梯**（`diagnose.cmd` / `diagnose.ps1`），
  逐档给出 `VERDICT` 把「同一个白屏」拆成四种不同的故障。
- **启动不再依赖渲染进程**：窗口先显示，白屏 / 闪退不再表现为「双击了没反应」；
  界面改用 `app://` 协议加载，不再走 `file://`。
- **win32 打包态默认带 `--no-sandbox`**：启动第一刻自我重启一次，把参数放到**真实命令行**上。
  崩溃发生在 Chromium 初始化早期，进程内自救来不及 —— 详见
  [启动排障](docs/STARTUP-TROUBLESHOOTING.md)。
- **默认落盘 Chromium 日志**，并在启动日志里留下可核对的里程碑标记。
- **应用图标**取自上游分层图标真正引用的 `cat_avatar.png`；exe 与任务栏不再显示 Electron 默认图标。
- `ELECTRON_RUN_AS_NODE` 在构建前被剔除 —— 它在场时 Electron 以纯 Node 运行，窗口永远不出现。

### 六、工程与验证

- **四套无头冒烟 + 源码级护栏**（内核 / 渲染 / IPC 契约 / 启动链路 + 禁用字符扫描），
  一条 `npm run verify` 跑完全部。设计前提是：**Electron GUI 在开发机上不一定起得来，
  但「元素树 → React 组件树」与整条 IPC 链路在 Node 里可以完整跑通**。
- **构建期两个坑已固化处理**：esbuild 在系统 `TEMP` 建临时文件会报 `Access is denied`，
  现统一把 `TMP`/`TEMP` 指到项目内的 `.tmp`；`npm run build` 走 `scripts/build.mjs` 包装脚本，
  不依赖 cmd/bash 语法。
- **`.cmd` / `.ps1` 一律纯 ASCII 且做字节级校验**：`cmd.exe` 在中文 Windows 上按 GBK 解析批处理，
  UTF-8 中文会把控制流拆坏；PowerShell 5.1 对 `.ps1` 同理。
- 持续集成覆盖类型检查、三端构建与四套冒烟（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。

---

<details>
<summary>完整提交清单（71 个提交，2026-10-14 → 2026-10-15）</summary>

```
1fc50b7 fix(dev): 清掉 ELECTRON_RUN_AS_NODE —— 它在场时 Electron 以纯 Node 运行，窗口永远不出现
0b68fe6 feat(dev): 直接用浏览器打开 dev server 时给出说明页，而不是甩一屏异常
fd0dac6 feat(ui): 正文栏在桌面铺开（对话两侧不再留两条大空白）
87bfa27 fix(ui): 空态文案改回智能体自己的介绍；侧边栏折叠真正收起（不再留一条空白栏）
e97550e fix(ui): 思考栏的展开箭头挪到行尾（原先在最左边和状态图标挤在一起）
9c807b4 fix(ui): 交互模式的活动栏改回「顺着来」—— 思考与工具按发生顺序收进同一条思考栏
c365f0a fix(ui): 真实智能体的图标被 CSS 压成 20px —— 这才是「图标特别小」的真因
683f435 feat(mermaid): 导图规范从「手机竖屏」改为「桌面宽屏」——结构放开、横向可滚动
1ca84dd fix(ui): 思考归位思考栏、折叠栏不再摆摆设；空态图标改回蓝色并按墨迹占比拉齐
602fd43 feat(ask): 恢复 ask_user_question 工具与提问卡片（工具 + 界面 + 回填 + 取消）
6e59b51 feat(ui): 回答不再带底色、思考常显、mermaid 报错静默、语音提示自动消失（用户反馈批次 1/2）
6e70048 fix(mode): 冷启动只设了智能体、没设形态 —— 交互模式被当成聊天模式跑（P0 回归）
9c27676 补齐 Agent Loop 缺口：运行时快照（每轮请求前注入日期/文件树/清单/目标/提醒）
0b96535 fix(chat): 聊天请求失败不能再是「一条空白回答 + 报成功」
a67f606 补齐 Agent Loop 最后两处缺口：聊天模式本机联网搜索多轮 + 交互模式界面补助
4d75a8d feat(interactive): 补上雷达图 —— 内核几何与提示词都早就位，只有渲染层与组件库没有它
6e17610 docs(porting): 补上阶段七（逐项对标审计）与新的平台层改动清单
a202952 补齐 Agent Loop 的上下文预算管理（原版三级压缩此前零调用点）
e0aa377 feat(align): 界面块可交互性的两种口径 + 状态回传不抢滚动（对标缺口批次 6 之三）
731b683 feat(align): 收尾/异常标注与「已停止」语义（对标缺口批次 6 之二）
a41ab0c feat(align): 输入区元素顺序与按钮规格、语音门禁、工作区兜底刷新（对标缺口批次 3/5 收尾）
27ce1dc 设置面板对齐原版 views/SettingsPanel.ets
455bae9 feat(align): 流式光标、思考跑马灯跟随、提示条规格、切会话置底（对标缺口批次 2/6）
f93727f feat(align): 附件在发送前就被解析（对标原版 enqueueFiles / parseOneFile）
870add8 feat(align): 工具行/气泡/侧栏的视觉规格与错误语义（对标缺口批次 2/3）
62ae7e9 feat(align): 统计行与「文本」复制口径对齐原版（对标缺口批次 2 之二）
0fa40c2 feat(align): 图片灯箱 + 修掉「正文里的 data URL 图片被静默剥掉」（对标缺口批次 2 之一）
515fc64 feat(align): LLM 会话标题 + 生成中的发送语义（对标缺口批次 1 收尾）
8b6b759 feat(align): 开关/档位/冷启动的完整语义 + 破坏性操作确认（对标缺口批次 1）
45ba4c1 feat(ui): 顶栏模型胶囊 —— 不进设置就能换模型（审计 P1-6 的另一半）
b27769a feat(plugins): 补上插件热加载（审计 P2-12）—— 内核已会分发，但清单一直没人读
45ec7ed feat(tools): 表格提取可用（审计 P1-3）—— 补上原版唯一不依赖对话的独立工具页
11d4f42 feat(work): 对话流末尾给出产物汇总卡（Codex 风格 Changes，审计 P2-8）
62043ff feat(ui): 工作区面板给出任务统计卡与当前目标卡（审计 P2-10）
8f0d696 feat(ui): 工具行给出 diff 卡片与任务清单卡（审计 P2-9）
6b88d07 feat(work): 执行中插话（审计 P1-4）—— 长任务不必再「中止重来」
37c668e feat(loop): 推理强度可选（工作 Max/High/Low，交互 High/Low/Off）—— 此前被写死在主进程（审计 P1-5）
1a45ad0 feat(ui): 侧栏引擎分组、聊天模式也能看工作区、自动朗读开关（审计 P2-13/14/15 + P3-18）
d24ae44 fix(schedule): 定时提醒真的会响了 —— 补上零调用点的每秒推进（审计 P1-2）
00260b0 fix(prompt): 提示词不再自称鸿蒙手机应用；补全移植补丁清单（审计 P2-11 / P3-16 / P3-17 / P3-19）
11c9477 feat(chat): 附件链路打通 —— 聊天模式终于能把图片/文档发给模型（审计 P0）
6b76c71 fix(net): 读超时改成真正的「读空闲」——长流式不再跑到一半被掐断
7ac2fb5 feat(settings): 配置方案（多套 API 配置）可用 —— 又一条「IPC 齐全、渲染层零调用点」
bca902a feat(settings): 设置面板补齐三处缺口，其中一处一直在静默丢配置
357a5ad feat(core): 平台不再向用户提问 —— ask_user_question 下线，一律改用默认假设
eea6aa2 feat(workspace): 文件可点开预览 —— 补上一条已移植却从没被用过的能力
d807f51 feat(core): PDF 后端与 SVG 栅格化落地 —— 两个「后端缺席」类故障
be08c71 fix(brand): exe 与任务栏不再显示 Electron 默认图标
c774ac0 fix(workspace): 补回「上传」入口 —— 文件导入不再只有隐形的手势
8b173e3 fix(markdown): 让 mermaid、代码块、LaTeX 真的渲染出来
9580bac feat(ui): 对齐原版编排与标识 —— 工作模式逐轮陈列、思考全程流式、去掉交互模式灰蒙层
cbdbf8c fix(release): 补上说明里一直提到、产物里却从没生成过的 create-desktop-shortcut.cmd；清掉会画进界面的第三方箭头符号
3299942 feat(ui): 智能体用回原版头像 —— app:// 增加 /res/ 资源根，不再用字母标代替
351023f feat(ui): 界面按鸿蒙原版还原 —— 会话标题/智能体入口/回合归组/全面去 emoji
8648020 fix(export): 导出 Word 不再报「文件名无效」—— 正文里的换行被当成了文件名
4f3d9bb feat(pack): 把「双击即可用」固化进产物 —— 新增 enable-admin-mode.cmd / disable-admin-mode.cmd
44d65e2 fix(startup): 默认启动即带 --no-sandbox（真实命令行参数），兼容参数收敛为一条
00a031f feat(startup): 自动降级到兼容模式并记住，用户不必再手动带参数或提权
b9da002 fix(diag): 诊断脚本改用 PowerShell 并逐轮隔离用户数据目录；新增兼容模式启动
bb47810 fix(renderer): 界面改用 app:// 协议加载，不再用 file://（白屏的真正嫌疑）
c1a5adf fix(startup): 渲染进程卡死时自动以安全模式重启；并修好被吞掉的渲染控制台日志
9d4c174 fix(window): 窗口不再依赖渲染进程才显示 —— 修掉「双击了没反应」
e725ca7 fix(pack): 换上原项目图标、迁到 npm、修掉构建期临时目录问题、加启动诊断
368712b feat(pack): 让用户双击就能开 —— 自带打包脚本产出独立应用目录
2e0ad95 feat(voice): 语音输入 —— 录音 + 服务商转写；阶段四收官
0ea0dd3 feat(desktop): 阶段四 —— 朗读、文件收件、导出 Word；并补齐 IPC 契约验证
dacbd9c feat(tools): 阶段三 —— Office 工具链与技能系统的端到端验证
c78d008 feat(interactive): 阶段二 —— 交互模式 guncat-ui lang 渲染器
2e0908b docs: 补充验证矩阵与已知环境限制说明
d469e3a feat(app): 打通电脑版可运行闭环 —— Electron 外壳 + 会话编排 + React 界面
cf80694 chore(port): 建立电脑版工程骨架，完成鸿蒙业务内核的逐字移植
```

</details>

---

本项目基于 [Apache License 2.0](LICENSE) 开源。
