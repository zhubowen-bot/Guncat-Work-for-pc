# Guncat Work (Desktop)

**English** | [中文](README.md)

> an Agent Harness client rebuilt with **Electron + React + TypeScript**.
> The business core (agent loop, three streaming protocols, 45 built-in tools, 37 skills, Office
> generators, the `guncat-ui lang` renderer) was ported line by line from ArkTS.

![Electron](https://img.shields.io/badge/Electron-38-blue)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![version](https://img.shields.io/badge/version-0.2.1-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![forms](https://img.shields.io/badge/Agent%20Forms-Intelligent%20UI%20%2B%20Harness-blueviolet)
![tools](https://img.shields.io/badge/built--in%20tools-45-informational)
![skills](https://img.shields.io/badge/skills-37-informational)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![CI](https://github.com/zhubowen-bot/Guncat-Work-for-pc/actions/workflows/ci.yml/badge.svg)](https://github.com/zhubowen-bot/Guncat-Work-for-pc/actions/workflows/ci.yml)

## Three modes

| Mode | Inspiration | What it does |
| --- | --- | --- |
| ✦ **Interactive mode** | GPT's **Intelligent UI** | One prompt produces a working interface; zero tool calls and a single render pass by default, controls recompute instantly as you drag them |
| 🛠 **Work mode** | **DeepSeek Harness** (dsh, Codex-style agent loop) | Multi-turn tool loops + a per-session sandbox workspace + 45 built-in tools, so long-running tasks run autonomously |
| Chat mode | — | Plain conversation, no sandbox workspace |

Work mode and interactive mode **share the same agent loop and sandbox workspace**; what differs is
behavioural discipline and **the tool surface exposed** — work mode gets all 45 tools, multi-turn tool
loops and long-horizon delivery, while interactive mode only receives **27** (read material / compute
real numbers / verify external facts / emit files). Long-horizon tools (`todo_write` / `goal_*` /
`schedule_*` / `subagent`) never appear in its requests, which is what makes it a "fast lane, one-shot
interface".

## Capabilities

- **Two agent shapes that matter today**: interactive mode mirrors GPT's Intelligent UI — the answer is
  no longer plain text but an **interface program** which the app renders as draggable, clickable UI
  whose parameters can be changed with instant recomputation (8 chart types: bar / line / area /
  horizontal bar / donut / radial / radar / stacked bar, plus tables, metric cards, image walls, tabs /
  accordions / step bars / card blocks and a full set of form controls); work mode brings the core
  DeepSeek Harness agent loop to the desktop intact.
- **Three protocols**: OpenAI Completions (`/chat/completions`), OpenAI Responses (`/responses`) and
  Anthropic Messages (`/messages`), all supporting direct image input; deep thinking and web search are
  explicitly controlled per protocol.
- **Built-in local web search**: bundled and always on — no toggle to flip — available in both work mode
  and chat mode, independent of any server-side web-search switch.
- **Office output straight from the desktop**: PPT / Word / Excel / SVG are produced by local generators
  on a JSON intermediate layer, and documents can be **read back losslessly and edited with operators**;
  PDF and Office files are parsed entirely locally, **consuming no multimodal quota**.
- **45 built-in tools**: file create / read / update / delete and pattern-based search, task lists,
  image viewing, network downloads, PDF parsing, Office read/write, data-pipeline cleaning,
  transformation and format conversion, and a `run_js` code sandbox built on `node:vm`
  (no network, no filesystem access, **infinite loops are hard-interrupted by the engine**).
- **37 skills**: 5 main skill routes + 7 format branches + 25 domain branches, loaded on demand when they
  match; the PPT / Word / Excel skills use gate-style constraints that produce a verifiable self-check
  report before delivery.
- **Native Markdown**: syntax highlighting, tables, task lists, inline and block LaTeX, Mermaid diagrams
  (laid out for **desktop widescreen** and scrollable horizontally), with automatic light/dark theming.
- **Attachments and export**: upload images / documents directly or pre-parse them, drag files into the
  window to import them into the workspace, and export a Markdown answer to Word (including
  LaTeX → native OMML equations).
- **Speech**: read-aloud (Web Speech API, with selectable system voices and speed) and voice input
  (recording + provider transcription endpoint).
- **Multiple API profiles**: save and switch between several access methods / base URLs / keys / models;
  the capsule in the title bar switches models without opening settings.
- **Adaptive UI**: wide screens show a side-by-side conversation panel, narrow screens collapse to a
  single column; light/dark theme follows the system.

## Quick start

> This project uses **npm** (**not** pnpm). Install dependencies with `npm install`.

### For users: double-click and go

Build once, copy the whole folder to someone else, and **double-click `Guncat Work.exe` inside it** —
no Node.js, no command line:

```bash
npm install
npm run dist       # produces release/Guncat Work-<version>/
```

Output layout:

```text
release/Guncat Work-0.2.1/
├── Guncat Work.exe              ← double-click this
├── create-desktop-shortcut.cmd  ← double-click once to add a desktop shortcut (with the app icon)
├── run-compat.cmd               ← starts with --no-sandbox, without elevation
├── run-as-admin.cmd             ← starts as administrator (triggers a UAC prompt)
├── enable-admin-mode.cmd        ← makes plain double-click elevate automatically; use disable-admin-mode.cmd to undo
├── diagnose.cmd / diagnose.ps1  ← double-click when it will not start; runs 6 tiers and reports a verdict per tier
├── 使用说明.txt                  ← read-me (Chinese)
├── LICENSE
└── resources/                   ← app code + bundled resources (do not move separately)
```

On first launch, open **Settings** in the bottom-left corner, fill in the access method, base URL, API
key and model, and start chatting. Data (conversation history, sandbox workspaces, configuration) lives
in `%APPDATA%\Guncat Work`, not in the program directory — deleting the program directory leaves your
existing data intact.

**A process that "flashes and starts again" is expected**: in a packaged win32 build the app restarts
itself once at startup so that `--no-sandbox` ends up on the real command line (see
[Known environment limitations](#known-environment-limitations) below).

**If no window appears after double-clicking**: run `diagnose.cmd`. It tries 6 tiers, each with its own
user-data directory, and writes the result to `diag-log.txt`. You can also double-click `run-compat.cmd`
to start in compatibility mode. The full troubleshooting path is in
**[Startup troubleshooting](docs/STARTUP-TROUBLESHOOTING.md)** (Chinese).

### For users: one installer, launch from the Start menu

If you would rather ship a single `.exe` than a folder, use the installer:

```bash
npm run dist:setup   # produces release/Guncat-Work-<version>-setup.exe (single file, ~105 MB)
```

Double-click to install. **This installs for all users**: it defaults to `C:\Program Files\Guncat Work`,
registers under machine-level `HKLM`, and puts shortcuts on the public desktop / public Start menu — so
installation and uninstallation each raise **one UAC prompt** (click "Yes"). An uninstaller is included,
with an option to delete local data too.

The UI is custom-drawn in a modern style (frameless rounded window with gradients), not a Win32 wizard.
Install and uninstall each have four pages, which can be rendered offscreen to PNG:

```bash
npm run dist:setup:ui   # → .tmp/installer-shots/*.png
```

Implementation notes, silent-install switches and toolchain constraints are in
**[installer/README.md](installer/README.md)** (Chinese).

### For developers: edit and reload

```bash
npm install
npm run dev        # main process + renderer with hot reload
```

## Tech stack

- **Desktop shell**: Electron 38 (all application code is bundled into `out/` by Vite, so the artifact has
  **no runtime node_modules**)
- **UI**: React 19 + TypeScript + Vite (electron-vite)
- **Business core**: TypeScript **ported line by line** from the HarmonyOS app (~35k lines), with
  platform dependencies replaced through `@kit.*` aliases
- **Packaging**: the bundled `scripts/package-portable.mjs` (see "About packaging" below)

### About packaging

`npm run dist` uses the repository's own assembly script rather than electron-builder, for a concrete
reason: electron-builder's dependency collector fails to read the package manager's JSON output in some
environments and aborts with `No JSON content found in output`. Since the app's runtime code is entirely
bundled into `out/` by Vite, **there is no node_modules to collect at packaging time** — that step is
redundant. The bundled script assembles the standard Electron app directory directly, which is more
predictable and faster.

The only two exceptions are the PDF backends: `pdfjs-dist` and `@napi-rs/canvas` (a native `.node`) cannot
go into the bundle (the former has dynamic paths to workers / wasm / fonts, the latter cannot be bundled
at all), so the assembly script copies them by hand into
`Guncat Work-<version>/resources/app/node_modules/`, and copies PDF standard fonts / CMaps / wasm decoders
into `Guncat Work-<version>/resources/resources/pdfjs/`. Missing either piece does not produce a "corrupt
file" error: text extraction degrades to missing font metrics, and rendering degrades to an explicit
"rendering backend missing" message. See `src/core/platform/native/pdfBackend.ts`.

`electron-builder.yml` stays in the repository for a future need to **sign installers / ship auto-updates**.

### Two build-time pitfalls (already handled)

1. **esbuild's temp directory**: on Windows esbuild creates temporary files in the system `TEMP` and then
   deletes them; in some environments this fails with `Access is denied` and the build dies at the
   `vite:esbuild-transpile` stage. `TMP`/`TEMP` are now pointed at the in-project `.tmp` (see
   `scripts/esbuild-aliases.mjs` and `scripts/build.mjs`).
2. **Build entry point**: `npm run build` goes through the `scripts/build.mjs` wrapper instead of calling
   `electron-vite` directly, so that the temp directory is set before the child process starts and the
   `ELECTRON_RUN_AS_NODE` variable that breaks Electron startup is stripped. It uses a Node wrapper rather
   than `set TMP=... &&` so it does not depend on cmd/bash syntax.

### App icon

Taken from the HarmonyOS original: in `AppScope/resources/base/media/layered_image.json` both the
background and foreground of the layered icon **point at `cat_avatar.png`**, so that is the real app icon.
`scripts/make-icon.py` generates two formats: `app-icon.png` (256², window and taskbar icon) and
`app-icon.ico` (7 sizes, used by desktop shortcuts).

## Verification

One command runs everything: **`npm run verify`** (= typecheck + smoke, and smoke builds first).

| Layer | Command | Coverage |
| --- | --- | --- |
| Types | `npm run typecheck` | `src/core` (ported core) + `src/main` + `src/preload` + `src/renderer` |
| Build | `npm run build` | main / preload / renderer artifacts |
| Core | `npm run smoke:core` | **341 assertions**: agent loading, 45 tools, 37 skills, sandbox workspace, the `run_js` sandbox, data pipelines, persistence, three protocol endpoints, **Office toolchain end to end** (generate → read back → operator edits), **skill-system tools**, **interactive mode full chain** (parse / `$binding` recompute / action callbacks / state tail markers / form packaging), **PDF parsing** (text / search / page-to-image), **SVG rasterization** (preview PNG / docx and pptx references), **plugin hot loading** (manifest → parse → register into the tool table), **HTTP read-idle timeout** (long streams not cut off / stalled connections cut off), plus 138 desktop-side enhancements, 12 voice-input items, 20 multi-turn chat and UI-assist items, 10 runtime snapshot items and 26 `ask_user_question` items |
| Renderer | `npm run smoke:render` | **272 assertions**: `react-dom/server` renders an interface program covering the main components to HTML and asserts item by item (including how work mode and interactive mode each orchestrate, the three Markdown chains for LaTeX / code blocks / mermaid, workspace-panel upload entry and file-type icons, attachment entry and interjection button in the input area, engine grouping and workspace toggle in the sidebar, diff / task-list cards on tool rows, task-stats and goal cards, artifact summary card, table-extraction panel) |
| Contract | `npm run smoke:ipc` | **247 assertions**: an electron stand-in really invokes **every IPC channel** the renderer calls (registration completeness, settings round-trip, session lifecycle, event push, out-of-bounds and directory-traversal rejection, guard prompts, **file inbox and workspace upload**, **Word export**, **voice transcription config and endpoint assembly**, **local web-search config and binding**, **protocol path-suffix toggle round-trip**, **configuration profiles** (migration / create / switch / save / delete protection), **chat attachments** (actually filling content into the message), **scheduled reminder advancement**, **reasoning-effort pass-through**, **interjection during execution**, **task stats and goals**, **artifact summary**, **table extraction** and model-output cleanup) |
| Startup | `npm run smoke:startup` | **150 assertions** (Windows; 145 on other platforms, see note below): runs the **real entry point** `src/main/index.ts` with an electron stand-in and asserts that single-instance lock → whenReady → create window → register IPC happen in order, that **both the preload path and index.html point at files that actually exist**, that the data directory was created, and that nothing throws; it also asserts taskbar identity, menu bar, window icon, scheduled-reminder startup and the icon written by the packaging script |
| Characters | `node scripts/check-emoji.mjs src/renderer` | the renderer must contain no emoji and no symbols used as icons (use SVG components instead) |
| All | `npm run smoke` | the four smoke suites above + the character scan (~1010 assertions in total on Windows) |

`npm run smoke` pulls the riskiest ported code down into plain Node and exercises it along the real call
chain, applying **exactly the same** alias rules as `electron.vite.config.ts` through esbuild — so what is
verified is the resolution rules the build artifacts actually depend on, not a separate approximation.

> **Counts are authoritative on Windows.** A batch of assertions is win32-specific (windows prefer `.ico`,
> packaged builds enable Chromium logging by default, packaged builds self-restart with `--no-sandbox`), so
> Linux / macOS see 5 fewer — CI runs on Linux, where the startup suite has **145 assertions**.
> These assertions are **written per platform, with an explicit expected value on each side**, rather than
> "skipped when not Windows": skipped assertions can never fail on a CI machine without Windows, which
> would make them a fake safety net.

Why renderer verification matters: Electron windows fail to start on some development machines, but the
"element tree → React component tree" step runs end to end in Node (SSR does not execute `useEffect`, so it
does not need `ResizeObserver` / `window`), which keeps the renderer from stopping at "type check passes".

CI covers type checking, the three builds and the four smoke suites — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). **The packaged artifact must be run locally and
double-clicked once for real** — hosted runners are not a good place to run Electron with a window.

## Known environment limitations

**On some Windows development machines, Electron cannot create a GPU child process when started with the
sandbox enabled**: after deciding "GPU process isn't usable", Chromium calls `LOG(FATAL)` and kills itself
with exit code `-2147483645` (`0x80000003` / `STATUS_BREAKPOINT`). Fourteen controlled experiments showed
that only `--no-sandbox` changes the outcome.

Therefore:

- **Packaged artifacts are immune** — in a packaged win32 build the app restarts itself at startup and puts
  `--no-sandbox` on the real command line (which is why "the process flashes and starts again" is
  expected).
- **`npm run dev` deliberately keeps the sandbox**, so on affected machines the dev build may not open a
  window. This is intentional: it preserves a path to reproduce the root cause.

The detailed root cause, the controlled experiments, the real cause of the white screen and the diagnostic
ladder are in **[Startup troubleshooting and compatibility mode](docs/STARTUP-TROUBLESHOOTING.md)**
(Chinese).

In every mode the app writes startup milestones to `%APPDATA%\Guncat Work\logs\startup.log`, and the
artifact ships with `diagnose.cmd`.

## Project layout

```text
src/
├── core/         # HarmonyOS business core (ported line by line) + platform adapter layer
│   ├── common/   #   prompts, tool registry, guncat-ui lang, data pipelines, diff…
│   ├── model/    #   Message / Conversation / ApiConfig / Agent…
│   ├── service/  #   three-protocol SSE, agent loop, tool execution, skills, sandbox workspace…
│   ├── export/   #   Docx / Xlsx / Pptx / Svg generators and importers
│   ├── data/     #   StorageManager
│   └── platform/ # ★ desktop-only: desktop equivalents of @kit.*
├── main/         # Electron main process (windows, IPC, session and agent-loop orchestration)
├── preload/      # contextBridge security bridge
├── renderer/     # React UI
└── ipc/          # shared main ↔ renderer contract
resources/        # bundled resources: agents.json, agent prompts, skill library
scripts/          # headless smoke verification and packaging scripts
docs/PORTING.md   # ★ porting strategy, platform-adapter mapping, divergences from upstream
```

## Documentation

| Document | Contents |
| --- | --- |
| [Porting notes](docs/PORTING.md) | Porting strategy, `@kit.*` adapter mapping, **list of divergences from upstream** (re-apply item by item when syncing upstream) |
| [Interactive mode](docs/INTERACTIVE-MODE.md) | guncat-ui lang data flow, 76 component coverage, fault tolerance, two-layer headless verification |
| [Startup troubleshooting](docs/STARTUP-TROUBLESHOOTING.md) | Crash root cause, 14 controlled experiments, the real cause of the white screen, the 6-tier diagnostic ladder, crash-dump analysis |
| [Contributing](CONTRIBUTING.md) | Environment requirements, verification matrix, coding conventions and red lines, PR process |
| [Changelog](CHANGELOG.md) | Every version change |

The documents themselves are written in Chinese.

Research material from the upstream HarmonyOS project:
[open-intelligent-ui spec](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/open-intelligent-ui-spec.md) ·
[openui-lang spec](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/openui-lang-spec.md).

## Privacy

- API keys and app configuration are stored in the local user-data directory (`%APPDATA%\Guncat Work`).
- Chat requests and attachments are sent only to the model service you configure.
- File reads and writes in work mode happen entirely inside the app's sandbox workspace; **no additional
  permissions are requested**.
- Files received through command-line arguments, a second instance or a window drag-and-drop go into the
  **sandbox workspace** (the model reads them with file tools); they are not automatically sent as
  attachments.
- Network requests use HTTPS; actual data-handling policies are those of your configured model provider.

## FAQ

Start with [Startup troubleshooting and compatibility mode](docs/STARTUP-TROUBLESHOOTING.md) (Chinese): it
covers a missing window / white screen / instant exit, the `-2147483645` exit code, the real cause of the
white screen, how to use the diagnostic scripts and how to read crash dumps.

## Contributing

Issues and pull requests are welcome. For the development environment, coding conventions (including the
hard rule that the ported core must not be modified by default), how to run the verification matrix and the
PR process, see **[CONTRIBUTING.md](CONTRIBUTING.md)** (Chinese).

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and run the matching verification layer (changes under `src/core/**` must come with
   new assertions).
4. Make sure `npm run verify` passes.
5. Open a pull request describing the change and how it was verified.

## License

Released under the [Apache License 2.0](LICENSE), the same license as the upstream HarmonyOS app.
