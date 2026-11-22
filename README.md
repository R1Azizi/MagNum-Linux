<div align="center">
  <img src="MagNum/public/logo.png" alt="MagNum logo" width="96" height="96" />
  <h1>MagNum</h1>
  <p>A local-first AI coding workspace for Android, Linux, and Windows.</p>
</div>

MagNum connects to your signed-in AI provider and works with a local project. Use chat for questions or give the agent a workspace so it can read files, propose edits, and run supported commands. The app stores chats and workspace state locally. Prompts, selected file contents, and tool output may be sent to the provider you use.

## Android

The **MagNum 0.2.0** release APK is for **ARM64 devices (`arm64-v8a`) running Android 7.0 or later**. The development build was exercised on a Redmi Note 9S running Android 12.

1. Download `MagNum-0.2.0-android-arm64.apk` from [GitHub Releases](https://github.com/R1Azizi/MagNum-Linux/releases) once the release has been published.
2. Open the APK on your device and allow installation from that source if Android prompts you.
3. Open MagNum, tap **Sign in to DeepSeek**, and sign in with a DeepSeek email account. Tap **Return to MagNum** when finished.
4. Use **Chat only** for a conversation, or use **Workspace** to create or import a folder for agent work. MagNum edits its private working copy of an imported folder. The source folder is preserved.

Android supports plain-text DeepSeek chat, DeepThink, file search and edits with review, and Lua 5.4 commands with live output. Gemini and ChatGPT open in browser tabs. Android checks that an APK update uses the same signing key. Switching from a debug APK to the release generally requires uninstalling the debug APK, which removes its local chats, sign-in, and imported workspaces. Save anything you need before uninstalling.

See the [Android usage guide](docs/android-plan.md) for provider sign-in details, workspace limits, and supported commands. See the [Android release guide](docs/android-release.md) to build, sign, and verify the APK from source.

## Desktop

The desktop app includes the workspace inspector, editor, diff review, terminal, and provider browser. It connects to DeepSeek, Gemini via Google AI Studio, and ChatGPT through a local Chromium-based browser. Desktop uses a local Node backend; Android runs the provider WebView and workspace tools through Tauri plugins.

Install Node.js 22.12 or later, stable Rust, the [Tauri prerequisites for your OS](https://v2.tauri.app/start/prerequisites/), and a supported browser such as Chrome, Chromium, or Edge. On Linux, install Zenity for the folder picker.

```bash
git clone https://github.com/R1Azizi/MagNum-Linux.git
cd MagNum-Linux/MagNum
npm ci
npm ci --prefix src-tauri/resources/backend
npm run tauri dev
```

On Linux, `npm run desktop:build` uses the Linux bundle configuration for Debian and AppImage packages. On Windows, install the root and installer dependencies with `npm ci` and `npm ci --prefix installer` from the repository root. Run `node build-setup.js` there to build `installer/src-tauri/target/release/MagNum-Setup.exe`.

### Desktop preview

![MagNum workspace and browser inspector](docs/screenshots/preview-1.png)

![MagNum terminal and diff inspector](docs/screenshots/preview-2.png)

## Development

| Path | Purpose |
| --- | --- |
| [`MagNum/src`](MagNum/src) | Shared React and TypeScript interface |
| [`MagNum/src-tauri`](MagNum/src-tauri) | Tauri application and shared Rust workspace tools |
| [`MagNum/src-tauri/android-provider`](MagNum/src-tauri/android-provider) | Android provider WebView, workspace import, and Lua runtime |
| [`MagNum/src-tauri/resources/backend`](MagNum/src-tauri/resources/backend) | Desktop Node backend and provider drivers |
| [`installer`](installer) | Windows installer |

To run the existing JavaScript suites on Linux, install the desktop dependencies above and run the following from `MagNum/`. Chromium-based fixtures default to `/usr/bin/chromium` unless you set `CHROMIUM_PATH`.

```bash
npm run build
node --test --test-concurrency=1 tests/*.test.cjs
```

The [run ownership notes](docs/run-ownership.md) describe how workspace selection, command execution, and cancellation behave during an active run.

## License

MagNum is available under the [MIT License](LICENSE). This repository is based on the [upstream MagNum project](https://github.com/mbbgreen/MagNum).
