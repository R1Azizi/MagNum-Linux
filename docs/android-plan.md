# MagNum on Android

MagNum shares its React chat UI between desktop and Android. Desktop uses the
existing local Node and Chromium backend. A desktop composer send goes through
`useMagNumSocket` to the backend's `send_prompt` handler. `agent.js` sends
the provider prompt and dispatches replies through `tools.js`. Folder
selection and process ownership go through `platform.js`.

On Android, the Tauri mobile entry point registers the provider plugin.
The same socket hook uses an in-process transport for the signed-in provider
WebView. That transport opens a scoped run through the plugin, dispatches
file tools through `magnum-core` and `magnum-fs`, and returns tool results
to the provider in the original conversation.

## DeepSeek

1. Open MagNum and tap **Sign in to DeepSeek**.
2. Sign in on `chat.deepseek.com` with a DeepSeek email account. Complete any
   verification that DeepSeek presents on the page.
3. Tap **Return to MagNum**. When MagNum says **DeepSeek connected**, send a
   prompt from the composer. **Chat only** keeps the plain-text flow.
4. Open **Workspace** to create a private workspace, select a saved workspace,
   or import an Android folder. With a workspace selected, the same composer
   starts an agent run. Reopening MagNum restores the provider session, local
   chat history, and the selected workspace.

Provider connection status comes from the loaded page. An expired session
requires signing in again. For a saved conversation, MagNum checks that the
provider opens the expected conversation before enabling Send.

The provider view uses Android's default WebView user agent and accepts
top-level navigation on the DeepSeek chat origin. **Log in with Google**
shows an **Open DeepSeek in browser** action. That opens a fresh DeepSeek
sign-in page in a Custom Tab. Select Google there and close the tab to return
to the original MagNum sign-in page. Google prohibits OAuth inside an embedded
WebView. The Custom Tab uses the browser's session, so embedded MagNum chat
requires DeepSeek email and password sign-in on the original page. If you
only use Google today, DeepSeek's **Forgot password?** form can tell you
whether password recovery is available for your email.
[Google’s OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies#secure-browsers)

The composer includes DeepThink and the provider menu. MagNum verifies the
DeepThink selection on DeepSeek before sending. The menu marks Gemini and
ChatGPT as Browser panel only, where they open in Custom Tabs. The Android composer accepts plain text. Attachments and skills are desktop features.

The [Android provider plugin](../MagNum/src-tauri/android-provider) registers
the Kotlin WebView and its origin-scoped DOM driver through Tauri. The website
holds cookies and sign-in state in app-private WebView storage. MagNum retains
local chat history in the app UI's storage. The provider bridge sends neither
cookies nor credentials to Rust or React. Android backup and WebView debugging
are disabled.

## Workspaces and tools

**Import Android folder** opens the system folder picker on supported devices
and copies the chosen tree to MagNum's app-owned storage. Future edits and tests
use that copy.
Reopening the copy requires no access to the original folder. Import limits
are 128 MiB, 4,000 entries and 24 directory levels. Virtual documents require
a regular local copy for import.

With a workspace selected, use **Workspace → View files in MagNum** to inspect
text files. Use **Workspace → Open Android Files** and choose a folder under
**MagNum Workspaces** to open or copy files, including binary files. You can
also select **MagNum Workspaces** directly from the system file browser's
locations menu. This location provides read-only access to the working copies,
including workspaces created by earlier versions of MagNum. To work on an
external copy, copy it to a writable folder in Android Files.

Android dispatches listing, literal search, numbered UTF-8 reads, creation
and patching in-process through `magnum-core` and `magnum-fs`. The agent
uses the desktop JSON action names and the shared chat, review and activity
events. A patch uses a unique existing text snippet. Workspace tools reject
absolute paths, parent traversal and symlinks. Each run keeps the workspace
and provider conversation it started with. You can open a different saved
chat or select a different workspace while the run is active. The provider
view moves to the selected chat after the run finishes. Use the **Review**
panel to approve or reject edits and commands when approval is enabled in
settings.

## Command output

Android bundles Lua 5.4 for dependency-free projects. Ask the agent to run
`lua tests/test.lua` from the workspace root. Use `require("src.math")` to
load `src/math.lua`, `assert` for checks, and `print` for live output. The
runtime offers local Lua modules, with no shell or process launch, network,
general file I/O, or native dependencies. Other project toolchains and
commands return a toolchain-unavailable result.

**Command output** shows the workspace, output and exit code. **Stop** in the
output panel cancels the Lua command and ends its agent run. The bundled
runtime uses a 20-second deadline and caps output and Lua memory. Exit codes
include 0 for success, 1 for script errors, 124 for timeout, 127 for an
unsupported command and 130 for cancellation.

## ARM64 debug build

Follow the SDK setup and project initialization in the [Android release guide](android-release.md). Then run the following from `MagNum/` to build a debug APK:

```bash
npm run android:build -- --debug --target aarch64 --split-per-abi
```

The APK is under `src-tauri/gen/android/app/build/outputs/apk/arm64/debug/`.

## Verification

On a Redmi Note 9S running Android 12, the debug APK launched, showed a
signed-out status, disabled Send, and opened the provider's email login form
inside MagNum. The Google button revealed the browser action, opened DeepSeek
in a Chrome Custom Tab, and returned to the original MagNum sign-in page when
the tab closed. After the user signed in, the updated APK displayed DeepThink
and the provider menu in a new chat, sent a test prompt with MagNum's setup
instructions, and displayed the live reply. A cold restart restored the signed-in
connection and the local reply.

The agent workflow was exercised on the same ARM64 Redmi Note 9S running
Android 12. Starting from a restored DeepSeek sign-in, the system picker
imported a project with `src/math.lua` and `tests/test.lua`. In normal
MagNum chat, the agent read both files and reproduced the failing addition
assertion (exit 1). It patched subtraction to addition in the working copy.
The test then printed `PASS: addition` and the command panel reported exit 0.
The original source retained subtraction. A second command printed a startup
line from a Lua script with an infinite loop. Tapping **Stop** reported
cancellation and exit 130. Allowing the same script to run to its deadline
reported exit 124. A cold restart restored the selected imported workspace,
the patched source, the agent's final summary and the DeepSeek connection.

The Android test fixtures cover signed-out gating, sending exactly once,
excluding previous replies, restoring the saved provider conversation, and
completing a reviewed agent run after switching chats and workspaces.
Run them with Chromium available at `/usr/bin/chromium` (or set
`CHROMIUM_PATH`).

```bash
cd MagNum
node --test tests/android-deepseek.test.cjs
```
