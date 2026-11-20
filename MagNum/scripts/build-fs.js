import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');                       // MagNum/
const crateDir = path.join(root, 'src-tauri', 'magnum-fs');
const manifest = path.join(crateDir, 'Cargo.toml');

const bin = process.platform === 'win32' ? 'magnum-fs.exe' : 'magnum-fs';
const src = path.join(crateDir, 'target', 'release', bin);
const dst = path.join(root, 'src-tauri', 'resources', 'backend', bin);

if (!fs.existsSync(manifest)) {
  console.error(`[magnum-fs] Cargo.toml not found: ${manifest}`);
  process.exit(1);
}

// اگر باینری از سورس تازه‌تر است، دوباره cargo اجرا نکن (dev سریع بماند)
const sources = [manifest, path.join(crateDir, 'src', 'main.rs')];
const newestSrc = Math.max(...sources.map(f => fs.statSync(f).mtimeMs));
const upToDate = fs.existsSync(dst) && fs.statSync(dst).mtimeMs > newestSrc;

if (upToDate && process.env.FORCE_FS_BUILD !== '1') {
  console.log('[magnum-fs] up-to-date — skipping cargo build.');
  process.exit(0);
}

// If an existing binary is present, try an OFFLINE build first (no network).
// This avoids ~2 minutes of doomed crate downloads when the network is slow.
if (fs.existsSync(dst) && process.env.FORCE_FS_BUILD !== '1') {
  console.log('[magnum-fs] existing binary present — attempting offline rebuild...');
  try {
    execSync(`cargo build --release --offline --manifest-path "${manifest}"`, { stdio: 'inherit' });
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      if (process.platform !== 'win32') fs.chmodSync(dst, 0o755);
      console.log(`[magnum-fs] rebuilt offline -> ${dst} (${(fs.statSync(dst).size / 1024).toFixed(0)} KB)`);
      process.exit(0);
    }
  } catch (e) {
    console.warn('[magnum-fs] offline rebuild not possible — keeping existing binary (skipping network build).');
    console.log(`[magnum-fs] keeping existing binary -> ${dst}`);
    process.exit(0);
  }
}

console.log('[magnum-fs] cargo build --release ...');
try {
  execSync(`cargo build --release --manifest-path "${manifest}"`, { stdio: 'inherit' });
} catch (err) {
  // Build failed (e.g. offline / slow network fetching crates).
  // Do NOT block `npm run dev` — if an existing binary is present, keep it.
  console.error('[magnum-fs] cargo build failed:', err.message || err);
  if (fs.existsSync(dst)) {
    console.error(`[magnum-fs] keeping existing binary -> ${dst} (build skipped)`);
    process.exit(0);
  }
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    if (process.platform !== 'win32') fs.chmodSync(dst, 0o755);
    console.error(`[magnum-fs] installed stale-but-present binary -> ${dst}`);
    process.exit(0);
  }
  console.error('[magnum-fs] no binary available and build failed — aborting.');
  process.exit(1);
}

if (fs.existsSync(src)) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  if (process.platform !== 'win32') fs.chmodSync(dst, 0o755);
  console.log(`[magnum-fs] installed -> ${dst} (${(fs.statSync(dst).size / 1024).toFixed(0)} KB)`);
} else if (fs.existsSync(dst)) {
  console.log(`[magnum-fs] build produced no binary; keeping existing -> ${dst}`);
}