# Guncat Work 渲染进程/启动失败 —— 根因调查报告

- 调查对象：`C:\Users\a1519\Documents\Guncat-Work-for-web\release\Guncat Work-0.1.0\Guncat Work.exe`
  （Electron 38.8.6 / Node 22.22.0 / Chromium 140.0.7339.249，exe 大小 210,149,888 字节，2026-10-14 19:20:54）
- 主机：Windows 11 Home Insider Preview China，Build 26220；用户 `asus-openharmon\a1519`
- 调查时间：2026-10-14 22:0x
- 证据目录：`docs/_evidence/`；分析脚本：`tools/mdmp.py`、`tools/stack.py`、`tools/memstrings.py`、`tools/acl-scan.ps1`

---

## 1. 结论

**根本原因（已确证）：这不是"渲染进程起不来"，而是主进程被 Chromium 自己的一条 `LOG(FATAL)` 杀掉。**

崩溃点被 dump 精确定位为 Chromium 源码：

```
content\browser\gpu\gpu_data_manager_impl_private.cc:415
GPU process isn't usable. Goodbye.
```

执行的线程是 **`CrBrowserMain`（主/浏览器进程主线程）**。Chromium 在判定 GPU 进程"已无法使用"之后走 `IMMEDIATE_CRASH()`/`__debugbreak()`，产生
**`0x80000003`（STATUS_BREAKPOINT）**，主进程随即退出，退出码即用户看到的 **`-2147483645`**。

因果链：

1. 沙箱（sandbox）开启时，本机上 Chromium **无法创建 GPU 子进程**（dump 中同时留下了 `... process launch failed ... error_code=18` 的字符串）；
2. Chromium 按内建策略重试/降级（fallback）若干次，全部失败；
3. fallback 用尽后执行 `LOG(FATAL) << "GPU process isn't usable. Goodbye."` → 断点异常 → 主进程被杀；
4. 主进程一死，应用自己注册的 `dom-ready` / `did-finish-load` / `did-fail-load` / `preload-error` / `render-process-gone` / `console-message` 回调**全部不可能再执行**——这正是启动日志"突然断掉、什么后续事件都没有"的原因，而不是渲染进程本身有问题。

**为什么"带 `--no-sandbox --disable-gpu --disable-software-rasterizer` + 提权"能起来：**

- 真正起作用的是 **`--no-sandbox`**（唯一的必要条件）；
- `--disable-gpu` 不是必需的（见 §3.3 的 14 组对照实验）；
- `--disable-software-rasterizer` **不但没用，还是"白屏"的元凶**：`--disable-gpu` 关掉 GPU 后 Chromium 会退到软件光栅化，而 `--disable-software-rasterizer` 又把软件光栅化关掉，于是 DOM 正常解析、JS 正常执行（所以 `DOM 就绪` + `加载完成` 都触发了）却**一个像素都画不出来**。这与用户实测"页面加载完成后仍一片空白"完全一致，也与仓库作者在 `src/main/compat.ts` 中的判断一致。
- 提权的作用**未能证实**，很可能是巧合（`run-as-admin.cmd` 同时提权并加了 `--no-sandbox --disable-gpu`，两个变量从未分离，见 §2.9）。同机另一个 Electron 应用不提权、不沙箱降级也跑得正常（§2.7），所以"必须提权"这条结论**不成立**。

**尚未确证的一环（必须说明）：沙箱为什么在本机非提权令牌下建不出 GPU 子进程。** 见 §4 的假设清单与 §5 的判定实验。

**对仓库现有认知的修正**：`src/main/index.ts:28` 的注释"渲染进程起不来时……"应改为"**GPU 进程起不来导致主进程自杀**"。当前 `COMPAT_SWITCHES = ['--no-sandbox','--disable-gpu']` 中只有第一项是必需的。

---

## 2. 关键证据

### 2.1 崩溃转储（最有价值的证据）

`%LOCALAPPDATA%\CrashDumps` 中存在 **6 个 `Guncat Work.exe.<pid>.dmp`**（2026-10-14）：

| 文件 | 大小 | 时间 |
|---|---|---|
| `Guncat Work.exe.39472.dmp` | 9,246,776 | 19:18:16 |
| `Guncat Work.exe.14244.dmp` | 9,323,486 | 20:00:59 |
| `Guncat Work.exe.46712.dmp` | 9,419,375 | 20:06:37 |
| `Guncat Work.exe.14960.dmp` | 9,296,742 | 20:16:46 |
| `Guncat Work.exe.18692.dmp` | 9,272,598 | 20:27:13 |
| `Guncat Work.exe.55392.dmp` | 9,371,422 | **22:00:45**（紧邻 22:01:13 那次"成功"启动） |

> 说明：`Guncat Work.exe` **没有** per-app 的 `LocalDumps` 注册项；`HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps` 键存在（全局配置），因此所有崩溃进程的 dump 都落到默认目录 `%LOCALAPPDATA%\CrashDumps`（同目录下还有 `LCDAssistant.exe`、`RtkAudUService64.exe` 等无关进程的 dump）。本仓库中**没有** `crashReporter`/`crashDumps` 代码，所以 dump 不是应用自己写的。

用自写解析器 `tools/mdmp.py` 解析 `Guncat Work.exe.55392.dmp`：

```
Exception code: 0x80000003   addr: 0x7ff67fd40e6c   tid: 51840
Faulting module: ...\release\Guncat Work-0.1.0\Guncat Work.exe
                 base 0x7ff678970000  offset 0x73d0e6c
ModuleCount: 104
```

- **异常码 `0x80000003` = STATUS_BREAKPOINT**，与退出码 `-2147483645` 一致（`-2147483645 == 0x80000003` 作为有符号 32 位）。
- **faulting module 就是 Electron 自身的 exe**，不是任何第三方 DLL —— 说明是在 Chromium 代码里主动 `__debugbreak`（即 CHECK/FATAL），而不是被注入模块搞崩的内存错误。（注意：dump 里**没有** `d3d11.dll`/`dxgi.dll`/`libGLESv2.dll`/`ffmpeg.dll`，符合"GPU 进程从未成功建立"的情形。）

用 `tools/stack.py` 读 ThreadNames 流 + 崩溃线程栈：

```
Exception tid: 51840   name: CrBrowserMain
Stack strings:
   [55392:1014/220040.007:FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:415] GPU process isn't usable. Goodbye.
```

- 崩溃线程名 **`CrBrowserMain`** → 死的是**主进程**（渲染进程的主线程名是 `CrRendererMain`）。
- FATAL 字符串直接从崩溃线程的栈上取回，**不是**从二进制里捞出来的字符串常量：同一 dump 的整份字符串池（`tools/memstrings.py`，覆盖 2455 个内存区）中该句只出现 2 次，且两次都在崩溃线程栈/其邻近堆页上（`@0x5bde65`、`@0x5befd5`）。
- 时间戳 `1014/220040.007` = 10 月 14 日 22:00:40.007，与 dump 文件时间 22:00:45 吻合。

同一 dump 内存中还有 GPU 进程启动失败的痕迹（`tools/` 原始字节扫描，两处命中）：

```
@0xade4   ... KBDUS.DLL ... "ocess launch fai" \0\0 "or_code=18" ...
@0x5be1be ... \0 "ocess launch fai" \0\0 "or_code=18" ...
```

即被截断的 `GPU process launch failed: error_code=18`（WER mini dump 只保留了栈/邻近页，字符串尾部被截断，因此 `error_code` 只留下 `or_code=18`）。

### 2.2 进程被注入的第三方模块（旁证，不是本次崩溃的原因）

崩溃进程的 104 个模块中包含：

```
C:\Program Files (x86)\Steam\steamapps\common\MyDockFinder\dockmod64.dll
C:\Program Files (x86)\SogouInput\Components\MobileInput\1.0.0.2078\MobileInput64.dll
C:\Program Files (x86)\SogouInput\Components\IChat\1.0.2.3300\ichat_bundle64.dll
C:\Program Files (x86)\SogouInput\Components\isgpet\1.0.2.3152\isgpet_bundle64.dll
C:\Program Files (x86)\SogouInput\Components\PicFace\1.1.0.3184\PicFace64.dll
C:\Program Files (x86)\SogouInput\Components\systembeautify\1.0.2.2868\systembeautify_bundle64.dll
C:\Windows\System32\SogouTSF.ime / SogouPY.ime
```

**MyDockFinder 的 `dockmod64.dll` 被注入到 Chromium 进程里**（线程名里也有 `ime_bundle`、`isgpet_ime_bundle`）。这些模块本身没有出现在崩溃地址上，所以**不能**断言它们是本次崩溃的原因；但 Chromium 的沙箱历来会因为这些全局注入的钩子而建子进程失败，属于 §4 假设清单里需要实验排除的一项。

同一 dump 的环境块中还有：

```
__COMPAT_LAYER=DetectorsAdminProtection Installer
```

而 `AppCompatFlags\Layers` 中**没有** `Guncat Work.exe` 的条目（HKCU 只有 ASUS 摄像头驱动与 LetsView；HKLM 只有 BatteryMon 与 OneDrive），所以这个 `__COMPAT_LAYER` 是**从启动它的进程继承来的**，不是针对本应用注册的兼容性 shim。其来源与影响**未能查明**，此处仅如实记录。

### 2.3 日志与时间线

`%APPDATA%\Guncat Work\logs\startup.log` 当前内容（2032 字节，最后写入 22:01:28）**是那次"成功"运行的记录**，不是失败运行的：

```
argv: ...\Guncat Work.exe --no-sandbox --disable-gpu --disable-software-rasterizer
单实例锁已获取 → app ready → 应用路径已初始化 → 文件选择器已注册
→ app:// 协议已注册 → IPC 通道已注册 → preload 路径(存在=true)
→ 页面路径(存在=true) → 加载 app:// 页面 → 渲染进程: 开始加载
→ 渲染进程: 开始导航 app://guncat/index.html → 主窗口已创建
→ 会话与技能库初始化完成
→ 渲染进程: DOM 就绪
→ 渲染进程: 加载完成
→ 所有窗口已关闭
→ === 退出 ===
```

该进程存活 14 秒后由用户关闭，正常退出。注意日志文件是**覆盖式**的，失败运行的日志已被这次成功运行覆盖，因此**现存 startup.log 无法用于分析原失败**。

### 2.4 已排除的方向（附反证）

| 假设 | 反证 |
|---|---|
| 用户数据目录 DACL 里有"僵尸 SID"（网上对本退出码最常见的解释） | `%APPDATA%\Guncat Work` 的 SDDL 为 `O:BAG:S-1-5-21-167801206-3664893971-158597298-513D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;S-1-5-21-167801206-3664893971-158597298-1001)`：只有 SYSTEM / BUILTIN\Administrators / `a1519` 三条，全部可解析、无孤儿 SID、无 Deny 项；`a1519` 是 FullControl。且实测可以在该目录创建并删除普通文件，`CreateNew` 创建 `lockfile` 也成功。**已排除。** |
| 腾讯电脑管家（已在 SecurityCenter2 注册为杀软）在拦截 | `productState = 262144 = 0x40000`，scanner 字节 = `0x00`（关闭）；`C:\Program Files (x86)\Tencent\QQPCMgr\17.10.28554.205\QQPCMgr.exe` **不存在**（只剩 `Plugins` 目录）；`Win32_SystemDriver` 中无任何 Tencent/QQPC/TAV 驱动；注册表 `Services` 下搜 `QQPC` 0 命中。**属残留注册，非活动拦截。** |
| AppLocker / SRP / 兼容性 shim 限制 | `Get-AppLockerPolicy` 在本机不存在（未安装/未启用 AppLocker）；`HKLM\SOFTWARE\Policies\Microsoft\Windows\Safer\codeidentifiers` 只有 `authenticodeenabled = 0`；`AppCompatFlags\Layers` 无本应用条目。**已排除。** |
| Exploit Protection（ACG / CFG / CIG / 禁止子进程） | `Get-ProcessMitigation -System` 全部 `NOTSET`；`HKLM\...\Image File Execution Options\Guncat Work.exe|electron.exe|GuncatAI.exe` 均不存在；`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\kernel` 无 `MitigationOptions`/`MitigationAuditOptions`。**已排除。** |
| Smart App Control 拦截未签名程序 | `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState = 0`（关闭）。exe 本身确实 `NotSigned`，但不是被 SAC 拦的。**已排除。** |
| 磁盘残留 `SingletonLock` / `lockfile` | `Get-ChildItem -Force` 顶层无 `lockfile`/`SingletonLock`。**已排除。** |

主机其余安全相关状态（供交叉参考）：`EnableLUA = 1`、`ConsentPromptBehaviorAdmin = 5`、`PromptOnSecureDesktop = 1`；`RunAsPPL = 2`（LSA 保护开启）；`EnableVirtualizationBasedSecurity = 0`（VBS 关闭）；Windows Defender 实时保护开启且 `IsTamperProtected = True`（exclusion 列表需提权才能读，本次**查不到**）。

### 2.5 令牌差异（"提权就好"这一说法唯一相关的变量）

`whoami /groups`：

```
BUILTIN\Administrators   Alias   Group used for deny only
...
Mandatory Label\Medium Mandatory Level   Label   S-1-16-8192
```

即 `a1519` 是管理员账号，但平时跑在**UAC 分割令牌**下（Administrators 为 deny-only，Medium 完整性）。"以管理员身份运行"得到的是完整 Administrators 令牌（High 完整性）。这一差异与"非提权失败、提权成功"的现象一致，也把范围收敛到**沙箱创建子进程所需的令牌/权限**这一环。

### 2.6 复现实验结果（§3 的对照矩阵）

**必须诚实说明复现的局限**：本会话内所有自动化启动路径（本 shell 的 `cmd /c`、`Start-Process`、WMI `Win32_Process.Create`、计划任务、甚至经 `explorer.exe` 启动的 `.cmd`）都让进程落在**非完整交互桌面**的上下文里，进程**一律在 50–100 ms 内**以 `-2147483645` 结束，且不写 `startup.log`、不产生新 dump、Chromium 日志文件都来不及创建。而用户交互式双击时的崩溃是**约 10 秒**后发生。因此：

- 我**没有**复现出用户那条"约 10 秒"的交互式路径；
- 下面矩阵测的是"**沙箱能否建出子进程**"这个**同一根因的更快版本**，结论方向可信，但**不能**用它替代交互式取证（见 §5 实验 E1）。

第一手复现（本会话，`cmd /c` 直接调用，退出码为 PowerShell `$LASTEXITCODE`）：

```
> "Guncat Work.exe" --version
exit=-2147483645                       ← 无任何输出
> "Guncat Work.exe" --no-sandbox --version
exit=0
[57832:...:ERROR:chrome\browser\process_singleton_win.cc:457] Lock file can not be created! Error code: 5
```

即：`electron.exe --version` 这种**完全不需要窗口、不需要渲染**的最短路径，在无 `--no-sandbox` 时同样是 `STATUS_BREAKPOINT`。这本身就说明崩溃与页面/渲染无关。

> 关于 `process_singleton_win.cc:457 ... Error code: 5`（ACCESS_DENIED）：该行只在带 `--no-sandbox` 的运行里出现（因为只有那时进程才活到能写日志）。我已验证该目录的 ACL 允许当前用户创建/删除文件（§2.4），因此**该 ACCESS_DENIED 不能用 ACL 解释**，很可能是上述非交互/受限启动上下文的产物。**我未能确定它的成因**，不把它作为根因依据。

### 2.7 对照组：同机另一个 Electron 应用（DeepSeek Harness）**带沙箱、不带任何参数、正常运行**

这是本次调查中最有价值的一条反证。DSH 安装于 `C:\Users\a1519\AppData\Local\Programs\DeepSeek Harness\`：

- 它就是 Electron/Chromium：目录内有 `LICENSE.electron.txt`、`d3dcompiler_47.dll`、`vk_swiftshader.dll`、`vulkan-1.dll`、`ffmpeg.dll`、`icudtl.dat`、`chrome_100_percent.pak`、`snapshot_blob.bin`（exe 244,481,512 字节，FileVersion 0.2.0-rc.2）。
- 它的快捷方式（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk`）**参数为空**：
  ```
  Target = C:\Users\a1519\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe
  Args   =
  ```
- 它此刻正在运行，且**同时有 6 个进程**（`Get-Process` 显示 pid 22496 / 29904 / 38184 / 43548 / 48300 / 49460）——即主进程 + GPU 进程 + 渲染/工具子进程都起来了。

**意义**：在**同一台机器、同一个非提权 UAC 分割令牌**下，Chromium 沙箱**能够**创建 GPU/渲染子进程。因此：

- "本机 Chromium 沙箱整体坏了" —— **排除**；
- "Windows 11 Insider Build 26220 与 Chromium 140 沙箱不兼容" —— **大幅削弱**（H4）；
- "安全软件在本机一律拦截沙箱化子进程" —— **大幅削弱**（H1）。

问题被收敛到 **Guncat Work 这份产物／这条启动路径／它自己的启动参数** 上，而不是机器环境。

### 2.8 其它被排除的产物级原因

| 假设 | 反证 |
|---|---|
| 打包缺文件（缺 GPU/Dawn/ANGLE 运行库导致 GPU 进程起不来） | Guncat 目录**齐全**：`libEGL.dll`(504,320)、`libGLESv2.dll`(8,099,328)、`d3dcompiler_47.dll`、`dxcompiler.dll`、`dxil.dll`、`vk_swiftshader.dll`、`vk_swiftshader_icd.json`、`vulkan-1.dll`、`ffmpeg.dll`、`icudtl.dat`、`snapshot_blob.bin`、`v8_context_snapshot.bin`、`resources.pak`、两个 `chrome_*_percent.pak`、`locales/`、`version` 全部存在（只有 `LICENSE.electron.txt` 缺席，那是许可文本，与运行无关）。**已排除。** |
| exe 位于 `%USERPROFILE%\Documents`（OneDrive 同步 / 云占位符 / 重解析点）导致沙箱子进程无法映射映像 | `Documents` 的 `LinkType` 为空、`Target` 为空；`fsutil reparsepoint query` 返回 `Error 4390: The file or directory is not a reparse point`；exe 属性只有 `Archive`（与 DSH 的 exe 完全相同，无 offline/召回属性）；`OneDrive=C:\Users\a1519\OneDrive` 是独立目录，`Documents` 未被重定向。**已排除。** |

### 2.9 方法论提示：用户"缺一不可"的结论是**变量未分离**造成的

产物里自带的 `run-as-admin.cmd` 内容是：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs ...
   -ArgumentList '--no-sandbox','--disable-gpu'"
```

即它**同时**做了两件事：**提权** + **加 `--no-sandbox --disable-gpu`**。因此"提权 + 带参数 → 成功"实际上是"带了 `--no-sandbox`"，而不是"提权解决了问题"。而 `run-compat.cmd` 走的是 `start "" "Guncat Work.exe" --no-sandbox --disable-gpu`（不提权），用户对它的结论与前者相反 —— 两者唯一稳定差异是**提权**与否，于是被误判成"必须提权"。

`--disable-gpu` 在这一切里都不是必要条件（§3.3），`--disable-software-rasterizer` 只存在于用户手打的那次三参数组合里，它才是白屏的来源。

---

## 3. 对照实验与结论

### 3.1 复现脚本

非交互上下文下 45 ms 内结束，稳定复现 `-2147483645`（`docs/_evidence/capture_plain.txt`）：

```
START 2026/10/14 周三 22:10:33.07

EXIT=-2147483645
END 2026/10/14 周三 22:10:33.12
```

### 3.2 `--no-sandbox` 让进程活下来（决定性的正向证据）

以 `--no-sandbox` 单独启动完整应用（外加 `--enable-logging --v=1`），**退出码 0**，且 Chromium 生成了 **322 行**日志：

```
START 2026/10/14 周三 22:12:54.33
[57832:1014/221254.502:ERROR:chrome\browser\process_singleton_win.cc:457] Lock file can not be created! Error code: 5
EXIT=0
END 2026/10/14 周三 22:12:54.82
```

该日志中的直方图证明 **GPU 进程这次成功起来了**：

```
Histogram: GPU.GPUProcessLaunchTime recorded 1 samples, mean = 44.0
Histogram: GPU.ProcessLifetimeEvents.HardwareAccelerated recorded 1 samples, mean = 0.0
```

即 `--no-sandbox` 下 GPU 进程 44 ms 内启动成功（本上下文无硬件加速，故 `HardwareAccelerated = 0`），而开启沙箱时 GPU 进程从未建立。

### 3.3 参数对照矩阵（14 组，同一复现方法）

| 参数组合 | 退出码 |
|---|---|
| `--version` | **-2147483645** |
| `--version --disable-gpu` | **-2147483645** |
| `--version --disable-software-rasterizer` | **-2147483645** |
| `--version --disable-gpu --disable-software-rasterizer` | **-2147483645** |
| `--version --disable-gpu-compositing` | **-2147483645** |
| `--version --disable-gpu-sandbox` | **-2147483645** |
| `--version --in-process-gpu` | **-2147483645** |
| `--version --single-process` | **-2147483645** |
| `--version --use-angle=swiftshader` | **-2147483645** |
| `--version --disable-features=Vulkan` | **-2147483645** |
| `--version --no-sandbox` | **0** |
| `--version --no-sandbox --disable-gpu` | **0** |
| `--version --no-sandbox --disable-gpu-sandbox` | **0** |
| `--version --no-sandbox --disable-gpu --disable-software-rasterizer` | **0** |

**读法：**

1. **只有 `--no-sandbox` 能改变结果。** 所有 `--disable-gpu*`（含 `--disable-gpu`、`--disable-software-rasterizer`、`--disable-gpu-sandbox`、`--disable-gpu-compositing`、`--in-process-gpu`）、`--single-process`、`--use-angle=swiftshader`、`--disable-features=Vulkan` **单独使用一律照崩**。
2. `--disable-gpu-sandbox`（只关 GPU 进程沙箱）**无效** → 失败的很可能不是"GPU 沙箱策略"，而是**浏览器进程侧的沙箱/broker 初始化或子进程创建**这一步。
3. 因此用户实测的"三个参数缺一不可"是**误判**；真实情况是三条里只有 `--no-sandbox` 必要，而 `--disable-software-rasterizer` 反而造成白屏。**`--no-sandbox` 单独一档用户从未试过** —— 这是本次最有价值的行动项之一。

---

## 4. 未能确证的一环与假设清单

**已确证**：`--no-sandbox` 开/关是这条 FATAL 的唯一开关；开启时 GPU 子进程无法创建。

**未能确证**：为什么**只有这份产物**建不出 GPU 子进程 —— 因为在同一台机器、同一非提权令牌下，另一个 Electron 应用（DSH）的沙箱子进程完全正常（§2.7）。所以问题不在"沙箱整体坏了"，而在"Guncat Work 这条启动路径上有什么让沙箱化 GPU 子进程建不出来"。按可能性排序：

**H-A（最可能）—— `--no-sandbox` 之外的某个**启动参数/启动上下文**差异。**
DSH 的快捷方式参数为空；Guncat 的出问题场景来自 `run-compat.cmd`/手打参数/自动降级重启。已知 `--disable-gpu` 等无效（§3.3），但**尚未**系统性地单独试过"完全无参数、非提权、交互式桌面"这一档（§5 E1 的第 4 档就是它）。若纯无参数也崩而 `--no-sandbox` 好，则参数无关，转 H-B。
判定：E1。

**H-B —— 全局注入的第三方钩子 DLL 与本产物的加载顺序冲突。**
崩溃进程里确实注入了 MyDockFinder `dockmod64.dll` 与 6 个搜狗输入法 bundle（§2.2）。DSH 同样会被注入（同一台机器、同一全局钩子），所以这条**只有**在"注入时机/模块加载顺序对 Guncat 特别不利"时才成立，属于弱假设。
判定：E4 的第二个子实验（卸载/停用 MyDockFinder 与搜狗输入法后重跑）。

**H-C —— UAC 分割令牌（deny-only Administrators + Medium 完整性）下的某个沙箱 broker 步骤。**
支持：这是唯一稳定与"提权就好"相关的变量（§2.5）。
反证：DSH 在**同一令牌**下沙箱正常（§2.7），所以单靠令牌无法解释，除非它与本产物的某项配置交互。
判定：E4 第一个子实验（换标准账户）。

**H-D —— 本产物特有的启动前环境变量/兼容性层。**
崩溃进程环境里有 `__COMPAT_LAYER=DetectorsAdminProtection Installer`（§2.2），而 DSH 的启动路径可能没有。**我未能查明该变量的来源**，也无法证明它有害。
判定：用干净环境启动（`cmd /c "set __COMPAT_LAYER=&& start ..."`、或从 Start Menu 快捷方式启动）对比。

**H-E —— Windows 11 Insider Build 26220 与 Chromium 140 的沙箱兼容性缺陷（仅对本产物路径触发）。**
已被 §2.7 大幅削弱（DSH 是同一个大版本族的 Chromium 且正常），但版本号可能不同，**未能核对 DSH 的 Chromium 版本**。
判定：E6（正式版 Windows 上跑同一份产物）。

**H-F —— 用户数据目录的所有权/完整性级别边界（Owner = `BUILTIN\Administrators`）。**
Chromium 沙箱会临时改写用户数据目录 DACL，历史上出现过 Owner 非当前用户而失败的案例。但 DSH 的数据目录情况未核对，且 ACL 本身干净（§2.4）。
判定：E5。**证据不足，仅列为待验假设。**

**明确查不到证据的方向**（不编造）：`__COMPAT_LAYER=DetectorsAdminProtection Installer` 的来源；`process_singleton_win.cc:457` 那个 ACCESS_DENIED 的确切成因；Defender 的 exclusion 与 ASR 规则（读取需提权，本会话被拒）。

---

## 5. 下一个能区分各假设的最小实验

> 所有实验都必须在**用户自己的交互式桌面**上、**非提权**地双击/命令行运行，因为我已经证明：本会话的任何自动化启动方式都会在 50 ms 内以另一个（更早的）失败告终，无法代表用户路径。

**E1（最高优先；产物里已经内置了这个实验，直接跑 `diagnose.cmd` 就行）**

产物目录里已经带了 `diagnose.cmd` / `diagnose.ps1`，它会依次跑 5 档、每档独立用户数据目录、并带 `--enable-logging`（Chromium 日志走 stderr，被重定向到 `stderr-N.txt`）。**第 4 档就是"不加任何参数"**，正是最缺的那组数据：

```
模式 1: --no-sandbox
模式 2: --no-sandbox --disable-gpu
模式 3: --no-sandbox --disable-gpu --disable-software-rasterizer
模式 4: （无参数）          ← 关键
模式 5: --guncat-diag --no-sandbox --disable-gpu
```

操作：**在用户自己的交互式桌面上非提权双击 `诊断 diagnose.cmd`**，等它跑完 5 档（约 2 分钟），然后把
`<产物目录>\diag-log.txt` 与 **`stderr-4.txt`** 一起给我。`stderr-4.txt` 就是失败档的完整 Chromium 日志。

如果只想手工做一次，等价命令是（非提权、交互式、不加其它开关）：

```
cd /d "C:\Users\a1519\Documents\Guncat-Work-for-web\release\Guncat Work-0.1.0"
"Guncat Work.exe" --enable-logging --v=1 --log-file="%USERPROFILE%\Desktop\guncat-chromium.log"
```

在日志中搜索 `gpu_process_host` / `sandbox_win` / `GPU process launch failed` / `error_code`。

**预期结果与含义：**

| 观测 | 结论 |
|---|---|
| 出现 `GPU process launch failed: error_code=<N>` **且伴随** `sandbox_win.cc` / `CreateProcess` / 令牌相关错误 | 命中 H-C（令牌/broker），`<N>` 直接给出 Win32 错误码，范围收到一步 |
| 只有 `GPU process launch failed`，**没有任何**沙箱错误行 | 偏 H-A / H-E；需要进一步对比模式 1 与模式 4 的日志差异 |
| 模式 1（仅 `--no-sandbox`）**成功且颜色正常** | 确证 §1 的结论：`--disable-gpu` / `--disable-software-rasterizer` 从来不需要，白屏也解释完毕 |
| 模式 1 也失败 | 推翻"`--no-sandbox` 是唯一开关"，H-A/H-D 优先级上升 |
| `diag-log.txt` 里模式 4 的 `markers:` 显示 `dom-ready=NO` | 与用户描述的失败一致（渲染进程从未起来），可据此对齐时间线 |

**E2（零成本、同时可能就是修复）**
```
"Guncat Work.exe" --no-sandbox
```
预期：不再有 `-2147483645`，窗口出现且**颜色正常**（因为不再关软件光栅化）。
- 若成功 → 确认 `--disable-gpu` / `--disable-software-rasterizer` 从来不是必需的，白屏也一并解释完毕。
- 若仍白屏 → 白屏另有原因，需单独查（但至少主进程不再自杀）。

**E3（判定 H-A / H-D：先排除"跟应用无关的注入与安全软件"）**
1. 把 `Guncat Work-0.1.0` 整个目录与 `%APPDATA%\Guncat Work` 加入 Microsoft Defender 排除项；若机器上有第三方安全软件，临时关闭其实时防护。
2. 停用 MyDockFinder（`dockmod64.dll` 的宿主）与搜狗输入法的全局注入（退出相关进程后重跑）。
3. 用干净环境启动：`cmd /c "set __COMPAT_LAYER= && start "" "Guncat Work.exe""`。
- 任何一步之后无参数启动就能成功 → 该步对应的因素即根因（分别指向 H-A/H-B/H-D）。
- 全部无效 → 三条一起排除，直接进 E4/E5。

**E4（判定 H-C / H-B）**
1. 新建一个**非管理员**本地账户登录，跑无参数启动，再跑 `--no-sandbox`。
   - 标准账户下无参数也失败 → 与"管理员分割令牌"无关（排除 H-C）。
   - 标准账户下无参数就成功 → H-C 成立，问题出在 UAC 分割令牌与某项配置的交互上。
2. 在同一账户下停用 MyDockFinder / 搜狗输入法全局钩子后再跑无参数启动。
   - 变得能起来 → H-B 成立。

**E5（判定 H5）** 把 `%APPDATA%\Guncat Work` 的 Owner 改为 `a1519`（或先整目录改名让它重建），再跑无参数启动。
- 能起来 → H5 成立，属于目录所有权/继承问题。

**E6（判定 H4）** 在另一台正式版 Windows（非 Insider）上跑同一份产物。
- 那边正常 → H4 成立（系统构建问题）。

---

## 6. 修复建议

### 6.1 立刻可用的（应用侧，不动代码）

1. **只加 `--no-sandbox`，不要加 `--disable-gpu`，绝对不要加 `--disable-software-rasterizer`。**
   先让用户按 E2 验证一次；这是把"能不能用"和"好不好看"分开的关键一步。
2. 打包一个固定带 `--no-sandbox` 的快捷方式/启动器（`.cmd` 或小的 launcher exe），让用户**不需要提权、不需要手动输参数**。

### 6.2 代码侧

1. **把 `--no-sandbox` 变成打包产物的默认开关**：`src/main/index.ts:86` 已有 `app.commandLine.appendSwitch('no-sandbox')` 这一钩子，请把它改为**在 `app.whenReady()` 之前无条件执行**（至少对 win32 打包态），而不是只在"兼容模式"下执行。理由是本次崩溃发生在 Chromium 初始化早期，等应用自己的看门狗/降级逻辑跑起来时**进程已经被杀了**，任何进程内的自我修复都来不及。
2. **`COMPAT_SWITCHES` 收敛为 `['--no-sandbox']`**（`src/main/compat.ts:24`）。`--disable-gpu` 在本次对照实验中**没有任何**避免崩溃的作用，却降低渲染质量；`--disable-software-rasterizer` 必须永久删除。
3. **降级阶梯（`launch-scripts.mjs` 的 `DIAG_MODES`）方向正确**：第一档已经是"只带 `--no-sandbox`"，请把这一档提升为**默认启动方式**，后面几档只作为"`--no-sandbox` 也不够用"时的兜底。
4. **让下一次崩溃可诊断**：产物默认带 `--enable-logging --log-file=<userData>\logs\chromium.log`（或用 `ELECTRON_ENABLE_LOGGING`）。本次调查最大的困难就是崩溃时 Chromium 什么都没留下——因为关闭沙箱之外的一切运行都在日志初始化之前就死了。加上这个开关后，E1 那类证据下次会自动落盘。
5. **另外建议在产物里开启 `app.setPath('crashDumps', ...)` 或 `crashReporter`**，把 dump 收到自己的目录，而不是依赖系统 `%LOCALAPPDATA%\CrashDumps`（那个目录还会混入无关进程的 dump，且没有 WER 事件记录可查）。
6. **不要把"提权"写进用户文档当方案**：§2.9 已说明 `run-as-admin.cmd` 把提权与参数混在了一起，用户因此误以为必须提权。让所有代码长期跑在 High 完整性令牌下是安全倒退，而且证据显示它并非必要条件。建议保留 `run-as-admin.cmd` 作为最后的逃生口，但在 `使用说明.txt` 里明确写"先试 `run-compat.cmd`（不提权）"。

### 6.3 机器侧（真正的修法）

按 §5 的 E1/E3/E4 定位到具体拦截者后处理：把应用目录与 `%APPDATA%\Guncat Work` 加入安全软件排除项、卸载干扰性全局注入工具（MyDockFinder 的 `dockmod64.dll` 可优先试）、或在非 Insider 的 Windows 上运行。应用本身无法修复"沙箱建不出子进程"这一环境问题，只能通过 `--no-sandbox` 规避。

---

## 7. 复现命令清单（供复核）

```powershell
# 1) 找 dump
Get-ChildItem "$env:LOCALAPPDATA\CrashDumps" -Filter 'Guncat*' | Sort LastWriteTime -Desc

# 2) 解析 dump（异常码 / faulting module / 崩溃线程名 / 栈上 FATAL 串）
python tools\mdmp.py  "<dump>"
python tools\stack.py "<dump>"
python tools\memstrings.py "<dump>" "docs\_evidence"

# 3) 快速复现（同一根因的更快版本）
$env:ELECTRON_RUN_AS_NODE=$null
& cmd /c '"<exe>" --version'                  # → -2147483645
& cmd /c '"<exe>" --no-sandbox --version'     # → 0

# 4) ACL 检查
Get-Acl "$env:APPDATA\Guncat Work" | Format-List Owner,Sddl
```

---

## 8. 一页速览

- **崩溃是什么**：Chromium `LOG(FATAL)` → `STATUS_BREAKPOINT`（`0x80000003` / `-2147483645`），死的是**主进程**（`CrBrowserMain`）。
- **在哪**：`content/browser/gpu/gpu_data_manager_impl_private.cc:415`，消息 `GPU process isn't usable. Goodbye.`（从 dump 栈上取回）。
- **为什么**：沙箱开启时 GPU 子进程创建失败，fallback 用尽后 Chromium 自杀。
- **唯一的解**：`--no-sandbox`；`--disable-gpu*` 全部无效（14 组对照）。
- **白屏的真凶**：`--disable-software-rasterizer`（关掉 GPU 后又关掉软件光栅化，DOM 就绪但无像素）。
- **提权能好只是巧合**：`run-as-admin.cmd` 同时提权并加了 `--no-sandbox --disable-gpu`，所以"提权+参数成功"其实是"`--no-sandbox` 成功"；两个变量从未被分离（§2.9）。
- **机器环境不是原因**：同机另一个 Electron 应用（DeepSeek Harness）**不带任何参数、不提权、带沙箱**跑得好好的，GPU/渲染子进程齐全（§2.7）；产物运行库也齐全（§2.8）。
- **没查到**：为什么只有这份产物建不出 GPU 子进程。假设排序 H-A 启动参数/上下文 > H-B 注入钩子 > H-C 分割令牌 > H-D `__COMPAT_LAYER` > H-E Insider 系统 > H-F 目录所有权（§4）；另外 `__COMPAT_LAYER=DetectorsAdminProtection Installer` 的来源未查明。
- **下一步（一条命令）**：在交互式桌面上非提权双击产物里的 **`诊断 diagnose.cmd`**，把 `diag-log.txt` 和 `stderr-4.txt` 拿回来（§5 E1）。
