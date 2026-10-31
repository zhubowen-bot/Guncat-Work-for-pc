# Guncat Work (Desktop)

**English** | [中文](README.md)

> A **desktop Agent Harness client** built with **Electron + React + TypeScript**: three streaming
> protocols, multi-turn tool loops with a sandboxed workspace, one-prompt interactive UIs, direct
> Office output, and a **command execution path that has been through a real security audit**.
>
> The HarmonyOS version is [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos)
> (ArkTS / ArkUI).

![Electron](https://img.shields.io/badge/Electron-38-blue)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![version](https://img.shields.io/badge/version-7.0.0-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![forms](https://img.shields.io/badge/Agent%20Forms-Intelligent%20UI%20%2B%20Harness-blueviolet)
![tools](https://img.shields.io/badge/built--in%20tools-45-informational)
![skills](https://img.shields.io/badge/skills-37-informational)
![shell audit](https://img.shields.io/badge/shell%20audit-163%20rules-red)
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
interface". `run_command` is likewise absent from interactive mode: a mode that can run commands must
have somewhere for a human to see and approve them.

## Capabilities

- **Audited terminal execution**: work mode can run builds, tests, git and local CLIs in a real
  project, but every command goes through the guard — destructive operations are **rejected outright
  with no approval path**, outward-facing operations raise an approval card according to the selected
  tier, and workspace escapes, actions hidden inside scripts, encoded payloads and inline interpreter
  code are all blocked. See [Shell security audit](#shell-security-audit-commandguard).
- **Two agent shapes that matter today**: interactive mode mirrors GPT's Intelligent UI — the answer is
  no longer plain text but an **interface program** which the app renders as draggable, clickable UI
  whose parameters can be changed with instant recomputation (8 chart types: bar / line / area /
  horizontal bar / donut / radial / radar / stacked bar, plus tables, metric cards, image walls, tabs /
  accordions / step bars / card blocks and a full set of form controls); work mode brings the core
  DeepSeek Harness agent loop to the desktop.
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
  transformation and format conversion, command execution with background jobs, and a `run_js` code
  sandbox built on `node:vm` (no network, no filesystem access, **infinite loops are hard-interrupted
  by the engine**).
- **37 skills**: 5 main skill routes + 7 format branches + 25 domain branches, loaded on demand when they
  match; the PPT / Word / Excel skills use gate-style constraints that produce a verifiable self-check
  report before delivery.
- **Native Markdown**: syntax highlighting, tables, task lists, inline and block LaTeX, Mermaid diagrams
  (laid out for **desktop widescreen** and scrollable horizontally), with automatic light/dark theming.
- **Attachments and export**: upload images / documents directly, pre-parse them, paste them into the
  composer, or drag files into the window to import them into the workspace; export a Markdown answer to
  Word (including LaTeX → native OMML equations).
- **Speech**: read-aloud (Web Speech API, with selectable system voices and speed) and voice input
  (recording + provider transcription endpoint).
- **Multiple API profiles**: save and switch between several access methods / base URLs / keys / models;
  the capsule in the title bar switches models without opening settings.
- **Adaptive UI**: wide screens show a side-by-side conversation panel, narrow screens collapse to a
  single column; light/dark theme follows the system.

## Shell security audit (CommandGuard)

> The worst outcome for an agent that can type commands is not a wrong answer — it is **one generated
> command deleting something on the user's disk**. This capability shipped with an audit from day one:
> the decision layer `src/core/service/CommandGuard.ts` (1,700+ lines of pure logic, no process access),
> the approval path `src/core/service/CommandService.ts`, and a dedicated adjudication corpus.
> Almost all of the last stretch of the beta (`0.2.0` → `0.2.1`) went here: more than ten rounds of adversarial testing, twenty-plus
> bypasses closed one by one — every one reproduced first, fixed second, and covered by a regression.

### Threat model

Model output is **untrusted input**; when `run_command` fails, the cost is not "one wrong file" but
unrecoverable data loss. The goal is therefore not "block the obviously bad spelling" but **stay blocked
when the spelling changes**.

### Gate 1: hard-deny, with no approval path

The `forbidden` tier rejects outright and does not even offer an "Allow" button — because **a user
slipping and clicking Allow is itself a failure mode that must be defended against**. Hard-deny only
contains genuinely irreversible things an agent has no legitimate reason to do: formatting disks,
writing raw devices, deleting shadow copies and system backups, firmware/controller-level erasure,
disabling Defender or the firewall, clearing audit logs, dumping lsass credentials or EFS recovery
keys… 37 rules in total.

### Gate 2: four approval tiers, changing **who decides**

| Tier | Who decides for a dangerous command |
| --- | --- |
| `ask` | Every command needs human approval |
| `ask-risk` | Dangerous commands raise an approval card; everything else runs |
| `auto` (default) | A model reviews first; runs silently only when it says low/medium **and** explicitly allows |
| `full-access` | No review, no questions — only hard-deny remains |

`auto` is not "fully automatic": a high verdict, a self-contradictory answer, a non-JSON reply, a
timeout, or no configured model — **all fall back to the human card; the machine never has the final
word**. The reviewer only sees the environment, the user's own words and the command text; the agent's
own explanations and reasoning are excluded, otherwise it could talk the reviewer into approving by
saying "this is safe" first. `full-access` only turns off review — the hard-deny table sits in front of
it and no tier can reach past it.

### Six rule tables, 163 rules

37 hard-deny + 77 risky + 27 "intent unreadable" + 11 script-content + 2 positional hard-deny +
9 positional risky. Rules register **semantics**, not the shape of a word.

### Three independent layers — drop one and it is bypassed

1. **Keywords over normalized text**: cmd's `^`, word-splitting quotes, the `@` prefix, `%ComSpec%`,
   the second segment inside parentheses or after a pipe — all disappear at execution time, so the text
   under judgement is "raw ∪ normalized ∪ extracted inner commands". Normalization only strips
   disguises and never rewrites meaning, so derived text can only **add** hits.
2. **Unreadable intent (OPAQUE)**: inline interpreter code, code fed through stdin or redirection,
   `for` loop variables executed as commands, Base64 payloads, command substitution, script hosts and
   system-component loaders, and WSL / ssh-style "hand the decision to somewhere else" channels. These
   commands contain no dangerous words by construction, so keywords can never catch up; they are judged
   as "we cannot tell what this does".
3. **Positional escape**: absolute paths, `..` traversal, paths built from environment variables,
   drive-root forms (`\data\a.txt` is `C:\data\a.txt`), UNC network paths, the `\\?\` prefix. This layer
   is spelling-independent and is the hardest of the three.

### Script co-review: read **the file that will run**, not its extension

`cscript //E:` can run a `.txt` as VBS, `cmd` appends PATHEXT suffixes to bare names, `%~dp0` /
`$PSScriptRoot` change the base directory, and `npm run x` runs the string inside `package.json`. So:

- references are resolved against **the process cwd and the script's own directory**, and every hit is
  reviewed;
- bare names without an extension are resolved through PATHEXT to real files before being read;
- `npm --prefix` / `yarn --cwd` / `pnpm -C` switch package directories, so the `package.json` **at the
  switched-to location** is the one read;
- rewriting a script with `copy` / redirection and then executing it also goes to approval — co-review
  would only see the pre-rewrite content;
- unresolvable references, missing files and references beyond the review-depth limit **become approval
  prompts instead of being silently allowed**.

### Command-position judgement: a new name for the same act is not a new command

`npx` and `npm exec` / `npm x` / `pnpm exec` / `pnpm dlx` / `yarn dlx` / `bunx` are the same act;
whether `format` means "format a disk" or is just a word inside `npm run format` depends on whether it
sits in command position. Rules are registered by **what the action does**, not by enumerating names —
otherwise changing one spelling bypasses an entire table.

### The process layer is tightened too

The working directory is pinned to the session workspace (an escape is rejected, the command never runs
in some other directory of the user's); the child environment is sanitized against a whitelist, so API
keys held by the main process never reach the command; timeouts, cancellation and no answer all
fail closed — **silence is not consent**.

### Audit method and regressions

- **Reproduce first, fix second**: every round runs real reports against production code, using the real
  `CommandGuard.assess` and the real `run_command` to reproduce a "zero-approval pass-through", and only
  fixes what reproduces.
- **Two regression layers**: the decision layer (dangerous inputs must be dangerous + everyday spellings
  must not be disturbed) and the integration layer (card raises → card states the matched reason → click
  reject → the file is still there).
- **A dedicated corpus**: `scripts/guard-corpus.mjs` covers 117 hard-deny cases, 90 risky cases and 47
  benign spellings, plus 250 `^`-escaped variants and 111 "`^` inserted between words" variants,
  asserting that **changing the spelling never lowers the tier**.
- **Explicit trade-offs**: no allowlist rewrite (it would make `npm run build` prompt every day —
  usability does not survive the security gain); string false positives are accepted (`git commit -m
  "notes on rm -rf /"` also gets one prompt) — a miss costs the user's data, a false positive costs one
  extra click.

In one line: **ask one time too many rather than miss one time.**

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
release/Guncat Work-7.0.0/
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
- **Business core**: TypeScript (~35k lines), with platform differences adapted to the desktop runtime
  through `@kit.*` aliases
- **Command security**: `CommandGuard` (pure decision logic) + `CommandService` (approval and execution
  path); the decision layer is testable without touching a real process
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

The icon uses the same brand assets: in `AppScope/resources/base/media/layered_image.json` both the
background and foreground of the layered icon **point at `cat_avatar.png`**, so that is the real app icon.
`scripts/make-icon.py` generates two formats: `app-icon.png` (256², window and taskbar icon) and
`app-icon.ico` (7 sizes, used by desktop shortcuts).

## Verification

One command runs everything: **`npm run verify`** (= typecheck + smoke, and smoke builds first).

| Layer | Command | Coverage |
| --- | --- | --- |
| Types | `npm run typecheck` | `src/core` (business core) + `src/main` + `src/preload` + `src/renderer` |
| Build | `npm run build` | main / preload / renderer artifacts |
| Core | `npm run smoke:core` | **504 assertions**: agent loading, 45 tools, 37 skills, sandbox workspace, the `run_js` sandbox, data pipelines, persistence, three protocol endpoints, **Office toolchain end to end** (generate → read back → operator edits), **skill-system tools**, **interactive mode full chain** (parse / `$binding` recompute / action callbacks / state tail markers / form packaging), **PDF parsing** (text / search / page-to-image), **SVG rasterization** (preview PNG / docx and pptx references), **plugin hot loading**, **HTTP read-idle timeout**, plus 156 desktop-side enhancements, 12 voice-input items, 20 multi-turn chat and UI-assist items, 10 runtime snapshot items, 26 `ask_user_question` items, **423 cumulative command-execution and security-boundary assertions**, the read-before-edit guard, `@` file references, credential encryption at rest and cross-turn context |
| Renderer | `npm run smoke:render` | **309 assertions**: `react-dom/server` renders an interface program covering the main components to HTML and asserts item by item (including how work mode and interactive mode each orchestrate, the three Markdown chains for LaTeX / code blocks / mermaid, workspace-panel upload entry and file-type icons, attachment entry and interjection button in the input area, engine grouping and workspace toggle in the sidebar, diff / task-list cards on tool rows, task-stats and goal cards, artifact summary card, table-extraction panel) |
| Contract | `npm run smoke:ipc` | **504 assertions**: an electron stand-in really invokes **every IPC channel** the renderer calls (registration completeness, settings round-trip, session lifecycle, event push, out-of-bounds and directory-traversal rejection, guard prompts, the **full command-approval chain** (card / reject / allow-all-this-task / model review in `auto` / the four tiers), **file inbox and workspace upload**, **Word export**, **voice transcription**, **local web search**, **configuration profiles**, **chat attachments**, **scheduled reminder advancement**, **reasoning-effort pass-through**, **interjection during execution**, **task stats and goals**, **artifact summary**, **table extraction** and model-output cleanup) |
| Security corpus | `node scripts/guard-corpus.mjs` | **43 assertion groups / 615 cases**: 117 hard-deny, 90 risky, 47 benign spellings, 250 `^`-escaped variants and 111 "`^` between words" variants; it also self-checks that every regex in all six tables is exercised and that every case lands in the expected tier |
| Startup | `npm run smoke:startup` | **150 assertions** (Windows; 145 on other platforms, see note below): runs the **real entry point** `src/main/index.ts` with an electron stand-in and asserts that single-instance lock → whenReady → create window → register IPC happen in order, that **both the preload path and index.html point at files that actually exist**, that the data directory was created, and that nothing throws; it also asserts taskbar identity, menu bar, window icon, scheduled-reminder startup and the icon written by the packaging script |
| Characters | `node scripts/check-emoji.mjs src/renderer` | the renderer must contain no emoji and no symbols used as icons (use SVG components instead) |
| All | `npm run smoke` | the four smoke suites above + the security corpus + the character scan (~1467 assertions in total on Windows) |

`npm run smoke` pulls the riskiest core code down into plain Node and exercises it along the real call
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
├── core/         # business core (TypeScript) + desktop platform adapter layer
│   ├── common/   #   prompts, tool registry, guncat-ui lang, data pipelines, diff…
│   ├── model/    #   Message / Conversation / ApiConfig / Agent…
│   ├── service/  #   three-protocol SSE, agent loop, tool execution, skills, sandbox workspace,
│   │             #   CommandGuard decisions and the command approval path…
│   ├── export/   #   Docx / Xlsx / Pptx / Svg generators and importers
│   ├── data/     #   StorageManager
│   └── platform/ #   desktop platform adapter: equivalents of @kit.*
├── main/         # Electron main process (windows, IPC, session and agent-loop orchestration)
├── preload/      # contextBridge security bridge
├── renderer/     # React UI
└── ipc/          # shared main ↔ renderer contract
resources/        # bundled resources: agents.json, agent prompts, skill library
scripts/          # headless smoke verification, command corpus and packaging scripts
docs/PORTING.md   # platform adaptation strategy and differences from the HarmonyOS version
```

## Documentation

| Document | Contents |
| --- | --- |
| [Platform adaptation and differences](docs/PORTING.md) | Desktop platform adapter, `@kit.*` mapping, **list of implementation differences from the HarmonyOS version** |
| [Command security audit](src/core/service/CommandGuard.ts) | Threat model, six rule tables, four approval tiers and the reason for every bypass (the header comment is the design document) |
| [Interactive mode](docs/INTERACTIVE-MODE.md) | guncat-ui lang data flow, 76 component coverage, fault tolerance, two-layer headless verification |
| [Startup troubleshooting](docs/STARTUP-TROUBLESHOOTING.md) | Crash root cause, 14 controlled experiments, the real cause of the white screen, the 6-tier diagnostic ladder, crash-dump analysis |
| [Contributing](CONTRIBUTING.md) | Environment requirements, verification matrix, coding conventions and red lines, PR process |
| [Changelog](CHANGELOG.md) | Every version change |

The documents themselves are written in Chinese.

Research material from the HarmonyOS project:
[open-intelligent-ui spec](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/open-intelligent-ui-spec.md) ·
[openui-lang spec](https://github.com/zhubowen-bot/Guncat-Work-for-hmos/blob/main/docs/reference/openui-lang-spec.md).

## Privacy

- API keys and app configuration live in the local user-data directory (`%APPDATA%\Guncat Work`) and are
  encrypted by the system credential vault.
- Chat requests and attachments are sent only to the model service you configure.
- File reads and writes in work mode happen entirely inside the app's sandbox workspace; **no additional
  permissions are requested**.
- Command execution always goes through the security audit: destructive operations are rejected;
  dangerous commands are reviewed by a model first by default (executed silently only when it explicitly
  allows, otherwise the human approval card is shown) and you can switch to human-only approval tiers;
  rejecting, skipping or not answering all count as denial; the child environment is whitelisted, so the
  main process's keys never reach the command.
- Files received through command-line arguments or a second instance go into the **sandbox workspace**
  (the model reads them with file tools); images/files pasted into the composer or dropped onto the
  window follow the current mode: chat mode adds them to the **attachment strip** (sent only after you
  confirm), while work/interactive mode imports them into the session workspace.
- Network requests use HTTPS; actual data-handling policies are those of your configured model provider.

## FAQ

Start with [Startup troubleshooting and compatibility mode](docs/STARTUP-TROUBLESHOOTING.md) (Chinese): it
covers a missing window / white screen / instant exit, the `-2147483645` exit code, the real cause of the
white screen, how to use the diagnostic scripts and how to read crash dumps.

For why a command was rejected or why approval is being requested, see the rule tables and reasons in
[Command security audit](src/core/service/CommandGuard.ts) and the
[Shell security audit](#shell-security-audit-commandguard) section.

## Contributing

Issues and pull requests are welcome. For the development environment, coding conventions (including the
hard rule that the core must not be modified by default), how to run the verification matrix and the PR
process, see **[CONTRIBUTING.md](CONTRIBUTING.md)** (Chinese).

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and run the matching verification layer (changes under `src/core/**` must come with
   new assertions; changes to command rules must add cases to both the decision layer and the integration
   layer of `scripts/guard-corpus.mjs` and `scripts/ipc-check.mjs`).
4. Make sure `npm run verify` passes.
5. Open a pull request describing the change and how it was verified.

## License

Released under the [Apache License 2.0](LICENSE), the same license as the HarmonyOS version.
