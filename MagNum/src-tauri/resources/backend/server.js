'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const { exec, spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { launchStealthContext } = require('./stealth');
const ProjectTools = require('./tools');
const DeepSeekDriver = require('./browser-driver');
const GeminiDriver = require('./gemini-driver');
const ChatGptDriver = require('./chatgpt-driver');
const CHATGPT_URL = ChatGptDriver.CHATGPT_URL || 'https://chatgpt.com/';
const CHATGPT_LOGIN_URL = ChatGptDriver.CHATGPT_LOGIN_URL || 'https://chatgpt.com/auth/login';
const AI_STUDIO_NEW_CHAT = GeminiDriver.AI_STUDIO_NEW_CHAT || 'https://aistudio.google.com/prompts/new_chat?model=gemini-3.8-flash';
const CodingAgent = require('./agent');
const sessionStore = require('./session-store');
const editStore = require('./edit-store');

const os = require('node:os');
const crypto = require('node:crypto');
const DATA_DIR = process.env.MAGNUM_DATA_DIR || 
  (process.env.APPDATA ? path.join(process.env.APPDATA, 'MagNum') : path.join(os.homedir(), '.magnum'));
const PROFILE_DIR = path.join(DATA_DIR, 'magnum-profile');
const GEMINI_PROFILE_DIR = path.join(DATA_DIR, 'gemini-profile');
const CHATGPT_PROFILE_DIR = path.join(DATA_DIR, 'chatgpt-profile');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const PORT = parseInt(process.env.MAGNUM_BACKEND_PORT || '5454', 10);
const PORT_FILE = path.join(DATA_DIR, '.backend-port');

async function writePortFile(actualPort) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(PORT_FILE, String(actualPort), { mode: 0o600 });
    console.log(`🔌 Backend port ${actualPort} written to ${PORT_FILE}`);
  } catch (err) {
    console.error('[FATAL] Could not write port file:', err.message);
  }
}



const WS_SECRET_TOKEN = crypto.randomBytes(32).toString('hex');
const TOKEN_FILE = path.join(DATA_DIR, '.ws-token');

const DEFAULT_IGNORED = ['node_modules', '.git', 'dist', 'build', '.next', 'magnum-profile', 'target', '.kilo', '.clinerules'];
let activeIgnoredList = [...DEFAULT_IGNORED];


async function writeWsTokenFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    await fs.writeFile(TOKEN_FILE, WS_SECRET_TOKEN, { mode: 0o600 });
    console.log(`🔐 WebSocket secret token written to ${TOKEN_FILE}`);
  } catch (err) {
    console.error('[FATAL] Could not write WS token file:', err.message);
  }
}


const ALLOWED_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420'
];


function verifyWebSocketUpgrade(req) {
  
  const origin = req.headers['origin'] || req.headers['sec-websocket-origin'] || '';
  
  
  if (origin && !ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
    console.warn(`🛡️ [CSWSH BLOCKED] Invalid Origin: ${origin}`);
    return { ok: false, code: 403, message: 'Forbidden: Invalid Origin' };
  }
  
  
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const providedToken = url.searchParams.get('token') || '';
  
  const tokenValid = providedToken.length === WS_SECRET_TOKEN.length &&
                     crypto.timingSafeEqual(
                       Buffer.from(providedToken, 'utf8'),
                       Buffer.from(WS_SECRET_TOKEN, 'utf8')
                     );
  
  if (!tokenValid) {
    console.warn(`🛡️ [CSWSH BLOCKED] Invalid or missing token from ${origin || 'unknown'}`);
    return { ok: false, code: 401, message: 'Unauthorized: Invalid token' };
  }
  
  return { ok: true };
}

async function scanWorkspaceTree(baseDir, currentRel = '', maxDepth = 6, ignoredList = activeIgnoredList) {
  const currentFull = path.join(baseDir, currentRel);
  let entries = [];
  try {
    entries = await fs.readdir(currentFull, { withFileTypes: true });
  } catch {
    return [];
  }

  const result = [];
  for (const entry of entries) {
    
    if (ignoredList.includes(entry.name)) continue;
    
    const entryRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      let children = [];
      if (maxDepth > 0) {
        children = await scanWorkspaceTree(baseDir, entryRel, maxDepth - 1, ignoredList);
      }
      result.push({ name: entry.name, relPath: entryRel, isDir: true, children });
    } else {
      result.push({ name: entry.name, relPath: entryRel, isDir: false });
    }
  }
  return result;
}

const server = http.createServer();

const wss = new WebSocketServer({ noServer: true, maxPayload: 500 * 1024 * 1024 }); 


server.on('upgrade', (req, socket, head) => {
  const verification = verifyWebSocketUpgrade(req);
  if (!verification.ok) {
    socket.write(`HTTP/1.1 ${verification.code} ${verification.message}\r\n\r\n`);
    socket.destroy();
    return;
  }
  
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});


process.on('unhandledRejection', (e) => {
  console.error('[FATAL] unhandledRejection:', e && (e.stack || e.message || e));
});
process.on('uncaughtException', (e) => {
  console.error('[FATAL] uncaughtException:', e && (e.stack || e.message || e));
});
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.warn(`[WARN] Port ${PORT} already in use — retrying on dynamic port 0...`);
    server.listen(0, '127.0.0.1');
    return;
  }
  console.error('[FATAL] server error:', e && e.message);
});

let browserContext = null;
let activePage = null;
let geminiContext = null;
let activeGeminiPage = null;
let currentTools = null;
let pendingPatch = null;
let pendingCommand = null;
let runningAgent = null;
let loginCheckTimer = null;
let currentSessionId = null;
let currentLang = 'en';
let geminiLoginCheckTimer = null;
let activeProvider = null;          
let deepseekStatus = 'disconnected'; 
let geminiStatus = 'disconnected';
let geminiThinkingLevel = 'medium'; 
let geminiRateCooldownUntil = 0;  
let geminiRateStrike = 0;         
let chatgptContext = null;
let activeChatGptPage = null;
let chatgptStatus = 'disconnected';
let chatgptLoginCheckTimer = null;
let chatgptThinkEnabled = true; // ★ Think همیشه پیش‌فرض روشن
let chatgptRateCooldownUntil = 0;
let chatgptRateStrike = 0;

const TERM_MARK = '\u0001';
let termShell = null;
let termCwd = null;
let termRoot = null;
let termLastCode = 0;
let termBuf = '';

function termFeed(chunk, isErr) {
  termBuf += chunk;
  let idx;
  while ((idx = termBuf.indexOf('\n')) >= 0) {
    const line = termBuf.slice(0, idx).replace(/\r$/, '');
    termBuf = termBuf.slice(idx + 1);
    if (line.indexOf(TERM_MARK + 'PS1' + TERM_MARK) === 0) {
      const p = line.split(TERM_MARK);
      termCwd = p[2] || termCwd;
      termLastCode = Number(p[3] || 0);
      continue;
    }
    broadcast({ event: 'terminal_live_output', line, isErr });
  }
}

function runTerminalCommand(cmd) {
  if (termShell) {
    broadcast({ event: 'terminal_live_output', line: 'A command is already running — press Ctrl+C to interrupt.', isErr: true });
    return;
  }
  broadcast({ event: 'terminal_echo', cwd: termCwd, command: cmd });
  if (!cmd.trim()) {
    broadcast({ event: 'terminal_prompt', cwd: termCwd, code: 0 });
    return;
  }
  if (/^(cls|clear|Clear-Host)$/i.test(cmd.trim())) {
    broadcast({ event: 'terminal_clear' });
    broadcast({ event: 'terminal_prompt', cwd: termCwd, code: 0 });
    return;
  }
  const wrapped = `${cmd}\r\nWrite-Host ('${TERM_MARK}PS1${TERM_MARK}'+(Get-Location).Path+'${TERM_MARK}'+$(if($?){0}else{1})+'${TERM_MARK}')`;
  termBuf = '';
  termLastCode = 0;
  termShell = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', wrapped], {
    cwd: termCwd,
    env: { ...process.env, NO_COLOR: '1' },
    windowsHide: true,
  });
  termShell.stdout.on('data', (d) => termFeed(d.toString('utf8'), false));
  termShell.stderr.on('data', (d) => termFeed(d.toString('utf8'), true));
  termShell.on('close', () => {
    termShell = null;
    broadcast({ event: 'terminal_prompt', cwd: termCwd, code: termLastCode });
  });
}

const treeSnapshots = new Map();
const SERVER_STRINGS = {
  en: {
    needWorkspace: 'Please open a project folder (Workspace) first.',
    syncing: 'Checking and syncing chat with DeepSeek...',
    chatLoaded: 'Chat loaded successfully.',
    syncDone: (n) => n > 0 ? `${n} chat(s) removed on DeepSeek were purged from local memory.` : 'All local chats are in sync with DeepSeek.',
    cfChallenge: 'A Cloudflare security check is active. Open the browser window and complete the checkbox.',
    captchaRequired: 'A security CAPTCHA appeared on DeepSeek! The browser window has been brought to front. Please solve the CAPTCHA and re-send your prompt.',
    suspended: (notice) => `Your DeepSeek account is temporarily suspended (${notice}). Please log out and switch accounts.`,
    notLoggedIn: 'You are not logged in to DeepSeek or the session has expired.',
    noInput: 'Logged in but the chat input is not ready (you may not be on a new chat page).',
    loading: 'Page is still loading.',
    closed: 'Browser is not open or the connection was lost.',
    ready: 'Connection active; DeepSeek is ready for commands.',
    errCheck: (m) => `Error during check: ${m}`,
    previousPurged: 'Previous chat was removed on DeepSeek; started a fresh chat.',
    geminiGoogleLogin: 'Gemini opened the Google sign-in page. The browser window is in front — sign in with your Google account; Gemini connects automatically.',
    geminiNotLoggedIn: 'Gemini is in Guest mode. In the opened browser window click "Sign in" (top-right) and complete Google login.',
    geminiNoInput: 'Gemini page is loaded but the chat input is not ready yet.',
    geminiReady: 'Connection active; Gemini is ready for commands.',
    geminiNotConnected: 'Gemini is not connected. Use the model pill at the bottom of the chat box to Connect Gemini.',
    chatgptLogin: 'ChatGPT opened the sign-in page. The browser window is in front — sign in (Google / Apple / email); ChatGPT connects automatically.',
    chatgptNoInput: 'ChatGPT page is loaded but the chat input is not ready yet.',
    chatgptReady: 'Connection active; ChatGPT is ready for commands.',
    chatgptNotConnected: 'ChatGPT is not connected. Use the model pill at the bottom of the chat box to Connect ChatGPT.',
    chatgptSessionExpiredTask: 'Task not sent: ChatGPT requires a new login. The browser window is open on the login page — sign in, then re-send your prompt.',
  sessionExpired: 'DeepSeek session expired — the browser window is open on the DeepSeek login page. Sign in again; MagNum reconnects automatically.',
  sessionExpiredTask: 'Task not sent: DeepSeek requires a new login. The browser window is open on the login page — sign in, then re-send your prompt.',
  reloginDone: 'DeepSeek login confirmed — engine back to background. You can re-send your prompt.'
  },
  fa: {
    needWorkspace: 'لطفاً ابتدا پوشه پروژه (Workspace) را انتخاب کنید.',
    syncing: 'در حال بررسی و همگام‌سازی چت با دیپ‌سیک...',
    chatLoaded: 'چت با موفقیت لود شد.',
    syncDone: (n) => n > 0 ? `تعداد ${n} چتِ حذف‌شده از دیپ‌سیک، از حافظه لوکال پاکسازی شد.` : 'همه چت‌های لوکال با دیپ‌سیک همگام هستند.',
    cfChallenge: 'صفحه بررسی امنیتی Cloudflare فعال شده است. لطفاً پنجره مرورگر را باز کرده و تیک تایید را بزنید.',
    captchaRequired: 'یک کپچا امنیتی روی صفحه دیپ‌سیک ظاهر شد! پنجره مرورگر برای شما نمایان شد (یا از دکمه Connect/Browser در بالای صفحه سمت راست استفاده کنید). لطفاً تیک کپچا را حل کنید و سپس دوباره درخواست‌تان را بفرستید.',
    suspended: (notice) => `حساب کاربری دیپ‌سیک موقتاً مسدود شده است (${notice}). لطفاً با کلیک روی Logout خارج شده و با اکانت دیگری وارد شوید.`,
    notLoggedIn: 'شما هنوز وارد حساب کاربری دیپ‌سیک نشده‌اید یا سشن منقضی شده است.',
    noInput: 'وارد اکانت شده‌اید اما فیلد چت هنوز آماده نیست (احتمالاً در صفحه چت جدید نیستید).',
    loading: 'صفحه هنوز کامل لود نشده است.',
    closed: 'مرورگر باز نیست یا ارتباط قطع شده است.',
    ready: 'اتصال فعال و دیپ‌سیک آماده دریافت دستور است.',
    errCheck: (m) => `خطا در بررسی: ${m}`,
    previousPurged: 'چت قبلی در دیپ‌سیک حذف شده بود؛ یک چت تازه شروع شد.',
    geminiGoogleLogin: 'جمنای صفحهٔ ورود گوگل را باز کرد. پنجره مرورگر جلو آمده — با حساب گوگل وارد شوید؛ اتصال جمنای خودکار برقرار می‌شود.',
    geminiNotLoggedIn: 'جمنای در حالت Guest است. در پنجره مرورگر باز شده روی «Sign in» بالا-راست کلیک کنید و ورود گوگل را کامل کنید.',
    geminiNoInput: 'صفحه جمنای لود شده اما فیلد چت هنوز آماده نیست.',
    geminiReady: 'اتصال فعال و جمنای آماده دریافت دستور است.',
    geminiNotConnected: 'جمنای متصل نیست. از پیل پایین چت‌باکس Connect جمنای را بزنید.',
    chatgptLogin: 'ChatGPT صفحه ورود را باز کرد. پنجره مرورگر جلو آمده — با گوگل/اپل/ایمیل وارد شوید؛ اتصال خودکار برقرار می‌شود.',
    chatgptNoInput: 'صفحه ChatGPT لود شده اما فیلد چت هنوز آماده نیست.',
    chatgptReady: 'اتصال فعال و ChatGPT آماده دریافت دستور است.',
    chatgptNotConnected: 'ChatGPT متصل نیست. از پیل پایین چت‌باکس Connect ChatGPT را بزنید.',
    chatgptSessionExpiredTask: 'تسک ارسال نشد: ChatGPT به ورود دوباره نیاز دارد. پنجره مرورگر روی صفحه لاگین باز است — وارد شوید و پرامپت را دوباره بفرستید.',
  sessionExpired: 'نشست دیپ‌سیک منقضی شد — پنجرهٔ مرورگر روی صفحهٔ ورود دیپ‌سیک باز است. دوباره وارد شوید؛ مگنوم به‌صورت خودکار متصل می‌شود.',
  sessionExpiredTask: 'تسک ارسال نشد: دیپ‌سیک به ورود دوباره نیاز دارد. پنجرهٔ مرورگر روی صفحهٔ لاگین باز است — پس از ورود، پرامپت را دوباره بفرستید.',
  reloginDone: 'ورود دوبارهٔ دیپ‌سیک تأیید شد — موتور به پس‌زمینه برگشت. می‌توانید پرامپت را دوباره بفرستید.'
  }
};
function tS(key, ...args) {
  const table = SERVER_STRINGS[currentLang] || SERVER_STRINGS.en;
  const v = table[key];
  return typeof v === 'function' ? v(...args) : (v || key);
}


function sessionUrlProvider(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.includes('aistudio.google.com')) return 'gemini';
  if (url.includes('chatgpt.com')) return 'chatgpt';
  if (url.includes('/chat/')) return 'deepseek';
  return null;
}


const TERMINAL_MAX = 400;
const terminalLogs = [];
function logTerminal(line, kind = 'sys') {
  const entry = { line: String(line), kind, ts: Date.now() };
  terminalLogs.push(entry);
  if (terminalLogs.length > TERMINAL_MAX) terminalLogs.shift();
  broadcast({ event: 'terminal_log', line: entry.line, kind: entry.kind, ts: entry.ts });
}

const LAST_WS_FILE = path.join(DATA_DIR, 'last_workspace.json');
async function saveLastWorkspace(p) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LAST_WS_FILE, JSON.stringify({ path: p }), 'utf-8');
  } catch {}
}
async function restoreLastWorkspace() {
  try {
    const raw = await fs.readFile(LAST_WS_FILE, 'utf-8');
    const { path: p } = JSON.parse(raw);
    if (!p) return;
    await fs.access(p);
    currentTools = new ProjectTools(p, activeIgnoredList);
    currentTools.setLogger((line, kind) => logTerminal(line, kind));
    const tree = await scanWorkspaceTree(p);
    broadcast({ event: 'workspace_loaded', path: p, tree });
    pushRecentWorkspace(p);
    logTerminal(`Workspace restored: ${p}`, 'sys');
  } catch {}
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}


const RECENT_WS_FILE = path.join(DATA_DIR, 'recent_workspaces.json');
let recentWorkspaces = [];
async function loadRecentWorkspaces() {
  try { recentWorkspaces = JSON.parse(await fs.readFile(RECENT_WS_FILE, 'utf-8')); } catch { recentWorkspaces = []; }
}
async function pushRecentWorkspace(p) {
  recentWorkspaces = [p, ...recentWorkspaces.filter(x => x !== p)].slice(0, 8);
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(RECENT_WS_FILE, JSON.stringify(recentWorkspaces, null, 2), 'utf-8');
  } catch {}
  broadcast({ event: 'recent_workspaces', workspaces: recentWorkspaces });
}
loadRecentWorkspaces();

function toggleBrowserVisibility(state = 0, profileName = path.basename(PROFILE_DIR)) {
  const psCode = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$targetPids = (Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${profileName}' } | Select-Object -ExpandProperty ProcessId)
$found = $false
for ($i=0; $i -lt 20; $i++) {
    $found = $false
    [Win32]::EnumWindows([Win32+EnumWindowsProc]{
        param($hWnd, $lParam)
        $wpid = 0
        [Win32]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
        if ($targetPids -contains $wpid) {
            [Win32]::ShowWindowAsync($hWnd, ${state}) | Out-Null
            if (${state} -eq 5) { [Win32]::SetForegroundWindow($hWnd) | Out-Null }
            $script:found = $true
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($found) { break }
    Start-Sleep -Milliseconds 500
}
  `;
  const base64Code = Buffer.from(psCode, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${base64Code}`);
}


// ── Robust cross-system folder picker (3 native strategies + in-app fallback) ──
const PS_EXE = (() => {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { fsSync.accessSync(abs); return abs; } catch { return 'powershell.exe'; }
})();

function runPickerPowerShell(script, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // NOTE: no -WindowStyle Hidden (it suppresses the dialog on some machines).
    // windowsHide only hides the console; the GUI dialog still shows.
    exec(
      `"${PS_EXE}" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: err ? (err.message || String(err)) : String(stderr || '').trim()
      })
    );
  });
}

const PS_OWNER = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Show()
$owner.Activate()
`;

const PS_DIALOG_VISTA = `$ErrorActionPreference='Stop'
try {
${PS_OWNER}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Select Project Folder'
$d.Filter = 'Folders|*.none'
$d.FileName = 'Select This Folder'
$d.CheckFileExists = $false
$d.CheckPathExists = $true
$d.ValidateNames = $false
$d.DereferenceLinks = $false
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
  $p = [System.IO.Path]::GetDirectoryName($d.FileName)
  if (-not $p) { $p = $d.FileName }
  [Console]::Out.WriteLine($p)
} else { [Console]::Out.WriteLine('__CANCEL__') }
} catch { try { $owner.Close() } catch {}; [Console]::Out.WriteLine('__ERROR__' + $_.Exception.Message) }`;

const PS_DIALOG_CLASSIC = `$ErrorActionPreference='Stop'
try {
${PS_OWNER}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select Project Folder'
$d.ShowNewFolderButton = $true
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $d.SelectedPath) {
  [Console]::Out.WriteLine($d.SelectedPath)
} else { [Console]::Out.WriteLine('__CANCEL__') }
} catch { try { $owner.Close() } catch {}; [Console]::Out.WriteLine('__ERROR__' + $_.Exception.Message) }`;

const PS_DIALOG_SHELL = `$ErrorActionPreference='Stop'
try {
  $shell = New-Object -ComObject Shell.Application
  $f = $shell.BrowseForFolder(0, 'Select Project Folder', 0x0050, 0)
  if ($f -and $f.Self) { [Console]::Out.WriteLine($f.Self.Path) }
  else { [Console]::Out.WriteLine('__CANCEL__') }
} catch { [Console]::Out.WriteLine('__ERROR__' + $_.Exception.Message) }`;

async function openNativeFolderDialog() {
  if (process.platform !== 'win32') {
    return { path: null, cancelled: false, error: 'Native dialog unsupported on this OS' };
  }
  const strategies = [PS_DIALOG_VISTA, PS_DIALOG_CLASSIC, PS_DIALOG_SHELL];
  let lastErr = '';
  for (const script of strategies) {
    const r = await runPickerPowerShell(script);
    const lines = (r.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const line = lines[lines.length - 1] || '';
    if (line === '__CANCEL__') return { path: null, cancelled: true, error: null };
    if (line.startsWith('__ERROR__')) { lastErr = line.slice(9); continue; }
    if (line) {
      try {
        const st = await fs.stat(line);
        if (st.isDirectory()) return { path: line, cancelled: false, error: null };
      } catch {}
      lastErr = 'Invalid path returned: ' + line;
      continue;
    }
    lastErr = r.err || 'No output from PowerShell';
  }
  return { path: null, cancelled: false, error: lastErr || 'All native dialog strategies failed' };
}




let embeddedAckResolver = null;
function embeddedRequest(event, payload = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (embeddedAckResolver) { try { embeddedAckResolver(null); } catch {} }
    const timer = setTimeout(() => {
      embeddedAckResolver = null;
      reject(new Error('Embedded browser did not respond. Open the Browser panel once so the in-app webview initializes.'));
    }, timeoutMs);
    embeddedAckResolver = (data) => { clearTimeout(timer); embeddedAckResolver = null; resolve(data); };
    broadcast({ event, ...payload });
  });
}

let latestBrowserPage = { url: '', title: '', text: '' };

server.on('request', async (req, res) => {
  
  if (req.method === 'GET' && req.url === '/api/ws-token') {
    
    const host = req.headers['host'] || '';
    if (!host.startsWith('localhost:') && !host.startsWith('127.0.0.1:')) {
      res.writeHead(403);
      res.end();
      return;
    }
    const origin = req.headers['origin'] || req.headers['sec-websocket-origin'] || '';
    if (origin && !ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: WS_SECRET_TOKEN }));
    return;
  }

  
  if (req.method === 'GET' && (req.url || '').startsWith('/api/attachment')) {
    const host = req.headers['host'] || '';
    if (!host.startsWith('localhost:') && !host.startsWith('127.0.0.1:')) { res.writeHead(403); res.end(); return; }
    const u = new URL(req.url, `http://${host || 'localhost'}`);
    const token = u.searchParams.get('token') || '';
    const rel = u.searchParams.get('file') || '';
    const okToken = token.length === WS_SECRET_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(WS_SECRET_TOKEN, 'utf8'));
    if (!okToken) { res.writeHead(401); res.end(); return; }
    const root = path.resolve(ATTACH_DIR);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const buf = await fs.readFile(full);
      const ext = path.extname(full).toLowerCase();
      const MIME = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon', '.pdf': 'application/pdf',
        '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.md': 'text/plain; charset=utf-8',
        '.js': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8',
        '.jsx': 'text/plain; charset=utf-8', '.css': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8',
        '.rs': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8'
      };
      const origin2 = req.headers['origin'] || '';
      if (origin2 && ALLOWED_ORIGINS.some(o => origin2.startsWith(o))) res.setHeader('Access-Control-Allow-Origin', origin2);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(buf);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/browser-sync') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        latestBrowserPage = {
          url: payload.url || latestBrowserPage.url,
          title: payload.title || latestBrowserPage.title,
          text: payload.text || latestBrowserPage.text
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  // ◄◄◄ اضافه شود: کنترل مستقیم و زندهٔ مرورگر تب داخلی
  if (req.method === 'POST' && req.url === '/api/browser-action') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const page = await getEmbeddedWebviewPage();
        if (page) {
          if (payload.action === 'back') {
            await page.goBack().catch(() => {});
          } else if (payload.action === 'forward') {
            await page.goForward().catch(() => {});
          } else if (payload.action === 'reload') {
            await page.reload().catch(() => {});
          } else if (payload.action === 'navigate' && payload.url) {
            await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url: page.url() }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Webview not found' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ◄◄◄ دریافت آدرس و عنوان فعلی برای به‌روزرسانی خودکار نوار آدرس
  if (req.method === 'GET' && req.url === '/api/browser-info') {
    try {
      const page = await getEmbeddedWebviewPage();
      if (page) {
        const title = await page.title().catch(() => '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: page.url(), title }));
        return;
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: '', title: '' }));
    return;
  }
});

function extractReadableTextFromHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}




const { chromium } = require('playwright');

let cdpBrowser = null;


const CDP_PORT = process.env.MAGNUM_CDP_PORT || 9222;


async function getEmbeddedWebviewPage() {
  try {
    if (!cdpBrowser || !cdpBrowser.isConnected()) {
      cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 3000 });
      cdpBrowser.on('disconnected', () => {
        cdpBrowser = null;
      });
    }

    const contexts = cdpBrowser.contexts();
    for (const ctx of contexts) {
      const pages = ctx.pages();
      for (const p of pages) {
        const rawUrl = p.url() || '';
        const url = rawUrl.toLowerCase();

        // 1. Skip blank / devtools pages
        if (!url || url === 'about:blank' || url.startsWith('devtools://')) {
          continue;
        }

        // ۲. رد کردن قطعی پنجرهٔ اصلی توری بر اساس آدرس
        if (
          url.includes('tauri.localhost') ||
          url.includes('tauri://') ||
          url.includes('localhost:1420') ||
          url.includes('127.0.0.1:1420') ||
          url.endsWith('/index.html')
        ) {
          continue;
        }

        // ۳. رد کردن پنجره اصلی فقط در صورتی که ساختار نرم‌افزار مگنوم (نوار بالا، سایدبار) را داشته باشد
        const isMainMagNumUi = await p.evaluate(() => {
          return Boolean(
            document.querySelector('.installer-container') ||
            document.querySelector('.brand-indicator') ||
            (document.getElementById('root') && document.querySelector('nav'))
          );
        }).catch(() => false);

        if (isMainMagNumUi) {
          continue;
        }

        // Prevent target="_blank" links from opening new windows or escaping to main window
        await p.evaluate(() => {
          if (window.__magnum_nav_hooked) return;
          window.__magnum_nav_hooked = true;
          document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a') : null;
            if (a && a.href && (a.target === '_blank' || a.target === '_new')) {
              e.preventDefault();
              e.stopPropagation();
              window.location.href = a.href;
            }
          }, true);
          window.open = function(u) {
            if (u) window.location.href = u;
            return window;
          };
        }).catch(() => {});

        return p;
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

const browserTool = {
  
  async navigate(input) {
    let target = String(input || '').trim();
    if (!target) return { url: '', title: '', text: '' };

    if (!/^https?:\/\//i.test(target) && !target.startsWith('about:')) {
      if (target.includes('.') && !target.includes(' ')) {
        target = 'https://' + target;
      } else {
        target = `https://www.google.com/search?q=${encodeURIComponent(target)}&hl=fa`;
      }
    }

    const page = await getEmbeddedWebviewPage();
    if (page) {
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // یک مکث کوتاه برای بارگذاری محتوای داینامیک و فریم‌ورک‌های SPA (مثل Next.js دیجی‌کالا)
        await page.waitForTimeout(2000);

        const title = await page.title().catch(() => 'صفحه وب');
        const text = await page.evaluate(() => {
          if (!document.body) return '';
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
          return clone.innerText || '';
        }).catch(() => '');

        broadcast({ event: 'embedded_navigated', url: page.url(), title });
        return { url: page.url(), title, text };
      } catch (e) {
        console.warn('CDP Navigate error:', e.message);
      }
    }

    // در صورتی که وب‌ویو هنوز ساخته نشده بود
    try {
      const res = await embeddedRequest('embedded_navigate', { input: target });
      return res || { url: target, title: 'صفحه وب', text: '' };
    } catch {
      return { url: target, title: 'صفحه وب', text: '' };
    }
  },

  
  async readRange(start = 1, end = 150) {
    const page = await getEmbeddedWebviewPage();

    if (!page) {
      return {
        url: 'Embedded Browser',
        title: 'صفحه مرورگر باز نیست',
        totalLines: 0,
        lines: [{ lineNum: 1, text: 'پنل مرورگر فعال نیست یا آدرسی در آن بارگذاری نشده است.' }]
      };
    }

    let pageTitle = 'صفحه وب';
    let rawText = '';
    const currentUrl = page.url();

    try {
      pageTitle = await page.title().catch(() => 'صفحه وب');
      rawText = await page.evaluate(() => {
        if (!document.body) return '';
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
        return clone.innerText || '';
      }).catch(() => '');
    } catch (err) {
      rawText = `خطا در خواندن صفحه: ${err.message}`;
    }

    
    const lines = rawText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const s = Math.max(1, Number(start) || 1);
    const e = Math.min(lines.length, Number(end) || (s + 149));
    const out = [];

    for (let i = s; i <= e && i <= lines.length; i++) {
      out.push({ lineNum: i, text: lines[i - 1] });
    }

    return {
      url: currentUrl,
      title: pageTitle,
      totalLines: lines.length,
      lines: out
    };
  },

  async getState() {
    const page = await getEmbeddedWebviewPage();
    if (page) {
      return {
        url: page.url(),
        title: await page.title().catch(() => 'Browser')
      };
    }
    return { url: '', title: '' };
  }
};





const DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/sign_in';

async function detectDeepSeekAuthState(page) {
  if (!page || page.isClosed()) return { ok: false, status: 'closed', url: '' };
  try {
    const url = page.url();
    const flags = await page.evaluate(() => {
      const ph = (el) => (el.getAttribute && (el.getAttribute('placeholder') || '')) || '';
      const inputs = Array.from(document.querySelectorAll('input'));
      const phoneOrEmail = inputs.some(i => /phone number|email/i.test(ph(i)));
      const password = inputs.some(i => i.type === 'password' || /password/i.test(ph(i)));
      const loginBtn = Array.from(document.querySelectorAll('div[role="button"], button, a')).some(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return /^(log in|sign in)$/i.test(t);
      });
      const authForm = !!document.querySelector(
        '.ds-auth-form-wrapper, .ds-sign-in-form-wrapper, .ds-sign-in-form__main'
      );
      const rawToken = localStorage.getItem('userToken');
      let hasToken = false;
      if (rawToken) { try { const p = JSON.parse(rawToken); hasToken = !!(p && (p.value || p)); } catch { hasToken = rawToken.length > 10; } }
      const hasChatInput = !!document.querySelector('#chat-input, textarea#chat-input, textarea, [contenteditable="true"]');
      return { phoneOrEmail, password, loginBtn, authForm, hasToken, hasChatInput };
    }).catch(() => null);
    if (!flags) return { ok: false, status: 'loading', url };
    const authForm = flags.authForm;
    const onLoginPage = /\/sign_in|\/login/i.test(url) || (flags.phoneOrEmail && flags.password) || (authForm && flags.loginBtn);
    if (onLoginPage || (!flags.hasToken && flags.loginBtn && !flags.hasChatInput)) return { ok: false, status: 'login_page', url };
    if (!flags.hasChatInput) return { ok: false, status: 'no_input', url };
    return { ok: true, status: 'ready', url };
  } catch (e) {
    return { ok: false, status: 'error', url: '', message: e && e.message };
  }
}

function attachDeepSeekPageHandlers(page) {
  if (!page) return;
  page.on('close', () => {
    activePage = null;
    browserContext = null;
    if (loginCheckTimer) { clearInterval(loginCheckTimer); loginCheckTimer = null; }
    deepseekStatus = 'disconnected';
    broadcastProviders();
  });
}

function startLoginWatchdog() {
  if (loginCheckTimer) { clearInterval(loginCheckTimer); loginCheckTimer = null; }
  loginCheckTimer = setInterval(async () => {
    if (!activePage || activePage.isClosed()) { clearInterval(loginCheckTimer); loginCheckTimer = null; return; }
    const st = await detectDeepSeekAuthState(activePage);
    if (st.ok) {
      clearInterval(loginCheckTimer);
      loginCheckTimer = null;
      await switchToBackground();
      broadcast({ event: 'agent_status', text: tS('reloginDone') });
    }
  }, 3000);
}

let deepSeekRecoveryRunning = false;
async function handleDeepSeekSessionExpired(source = 'check') {
  if (deepSeekRecoveryRunning) return true;
  deepSeekRecoveryRunning = true;
  try {
    console.warn(`🔐 [${source}] DeepSeek session expired / window missing — recovery flow started.`);
    
    if (!browserContext || !activePage || activePage.isClosed()) {
      try {
        browserContext = await launchStealthContext(PROFILE_DIR, { headless: false });
        activePage = await consolidateProviderTabs(browserContext, 'chat.deepseek.com');
        attachDeepSeekPageHandlers(activePage);
      } catch (e) {
        broadcast({ event: 'error', message: tS('closed') });
        return false;
      }
    }
    
    try {
      const st = await detectDeepSeekAuthState(activePage);
      const url = activePage.url();
      if (st.status === 'login_page' || st.status === 'closed') {
        if (!/\/sign_in|\/login/i.test(url)) {
          await activePage.goto(DEEPSEEK_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await activePage.waitForTimeout(800);
        }
      } else if (st.status === 'no_input' && !url.includes('chat.deepseek.com')) {
        await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
    } catch (e) { console.warn('login navigate warning:', e.message); }
    
    deepseekStatus = 'connecting'; activeProvider = 'deepseek'; broadcastProviders();
    toggleBrowserVisibility(5);
    broadcast({ event: 'login_browser_opened', provider: 'deepseek', message: tS('sessionExpired') });
    broadcast({ event: 'agent_status', text: tS('sessionExpired') });
    logTerminal('DeepSeek session expired — window shown on login page; waiting for user login.', 'err');
    
    startLoginWatchdog();
    return true;
  } finally {
    deepSeekRecoveryRunning = false;
  }
}


async function diagnoseSession(page) {
  if (!page || page.isClosed()) {
    return { ok: false, status: 'closed', message: tS('closed') };
  }

  try {
    const url = page.url();
    const title = await page.title().catch(() => '');

    
    const isCloudflare = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText.trim() : '';
      const hasCfTitle = document.title.includes('Just a moment') || document.title.includes('Attention Required');
      
      
      const stage = document.querySelector('#challenge-stage, #turnstile-wrapper, iframe[src*="challenges.cloudflare.com"]');
      let hasVisibleStage = false;
      if (stage) {
        const r = stage.getBoundingClientRect();
        hasVisibleStage = r.width > 0 && r.height > 0 && stage.offsetParent !== null;
      }
      const hasCfText = /verify you are human|cloudflare ray id|checking your browser|please complete the security verification/i.test(bodyText);
      const isShort = bodyText.length < 400;
      const hasChatInput = !!document.querySelector('#chat-input, textarea#chat-input, textarea, [contenteditable="true"]');
      
      if (hasChatInput) return false;
      return hasCfTitle || hasVisibleStage || (hasCfText && isShort);
    }).catch(() => false);

    if (isCloudflare) {
      return {
        ok: false,
        status: 'cloudflare',
        message: tS('cfChallenge'),
        url,
        title
      };
    }

    
    
    
    
    const suspension = await page.evaluate(() => {
      const kw = /violation of user policies|account has been suspended|temporarily suspended|suspended until/i;
      const bodyText = document.body ? document.body.innerText : '';
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (clone) {
        clone.querySelectorAll(
          '[class*="user-message"], [class*="UserMessage"], [class*="ds-markdown"], [class*="code-block"], pre, code, textarea, [contenteditable="true"]'
        ).forEach(el => el.remove());
      }
      const chromeText = clone ? (clone.innerText || '') : '';
      const inputEl = document.querySelector('#chat-input, textarea#chat-input, textarea, [contenteditable="true"]');
      const composerUsable = !!inputEl && !inputEl.hasAttribute('disabled') && !inputEl.readOnly;
      const match =
        chromeText.match(/Due to violation of user policies[\s\S]*?(?:suspended until [^\n.]+)/i) ||
        bodyText.match(/Due to violation of user policies[\s\S]*?(?:suspended until [^\n.]+)/i);
      return {
        inBody: kw.test(bodyText),
        inChrome: kw.test(chromeText),
        composerUsable,
        notice: match ? match[0] : 'Due to violation of user policies, your account has been suspended.'
      };
    }).catch(() => null);
    if (suspension && suspension.inBody) {
      
      if (!suspension.composerUsable) {
        return { ok: false, status: 'suspended', message: tS('suspended', suspension.notice), url, title };
      }
      
      console.warn('[diagnose] Suspension keywords seen but composer is usable — ignoring chat-history artifact.');
    }

    
    const hasCaptcha = await page.evaluate(() => {
      const inputEl = document.querySelector('#chat-input, textarea#chat-input, textarea, [contenteditable="true"]');
      const isInputReady = inputEl && !inputEl.hasAttribute('disabled') && inputEl.offsetParent !== null;

      const modalEl = document.querySelector('[role="dialog"], .ds-modal, .ds-dialog, .ds-modal-mask, [class*="modal-wrapper"], [class*="modal-overlay"]');
      const isModalVisible = modalEl && (() => {
        const s = window.getComputedStyle(modalEl);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      })();

      if (isInputReady && !isModalVisible) {
        return false;
      }

      const iframes = Array.from(document.querySelectorAll('iframe'));
      return iframes.some(f => {
        const src = (f.getAttribute('src') || '').toLowerCase();
        const title = (f.getAttribute('title') || '').toLowerCase();
        const isCaptchaSrc = src.includes('hcaptcha.com') || src.includes('challenges.cloudflare.com') || title.includes('hcaptcha');
        if (!isCaptchaSrc) return false;

        const rect = f.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 120) return false;

        const s = window.getComputedStyle(f);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && f.offsetParent !== null;
      });
    }).catch(() => false);

    if (hasCaptcha) {
      return {
        ok: false,
        status: 'captcha',
        message: tS('captchaRequired'),
        url,
        title
      };
    }

  
  const auth = await detectDeepSeekAuthState(page);
  if (!auth.ok) {
    if (auth.status === 'login_page') return { ok: false, status: 'not_logged_in', message: tS('sessionExpired'), url, title };
    if (auth.status === 'no_input')  return { ok: false, status: 'no_input', message: tS('noInput'), url, title };
    return { ok: false, status: 'loading', message: tS('loading'), url, title };
  }
  return { ok: true, status: 'ready', message: tS('ready'), url, title };
  } catch (err) {
    return { ok: false, status: 'error', message: tS('errCheck', err.message) };
  }
}

async function checkIsLoggedIn(page) {
  if (!page || page.isClosed()) return false;
  try {
    const diag = await diagnoseSession(page);
    return diag.ok && diag.status === 'ready';
  } catch {
    return false;
  }
}

async function switchToBackground() {
  if (loginCheckTimer) {
    clearInterval(loginCheckTimer);
    loginCheckTimer = null;
  }
  broadcast({ event: 'agent_status', text: 'Making browser invisible (Windows API)...' });
  
  
  toggleBrowserVisibility(0);
  logTerminal('Browser hidden; engine running in background.', 'sys');
  
    if (activePage && !activePage.isClosed()) {
    const diag = await diagnoseSession(activePage);
    if (diag.ok) {
      broadcast({ event: 'logged_in', email: 'DeepSeek Active (Invisible)' });
      broadcast({ event: 'agent_status', text: 'Ready! Invisible engine active.' });
      deepseekStatus = 'connected'; activeProvider = 'deepseek'; broadcastProviders();
      
      const driver = new DeepSeekDriver(activePage);
      const dtState = await driver.getDeepThinkState();
      if (typeof dtState === 'boolean') {
        broadcast({ event: 'deep_think_status', enabled: dtState });
      }
    }
  }
}

async function openVisibleBrowser() {
  if (loginCheckTimer) clearInterval(loginCheckTimer);
  if (geminiContext) await parkAndCloseGemini();
  deepseekStatus = 'connecting'; activeProvider = 'deepseek'; broadcastProviders();
  broadcast({ event: 'agent_status', text: 'Showing browser window...' });

  if (!browserContext) {
    browserContext = await launchStealthContext(PROFILE_DIR, { headless: false });
    activePage = await consolidateProviderTabs(browserContext, 'chat.deepseek.com');
    
    activePage.on('close', () => {
      activePage = null;
      browserContext = null;
      if (loginCheckTimer) clearInterval(loginCheckTimer);
    });
    if (!activePage.url().includes('chat.deepseek.com')) {
      await activePage.goto('https://chat.deepseek.com/');
    }
  }

  
  toggleBrowserVisibility(5);
  broadcast({ event: 'login_browser_opened', provider: 'deepseek', message: 'Browser window is open.' });
  logTerminal('Stealth browser window shown on desktop.', 'sys');
  const st = await detectDeepSeekAuthState(activePage);
  if (st.ok) { await switchToBackground(); }
  else { await handleDeepSeekSessionExpired('open_browser'); }
}

function broadcastProviders() {
  broadcast({ event: 'providers_status', deepseek: deepseekStatus, gemini: geminiStatus, chatgpt: chatgptStatus, active: activeProvider });
}
async function parkAndCloseDeepSeek() {
  clearStagingState('deepseek');
  if (runningAgent) { runningAgent.stop(); runningAgent = null; }
  if (loginCheckTimer) { clearInterval(loginCheckTimer); loginCheckTimer = null; }
  if (browserContext) {
    try { if (activePage && !activePage.isClosed()) await new DeepSeekDriver(activePage).parkTab(); } catch {}
    try { await browserContext.close(); } catch {}
    browserContext = null; activePage = null;
  }
  deepseekStatus = 'disconnected';
  broadcast({ event: 'logged_out' });
  logTerminal('DeepSeek parked & closed to free RAM (Gemini takes over).', 'sys');
}
async function parkAndCloseGemini() {
  clearStagingState('gemini');
  if (geminiLoginCheckTimer) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; }
  if (geminiContext) {
    try { await geminiContext.close(); } catch {}
    geminiContext = null; activeGeminiPage = null;
  }
  geminiStatus = 'disconnected';
  broadcast({ event: 'gemini_logged_out' });
  logTerminal('Gemini closed to free RAM (DeepSeek takes over).', 'sys');
}
async function diagnoseGeminiSession(page) {
  if (!page || page.isClosed()) return { ok: false, status: 'closed', message: tS('closed') };
  try {
    const url = page.url();
    const flags = await page.evaluate(() => {
      const onAccounts = location.href.includes('accounts.google.com');
      const hasGoogleEmailInput = !!document.querySelector('input#identifierId, input[type="email"][name="identifier"], input[aria-label="Email or phone"]');
      const hasSignIn = Array.from(document.querySelectorAll('button, a')).some(el => {
        const t = (el.innerText || '').trim();
        return t === 'Sign in' || t === 'Sign in to save activity';
      });
      const hasInput = !!document.querySelector(
        'textarea[placeholder*="Start typing"], ms-prompt-textarea textarea, textarea[aria-label*="prompt" i], div[contenteditable="true"][role="textbox"], textarea'
      );
      return { onAccounts, hasGoogleEmailInput, hasSignIn, hasInput };
    }).catch(() => null);
    if (!flags) return { ok: false, status: 'loading', message: tS('loading'), url };
    if (flags.onAccounts || flags.hasGoogleEmailInput) return { ok: false, status: 'google_login', message: tS('geminiGoogleLogin'), url };
    if (flags.hasSignIn) return { ok: false, status: 'not_logged_in', message: tS('geminiNotLoggedIn'), url };
    if (!flags.hasInput) return { ok: false, status: 'no_input', message: tS('geminiNoInput'), url };
    return { ok: true, status: 'ready', message: tS('geminiReady'), url };
  } catch (err) {
    return { ok: false, status: 'error', message: tS('errCheck', err.message) };
  }
}
function switchGeminiToBackground() {
  toggleBrowserVisibility(0, path.basename(GEMINI_PROFILE_DIR));
  logTerminal('Gemini hidden; engine running in background.', 'sys');
  broadcast({ event: 'agent_status', text: 'Ready! Gemini invisible engine active.' });
}

// ◄◄◄ NEW: Central provider-switch logic ►►►
let providerSwitchInProgress = false;

async function ensureProviderConnected(provider) {
  let waitCount = 0;
  while (providerSwitchInProgress && waitCount < 20) { await new Promise(r => setTimeout(r, 500)); waitCount++; }

  const isActive = (p) =>
    p === 'gemini' ? (activeGeminiPage && !activeGeminiPage.isClosed() && geminiStatus === 'connected') :
    p === 'chatgpt' ? (activeChatGptPage && !activeChatGptPage.isClosed() && chatgptStatus === 'connected') :
    (activePage && !activePage.isClosed() && deepseekStatus === 'connected');

  const parkOthers = async (keep) => {
    if (keep !== 'deepseek' && browserContext) await parkAndCloseDeepSeek();
    if (keep !== 'gemini' && geminiContext) await parkAndCloseGemini();
    if (keep !== 'chatgpt' && chatgptContext) await parkAndCloseChatGpt();
  };

  if (isActive(provider)) {
    await parkOthers(provider);
    activeProvider = provider; broadcastProviders();
    return { ok: true };
  }

  providerSwitchInProgress = true;
  try {
    await parkOthers(provider);

    if (provider === 'chatgpt') {
      if (!activeChatGptPage || activeChatGptPage.isClosed()) {
        if (!chatgptContext) chatgptContext = await launchStealthContext(CHATGPT_PROFILE_DIR, { headless: false });
        activeChatGptPage = await consolidateProviderTabs(chatgptContext, 'chatgpt.com');
        attachChatGptPageHandlers(activeChatGptPage);
        chatgptContext.on('page', (p) => {
          setTimeout(() => { try { if (chatgptContext && p !== activeChatGptPage && !p.isClosed()) p.close().catch(() => {}); } catch {} }, 1500);
        });
        if (!/chatgpt\.com/.test(activeChatGptPage.url())) {
          await activeChatGptPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        }
      }
      toggleBrowserVisibility(0, path.basename(CHATGPT_PROFILE_DIR));
      const diag = await diagnoseChatGptSession(activeChatGptPage);
      if (diag.ok) {
        // Clear any leftover draft on a fresh chat page.
        if (!/chatgpt\.com\/c\//.test(activeChatGptPage.url())) {
          await new ChatGptDriver(activeChatGptPage).clearComposer().catch(() => {});
        }
        chatgptStatus = 'connected'; activeProvider = 'chatgpt'; broadcastProviders();
        new ChatGptDriver(activeChatGptPage).setThinkEnabled(chatgptThinkEnabled).catch(() => {});
        flushStaging('chatgpt').catch(() => {});
        return { ok: true };
      }
      chatgptStatus = 'connecting'; activeProvider = 'chatgpt'; broadcastProviders();
      if (diag.status === 'not_logged_in') {
        try { await activeChatGptPage.goto(CHATGPT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
      }
      toggleBrowserVisibility(5, path.basename(CHATGPT_PROFILE_DIR));
      broadcast({ event: 'login_browser_opened', provider: 'chatgpt', message: diag.message });
      broadcast({ event: 'agent_status', text: diag.message });
      startChatGptLoginWatchdog();
      return { ok: false, message: diag.message };
    }

    if (provider === 'gemini') {
      if (!activeGeminiPage || activeGeminiPage.isClosed()) {
        if (!geminiContext) geminiContext = await launchStealthContext(GEMINI_PROFILE_DIR, { headless: false });
        activeGeminiPage = await consolidateProviderTabs(geminiContext, 'aistudio.google.com');
        activeGeminiPage.on('close', () => {
          activeGeminiPage = null; geminiContext = null; geminiStatus = 'disconnected';
          if (activeProvider === 'gemini') activeProvider = null;
          if (geminiLoginCheckTimer) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; }
          broadcastProviders();
        });
        geminiContext.on('page', (p) => {
          setTimeout(() => { try { if (geminiContext && p !== activeGeminiPage && !p.isClosed()) p.close().catch(() => {}); } catch {} }, 1500);
        });
        if (!activeGeminiPage.url().includes('aistudio.google.com/prompts')) {
          await activeGeminiPage.goto(AI_STUDIO_NEW_CHAT, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
      }
      toggleBrowserVisibility(0, path.basename(GEMINI_PROFILE_DIR));
      const diag = await diagnoseGeminiSession(activeGeminiPage);
      if (diag.ok) { geminiStatus = 'connected'; activeProvider = 'gemini'; broadcastProviders(); flushStaging('gemini').catch(() => {}); return { ok: true }; }
      geminiStatus = 'connecting'; activeProvider = 'gemini'; broadcastProviders();
      toggleBrowserVisibility(5, path.basename(GEMINI_PROFILE_DIR));
      broadcast({ event: 'login_browser_opened', provider: 'gemini', message: diag.message });
      broadcast({ event: 'agent_status', text: diag.message });
      if (geminiLoginCheckTimer) clearInterval(geminiLoginCheckTimer);
      geminiLoginCheckTimer = setInterval(async () => {
        if (!activeGeminiPage || activeGeminiPage.isClosed()) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; return; }
        const d = await diagnoseGeminiSession(activeGeminiPage);
        if (d.ok) {
          clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null;
          geminiStatus = 'connected'; activeProvider = 'gemini'; broadcastProviders();
          flushStaging('gemini').catch(() => {});
          broadcast({ event: 'gemini_logged_in', message: d.message });
          switchGeminiToBackground();
        }
      }, 3000);
      return { ok: false, message: diag.message };
    }

    // deepseek
    if (!activePage || activePage.isClosed()) {
      if (!browserContext) browserContext = await launchStealthContext(PROFILE_DIR, { headless: false });
      activePage = await consolidateProviderTabs(browserContext, 'chat.deepseek.com');
      attachDeepSeekPageHandlers(activePage);
      if (!activePage.url().includes('chat.deepseek.com')) {
        await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
    }
    toggleBrowserVisibility(0, path.basename(PROFILE_DIR));
    const diag = await diagnoseSession(activePage);
    if (diag.ok) { deepseekStatus = 'connected'; activeProvider = 'deepseek'; broadcastProviders(); flushStaging('deepseek').catch(() => {}); return { ok: true }; }
    deepseekStatus = 'connecting'; activeProvider = 'deepseek'; broadcastProviders();
    if (diag.status === 'not_logged_in' || diag.status === 'login_page' || diag.status === 'no_input') {
      await handleDeepSeekSessionExpired('ensure_provider');
      return { ok: false, message: tS('sessionExpired') };
    }
    return { ok: false, message: diag.message };
  } finally {
    providerSwitchInProgress = false;
  }
}
// ►►► END NEW

async function parkAndCloseChatGpt() {
  clearStagingState('chatgpt');
  if (chatgptLoginCheckTimer) { clearInterval(chatgptLoginCheckTimer); chatgptLoginCheckTimer = null; }
  if (chatgptContext) {
    try { if (activeChatGptPage && !activeChatGptPage.isClosed()) await new ChatGptDriver(activeChatGptPage).parkTab(); } catch {}
    try { await chatgptContext.close(); } catch {}
    chatgptContext = null; activeChatGptPage = null;
  }
  chatgptStatus = 'disconnected';
  if (activeProvider === 'chatgpt') activeProvider = null;
  broadcast({ event: 'chatgpt_logged_out' });
  logTerminal('ChatGPT closed to free RAM.', 'sys');
}

function attachChatGptPageHandlers(page) {
  if (!page) return;
  page.on('close', () => {
    activeChatGptPage = null; chatgptContext = null;
    if (chatgptLoginCheckTimer) { clearInterval(chatgptLoginCheckTimer); chatgptLoginCheckTimer = null; }
    chatgptStatus = 'disconnected';
    if (activeProvider === 'chatgpt') activeProvider = null;
    broadcastProviders();
  });
}

async function diagnoseChatGptSession(page) {
  if (!page || page.isClosed()) return { ok: false, status: 'closed', message: tS('closed') };
  try {
    const st = await new ChatGptDriver(page).getAuthState();
    const url = st.url || page.url();
    if (st.status === 'captcha') return { ok: false, status: 'captcha', message: tS('cfChallenge'), url };
    if (st.status === 'login_page') return { ok: false, status: 'not_logged_in', message: tS('chatgptLogin'), url };
    if (st.status === 'no_input') return { ok: false, status: 'no_input', message: tS('chatgptNoInput'), url };
    if (st.status === 'loading') return { ok: false, status: 'loading', message: tS('loading'), url };
    return { ok: true, status: 'ready', message: tS('chatgptReady'), url };
  } catch (err) {
    return { ok: false, status: 'error', message: tS('errCheck', err.message) };
  }
}

function switchChatGptToBackground() {
  toggleBrowserVisibility(0, path.basename(CHATGPT_PROFILE_DIR));
  logTerminal('ChatGPT hidden; engine running in background.', 'sys');
  broadcast({ event: 'agent_status', text: 'Ready! ChatGPT invisible engine active.' });
}

function startChatGptLoginWatchdog() {
  if (chatgptLoginCheckTimer) clearInterval(chatgptLoginCheckTimer);
  chatgptLoginCheckTimer = setInterval(async () => {
    if (!activeChatGptPage || activeChatGptPage.isClosed()) { clearInterval(chatgptLoginCheckTimer); chatgptLoginCheckTimer = null; return; }
    const d = await diagnoseChatGptSession(activeChatGptPage);
    if (d.ok) {
      clearInterval(chatgptLoginCheckTimer); chatgptLoginCheckTimer = null;
      chatgptStatus = 'connected'; activeProvider = 'chatgpt';
      broadcastProviders();
      flushStaging('chatgpt').catch(() => {});
      broadcast({ event: 'chatgpt_logged_in', message: d.message });
      switchChatGptToBackground();
      new ChatGptDriver(activeChatGptPage).setThinkEnabled(chatgptThinkEnabled).catch(() => {});
      // Clear any leftover draft on a fresh chat page after login.
      if (!/chatgpt\.com\/c\//.test(activeChatGptPage.url())) {
        new ChatGptDriver(activeChatGptPage).clearComposer().catch(() => {});
      }
    }
  }, 3000);
}

let chatgptOpenInProgress = null;
async function openChatGptBrowser() {
  if (chatgptOpenInProgress) return chatgptOpenInProgress;
  chatgptOpenInProgress = (async () => {
    if (chatgptLoginCheckTimer) clearInterval(chatgptLoginCheckTimer);
    if (browserContext) await parkAndCloseDeepSeek();
    if (geminiContext) await parkAndCloseGemini();
    broadcast({ event: 'agent_status', text: 'Showing ChatGPT browser window...' });
    if (!chatgptContext) {
      chatgptContext = await launchStealthContext(CHATGPT_PROFILE_DIR, { headless: false });
    }
    if (!activeChatGptPage || activeChatGptPage.isClosed()) {
      activeChatGptPage = await consolidateProviderTabs(chatgptContext, 'chatgpt.com');
      attachChatGptPageHandlers(activeChatGptPage);
      chatgptContext.on('page', (p) => {
        setTimeout(() => { try { if (chatgptContext && p !== activeChatGptPage && !p.isClosed()) p.close().catch(() => {}); } catch {} }, 1500);
      });
      if (!/chatgpt\.com/.test(activeChatGptPage.url())) {
        await activeChatGptPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      }
    }
    toggleBrowserVisibility(5, path.basename(CHATGPT_PROFILE_DIR));
    const diag = await diagnoseChatGptSession(activeChatGptPage);
    if (diag.ok) {
      // Clear any leftover draft when the current page is a fresh chat.
      if (!/chatgpt\.com\/c\//.test(activeChatGptPage.url())) {
        await new ChatGptDriver(activeChatGptPage).clearComposer().catch(() => {});
      }
      chatgptStatus = 'connected'; activeProvider = 'chatgpt';
      broadcastProviders();
      flushStaging('chatgpt').catch(() => {});
      switchChatGptToBackground();
      return;
    }
    chatgptStatus = 'connecting'; activeProvider = 'chatgpt';
    broadcastProviders();
    if (diag.status === 'not_logged_in') {
      try { await activeChatGptPage.goto(CHATGPT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
    }
    broadcast({ event: 'login_browser_opened', provider: 'chatgpt', message: diag.message });
    logTerminal('ChatGPT window shown; waiting for login...', 'sys');
    startChatGptLoginWatchdog();
  })();
  try { return await chatgptOpenInProgress; } finally { chatgptOpenInProgress = null; }
}

async function consolidateProviderTabs(context, urlMarker) {
  if (!context) return null;
  const pages = context.pages().filter(p => !p.isClosed());
  let keep = pages.find(p => p.url().includes(urlMarker)) || pages[0] || null;
  if (!keep) keep = await context.newPage();
  for (const p of pages) {
    if (p !== keep) await p.close().catch(() => {});
  }
  return keep;
}

// ═══════════ ATTACHMENT PRE-STAGING (pre-upload on file drop) ═══════════
const STAGE_DIR = path.join(ATTACH_DIR, '_staged');
const staging = {
  deepseek: { entries: new Map(), queue: Promise.resolve() },
  gemini:   { entries: new Map(), queue: Promise.resolve() },
  chatgpt:  { entries: new Map(), queue: Promise.resolve() }
};
function enqueueStaging(provider, fn) {
  const st = staging[provider];
  if (!st) return Promise.resolve();
  const run = st.queue.then(fn).catch(e => console.warn(`[staging:${provider}]`, e && e.message));
  st.queue = run;
  return run;
}
function waitStagingIdle(provider, timeoutMs = 180000) {
  const st = staging[provider];
  if (!st) return Promise.resolve();
  return Promise.race([st.queue, new Promise(r => setTimeout(r, timeoutMs))]);
}
function providerPage(provider) {
  return provider === 'gemini' ? activeGeminiPage
    : provider === 'chatgpt' ? activeChatGptPage : activePage;
}
function providerConnected(provider) {
  const page = providerPage(provider);
  const status = provider === 'gemini' ? geminiStatus : provider === 'chatgpt' ? chatgptStatus : deepseekStatus;
  return Boolean(page && !page.isClosed() && status === 'connected');
}
function makeDriver(provider) {
  const page = providerPage(provider);
  if (!page || page.isClosed()) return null;
  return provider === 'gemini' ? new GeminiDriver(page)
    : provider === 'chatgpt' ? new ChatGptDriver(page) : new DeepSeekDriver(page);
}
async function saveStagedFile(provider, att) {
  const base64Data = String(att.base64 || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(base64Data, 'base64');
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const dir = path.join(STAGE_DIR, provider);
  await fs.mkdir(dir, { recursive: true });
  const safeName = String(att.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-120) || 'file';
  let fileName = `${hash}-${safeName}`;
  let full = path.join(dir, fileName);
  try { await fs.access(full); }
  catch {
    const ext = path.extname(safeName);
    fileName = `${hash}-${Date.now().toString(36)}${ext}`;
    full = path.join(dir, fileName);
    await fs.writeFile(full, buf);
  }
  return { hash, path: full, name: att.name || safeName, size: att.size || buf.length, type: att.type || '' };
}
async function stageOneAttachment(provider, att) {
  if (!att || !att.id || !att.base64) return;
  const st = staging[provider];
  const existing = st.entries.get(att.id);
  if (existing && (existing.status === 'ready' || existing.status === 'uploaded')) return;
  const saved = await saveStagedFile(provider, att);
  const entry = { id: att.id, ...saved, status: 'queued', uploaded: false };
  st.entries.set(att.id, entry);
  if (!providerConnected(provider)) {
    logTerminal(`Attachment queued for ${provider} (will upload on connect): ${entry.name}`, 'sys');
    return;
  }
  const driver = makeDriver(provider);
  if (!driver) return;
  broadcast({ event: 'agent_status', text: `Uploading ${entry.name} to ${provider}…` });
  await driver.uploadFiles([entry.path]);
  entry.uploaded = true;
  entry.status = 'uploaded';
  logTerminal(`Pre-uploaded to ${provider}: ${entry.name}`, 'sys');
}
async function flushStaging(provider) {
  return enqueueStaging(provider, async () => {
    if (!providerConnected(provider)) return;
    const pending = Array.from(staging[provider].entries.values()).filter(e => !e.uploaded);
    if (!pending.length) return;
    const driver = makeDriver(provider);
    if (!driver) return;
    try {
      await driver.uploadFiles(pending.map(e => e.path));
      for (const e of pending) { e.uploaded = true; e.status = 'uploaded'; }
      logTerminal(`Flushed ${pending.length} queued attachment(s) to ${provider}.`, 'sys');
      broadcast({ event: 'agent_status', text: `${pending.length} queued attachment(s) uploaded to ${provider}.` });
    } catch (e) { console.warn(`[staging:${provider}] flush failed:`, e && e.message); }
  });
}
function clearStagingState(provider) {
  const st = staging[provider];
  if (!st) return;
  for (const e of st.entries.values()) { try { fsSync.unlinkSync(e.path); } catch {} }
  st.entries.clear();
}
async function clearProviderStaging(provider, { cleanPage = true } = {}) {
  const st = staging[provider];
  if (!st) return;
  const uploaded = Array.from(st.entries.values()).filter(e => e.uploaded);
  if (cleanPage && uploaded.length) {
    const driver = makeDriver(provider);
    if (driver && typeof driver.clearStagedMedia === 'function') {
      try { await driver.clearStagedMedia(uploaded.map(e => e.name)); } catch {}
    }
  }
  clearStagingState(provider);
}
async function unstageOne(provider, id) {
  const st = staging[provider];
  const entry = st && st.entries.get(id);
  if (!entry) return;
  st.entries.delete(id);
  if (entry.uploaded) {
    const driver = makeDriver(provider);
    if (driver && typeof driver.clearStagedMedia === 'function') {
      try { await driver.clearStagedMedia([entry.name]); } catch {}
    }
  }
  try { await fs.unlink(entry.path); } catch {}
}
(async () => {
  try {
    const root = STAGE_DIR;
    if (!fsSync.existsSync(root)) return;
    for (const prov of fsSync.readdirSync(root)) {
      const dir = path.join(root, prov);
      for (const f of fsSync.readdirSync(dir)) {
        const full = path.join(dir, f);
        try { if (Date.now() - fsSync.statSync(full).mtimeMs > 24 * 3600 * 1000) fsSync.unlinkSync(full); } catch {}
      }
    }
  } catch {}
})();
// ►►► END STAGING

let geminiOpenInProgress = null;
async function openGeminiBrowser() {
  if (geminiOpenInProgress) return geminiOpenInProgress; 
  geminiOpenInProgress = openGeminiBrowserInner();
  try { return await geminiOpenInProgress; } finally { geminiOpenInProgress = null; }
}
async function openGeminiBrowserInner() {
  if (geminiLoginCheckTimer) clearInterval(geminiLoginCheckTimer);
  if (browserContext) await parkAndCloseDeepSeek();
  broadcast({ event: 'agent_status', text: 'Showing Gemini browser window...' });
  if (!geminiContext) {
    geminiContext = await launchStealthContext(GEMINI_PROFILE_DIR, { headless: false });
    activeGeminiPage = await consolidateProviderTabs(geminiContext, 'aistudio.google.com');
    activeGeminiPage.on('close', () => {
      activeGeminiPage = null; geminiContext = null;
      geminiStatus = 'disconnected';
      if (activeProvider === 'gemini') activeProvider = null;
      if (geminiLoginCheckTimer) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; }
      broadcastProviders();
    });
    
    geminiContext.on('page', (p) => {
      setTimeout(() => {
        try { if (geminiContext && p !== activeGeminiPage && !p.isClosed()) p.close().catch(() => {}); } catch {}
      }, 1500);
    });
    if (!activeGeminiPage.url().includes('aistudio.google.com/prompts')) {
      await activeGeminiPage.goto(AI_STUDIO_NEW_CHAT, { waitUntil: 'domcontentloaded' });
    }
  }
  toggleBrowserVisibility(5, path.basename(GEMINI_PROFILE_DIR));
  const diag = await diagnoseGeminiSession(activeGeminiPage);
  if (diag.ok) {
    geminiStatus = 'connected'; activeProvider = 'gemini';
    broadcastProviders();
    switchGeminiToBackground();
    new GeminiDriver(activeGeminiPage).ensureModel().catch(() => {});
    return;
  }
  geminiStatus = 'connecting'; activeProvider = 'gemini';
  broadcastProviders();
  broadcast({ event: 'login_browser_opened', provider: 'gemini', message: diag.message });
  logTerminal('Gemini window shown; waiting for Google login...', 'sys');
  geminiLoginCheckTimer = setInterval(async () => {
    if (!activeGeminiPage || activeGeminiPage.isClosed()) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; return; }
    const d = await diagnoseGeminiSession(activeGeminiPage);
    if (d.ok) {
      clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null;
      geminiStatus = 'connected'; activeProvider = 'gemini';
      broadcastProviders();
      broadcast({ event: 'gemini_logged_in', message: d.message });
      switchGeminiToBackground();
    }
  }, 3000);
}

wss.on('connection', (ws) => {
  console.log('🔌 MagNum UI connected to Engine');
  
  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    try {
    if (data.action === 'login' || data.action === 'open_browser') {
      try {
        await openVisibleBrowser();
      } catch (err) {
        broadcast({ event: 'error', message: `Failed to open browser: ${err.message}` });
      }
    }

    if (data.action === 'connect_gemini' || data.action === 'open_gemini_browser') {
      try {
        await openGeminiBrowser();
      } catch (err) {
        broadcast({ event: 'error', message: `Failed to open Gemini browser: ${err.message}` });
      }
    }
    if (data.action === 'connect_chatgpt' || data.action === 'open_chatgpt_browser') {
      try { await openChatGptBrowser(); }
      catch (err) { broadcast({ event: 'error', message: `Failed to open ChatGPT browser: ${err.message}` }); }
    }
    if (data.action === 'show_gemini_browser') {
      toggleBrowserVisibility(5, path.basename(GEMINI_PROFILE_DIR));
    }
        
        if (data.action === 'show_provider_browser') {
          const prov = data.provider === 'gemini' ? 'gemini' : data.provider === 'chatgpt' ? 'chatgpt' : 'deepseek';
          const page = prov === 'gemini' ? activeGeminiPage : prov === 'chatgpt' ? activeChatGptPage : activePage;
          const dir = prov === 'gemini' ? GEMINI_PROFILE_DIR : prov === 'chatgpt' ? CHATGPT_PROFILE_DIR : PROFILE_DIR;
          if (page && !page.isClosed()) {
            toggleBrowserVisibility(5, path.basename(dir));
            broadcast({ event: 'agent_status', text: `${prov === 'gemini' ? 'Gemini' : prov === 'chatgpt' ? 'ChatGPT' : 'DeepSeek'} browser window brought to front (same tab).` });
          } else {
            broadcast({ event: 'agent_status', text: prov === 'chatgpt' ? tS('chatgptNotConnected') : prov === 'gemini' ? tS('geminiNotConnected') : tS('closed') });
          }
        }
        if (data.action === 'hide_provider_browser') {
          const prov = data.provider === 'gemini' ? 'gemini' : data.provider === 'chatgpt' ? 'chatgpt' : 'deepseek';
          const page = prov === 'gemini' ? activeGeminiPage : prov === 'chatgpt' ? activeChatGptPage : activePage;
          const dir = prov === 'gemini' ? GEMINI_PROFILE_DIR : prov === 'chatgpt' ? CHATGPT_PROFILE_DIR : PROFILE_DIR;
          if (page && !page.isClosed()) toggleBrowserVisibility(0, path.basename(dir));
          broadcast({ event: 'agent_status', text: 'Browser window hidden — engine continues in background.' });
        }
    if (data.action === 'logout_gemini') {
      if (runningAgent) { runningAgent.stop(); runningAgent = null; }
      pendingPatch = null; pendingCommand = null;
      await parkAndCloseGemini();
      if (activeProvider === 'gemini') activeProvider = null;
      broadcastProviders();
      broadcast({ event: 'agent_status', text: 'Gemini disconnected. Saved Google profile kept.' });
    }
    if (data.action === 'logout_chatgpt') {
      if (runningAgent && activeProvider === 'chatgpt') { runningAgent.stop(); runningAgent = null; }
      pendingPatch = null; pendingCommand = null;
      await parkAndCloseChatGpt();
      broadcastProviders();
      broadcast({ event: 'agent_status', text: 'ChatGPT disconnected. Saved profile kept.' });
    }
    if (data.action === 'get_providers_status') { broadcastProviders(); }

    if (data.action === 'set_default_provider') {
      const p = data.provider === 'chatgpt' ? 'chatgpt' : data.provider === 'gemini' ? 'gemini' : 'deepseek';
      defaultProvider = p;
      broadcast({ event: 'default_provider', provider: p });
      if (!autoRestoreStarted) {
        autoRestoreDefaultProvider(p).catch(e => console.warn('auto-restore failed:', e && e.message));
      }
    }

    if (data.action === 'set_language') {
      currentLang = data.lang === 'fa' ? 'fa' : 'en';
    }

    if (data.action === 'set_thinking_level') {
      const lv = String(data.level || '').toLowerCase();
      if (lv === 'low' || lv === 'medium' || lv === 'high') {
        geminiThinkingLevel = lv;
        if (activeGeminiPage && !activeGeminiPage.isClosed()) {
          try { await new GeminiDriver(activeGeminiPage).setThinkingLevel(lv); } catch {}
        }
        broadcast({ event: 'thinking_level', level: geminiThinkingLevel });
      }
    }

    if (data.action === 'set_chatgpt_think') {
      chatgptThinkEnabled = data.enabled !== false;
      if (activeChatGptPage && !activeChatGptPage.isClosed()) {
        try { await new ChatGptDriver(activeChatGptPage).setThinkEnabled(chatgptThinkEnabled); } catch {}
      }
      broadcast({ event: 'chatgpt_think_status', enabled: chatgptThinkEnabled });
    }

    if (data.action === 'diagnose') {
      const diag = activeProvider === 'gemini' ? await diagnoseGeminiSession(activeGeminiPage)
        : activeProvider === 'chatgpt' ? await diagnoseChatGptSession(activeChatGptPage)
        : await diagnoseSession(activePage);
      broadcast({ event: 'diagnostic_result', ...diag });
    }

    if (data.action === 'confirm_login') {
      await switchToBackground();
    }

    if (data.action === 'logout') {
      
      if (runningAgent) {
        runningAgent.stop();
        runningAgent = null;
      }
      pendingPatch = null;
      pendingCommand = null;
      if (loginCheckTimer) {
        clearInterval(loginCheckTimer);
        loginCheckTimer = null;
      }
      if (browserContext) {
        try { await browserContext.close(); } catch {}
        browserContext = null;
        activePage = null;
      }
      deepseekStatus = 'disconnected';
      if (activeProvider === 'deepseek') activeProvider = null;
      broadcastProviders();
      broadcast({ event: 'logged_out' });
      broadcast({ event: 'agent_status', text: 'Disconnected. Saved profile kept for auto-reconnect.' });
      logTerminal('Disconnected from DeepSeek (profile preserved).', 'sys');
    }

    if (data.action === 'set_workspace') {
      try {
         const targetPath = data.path;
         currentTools = new ProjectTools(targetPath, activeIgnoredList);
         currentTools.setLogger((line, kind) => logTerminal(line, kind));
         const tree = await scanWorkspaceTree(targetPath);

         broadcast({ event: 'workspace_loaded', path: targetPath, tree });
         pushRecentWorkspace(targetPath);
         await saveLastWorkspace(targetPath);
         logTerminal(`Workspace loaded: ${targetPath}`, 'sys');
         broadcast({ event: 'agent_status', text: `Workspace loaded: ${path.basename(targetPath)}` });
      } catch (err) {
        broadcast({ event: 'error', message: `خطا در اسکن پروژه: ${err.message}` });
      }
    }

    if (data.action === 'read_file') {
      if (!currentTools) return;
      const res = await currentTools.readMultipleFiles([data.filename]);
      broadcast({ event: 'file_content', filename: data.filename, content: res[data.filename] });
    }

    if (data.action === 'send_prompt') {
      const provider = data.provider === 'gemini' ? 'gemini' : data.provider === 'chatgpt' ? 'chatgpt' : 'deepseek';
      let taskSessionId = currentSessionId;

      // If pre-upload is still in flight, wait so we don't upload twice
      await waitStagingIdle(provider, 180000);

      // ◄◄◄ NEW 1: Enforce provider ↔ session match (no mixing) ►►►
      if (currentSessionId) {
        const sess = await sessionStore.loadSession(currentSessionId);
        const sessProvider = (sess && sess.provider) || sessionUrlProvider(sess && sess.deepseekUrl) || 'deepseek';
        if (sessProvider !== provider) {
          const name = sessProvider === 'gemini' ? 'Gemini' : sessProvider === 'chatgpt' ? 'ChatGPT' : 'DeepSeek';
          const errMsg = currentLang === 'fa'
            ? `این چت متعلق به ${name} است. نمی‌توانید با پروایدر دیگر در آن پیام بفرستید. لطفاً چت جدید بسازید.`
            : `This chat belongs to ${name}. You cannot send messages with a different provider here. Please create a new chat.`;
          broadcast({ event: 'error', message: errMsg });
          return;
        }
      }
      // ►►► END NEW 1

      if (!currentTools) {
         broadcast({ event: 'error', message: tS('needWorkspace') });
        return;
      }

      if (currentTools && Array.isArray(data.excludedPaths)) {
        currentTools.setExcludedPaths(data.excludedPaths);
      }
      if (currentTools && Array.isArray(data.ignoredPatterns)) {
        currentTools.setIgnoredPatterns(data.ignoredPatterns);
      }

      // ◄◄◄ NEW 2: Auto-connect provider if it dropped ►►►
      if (provider === 'deepseek' && (!activePage || activePage.isClosed())) {
        broadcast({ event: 'agent_status', text: 'Auto-reconnecting to DeepSeek…' });
        const conn = await ensureProviderConnected('deepseek');
        if (!conn.ok) {
          broadcast({ event: 'error', message: conn.message });
          broadcast({ event: 'task_stopped', message: conn.message });
          return;
        }
      }
      if (provider === 'gemini' && (!activeGeminiPage || activeGeminiPage.isClosed())) {
        if (Date.now() < geminiRateCooldownUntil) {
          const minsLeft = Math.ceil((geminiRateCooldownUntil - Date.now()) / 60000);
          const coolMsg = currentLang === 'fa'
            ? `جمنای در حالت خنک‌سازی است (${minsLeft} دقیقه دیگر).`
            : `Gemini is cooling down (${minsLeft} min left).`;
          broadcast({ event: 'error', message: coolMsg });
          broadcast({ event: 'task_stopped', message: coolMsg });
          return;
        }
        broadcast({ event: 'agent_status', text: 'Auto-connecting to Gemini for this chat…' });
        const conn = await ensureProviderConnected('gemini');
        if (!conn.ok) {
          broadcast({ event: 'error', message: conn.message });
          broadcast({ event: 'task_stopped', message: conn.message });
          return;
        }
      }
      if (provider === 'chatgpt' && (!activeChatGptPage || activeChatGptPage.isClosed() || chatgptStatus !== 'connected')) {
        if (Date.now() < chatgptRateCooldownUntil) {
          const minsLeft = Math.ceil((chatgptRateCooldownUntil - Date.now()) / 60000);
          const coolMsg = currentLang === 'fa' ? `ChatGPT در حالت خنک‌سازی است (${minsLeft} دقیقه دیگر).` : `ChatGPT is cooling down (${minsLeft} min left).`;
          broadcast({ event: 'error', message: coolMsg });
          broadcast({ event: 'task_stopped', message: coolMsg });
          return;
        }
        broadcast({ event: 'agent_status', text: 'Auto-connecting to ChatGPT for this chat…' });
        const conn = await ensureProviderConnected('chatgpt');
        if (!conn.ok) {
          broadcast({ event: 'error', message: conn.message });
          broadcast({ event: 'task_stopped', message: conn.message });
          return;
        }
      }
      // ►►► END NEW 2

        if (provider === 'deepseek') {
          let diag = await diagnoseSession(activePage);
          if (!diag.ok && diag.status === 'loading') {           
            await new Promise(r => setTimeout(r, 2500));
            diag = await diagnoseSession(activePage);
          }
          if (!diag.ok) {
            if (diag.status === 'suspended') {
              
              broadcast({ event: 'error', message: diag.message });
              broadcast({ event: 'task_stopped', message: diag.message });
              return;
            }
            if (diag.status === 'cloudflare' || diag.status === 'captcha') {
              toggleBrowserVisibility(5);
              broadcast({ event: 'error', message: diag.message });
              broadcast({ event: 'task_stopped', message: diag.message });
              return;
            }
            
            await handleDeepSeekSessionExpired('send_prompt');
            broadcast({ event: 'error', message: tS('sessionExpiredTask') });
            broadcast({ event: 'task_stopped', message: tS('sessionExpiredTask') });
            return;
          }
        }

      if (provider === 'gemini') {
        
        if (Date.now() < geminiRateCooldownUntil) {
          const minsLeft = Math.ceil((geminiRateCooldownUntil - Date.now()) / 60000);
          const coolMsg = currentLang === 'fa'
            ? `جمنای در حالت خنک‌سازی است (${minsLeft} دقیقه دیگر). سهمیهٔ این حساب گوگل تمام شده؛ بعداً از این حساب استفاده کنید یا از پیل مدل به دیپ‌سیک سوییچ کنید.`
            : `Gemini is cooling down (${minsLeft} min left). This Google account's quota is exhausted — use it later or switch to DeepSeek from the model pill.`;
          broadcast({ event: 'error', message: coolMsg });
          broadcast({ event: 'task_stopped', message: coolMsg });
          return;
        }
        const gdiag = await diagnoseGeminiSession(activeGeminiPage);
        if (!gdiag.ok) {
          toggleBrowserVisibility(5, path.basename(GEMINI_PROFILE_DIR));
          geminiStatus = 'connecting'; activeProvider = 'gemini'; broadcastProviders();
          broadcast({ event: 'error', message: gdiag.message });
          return;
        }
      }

      if (provider === 'chatgpt') {
        if (Date.now() < chatgptRateCooldownUntil) {
          const minsLeft = Math.ceil((chatgptRateCooldownUntil - Date.now()) / 60000);
          const coolMsg = currentLang === 'fa' ? `ChatGPT در حالت خنک‌سازی است (${minsLeft} دقیقه دیگر).` : `ChatGPT is cooling down (${minsLeft} min left).`;
          broadcast({ event: 'error', message: coolMsg });
          broadcast({ event: 'task_stopped', message: coolMsg });
          return;
        }
        const cdiag = await diagnoseChatGptSession(activeChatGptPage);
        if (!cdiag.ok) {
          toggleBrowserVisibility(5, path.basename(CHATGPT_PROFILE_DIR));
          chatgptStatus = 'connecting'; activeProvider = 'chatgpt'; broadcastProviders();
          if (cdiag.status === 'not_logged_in') startChatGptLoginWatchdog();
          broadcast({ event: 'error', message: cdiag.message });
          broadcast({ event: 'task_stopped', message: cdiag.message });
          return;
        }
      }

      
      if (provider === 'deepseek' && currentSessionId) {
        const currentSess = await sessionStore.loadSession(currentSessionId);
        const curUrl = currentSess && currentSess.deepseekUrl ? currentSess.deepseekUrl : '';
        if (currentSess && curUrl && sessionUrlProvider(curUrl) === 'deepseek') {
          const driver = new DeepSeekDriver(activePage);
          let isAlive = await driver.checkChatExists(curUrl);
          if (!isAlive) {
            
            await new Promise(r => setTimeout(r, 1500));
            isAlive = await driver.checkChatExists(curUrl);
          }
          if (!isAlive) {
            await sessionStore.deleteSession(currentSessionId);
            const updatedSessions = await sessionStore.getSessions();
            currentSessionId = null;
            await driver.startNewChat();
             broadcast({
               event: 'session_purged_remote',
               sessionId: currentSess.id,
               sessions: updatedSessions
             });
             broadcast({ event: 'agent_status', text: tS('previousPurged') });
             broadcast({ event: 'task_stopped', message: 'Previous chat was purged on DeepSeek; task aborted. Send your prompt again.' });
             return; 
          }
        }
      }
      
      if (provider === 'gemini' && currentSessionId && activeGeminiPage && !activeGeminiPage.isClosed()) {
        try {
          const currentSess = await sessionStore.loadSession(currentSessionId);
          const curUrl = currentSess && currentSess.deepseekUrl ? currentSess.deepseekUrl : '';
          if (currentSess && sessionUrlProvider(curUrl) === 'gemini') {
            const gdriver = new GeminiDriver(activeGeminiPage);
            const alive = await gdriver.checkChatExists(curUrl);
            if (!alive) {
              currentSess.deepseekUrl = null;
              await sessionStore.saveSession(currentSess);
              await gdriver.startNewChat();
              broadcast({ event: 'agent_status', text: 'Previous Gemini chat no longer exists online — started a fresh Gemini chat (local session kept).' });
            }
          }
        } catch (e) { console.warn('Gemini pre-send verify warning:', e && e.message); }
      }

      if (provider === 'chatgpt' && currentSessionId && activeChatGptPage && !activeChatGptPage.isClosed()) {
        try {
          const currentSess = await sessionStore.loadSession(currentSessionId);
          const curUrl = currentSess && currentSess.deepseekUrl ? currentSess.deepseekUrl : '';
          if (currentSess && sessionUrlProvider(curUrl) === 'chatgpt') {
            const cdriver = new ChatGptDriver(activeChatGptPage);
            const alive = await cdriver.checkChatExists(curUrl);
            if (!alive) {
              currentSess.deepseekUrl = null;
              await sessionStore.saveSession(currentSess);
              await cdriver.startNewChat();
              broadcast({ event: 'agent_status', text: 'Previous ChatGPT chat no longer exists online — started a fresh chat (local session kept).' });
            }
          }
        } catch (e) { console.warn('ChatGPT pre-send verify warning:', e && e.message); }
      }

       
       let isFirstMessage;
       if (!currentSessionId) {
         isFirstMessage = true;
       } else {
         const _sess = await sessionStore.loadSession(currentSessionId);
         isFirstMessage = !(_sess && _sess.deepseekUrl);
       }

       
       const projectTree = await currentTools.getProjectTree();
       let treeUpdate = null;
       if (!isFirstMessage) {
         const prevTree = treeSnapshots.get(currentSessionId);
         if (typeof prevTree === 'string' && prevTree !== projectTree) {
           treeUpdate = projectTree;
         }
       }
       treeSnapshots.set(currentSessionId, projectTree);

       broadcast({ event: 'agent_status', text: 'Preparing coding mission...' });

       const thinkingLevel = ['low','medium','high'].includes(String(data.thinkingLevel || '').toLowerCase())
         ? String(data.thinkingLevel).toLowerCase()
         : geminiThinkingLevel;
       const chatgptThink = typeof data.chatgptThink === 'boolean' ? data.chatgptThink : chatgptThinkEnabled;

      (async () => {
        try {
          if (provider === 'deepseek') { if (geminiContext) await parkAndCloseGemini(); if (chatgptContext) await parkAndCloseChatGpt(); }
          if (provider === 'gemini') { if (browserContext) await parkAndCloseDeepSeek(); if (chatgptContext) await parkAndCloseChatGpt(); }
          if (provider === 'chatgpt') { if (browserContext) await parkAndCloseDeepSeek(); if (geminiContext) await parkAndCloseGemini(); }
          if (provider === 'gemini') { geminiStatus = 'connected'; activeProvider = 'gemini'; broadcastProviders(); }
          if (provider === 'chatgpt') { chatgptStatus = 'connected'; activeProvider = 'chatgpt'; broadcastProviders(); }
          if (provider === 'deepseek') { deepseekStatus = 'connected'; activeProvider = 'deepseek'; broadcastProviders(); }

          let selectedDriver;
          if (provider === 'gemini') {
            if (!activeGeminiPage || activeGeminiPage.isClosed()) {
              if (!geminiContext) geminiContext = await launchStealthContext(GEMINI_PROFILE_DIR, { headless: false });
              activeGeminiPage = await consolidateProviderTabs(geminiContext, 'aistudio.google.com');
              activeGeminiPage.on('close', () => { activeGeminiPage = null; });
              if (!activeGeminiPage.url().includes('aistudio.google.com/prompts')) {
                await activeGeminiPage.goto(AI_STUDIO_NEW_CHAT, { waitUntil: 'domcontentloaded' });
              }
              toggleBrowserVisibility(0, path.basename(GEMINI_PROFILE_DIR));
            }
            selectedDriver = new GeminiDriver(activeGeminiPage);
          } else if (provider === 'chatgpt') {
            if (!activeChatGptPage || activeChatGptPage.isClosed()) {
              if (!chatgptContext) chatgptContext = await launchStealthContext(CHATGPT_PROFILE_DIR, { headless: false });
              activeChatGptPage = await consolidateProviderTabs(chatgptContext, 'chatgpt.com');
              attachChatGptPageHandlers(activeChatGptPage);
              if (!/chatgpt\.com/.test(activeChatGptPage.url())) {
                await activeChatGptPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
              }
              toggleBrowserVisibility(0, path.basename(CHATGPT_PROFILE_DIR));
            }
            selectedDriver = new ChatGptDriver(activeChatGptPage);
          } else {
            selectedDriver = new DeepSeekDriver(activePage);
          }
          const driver = selectedDriver;
          if (!currentSessionId) {
            const title = data.prompt.slice(0, 45).replace(/\n/g, ' ') || 'Coding Mission';
            const newSess = await sessionStore.createSession(title, { workspacePath: currentTools.workspaceDir, provider });
            currentSessionId = newSess.id;
            taskSessionId = newSess.id;
          }

          let attachmentMeta = [];
          const toUpload = [];
          if (Array.isArray(data.attachments) && data.attachments.length > 0) {
            const sessDir = path.join(ATTACH_DIR, taskSessionId);
            await fs.mkdir(sessDir, { recursive: true });
            const stagedMap = staging[provider].entries;
            for (const att of data.attachments.slice(0, 10)) {
              const id = String(att.id || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9_-]/gi, '');
              const ext = (path.extname(att.name || '') || '.png').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png';
              const fileName = `${id}${ext}`;
              const targetPath = path.join(sessDir, fileName);
              const staged = stagedMap.get(att.id);
              if (staged) {
                // Already saved on disk — no base64 decode needed
                try { await fs.rename(staged.path, targetPath); }
                catch { try { await fs.copyFile(staged.path, targetPath); } catch {} }
              } else if (att.base64) {
                const base64Data = String(att.base64).replace(/^data:[^;]+;base64,/, '');
                await fs.writeFile(targetPath, Buffer.from(base64Data, 'base64'));
              } else { continue; }
              attachmentMeta.push({ id, name: att.name || fileName, size: att.size || 0, type: att.type || '', file: `${taskSessionId}/${fileName}` });
              if (staged && staged.uploaded) {
                stagedMap.delete(att.id);
              } else {
                if (staged) stagedMap.delete(att.id);
                toUpload.push(targetPath);
              }
            }
            // ★ Now ALL three providers — Gemini finally uploads too
            if (toUpload.length > 0) {
              try {
                await driver.uploadFiles(toUpload);
                logTerminal(`Uploaded ${toUpload.length} attachment(s) to ${provider}`, 'sys');
              } catch (e) { console.warn('attachment upload at send failed:', e && e.message); }
            } else if (attachmentMeta.length > 0) {
              logTerminal(`Using ${attachmentMeta.length} pre-staged attachment(s) — instant send ⚡`, 'sys');
            }
          } else {
            // No files but staged chips remain → clear so they aren't sent by mistake
            const leftovers = Array.from(staging[provider].entries.values()).filter(e => e.uploaded);
            if (leftovers.length) {
              const drv = makeDriver(provider);
              if (drv && typeof drv.clearStagedMedia === 'function') {
                try { await drv.clearStagedMedia(leftovers.map(e => e.name)); } catch {}
              }
            }
            clearStagingState(provider);
          }

          if (provider === 'deepseek' && typeof data.deepThink === 'boolean') {
            await driver.setDeepThink(data.deepThink);
          }

const skill = typeof data.skill === 'string' ? data.skill : null;
await sessionStore.appendMessage(currentSessionId, {
  role: 'user',
  text: data.prompt,
  skill: skill || undefined,
  attachments: attachmentMeta.length ? attachmentMeta : undefined,
  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
});

          const updatedList = await sessionStore.getSessions();
          broadcast({ event: 'sessions_list', sessions: updatedList, currentSessionId });

          const agent = new CodingAgent(driver, currentTools, async (event, payload) => {
            
            if ((provider === 'deepseek' || provider === 'chatgpt') && event === 'chat_url_captured' && payload.url) {
              const session = await sessionStore.loadSession(taskSessionId);
              if (session && !session.deepseekUrl) {
                session.deepseekUrl = payload.url;
                if (!session.provider) session.provider = provider;
                await sessionStore.saveSession(session);
              }
            }
             if (event === 'network_retry') {
               logTerminal(`Network error — retry ${payload.attempt}/${payload.max}`, 'err');
             }
             if (event === 'agent_message' && payload.action === 'patch_file' && payload.result) {
              broadcast({ event: 'patch_applied', details: payload.result.details || [], successful: payload.result.successful, total: payload.result.total });
            }
            if (event === 'gemini_rate_limit') {
              geminiRateStrike++;
              const mins = geminiRateStrike === 1 ? 5 : geminiRateStrike === 2 ? 15 : 60;
              geminiRateCooldownUntil = Date.now() + mins * 60000;
              logTerminal(`Gemini rate limit strike ${geminiRateStrike} — cooling down for ${mins} min.`, 'err');
              broadcast({ event: 'gemini_rate_limit', minutes: mins, until: geminiRateCooldownUntil });
              broadcast({ event: 'agent_status', text: currentLang === 'fa' ? `خنک‌سازی جمنای: ${mins} دقیقه بدون درخواست جدید.` : `Gemini cooldown: no new requests for ${mins} min.` });
              return;
            }
            if (event === 'provider_rate_limit' && payload.provider === 'chatgpt') {
              chatgptRateStrike++;
              const mins = chatgptRateStrike === 1 ? 5 : chatgptRateStrike === 2 ? 15 : 60;
              chatgptRateCooldownUntil = Date.now() + mins * 60000;
              logTerminal(`ChatGPT rate limit strike ${chatgptRateStrike} — cooling down for ${mins} min.`, 'err');
              broadcast({ event: 'chatgpt_rate_limit', minutes: mins, until: chatgptRateCooldownUntil });
              broadcast({ event: 'agent_status', text: currentLang === 'fa' ? `خنک‌سازی ChatGPT: ${mins} دقیقه بدون درخواست جدید.` : `ChatGPT cooldown: no new requests for ${mins} min.` });
              return;
            }
            if (event === 'task_finished' && provider === 'chatgpt' && Date.now() >= chatgptRateCooldownUntil) {
              chatgptRateStrike = 0;
            }
            if (event === 'task_finished' && provider === 'gemini' && Date.now() >= geminiRateCooldownUntil) {
              geminiRateStrike = 0; 
            }
            if (event === 'patch_proposed') {
              const summaries = editStore.addEdits(taskSessionId, 0, payload.patches || [payload.patch], 'pending');
              pendingPatch = { ids: summaries.map(s => s.id) };
              broadcast({ event: 'patch_proposed', summaries, files: summaries.map(s => s.file), sessionId: taskSessionId });
              return;
            }
            if (event === 'command_proposed') {
              pendingCommand = { command: payload.command };
              broadcast({
                event: 'command_proposed',
                command: payload.command,
                sessionId: taskSessionId
              });
              return;
            }
            if (event === 'agent_message') {
              let editSummaries;
              if (Array.isArray(payload.edits) && payload.edits.length > 0) {
                editSummaries = editStore.addEdits(taskSessionId, 0, payload.edits, 'applied');
              }
              const saved = sessionStore.appendMessage(taskSessionId, {
                role: payload.role || 'agent',
                text: payload.text,
                thought: payload.thought || undefined,
                action: payload.action,
                edits: editSummaries,
                files: Array.isArray(payload.files) ? payload.files : undefined,
                file: payload.file || undefined,
                command: payload.command || undefined,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              });
              if (saved && editSummaries) {
                editStore.linkMessage(editSummaries.map(s => s.id), Number(saved.id));
              }
              broadcast({
                event,
                sessionId: taskSessionId,
                role: payload.role || 'agent',
                text: payload.text,
                thought: payload.thought,
                action: payload.action,
                skill: payload.skill,
                files: payload.files,
                file: payload.file || undefined,
                command: payload.command || undefined,
                ts: payload.ts,
                msgId: saved ? saved.id : undefined,
                edits: editSummaries
              });
              return;
            }
            broadcast({ event, sessionId: taskSessionId, ...payload });
          }, browserTool);

          runningAgent = agent;
          await agent.run(data.prompt, {
            provider,
            thinkingLevel,
            chatgptThink,
            deepThink: data.deepThink,
            autoApplyPatch: data.autoApplyPatch,
            autoApproveCommand: data.autoApproveCommand,
            skill,
            lang: currentLang,
            isFirstMessage,
            systemPromptSent: !isFirstMessage,
            projectTree,
            treeUpdate
          });

          
            const currentUrl = await driver.getChatUrl();
            if (currentUrl && (currentUrl.includes('/chat/') || currentUrl.includes('aistudio.google.com/prompts') || currentUrl.includes('chatgpt.com/c/'))) {
             const session = await sessionStore.loadSession(taskSessionId);
             if (session && !session.deepseekUrl) {
               session.deepseekUrl = currentUrl;
               if (!session.provider) session.provider = provider;
               await sessionStore.saveSession(session);
             }
           }

           
           try { treeSnapshots.set(taskSessionId, await currentTools.getProjectTree()); } catch {}

          runningAgent = null;
        } catch (err) {
          runningAgent = null;
          console.error('Agent execution error:', err.message);

          if (err.code === 'DS_SESSION_EXPIRED' || (err.message && err.message.includes('DS_SESSION_EXPIRED'))) {
            await handleDeepSeekSessionExpired('mid-task');
            broadcast({ event: 'error', message: tS('sessionExpiredTask') });
            broadcast({ event: 'task_stopped', message: tS('sessionExpiredTask') });
            return;
          }

          if (err.code === 'CHATGPT_LOGIN_REQUIRED' || (err.message && err.message.includes('CHATGPT_LOGIN_REQUIRED'))) {
            toggleBrowserVisibility(5, path.basename(CHATGPT_PROFILE_DIR));
            chatgptStatus = 'connecting'; activeProvider = 'chatgpt'; broadcastProviders();
            startChatGptLoginWatchdog();
            broadcast({ event: 'error', message: tS('chatgptSessionExpiredTask') });
            broadcast({ event: 'task_stopped', message: tS('chatgptSessionExpiredTask') });
            return;
          }

          
          if (err.code === 'CAPTCHA_REQUIRED' || (err.message && err.message.includes('CAPTCHA_REQUIRED'))) {
            
            toggleBrowserVisibility(5);

            const alertMsg = tS('captchaRequired');
            logTerminal('Security CAPTCHA detected. Browser window brought to front.', 'err');
            broadcast({ event: 'agent_status', text: alertMsg });
            broadcast({ event: 'error', message: alertMsg });
            broadcast({ event: 'task_stopped', message: alertMsg });
            return;
          }

          
          const safeMessage = err.message.length > 300 
            ? err.message.slice(0, 300) + '... (Check terminal for full log)' 
            : err.message;

          broadcast({ event: 'error', message: safeMessage });
        }
      })();
    }

    if (data.action === 'set_deep_think') {
      if (activePage && !activePage.isClosed()) {
        try {
          const driver = new DeepSeekDriver(activePage);
          await driver.setDeepThink(data.enabled);
        } catch {}
      }
    }

    if (data.action === 'stop_task') {
      if (runningAgent) {
        runningAgent.stop();
        runningAgent = null;
      }
      pendingPatch = null;
      pendingCommand = null;
      broadcast({ event: 'task_stopped', message: 'Task stopped by user.' });
    }

    if (data.action === 'get_sessions') {
      const sessions = await sessionStore.getSessions();
      ws.send(JSON.stringify({ event: 'sessions_list', sessions, currentSessionId }));
    }

    if (data.action === 'new_chat') {
      if (runningAgent) {
        runningAgent.stop();
        runningAgent = null;
      }

      currentSessionId = null;

      await clearProviderStaging('deepseek').catch(() => {});
      await clearProviderStaging('gemini').catch(() => {});
      await clearProviderStaging('chatgpt').catch(() => {});

       if (activePage && !activePage.isClosed()) {
         try {
           const driver = new DeepSeekDriver(activePage);
           await driver.startNewChat();
         } catch (e) {
           console.warn('Driver new chat warning:', e.message);
         }
       }

       if (activeGeminiPage && !activeGeminiPage.isClosed()) {
         try {
           const gdriver = new GeminiDriver(activeGeminiPage);
           await gdriver.startNewChat();
         } catch (e) {
           console.warn('Gemini new chat warning:', e.message);
         }
       }

       if (activeChatGptPage && !activeChatGptPage.isClosed()) {
         try { await new ChatGptDriver(activeChatGptPage).startNewChat(); }
         catch (e) { console.warn('ChatGPT new chat warning:', e.message); }
       }

      const cleanSessions = await sessionStore.purgeEmptySessions();

      broadcast({
        event: 'chat_reset',
        sessionId: null,
        sessions: cleanSessions
      });
      broadcast({ event: 'agent_status', text: 'Ready for new task.' });
    }

    if (data.action === 'stage_attachments') {
      const provider = data.provider === 'gemini' ? 'gemini' : data.provider === 'chatgpt' ? 'chatgpt' : 'deepseek';
      const atts = Array.isArray(data.attachments) ? data.attachments.slice(0, 10) : [];
      for (const att of atts) {
        enqueueStaging(provider, () => stageOneAttachment(provider, att));
      }
    }

    if (data.action === 'unstage_attachment') {
      const provider = data.provider === 'gemini' ? 'gemini' : data.provider === 'chatgpt' ? 'chatgpt' : 'deepseek';
      if (data.id) enqueueStaging(provider, () => unstageOne(provider, String(data.id)));
    }

     if (data.action === 'load_session') {
       const limit = data.limit || 30;
       const offset = data.offset || 0;
       const sessionData = await sessionStore.loadSession(data.sessionId, limit, offset);
       if (!sessionData) return;

        currentSessionId = sessionData.id;
        
        if (!sessionData.provider) {
          sessionData.provider = sessionUrlProvider(sessionData.deepseekUrl) || 'deepseek';
        }
        ws.send(JSON.stringify({ event: 'session_loaded', session: sessionData }));
        broadcast({ event: 'agent_status', text: tS('chatLoaded') });

        
        if (runningAgent) {
          console.log(`🔒 Task in progress on another session. Skipping browser navigation.`);
          return;
        }

        
        const sessUrl = sessionData.deepseekUrl || '';
        const sessionProvider = sessionData.provider || sessionUrlProvider(sessUrl) || 'deepseek';

        // ◄◄◄ NEW: auto-connect the session's own provider in background ►►►
        (async () => {
          try {
            const needsConnect =
              (sessionProvider === 'gemini'   && (!activeGeminiPage || activeGeminiPage.isClosed() || geminiStatus !== 'connected')) ||
              (sessionProvider === 'chatgpt'  && (!activeChatGptPage || activeChatGptPage.isClosed() || chatgptStatus !== 'connected')) ||
              (sessionProvider === 'deepseek' && (!activePage       || activePage.isClosed()       || deepseekStatus !== 'connected'));

            if (needsConnect || activeProvider !== sessionProvider) {
              const provName = sessionProvider === 'gemini' ? 'Gemini' : sessionProvider === 'chatgpt' ? 'ChatGPT' : 'DeepSeek';
              broadcast({ event: 'agent_status', text: `Switching to ${provName} for this chat…` });
              const conn = await ensureProviderConnected(sessionProvider);
              if (conn.ok) {
                broadcast({ event: 'agent_status', text: `${provName} connected — ready.` });
              }
            }

            if (sessionProvider === 'deepseek' && activePage && !activePage.isClosed()) {
              const driver = new DeepSeekDriver(activePage);
              broadcast({ event: 'agent_status', text: tS('syncing') });
              let exists = sessUrl ? await driver.checkChatExists(sessUrl) : true;
              if (sessUrl && !exists) {
                await new Promise(r => setTimeout(r, 1500));
                exists = await driver.checkChatExists(sessUrl);
              }
              if (!exists) {
                await sessionStore.deleteSession(data.sessionId);
                const updated = await sessionStore.getSessions();
                currentSessionId = null;
                await driver.startNewChat();
                broadcast({ event: 'session_purged_remote', sessionId: data.sessionId, sessions: updated });
                broadcast({ event: 'agent_status', text: tS('previousPurged') });
                return;
              }
              if (!sessUrl) await driver.startNewChat();
              broadcast({ event: 'agent_status', text: tS('chatLoaded') });
            } else if (sessionProvider === 'gemini' && activeGeminiPage && !activeGeminiPage.isClosed()) {
              const gdriver = new GeminiDriver(activeGeminiPage);
              const exists = await gdriver.checkChatExists(sessUrl);
              if (!exists) {
                const sess = await sessionStore.loadSession(data.sessionId);
                if (sess) { sess.deepseekUrl = null; await sessionStore.saveSession(sess); }
                broadcast({ event: 'agent_status', text: 'Gemini chat no longer exists online — local session kept.' });
              }
            } else if (sessionProvider === 'chatgpt' && activeChatGptPage && !activeChatGptPage.isClosed()) {
              const cdriver = new ChatGptDriver(activeChatGptPage);
              const exists = sessUrl ? await cdriver.checkChatExists(sessUrl) : true;
              if (!exists) {
                const sess = await sessionStore.loadSession(data.sessionId);
                if (sess) { sess.deepseekUrl = null; await sessionStore.saveSession(sess); }
                broadcast({ event: 'agent_status', text: 'ChatGPT chat no longer exists online — local session kept.' });
              }
            }
          } catch (e) {
            console.warn('Background provider-switch error:', e && e.message);
          }
        })();
        // ►►► END NEW
        return;
     }

     if (data.action === 'load_older_messages') {
       const limit = data.limit || 30;
       const offset = data.offset || 0;
       const sessionData = await sessionStore.loadSession(data.sessionId, limit, offset);
       if (sessionData) {
         ws.send(JSON.stringify({ event: 'older_messages_loaded', session: sessionData }));
       }
     }

    if (data.action === 'sync_with_deepseek') {
      if (!activePage || activePage.isClosed()) {
        ws.send(JSON.stringify({ event: 'error', message: 'مرورگر باز نیست؛ امکان همگام‌سازی وجود ندارد.' }));
        return;
      }

      broadcast({ event: 'agent_status', text: 'Synchronizing with DeepSeek sidebar...' });
      const driver = new DeepSeekDriver(activePage);
      const localSessions = await sessionStore.getSessions();
      let purgedCount = 0;

      for (const sess of localSessions) {
        const full = await sessionStore.loadSession(sess.id);
        
        if (full && full.deepseekUrl && sessionUrlProvider(full.deepseekUrl) !== 'deepseek') continue;
        if (full && full.deepseekUrl) {
          let exists = await driver.checkChatExists(full.deepseekUrl);
          if (!exists) {
            await new Promise(r => setTimeout(r, 1200));
            exists = await driver.checkChatExists(full.deepseekUrl);
          }
          if (!exists) {
            await sessionStore.deleteSession(sess.id);
            purgedCount++;
          }
        }
      }

      const refreshed = await sessionStore.getSessions();
      broadcast({
        event: 'sync_completed',
        purgedCount,
        sessions: refreshed,
         message: tS('syncDone', purgedCount)
      });
      broadcast({ event: 'agent_status', text: 'Ready.' });
    }

    if (data.action === 'delete_session') {
      await sessionStore.deleteSession(data.sessionId);
      editStore.clearSession(data.sessionId);
      try { await fs.rm(path.join(ATTACH_DIR, data.sessionId), { recursive: true, force: true }); } catch {}
      treeSnapshots.delete(data.sessionId);
      if (currentSessionId === data.sessionId) {
        const newSess = await sessionStore.createSession('New Mission', { workspacePath: currentTools ? currentTools.workspaceDir : '' });
        currentSessionId = newSess.id;
      }
      const sessions = await sessionStore.getSessions();
      broadcast({ event: 'sessions_list', sessions, currentSessionId });
    }

        if (data.action === 'choose_folder') {
          broadcast({ event: 'agent_status', text: currentLang === 'fa' ? 'در حال باز کردن پنجره انتخاب پوشه…' : 'Opening folder picker…' });
          const pick = await openNativeFolderDialog();
          if (pick.path) {
            try {
              currentTools = new ProjectTools(pick.path, activeIgnoredList);
              currentTools.setLogger((line, kind) => logTerminal(line, kind));
              const tree = await scanWorkspaceTree(pick.path);
              broadcast({ event: 'workspace_loaded', path: pick.path, tree });
              pushRecentWorkspace(pick.path);
              await saveLastWorkspace(pick.path);
              logTerminal(`Workspace loaded: ${pick.path}`, 'sys');
              broadcast({ event: 'agent_status', text: `Workspace loaded: ${path.basename(pick.path)}` });
            } catch (err) {
              broadcast({ event: 'error', message: `خطا در باز کردن پوشه: ${err.message}` });
            }
          } else if (pick.cancelled) {
            broadcast({ event: 'agent_status', text: '' });
          } else {
            const msg = currentLang === 'fa'
              ? 'پنجره انتخاب پوشه ویندوز روی این سیستم باز نشد — انتخاب‌گر داخلی برنامه باز شد.'
              : 'The native folder dialog could not open on this system — the in-app folder picker was opened instead.';
            logTerminal(`Native folder dialog failed: ${pick.error}`, 'err');
            broadcast({ event: 'agent_status', text: msg });
            broadcast({ event: 'folder_dialog_failed', message: msg, detail: pick.error });
          }
        }

        if (data.action === 'browse_dir') {
          const reqId = data.requestId;
          const home = os.homedir();
          const shortcuts = [
            { name: 'Home', path: home },
            { name: 'Desktop', path: path.join(home, 'Desktop') },
            { name: 'Documents', path: path.join(home, 'Documents') },
            { name: 'Downloads', path: path.join(home, 'Downloads') }
          ].filter(s => { try { return fsSync.statSync(s.path).isDirectory(); } catch { return false; } });
          try {
            let target = String(data.path || '').trim();
            if (!target) {
              const entries = [];
              if (process.platform === 'win32') {
                for (let c = 65; c <= 90; c++) {
                  const root = String.fromCharCode(c) + ':\\';
                  try { await fs.access(root); entries.push({ name: root, path: root, isDrive: true }); } catch {}
                }
              } else {
                entries.push({ name: '/', path: '/', isDrive: true });
              }
              ws.send(JSON.stringify({ event: 'dir_listing', requestId: reqId, path: '', parent: null, entries, shortcuts }));
              return;
            }
            target = path.resolve(target);
            const raw = await fs.readdir(target, { withFileTypes: true });
            const entries = [];
            for (const e of raw) {
              if (!e.isDirectory()) continue;
              if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
              entries.push({ name: e.name, path: path.join(target, e.name) });
              if (entries.length >= 500) break;
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            const parent = path.dirname(target);
            ws.send(JSON.stringify({
              event: 'dir_listing', requestId: reqId, path: target,
              parent: parent === target ? null : parent, entries, shortcuts
            }));
          } catch (err) {
            ws.send(JSON.stringify({
              event: 'dir_listing', requestId: reqId, path: String(data.path || ''),
              parent: null, entries: [], shortcuts, error: err.message
            }));
          }
        }

    if (data.action === 'update_ignored_list') {
      if (Array.isArray(data.ignored)) {
        activeIgnoredList = data.ignored;
      }
      if (currentTools) {
        currentTools.setIgnoredPatterns(activeIgnoredList);
      }
      const targetPath = data.path || (currentTools && currentTools.workspaceDir);
      if (targetPath) {
        try {
          const tree = await scanWorkspaceTree(targetPath, '', 6, activeIgnoredList);
          broadcast({ event: 'workspace_loaded', path: targetPath, tree });
        } catch (err) {
          console.error('Error rescanning tree:', err);
        }
      }
    }
      if (data.action === 'get_terminal_logs') {
    ws.send(JSON.stringify({ event: 'terminal_history', logs: terminalLogs }));
    ws.send(JSON.stringify({ event: 'recent_workspaces', workspaces: recentWorkspaces }));
      }
      if (data.action === 'terminal_input') {
        const wsDir = currentTools ? currentTools.workspaceDir : process.cwd();
        if (termRoot !== wsDir) {
          termRoot = wsDir; termCwd = wsDir;
          broadcast({ event: 'terminal_clear' });
        }
        if (!termCwd) { termCwd = wsDir; termRoot = wsDir; }
        runTerminalCommand(String(data.text || ''));
      }
      if (data.action === 'terminal_interrupt') {
        if (termShell) {
          broadcast({ event: 'terminal_live_output', line: '^C', isErr: true });
          try { termShell.kill(); } catch {}
        }
      }
      if (data.action === 'terminal_restart') {
        if (termShell) { try { termShell.kill(); } catch {} termShell = null; }
        termCwd = currentTools ? currentTools.workspaceDir : process.cwd();
        termRoot = termCwd;
        broadcast({ event: 'terminal_clear' });
        broadcast({ event: 'terminal_prompt', cwd: termCwd, code: 0 });
      }
      if (data.action === 'open_workspace_explorer') {
        if (currentTools) {
          exec(`explorer.exe "${currentTools.workspaceDir.replace(/\//g, '\\')}"`);
          logTerminal(`Opened workspace in Explorer: ${currentTools.workspaceDir}`, 'sys');
        }
      }
      if (data.action === 'get_recent_workspaces') {
        ws.send(JSON.stringify({ event: 'recent_workspaces', workspaces: recentWorkspaces }));
      }
      if (data.action === 'open_workspace') {
        try {
          const p = data.path;
          await fs.access(p);
          currentTools = new ProjectTools(p, activeIgnoredList);
          if (typeof currentTools.setLogger === 'function') currentTools.setLogger((line, kind) => logTerminal(line, kind));
          const tree = await scanWorkspaceTree(p);
          broadcast({ event: 'workspace_loaded', path: p, tree });
          broadcast({ event: 'agent_status', text: `Workspace loaded: ${path.basename(p)}` });
          pushRecentWorkspace(p);
          if (typeof saveLastWorkspace === 'function') saveLastWorkspace(p);
        } catch (err) {
          broadcast({ event: 'error', message: `Failed to open workspace: ${err.message}` });
        }
      }
      if (data.action === 'start_scratch') {
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const scratchDir = path.join(DATA_DIR, 'scratch', `scratch-${stamp}`);
          await fs.mkdir(scratchDir, { recursive: true });
          currentTools = new ProjectTools(scratchDir, activeIgnoredList);
          if (typeof currentTools.setLogger === 'function') currentTools.setLogger((line, kind) => logTerminal(line, kind));
          const tree = await scanWorkspaceTree(scratchDir);
          broadcast({ event: 'workspace_loaded', path: scratchDir, tree });
          logTerminal(`Scratch workspace created: ${scratchDir}`, 'sys');
          broadcast({ event: 'agent_status', text: 'Scratch workspace ready — agent can build from zero.' });
        } catch (err) {
          broadcast({ event: 'error', message: `Failed to create scratch workspace: ${err.message}` });
        }
      }
        if (data.action === 'embedded_navigate_ack' || data.action === 'embedded_read_ack') {
          if (embeddedAckResolver) embeddedAckResolver(data);
        }

      if (data.action === 'approve_patch') {
      if (runningAgent) {
        runningAgent.resolvePendingPatch(true);
      }
      if (pendingPatch) { editStore.setStatus(pendingPatch.ids, 'applied'); pendingPatch = null; }
      broadcast({ event: 'patch_result', success: true, message: 'Patch approved by user.' });
    }

    if (data.action === 'revert_edits') {
      (async () => {
        const ids = Array.isArray(data.editIds) ? data.editIds : [];
        const details = editStore.getDetails(ids);
        const results = [];
        for (const d of details) {
          if (!currentTools) { results.push({ id: d.id, file: d.file, success: false, message: 'No workspace open' }); continue; }
          const cur = [];
          const orig = [];
          for (const l of d.diff) {
            if (l.type === 'ctx') { cur.push(l.text); orig.push(l.text); }
            else if (l.type === 'add') cur.push(l.text);
            else if (l.type === 'del') orig.push(l.text);
          }
          const search = cur.join('\n');
          const replace = orig.join('\n');
          if (!search && !replace) { results.push({ id: d.id, file: d.file, success: false, message: 'Empty diff' }); continue; }
          const res = await currentTools.patchFile(d.file, search, replace);
          if (res.success) editStore.setStatus([d.id], 'reverted');
          results.push({ id: d.id, file: d.file, success: res.success, message: res.message || res.error });
        }
        broadcast({ event: 'edits_reverted', results });
      })();
    }

    if (data.action === 'reject_patch') {
      if (runningAgent) {
        runningAgent.resolvePendingPatch(false);
      }
      if (pendingPatch) { editStore.setStatus(pendingPatch.ids, 'rejected'); pendingPatch = null; }
      broadcast({ event: 'patch_result', success: false, message: 'Patch rejected by user.' });
    }

    if (data.action === 'approve_command') {
      if (runningAgent) {
        runningAgent.resolvePendingCommand(true);
      }
      pendingCommand = null;
      broadcast({ event: 'command_result', success: true, message: 'Command approved by user.' });
    }

    if (data.action === 'reject_command') {
      if (runningAgent) {
        runningAgent.resolvePendingCommand(false);
      }
      pendingCommand = null;
      broadcast({ event: 'command_result', success: false, message: 'Command rejected by user.' });
    }

    if (data.action === 'get_message_edits') {
      const edits = editStore.getDetailsByMessage(data.messageId);
      ws.send(JSON.stringify({ event: 'message_edits', messageId: data.messageId, edits }));
    }
    if (data.action === 'get_edits_detail') {
      const edits = editStore.getDetails(Array.isArray(data.editIds) ? data.editIds : []);
      ws.send(JSON.stringify({ event: 'edits_detail', edits }));
    }
    } catch (err) {
      console.error('[ws message] handler error:', err && (err.stack || err.message || err));
      try {
        broadcast({ event: 'error', message: `Handler error: ${err && err.message ? err.message : String(err)}` });
      } catch {}
    }
  });

  
  (async () => {
    
    try {
      const earlySessions = await sessionStore.getSessions();
      ws.send(JSON.stringify({ event: 'sessions_list', sessions: earlySessions, currentSessionId }));
    } catch {}
    ws.send(JSON.stringify({ event: 'terminal_history', logs: terminalLogs }));
    ws.send(JSON.stringify({ event: 'providers_status', deepseek: deepseekStatus, gemini: geminiStatus, active: activeProvider }));
    ws.send(JSON.stringify({ event: 'thinking_level', level: geminiThinkingLevel }));
    ws.send(JSON.stringify({ event: 'chatgpt_think_status', enabled: chatgptThinkEnabled }));
    if (currentTools) {
      try {
        const tree = await scanWorkspaceTree(currentTools.workspaceDir);
        ws.send(JSON.stringify({ event: 'workspace_loaded', path: currentTools.workspaceDir, tree }));
      } catch {}
    }
    
    if (activePage && !activePage.isClosed()) {
      const diag = await diagnoseSession(activePage);
      ws.send(JSON.stringify({ event: 'auth_status', isLoggedIn: diag.ok }));
      if (diag.ok) {
        const driver = new DeepSeekDriver(activePage);
        const dtState = await driver.getDeepThinkState();
        if (typeof dtState === 'boolean') {
          ws.send(JSON.stringify({ event: 'deep_think_status', enabled: dtState }));
        }
      } else if (diag.status === 'not_logged_in') {
        
        deepseekStatus = 'connecting'; broadcastProviders();
        startLoginWatchdog();
      }
    } else {
      ws.send(JSON.stringify({ event: 'auth_status', isLoggedIn: false }));
    }
  })();

});


// ── مدل پیش‌فرض + ریستور خودکار (فقط یک‌بار، فقط همان مدل) ──
let defaultProvider = null;
let autoRestoreStarted = false;

async function autoRestoreDefaultProvider(provider) {
  if (autoRestoreStarted) return;
  autoRestoreStarted = true;
  const prov = provider === 'chatgpt' ? 'chatgpt' : provider === 'gemini' ? 'gemini' : 'deepseek';
  defaultProvider = prov;
  providerSwitchInProgress = true;
  try {
    // ══════════ ChatGPT ══════════
    if (prov === 'chatgpt') {
      if (chatgptContext) return;
      let profileExists = false;
      try { await fs.access(CHATGPT_PROFILE_DIR); profileExists = true; } catch {}
      if (!profileExists) {
        chatgptStatus = 'disconnected'; broadcastProviders();
        logTerminal('No saved ChatGPT profile — use Connect ChatGPT to sign in.', 'sys');
        return;
      }
      try {
        logTerminal('Restoring previous ChatGPT session...', 'sys');
        chatgptContext = await launchStealthContext(CHATGPT_PROFILE_DIR, { headless: false });
        activeChatGptPage = await consolidateProviderTabs(chatgptContext, 'chatgpt.com');
        attachChatGptPageHandlers(activeChatGptPage);
        chatgptContext.on('page', (p) => {
          setTimeout(() => { try { if (chatgptContext && p !== activeChatGptPage && !p.isClosed()) p.close().catch(() => {}); } catch {} }, 1500);
        });
        toggleBrowserVisibility(0, path.basename(CHATGPT_PROFILE_DIR));
        if (!/chatgpt\.com/.test(activeChatGptPage.url())) {
          await activeChatGptPage.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        }
        await activeChatGptPage.waitForTimeout(2500);
        toggleBrowserVisibility(0, path.basename(CHATGPT_PROFILE_DIR));
        const diag = await diagnoseChatGptSession(activeChatGptPage);
        if (diag.ok) {
          chatgptStatus = 'connected'; activeProvider = 'chatgpt'; broadcastProviders();
          broadcast({ event: 'chatgpt_logged_in', message: diag.message });
          broadcast({ event: 'agent_status', text: 'Ready! ChatGPT invisible engine active.' });
          const drv = new ChatGptDriver(activeChatGptPage);
          if (typeof drv.clearComposer === 'function' && !/chatgpt\.com\/c\//.test(activeChatGptPage.url())) {
            drv.clearComposer().catch(() => {});
          }
          drv.setThinkEnabled(chatgptThinkEnabled).catch(() => {});
          logTerminal('Auto-connected to saved ChatGPT profile.', 'sys');
        } else {
          chatgptStatus = 'connecting'; activeProvider = 'chatgpt'; broadcastProviders();
          if (diag.status === 'not_logged_in') {
            try { await activeChatGptPage.goto(CHATGPT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
          }
          toggleBrowserVisibility(5, path.basename(CHATGPT_PROFILE_DIR));
          broadcast({ event: 'login_browser_opened', provider: 'chatgpt', message: diag.message });
          broadcast({ event: 'agent_status', text: diag.message });
          startChatGptLoginWatchdog();
        }
      } catch (err) {
        console.error('ChatGPT auto-restore error:', err.message);
        try { if (chatgptContext) await chatgptContext.close(); } catch {}
        chatgptContext = null; activeChatGptPage = null;
        chatgptStatus = 'disconnected'; broadcastProviders();
      }
      return;
    }

    // ══════════ Gemini ══════════
    if (prov === 'gemini') {
      if (geminiContext) return;
      let profileExists = false;
      try { await fs.access(GEMINI_PROFILE_DIR); profileExists = true; } catch {}
      if (!profileExists) {
        geminiStatus = 'disconnected'; broadcastProviders();
        logTerminal('No saved Gemini profile — use Connect Gemini to sign in.', 'sys');
        return;
      }
      try {
        logTerminal('Restoring previous Gemini session...', 'sys');
        geminiContext = await launchStealthContext(GEMINI_PROFILE_DIR, { headless: false });
        activeGeminiPage = await consolidateProviderTabs(geminiContext, 'aistudio.google.com');
        activeGeminiPage.on('close', () => {
          activeGeminiPage = null; geminiContext = null; geminiStatus = 'disconnected';
          if (activeProvider === 'gemini') activeProvider = null;
          if (geminiLoginCheckTimer) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; }
          broadcastProviders();
        });
        geminiContext.on('page', (p) => {
          setTimeout(() => { try { if (geminiContext && p !== activeGeminiPage && !p.isClosed()) p.close().catch(() => {}); } catch {} }, 1500);
        });
        toggleBrowserVisibility(0, path.basename(GEMINI_PROFILE_DIR));
        if (!activeGeminiPage.url().includes('aistudio.google.com/prompts')) {
          await activeGeminiPage.goto(AI_STUDIO_NEW_CHAT, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        await activeGeminiPage.waitForTimeout(2500);
        toggleBrowserVisibility(0, path.basename(GEMINI_PROFILE_DIR));
        const diag = await diagnoseGeminiSession(activeGeminiPage);
        if (diag.ok) {
          geminiStatus = 'connected'; activeProvider = 'gemini'; broadcastProviders();
          broadcast({ event: 'gemini_logged_in', message: diag.message });
          broadcast({ event: 'agent_status', text: 'Ready! Gemini invisible engine active.' });
          new GeminiDriver(activeGeminiPage).ensureModel().catch(() => {});
          logTerminal('Auto-connected to saved Gemini profile.', 'sys');
        } else {
          geminiStatus = 'connecting'; activeProvider = 'gemini'; broadcastProviders();
          toggleBrowserVisibility(5, path.basename(GEMINI_PROFILE_DIR));
          broadcast({ event: 'login_browser_opened', provider: 'gemini', message: diag.message });
          broadcast({ event: 'agent_status', text: diag.message });
          if (geminiLoginCheckTimer) clearInterval(geminiLoginCheckTimer);
          geminiLoginCheckTimer = setInterval(async () => {
            if (!activeGeminiPage || activeGeminiPage.isClosed()) { clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null; return; }
            const d = await diagnoseGeminiSession(activeGeminiPage);
            if (d.ok) {
              clearInterval(geminiLoginCheckTimer); geminiLoginCheckTimer = null;
              geminiStatus = 'connected'; activeProvider = 'gemini'; broadcastProviders();
              broadcast({ event: 'gemini_logged_in', message: d.message });
              switchGeminiToBackground();
            }
          }, 3000);
        }
      } catch (err) {
        console.error('Gemini auto-restore error:', err.message);
        try { if (geminiContext) await geminiContext.close(); } catch {}
        geminiContext = null; activeGeminiPage = null;
        geminiStatus = 'disconnected'; broadcastProviders();
      }
      return;
    }

    // ══════════ DeepSeek ══════════
    if (browserContext) return;
    let profileExists = false;
    try { await fs.access(PROFILE_DIR); profileExists = true; } catch {}
    if (!profileExists) return;
    try {
      logTerminal('Restoring previous DeepSeek session...', 'sys');
      browserContext = await launchStealthContext(PROFILE_DIR, { headless: false });
      activePage = await consolidateProviderTabs(browserContext, 'chat.deepseek.com');
      attachDeepSeekPageHandlers(activePage);
      toggleBrowserVisibility(0);
      if (!activePage.url().includes('chat.deepseek.com')) {
        await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
      }
      await activePage.waitForTimeout(2500);
      toggleBrowserVisibility(0);
      const diag = await diagnoseSession(activePage);
      if (diag.ok) {
        broadcast({ event: 'logged_in', email: 'DeepSeek Active (Invisible)' });
        broadcast({ event: 'agent_status', text: 'Ready! Invisible engine active.' });
        const driver = new DeepSeekDriver(activePage);
        const dtState = await driver.getDeepThinkState();
        if (typeof dtState === 'boolean') {
          broadcast({ event: 'deep_think_status', enabled: dtState });
        }
        deepseekStatus = 'connected'; activeProvider = 'deepseek'; broadcastProviders();
        logTerminal('Auto-connected to saved DeepSeek profile.', 'sys');
      } else {
        await handleDeepSeekSessionExpired('auto-restore');
      }
    } catch (err) {
      console.error('DeepSeek auto-restore error:', err.message);
      try { if (browserContext) await browserContext.close(); } catch {}
      browserContext = null; activePage = null;
      deepseekStatus = 'disconnected'; broadcastProviders();
    }
  } finally {
    providerSwitchInProgress = false;
  }
}

restoreLastWorkspace();
server.listen(PORT, '127.0.0.1', async () => {
  const actualPort = server.address().port;
  console.log(`🚀 MagNum Engine Server listening on ws://127.0.0.1:${actualPort}`);
  await writePortFile(actualPort);
  await writeWsTokenFile();
  // ★ هیچ مرورگری اینجا لانچ نمی‌شود — تا وقتی UI مدل پیش‌فرض را اعلام کند صبر می‌کنیم
});
