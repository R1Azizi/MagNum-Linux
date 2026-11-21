# MagNum Android — Repository & Build Plan

## Decision: Single repo, Android as an additional Tauri target

Build Android on top of the existing `magnum-merge/MagNum` tree. Do NOT fork a separate repo.

### Why not a separate repo
- The React UI and the WebSocket JSON action protocol are ~95% shared. A fork would force cherry-picks and guarantee protocol drift.
- The tool executor (`read_files`, `patch_file`, `create_file`, `search_code`, browser actions) belongs in one shared Rust crate (`magnum-core`) compiled by both desktop and Android.
- One version, one release tag -> desktop bundles + `app-release.apk` from the same commit.

### Platform split (already wired in this repo)
- `src-tauri/src/lib.rs` `.setup()`: Node backend spawn is inside `#[cfg(not(target_os = "android"))] { ... }`. On Android the Rust core runs in-process.
- `src-tauri/Cargo.toml`: added `[target.'cfg(target_os = "android")'.dependencies]` for mobile-only crates.
- `package.json`: added `android:init`, `android:dev`, `android:build` (APK), `android:build:aab`, `desktop:build`.
- `cargo check` passes on desktop.

### WebView / scraping on Android
- Desktop: native Tauri child webview + CDP (unchanged).
- Android: `android.webkit.WebView` behind a `BrowserEngine` trait (`browse_web`, `read_page`, `embedded_navigate`, `embedded_read_page`). Per-provider cookie store via `CookieManager`.

### File tools on Android
- Default workspace: app-scoped external dir — no permission prompts.
- Optional real project: Storage Access Framework behind a `magnum-fs` `saf` feature.
- `execute_command`: native allowlist only, no real shell.

### APK build
```bash
cd magnum-merge/MagNum
npm install
npm run android:init   # one-time
npm run android:build  # app-release.apk
```
