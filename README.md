<div align="center">

  <img src="MagNum/public/logo.png" alt="MagNum Logo" width="96" height="96" />

  <h1>MagNum</h1>
  <p><strong>Autonomous Software Engineering Workspace & AI Coding Agent</strong></p>

  <p>
    <a href="https://github.com/mbbgreen/magnum/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981.svg" alt="License: MIT"></a>
    <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white" alt="Tauri v2"></a>
    <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=black" alt="Rust"></a>
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React"></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
    <a href="#"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-0078D6" alt="Platform: Windows | Linux"></a>
  </p>

  <p>
    MagNum is a high-performance, local-first autonomous software engineering workspace built with Tauri v2, Rust, and React. It connects directly with DeepSeek and Google AI Studio (Gemini) through secure, client-side stealth browser automation — no cloud relays, no subscription markups.
  </p>
</div>

---

## Interface Preview

<div align="center">
  <img src="docs/screenshots/preview-1.png" alt="MagNum Workspace" width="100%" style="border-radius: 8px; margin-bottom: 12px;" />
  <p><em>Autonomous Agent Workspace & Embedded Browser Inspection</em></p>

  <br />

  <img src="docs/screenshots/preview-2.png" alt="MagNum Terminal and Diff Inspector" width="100%" style="border-radius: 8px;" />
  <p><em>Interactive Terminal (PowerShell on Windows, bash on Linux) & Visual Hunk Diff Inspector</em></p>
</div>

---

## Key Features

- **Autonomous Multi-Turn Agent Loop:** Inspects directories, reads files (up to 5,000 lines/chunk), runs code grep, creates files, executes shell commands, and generates smart surgical multi-file patches.
- **Multi-Model Provider Dock:** Seamlessly toggle between **DeepSeek** (with DeepThink reasoning) and **Google Gemini** (via Google AI Studio with adjustable Low/Medium/High thinking levels).
- **Built-in Engineering Skills:** Instant workflow specialization with dedicated skills including `/plan`, `/debug`, `/multitask`, and `/ask`.
- **Advanced Workspace Inspector:**
  - **Changes Tab:** Visual unified diff viewer with hunk folding, line-by-line inspection, and atomic single-click file revert.
  - **Live Terminal:** Real-time integrated shell (PowerShell on Windows, bash on Linux) with inline prompt tracking, shell restarts, and Ctrl+C interrupt support.
  - **Native In-App Webview:** Embedded Chromium browser with live text-reading and search grounding via dynamic CDP bridging.
  - **File Explorer:** Workspace tree viewer with Monaco Editor syntax highlighting.
- **Safety & Human-in-the-Loop:** Toggleable approval gates for patch application and shell command execution.
- **Local-First & Privacy-Centered:**
  - All chats and diffs persist in local **SQLite** (`magnum.db` with WAL mode).
  - Inter-process communication uses a cryptographically generated 64-character token via authenticated local WebSockets (`localhost:5454`).
  - Browser sessions and login cookies stay strictly on your local disk (the per-user app data directory, e.g. `AppData/Local/MagNum` on Windows or `~/.local/share/com.green.magnum` on Linux).
- **Tailored Interface & Localization:** Modern dark and light workspaces, F11 fullscreen workflow, and native English and Persian (RTL) localization.

---

## System Architecture

MagNum uses a 3-tier hybrid architecture combining native performance, OS integration, and fast web technologies:

```text
+-------------------------------------------------------------+
|                        MagNum Desktop UI                    |
|      React 18 + TypeScript + Vite + Tailwind/Custom CSS     |
|      (Monaco Editor, Visual Diff Viewer, Lucide)            |
+------------------------------+------------------------------+
                               | Tauri IPC / Events
+------------------------------v------------------------------+
|                      Rust Core (src-tauri)                  |
|  - Windows Job Object (auto-termination of child procs)     |
|  - Dynamic CDP Remote Debugging allocation                  |
|  - Single Instance Guard & Native Window Decorations        |
|  - Secure .ws-token reader & Updater Gate                   |
+------------------------------+------------------------------+
                               | Auth WS (localhost:5454)
+------------------------------v------------------------------+
|                  Node.js Backend Engine Daemon              |
|  - CodingAgent (tool calling, loop controller)              |
|  - ProjectTools (AST-free resilient fuzzy patch engine)     |
|  - Drivers (DeepSeek Stealth Driver & Gemini Driver)        |
|  - Storage (SQLite Sync Database via WAL mode)              |
+-------------------------------------------------------------+
```

---

## Repository Structure

```text
├── MagNum/                      # Main desktop application
│   ├── src/                     # React frontend (Components, Hooks, i18n, Styles)
│   ├── src-tauri/               # Rust source code, capabilities & Tauri config
│   │   └── resources/backend/   # Node.js Agent Engine (server.js, tools, drivers)
│   └── vite.config.ts
├── installer/                   # Standalone installer application (Tauri)
│   ├── src/                     # Installer setup UI (React)
│   └── src-tauri/               # Rust installer logic & payload extractor
├── build-setup.js               # Unified pipeline builder (App -> Payload -> Setup.exe)
├── download-fonts.js            # Self-hosted offline font bundle fetcher
└── LICENSE                      # MIT Open Source License
```

---

## Getting Started

### Prerequisites

- **Node.js:** v20.x or v22.x+ (Recommended: Node 22+ with native `node:sqlite`).
- **Rust & Cargo:** Stable toolchain (`rustup default stable`).
- **C++ Build Tools (Windows):** Visual Studio C++ Build Tools. On Linux see [Linux](#linux) below.
- **Google Chrome**, **Microsoft Edge** or **Chromium** installed.

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/mbbgreen/magnum.git
cd magnum

# Install frontend dependencies
cd MagNum
npm install

# Install installer dependencies
cd ../installer
npm install
cd ..
```

### 2. Download Offline Fonts (First-time setup)

MagNum bundles its fonts offline (JetBrains Mono, Plus Jakarta Sans, Vazirmatn) to ensure no remote telemetry calls:

```bash
node download-fonts.js
```

### 3. Running in Development Mode

Run the main application with live hot-reloading:

```bash
cd MagNum
npm run tauri dev
```

### Linux

Install system packages (Debian/Ubuntu names):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Install Rust via [rustup](https://rustup.rs), Node.js 20 or 22+ (`node` must be on your `PATH`), and Chrome, Edge or Chromium (auto-detected). Then:

```bash
cd MagNum
npm install
cd src-tauri/resources/backend
npm install
npx playwright install chromium   # only needed if no system Chrome/Chromium is installed
cd ../../..
npm run tauri dev
```

`npm run tauri build` uses `src-tauri/tauri.linux.conf.json` to produce `.deb` and `.AppImage` bundles, without the Windows-only `node.exe` / `magnum-fs.exe`. The `magnum-fs` helper is compiled by `scripts/build-fs.js` and is git-ignored. The Windows installer (`installer/`, `build-setup.js`) does not apply to Linux. The integrated terminal uses `bash`. App data lives in the directory derived from the identifier `com.green.magnum` (`~/.local/share/com.green.magnum`).

**Ubuntu 23.10+ / 24.04: "No usable sandbox!"** These releases set `kernel.apparmor_restrict_unprivileged_userns=1`, which stops Chromium's sandbox from starting for any browser that has no AppArmor profile. Playwright's bundled Chromium (`npx playwright install chromium`) has none, so the first prompt fails with `Chromium sandboxing failed`. Fixes, in order of preference:

1. Install Google Chrome from the `.deb`. It ships an AppArmor profile for `/opt/google/chrome/chrome`, and MagNum auto-detects it, so no flags are needed.
2. Run with `MAGNUM_NO_SANDBOX=1 npm run tauri dev`. This starts the automation browser without its sandbox, so use it only if you accept that.

Chrome may also show an infobar about `--disable-blink-features=AutomationControlled`. It is cosmetic: MagNum passes that flag to hide the automation marker from the chat sites.

---

## Building Production Release

MagNum provides an automated pipeline in `build-setup.js` that:

1. Builds the core React frontend and compiles the Rust binary.
2. Stages the backend engine and packages it into an internal payload.
3. Compiles the custom standalone installer (`MagNum-Setup.exe`).

```bash
# From the repository root:
node build-setup.js
```

The resulting standalone setup executable will be generated at:

```text
installer/src-tauri/target/release/MagNum-Setup.exe
```

> The Windows installer pipeline (`installer/`, `build-setup.js`, `node.exe`, `magnum-fs.exe`) is Windows-only and does not apply to Linux. See **Linux Support** below for the Linux build path.

---

## Linux Support

MagNum runs natively on Linux (Debian/Ubuntu and derivatives tested) using the same 3-tier architecture as Windows. This section covers dependencies, how to run, and every adaptation made to the originally Windows-only codebase.

### System Dependencies (Debian / Ubuntu)

Runtime and build dependencies for the desktop app and its native dependencies:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential curl wget file \
  libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  zenity \
  chromium \
  bash
```

| Dependency | Why it is required |
| --- | --- |
| `libwebkit2gtk-4.1-dev` + build toolchain | Tauri v2 native webview and Rust/C toolchain to compile `src-tauri` |
| `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` | Tauri native integrations (windowing, TLS, tray, icons) |
| `zenity` | Native GTK folder-picker / dialog backend on Linux (replaces the Windows native dialog calls) |
| `chromium` (or `google-chrome`, `chromium-browser`) | Browser engine driven by the stealth automation for DeepSeek / Gemini chat UIs |
| `bash` | Shell used by `execute_command` and the integrated terminal |

The `.deb` package declares `zenity` and `chromium` (with `chromium-browser` / `google-chrome` as alternatives) as dependencies, so `apt` pulls them automatically on install.

Also install [Rust via rustup](https://rustup.rs) and **Node.js 20.x or 22.x+** (`node` must be on `PATH`).

### Browser Requirement

MagNum auto-detects an installed browser at launch. On Linux it looks for:

- Google Chrome: `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/opt/google/chrome/chrome`
- Microsoft Edge: `/usr/bin/microsoft-edge`, `/usr/bin/microsoft-edge-stable`, `/opt/microsoft/msedge/msedge`
- Chromium: `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`

If none is found, install Chromium via `apt` or run `npx playwright install chromium` inside `MagNum/src-tauri/resources/backend`. You can force a specific browser with `BROWSER_CHANNEL=chrome|msedge|chromium`.

### How to Run (Linux)

```bash
git clone https://github.com/R1Azizi/MagNum-Linux.git
cd MagNum-Linux

node download-fonts.js                       # fetch offline font bundle (one-time)

cd MagNum
npm install                                  # frontend deps
cd src-tauri/resources/backend
npm install                                  # backend engine deps
cd ../../..                                  # back to MagNum/

npm run tauri dev                            # development with hot-reload
```

Build production `.deb` and `.AppImage` bundles (uses `src-tauri/tauri.linux.conf.json`):

```bash
cd MagNum
npm run tauri build
```

Build artifacts land in `MagNum/src-tauri/target/release/bundle/` (`deb/` and `appimage/`). The `magnum-fs` helper is compiled by `scripts/build-fs.js` and is git-ignored.

**Ubuntu 23.10+ / 24.04 sandbox note:** these releases set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks Chromium's sandbox unless the browser ships an AppArmor profile. Install Google Chrome from its `.deb` (it ships a profile and MagNum auto-detects it), or run with `MAGNUM_NO_SANDBOX=1 npm run tauri dev` if you accept disabling the sandbox.

### What Changed for Linux

The Linux port reuses the exact Windows architecture, only swapping OS-specific integration points:

- **Rust core (`src-tauri/src/lib.rs`)** — builds and runs on Linux; the Windows Job Object process-tree termination is replaced by POSIX process-group signalling; dynamic CDP allocation and the single-instance guard work cross-platform.
- **Backend platform layer (`resources/backend/platform.js`, new)** — all OS-specific operations (terminal spawn, folder picker, reveal-in-file-manager, browser show/hide) are isolated in one module. Windows branches are the original code moved verbatim; Linux/macOS branches are additions.
- **Terminal / `execute_command`** — uses `bash` on Linux/macOS (with a `trap ... EXIT` marker to report `cwd` and exit status) and PowerShell on Windows. `tools.js` runs commands through `/bin/bash` when available.
- **Agent system prompt** — OS, shell, and path hints follow `process.platform`, so the model is told it is talking to `bash` and POSIX paths on Linux.
- **Browser detection (`resources/backend/stealth.js`)** — new Linux candidate paths for Chrome, Edge, and Chromium (including Snap). Chromium has no Playwright channel, so it is launched by `executablePath`; optional `--no-sandbox` is opt-in via `MAGNUM_NO_SANDBOX=1`.
- **Folder picker / dialogs** — backed by `zenity` on Linux instead of native Windows dialogs.
- **Embedded browser (`src/utils/embeddedBrowser.ts`)** — overlaid on the main webview on Linux (the Windows path uses a child webview window).
- **Update gate (`src/components/update/UpdateGate.tsx`)** — self-update is skipped on Linux (`setState('uptodate')`), because the current updater endpoint serves Windows artifacts only.
- **Bundle config (`src-tauri/tauri.linux.conf.json`, new)** — builds `.deb` and `.AppImage` from the JS backend without `node.exe` / `magnum-fs.exe`, and declares `zenity` + `chromium` as `.deb` dependencies.
- **Build scripts** — `scripts/build-fs.js` chmods the generated `magnum-fs` binary on Linux; the Linux binary is git-ignored.

### How Windows-Only Code Was Overcome

The original codebase hard-coded `powershell.exe`, `node.exe`, `.exe` resource paths, Windows dialog APIs, and Windows process termination. Rather than forking the app, the port introduces a **single platform-abstraction seam**:

1. **One module, two implementations.** `platform.js` exposes the OS-specific functions (`spawnTerminal`, folder picker, reveal, browser show/hide, `commandShell`). Every Windows branch is the original code unchanged; Linux/macOS branches sit beside it. Callers in `server.js` no longer contain `if (win32)` scattered around.
2. **Process lifecycle via process groups.** The Windows Job Object (which auto-kills child processes) has no direct Linux equivalent, so the terminal spawns `bash` as a **detached process group** and `child.kill()` sends the signal to `-pid`, terminating the whole tree — the same guarantee, using POSIX primitives.
3. **Platform-aware prompt and shell.** The agent's system prompt and `execute_command` both branch on `process.platform`, so the model receives correct shell/path hints instead of Windows ones, keeping tool calls valid on Linux.
4. **Browser resolution, not a fixed path.** `stealth.js` builds a per-OS candidate list and resolves channel + `executablePath` at launch, so the same code works whether Chrome, Edge, or Chromium is installed.
5. **Separate bundle config, shared source.** `tauri.linux.conf.json` overrides only the bundle resources/dependencies; the Rust source, React frontend, and Node backend are shared with Windows, so Linux builds do not fork the application logic.

---

## Privacy, Security & Architecture Disclosure

MagNum was engineered specifically for developers who want the power of state-of-the-art reasoning models directly applied to their local codebases without paying subscription markups or sending source code to untrusted cloud relay servers:

- **Zero Cloud Proxies:** All prompts, file contents, diffs, and terminal outputs stay strictly between your computer and the official provider endpoint you choose.
- **Local Browser Automation:** MagNum does not ask you to paste API keys into third-party servers. It drives a local, stealth-configured Chromium instance linked directly to your authenticated session.
- **WebSocket Protection (CSWSH Defense):** The internal communication port rejects any request whose origin is not in the whitelist and requires a single-use 64-character cryptographic token (`.ws-token`) generated upon every boot.
- **Non-Destructive Git-Free Revert:** Every code modification generates a forward and backward diff saved inside `edits.db`. You can revert any agent action at any time even in folders without a Git repository.

### Why Local Automation?

MagNum intentionally avoids routing code through third-party relay services. The agent engine runs **entirely on your machine** and only communicates with the model provider you explicitly select. This design minimizes the attack surface, removes intermediary data exposure, and keeps every artifact (chats, diffs, cookies) within your OS user profile.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## License

Distributed under the **MIT License**. See the [LICENSE](LICENSE) file for more information.

---

<div align="center">
  <sub>Engineered by <strong>Nethers Games</strong> &copy; 2026. All rights reserved.</sub>
</div>
