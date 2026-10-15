# 安装程序（Guncat Work Setup）

一条命令产出**单文件**安装包：

```bash
npm run dist:setup
# → release/Guncat-Work-<版本>-setup.exe
```

双击即可安装；装完出开始菜单项与桌面快捷方式，并在「设置 → 应用 → 已安装的应用」里登记，
自带卸载程序。**全程不需要管理员权限**（默认装到 `%LOCALAPPDATA%\Programs\Guncat Work`）。

---

## 为什么不用 electron-builder 的 nsis 目标

仓库里那份 `electron-builder.yml` 是为「便携 + NSIS」写的，但这条路在本项目上走不通：

1. **界面。** electron-builder 的 NSIS 用的是标准 Win32 向导（下一页/上一步那一套），
   要改成圆角、渐变、自定义配色的现代界面，得换第三方皮肤插件（nsNiuniuSkin 之类），
   投入大、不可控，而且那类插件基本只在 32 位 ANSI 版 NSIS 上验证过。
2. **它在本机根本跑不到打包那一步。** 收集 node_modules 时 `app-builder-lib` 会用管道
   捕获子进程输出，而本机环境（受限令牌/沙箱）下 `spawn` 直接 `EPERM`。
   而本应用的运行时代码已被 vite 全部打进 `out/`，**没有任何依赖需要收集** —— 这一步本就是多余的。

于是安装程序改成用 **Windows 自带的 csc.exe 编译的 WPF 程序**：界面随便画，产物是单个 exe，
不需要任何第三方运行时。

## 它由哪几块拼成

```
release/Guncat-Work-<版本>-setup.exe
├── 安装程序界面 + 安装逻辑   installer/src/*.cs            （WPF，运行期 XamlReader 解析 XAML）
├── 应用本体                  payload.7z                    （与 npm run dist 的便携目录逐字节相同）
├── 解压器                    7za.exe                       （构建时从 electron-builder 缓存里取）
└── 卸载程序                  uninstall.exe                 （装完后释放到安装目录）
```

* **载荷**：`scripts/package-portable.mjs` 组装的便携目录，一字不改地压成 `payload.7z`（LZMA2）。
  这么做保证「装出来的」和「绿色版」永远是同一份文件，不会出现两份产物各自漂移。
* **7za.exe**：安装时用它解压。为什么不用 .NET 自带的 `ZipFile`：整包 380+ MB，
  deflate 与 LZMA2 的体积差在 60 MB 量级，解压速度也差好几倍。
  构建脚本按 `installer/vendor/7za.exe` → `%LOCALAPPDATA%\electron-builder\Cache\7zip@*\…\bin\7za.exe`
  的顺序查找。
* **卸载程序**：独立编译的小 exe，留在安装目录里。运行时会先把自己复制到 `%TEMP%` 再执行 ——
  它就在要删的那棵树里，Windows 不允许删除正在运行的映像（NSIS / Inno 用的也是这一套）。

## 安装时都做了什么

1. 校验目标目录与剩余空间；
2. 把内嵌的 `payload.7z` 与 `7za.exe` 释放到 `%TEMP%`，用 7za 解压到安装目录（带进度、速度、剩余时间）；
3. 释放 `uninstall.exe`；
4. 创建快捷方式（桌面 / 开始菜单，含「卸载 Guncat Work」）；
5. 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Guncat Work`
   —— 即「应用和功能」里的那一项，包含 `UninstallString` / `QuietUninstallString` / `EstimatedSize`；
6. **可选**：给 exe 挂 `RUNASADMIN` 兼容层（`AppCompatFlags\Layers`）。默认不勾，
   本机排查表明「双击没反应」时需要它，见 `docs/STARTUP-TROUBLESHOOTING.md`。

只要目标目录能写就装得上；快捷方式或注册表写失败**不会**中断安装，只会记进日志。

## 卸载

`uninstall.exe`（或「设置 → 应用」里的卸载）会删除：应用文件、两个快捷方式、
「应用和功能」登记项、以及 `RUNASADMIN` 兼容层。默认**保留**用户数据
（`%APPDATA%\Guncat Work` 下的对话历史、工作区与 API 配置），
勾选「同时删除我的数据与配置」才会一并清掉。

## 日志

安装/卸载都写 `%TEMP%\Guncat-Work-Setup.log`；界面出错时会把该路径显示出来。
静默安装失败时这是唯一的线索。

## 分发前值得知道的两件事

1. **exe 没有签名**，所以别人第一次双击时 SmartScreen 大概率会拦一下
   （「Windows 已保护你的电脑 → 更多信息 → 仍要运行」）。要彻底消掉，得买代码签名证书，
   然后在 `scripts/package-installer.mjs` 里给两个 exe 各加一步 `signtool sign`。
2. **安装时会在 `%TEMP%` 释放一个 `7za.exe` 并执行它**（解压 385 MB 载荷用）。
   这是标准做法，但确实有杀软会因此报「可疑行为」。如果目标环境杀软很敏感，
   可以考虑改用 .NET 的 `ZipFile` 解压（体积会大 60 MB 左右、解压慢几倍），
   代价与收益见文件开头的说明。

## 静默安装（批量部署 / 自动化验证）

```bash
"release/Guncat-Work-0.1.0-setup.exe" --silent --dir "D:\Apps\Guncat Work"
"<安装目录>\uninstall.exe" --silent          # 默认保留用户数据
"<安装目录>\uninstall.exe" --silent --purge  # 连 %APPDATA%\Guncat Work 一起删
```

| 参数 | 作用 |
| --- | --- |
| `--silent` | 不建窗口，直接装/卸；成功退出码 0 |
| `--dir <路径>` | 指定安装/卸载目录 |
| `--no-launch` | 装完不自动启动 |
| `--no-desktop` / `--no-startmenu` | 不建对应快捷方式 |
| `--admin` | 安装时直接写入 `RUNASADMIN` 兼容层 |
| `--purge` | 卸载时连用户数据一起删（只有静默模式需要，界面上是勾选框） |
| `--shots <目录>` | 开发用：把各页面离屏渲染成 PNG 后退出 |
| `--from-temp` / `--wait-pid` | 卸载程序内部使用（见上） |

> **静默卸载是「交接完就返回」**：`uninstall.exe --silent` 把自己复制到 `%TEMP%`、拉起副本、
> 自己立刻退出 —— 退出码 0 只代表交接成功，真正的删除发生在副本里。
> 脚本要判断卸载是否完成，**请轮询安装目录是否消失**，不要只看退出码。
> （附带一个真实的坑：调用方若在同一个作业对象里、拉起后立刻退出，副本可能跟着被杀掉，
> 本次开发中就踩到过一次。）

## 改界面

界面全部在 `installer/src/*.xaml` 里。改完跑：

```bash
node scripts/package-installer.mjs --ui-only --shots
# → .tmp/installer-shots/*.png（安装 4 页 + 卸载 4 页）
```

`--ui-only` 跳过应用构建与 7z 压缩（省几分钟），只编界面并把每页渲染成 PNG。
渲染走 WPF 自己的 `RenderTargetBitmap`，**不需要真的开窗口**，因此在没有桌面会话的
环境里也能出图，是这套界面唯一的验证手段。

## 本机工具链约束（改代码前先看）

* 编译器是 **Windows 自带的 `csc.exe`（.NET Framework 4.8 目录下那个）**，
  它的语言版本是 **C# 5**：不能用字符串内插、`?.`、表达式体成员、`nameof`。
  这不是风格选择 —— 本机没有 dotnet SDK，也没有 VS/MSBuild，Roslyn 无处可取。
* XAML 是**运行时**由 `XamlReader.Load` 解析的，所以：
  * 不能写 `x:Class`、不能写事件属性（一律在 C# 里 `FindName` 后挂事件）；
  * `StaticResource` 依赖 `Application.Resources`（`Theme.Install()` 把 `theme.xaml` 挂上去）；
  * `Grid` 这类没有 `FontFamily` 属性的元素要用附加属性 `TextElement.FontFamily`。
* 引用程序集取自 `C:\Program Files (x86)\Reference Assemblies\…\.NETFramework\v4.x`，
  编译时带 `/noconfig`（否则 `csc.rsp` 会再引用一份运行时目录下的 `System.dll`，报 CS1703）。

## 文件一览

| 路径 | 作用 |
| --- | --- |
| `installer/src/theme.xaml` | 配色、字体、按钮/勾选框/输入框/进度条的 ControlTemplate |
| `installer/src/shell.xaml` | 窗口外壳：自定义标题栏 + 左侧品牌栏 + 页面宿主 |
| `installer/src/setup.xaml` / `setup.cs` | 安装程序四页与安装逻辑 |
| `installer/src/uninstall.xaml` / `uninstall.cs` | 卸载程序四页与卸载逻辑 |
| `installer/src/common.cs` | 资源装载、窗口外壳、快捷方式、注册表、日志、格式化 |
| `installer/app.manifest` | `asInvoker` + per-monitor DPI |
| `scripts/package-installer.mjs` | 构建入口：载荷 → 7z → 编译 → 产物 |

## 验证到哪一步了

| 项 | 结论 | 怎么验的 |
| --- | --- | --- |
| 静默安装 | ✅ 650 个文件 / 384.7 MB，约 6 秒 | `--silent --dir` 装完逐一核对目录结构 |
| 覆盖安装（装第二遍） | ✅ 同样 6 秒，无报错 | 连装两次，文件数与首次一致 |
| 静默卸载 | ✅ 安装目录、临时副本全部清干净 | 卸载后轮询目录消失 |
| 界面（安装 4 页 / 卸载 4 页） | ✅ | `--ui-only --shots` 离屏渲染 PNG |
| 真实窗口 | ✅ 1404×924 物理像素（150% DPI 下的 936×616 逻辑尺寸），圆角与透明边距正常 | 起窗口后按 DPI 感知方式截屏 |
| 快捷方式 COM 调用 | ✅ 能在工作区内生成可解析的 `.lnk` | 同一段 `Shortcuts.Create` 单独驱动 |
| `RUNASADMIN` 兼容层写入 | ⚠️ 未能实跑 | 目标路径 `Desktop` / `HKCU` 对被沙箱托管的子进程不可写；被拒绝时报的键路径正确 |
| 「应用和功能」登记项 | ⚠️ 未能实跑，同上 | 同上 |

那两项没跑通是**本机沙箱限制**，不是代码问题：同一个进程直接（不经子进程）往桌面写文件、
往 `HKCU` 写键都是成功的，而由沙箱托管的子进程会被拒。
在普通环境下跑一遍 `npm run dist:setup` 装一次即可确认这两项。

