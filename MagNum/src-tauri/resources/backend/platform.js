'use strict';

// Per-OS helpers for the backend. Every win32 branch is the original Windows
// code moved here unchanged; the Linux/macOS branches are additions.

const fsSync = require('node:fs');
const { exec, execFile, spawn } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Shell used by tools.js executeCommand. undefined = Node's default
// (cmd.exe on Windows, /bin/sh elsewhere). On Linux/macOS prefer bash, since
// the agent prompt tells the model it is talking to bash.
const commandShell = !IS_WIN && fsSync.existsSync('/bin/bash') ? '/bin/bash' : undefined;

// ---------------------------------------------------------------- terminal

// Runs `cmd` in a fresh shell and, when it finishes, prints the marker line
//   TERM_MARK 'PS1' TERM_MARK <cwd> TERM_MARK <0|1> TERM_MARK
// that server.js termFeed() parses to track cwd and exit status.
function spawnTerminal(cmd, cwd, TERM_MARK) {
  if (IS_WIN) {
    const wrapped = `${cmd}\r\nWrite-Host ('${TERM_MARK}PS1${TERM_MARK}'+(Get-Location).Path+'${TERM_MARK}'+$(if($?){0}else{1})+'${TERM_MARK}')`;
    return spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', wrapped], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
    });
  }
  // An EXIT trap prints the marker even after `exit N` or a syntax error.
  // TERM_MARK is passed via the environment so no escaping is needed.
  const trap = `trap '__mg_rc=$?; printf "%sPS1%s%s%s%s%s\\n" "$__MG_M" "$__MG_M" "$PWD" "$__MG_M" "$([ "$__mg_rc" -eq 0 ] && echo 0 || echo 1)" "$__MG_M"' EXIT`;
  const child = spawn('bash', ['-c', `${trap}\n${cmd}`], {
    cwd: cwd || undefined,
    env: { ...process.env, NO_COLOR: '1', __MG_M: TERM_MARK },
    detached: true, // own process group, so kill() also stops what the command started
  });
  const killOne = child.kill.bind(child);
  child.kill = (sig = 'SIGTERM') => {
    try { process.kill(-child.pid, sig); return true; } catch { return killOne(sig); }
  };
  return child;
}

// ------------------------------------------------------------ folder picker

// Resolves stdout of a dialog program, null if cancelled, undefined if the
// program is not installed.
function runDialog(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(undefined);
      const out = String(stdout || '').trim();
      resolve(!err && out ? out : null);
    });
  });
}

// Resolves the chosen folder, or null if cancelled / no dialog is available.
async function pickFolder() {
  if (IS_WIN) {
    return new Promise((resolve) => {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $dialog = New-Object System.Windows.Forms.OpenFileDialog
      $dialog.Title = 'Select Project Folder'
      $dialog.Filter = 'Folders|*.none'
      $dialog.FileName = 'Select This Folder'
      $dialog.CheckFileExists = $false
      $dialog.CheckPathExists = $true
      $dialog.ValidateNames = $false
      $dialog.DereferenceLinks = $false
      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $selected = [System.IO.Path]::GetDirectoryName($dialog.FileName)
        if (-not $selected) { $selected = $dialog.FileName }
        [Console]::WriteLine($selected)
      }
    `;
    const base64Code = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${base64Code}`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
    });
  }
  if (IS_MAC) {
    const r = await runDialog('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select Project Folder")']);
    return r ? r.replace(/\/$/, '') || '/' : null;
  }
  let r = await runDialog('zenity', ['--file-selection', '--directory', '--title=Select Project Folder']);
  if (r !== undefined) return r;
  r = await runDialog('kdialog', ['--getexistingdirectory', process.env.HOME || '/', '--title', 'Select Project Folder']);
  return r || null;
}

// ------------------------------------------------------------ file manager

function revealInFileManager(dir) {
  if (IS_WIN) {
    exec(`explorer.exe "${dir.replace(/\//g, '\\')}"`);
    return;
  }
  try {
    const child = spawn(IS_MAC ? 'open' : 'xdg-open', [dir], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// ------------------------------------------------- automation browser window

function runQuiet(bin, args) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch { resolve(null); }
  });
}

// state: 0 = hide, 5 = show (the ShowWindowAsync values the Windows code uses).
// Finds the Chrome/Edge processes whose command line contains profileName and
// minimizes / raises their windows. Linux: xdotool, else wmctrl (X11 or
// XWayland windows only). Anything missing or failing is a silent no-op.
async function setBrowserVisibility(state, profileName) {
  if (IS_WIN) {
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
    return;
  }
  if (IS_MAC || !profileName) return;
  try {
    const show = state === 5;
    const hasXdotool = (await runQuiet('xdotool', ['version'])) !== null;
    const hasWmctrl = !hasXdotool && (await runQuiet('wmctrl', ['-m'])) !== null;
    if (!hasXdotool && !hasWmctrl) return;
    for (let i = 0; i < 20; i++) {
      const pids = new Set(((await runQuiet('pgrep', ['-f', '--', profileName])) || '')
        .split('\n').map((s) => s.trim()).filter((s) => s && s !== String(process.pid)));
      const ids = [];
      if (hasXdotool) {
        for (const pid of pids) {
          const out = await runQuiet('xdotool', ['search', '--pid', pid]);
          if (out) ids.push(...out.split('\n').map((s) => s.trim()).filter(Boolean));
        }
        for (const id of ids) {
          if (show) await runQuiet('xdotool', ['windowactivate', id]);
          else await runQuiet('xdotool', ['windowminimize', id]);
        }
      } else {
        for (const line of ((await runQuiet('wmctrl', ['-lp'])) || '').split('\n')) {
          const f = line.trim().split(/\s+/);
          if (f.length > 2 && pids.has(f[2])) ids.push(f[0]);
        }
        for (const id of ids) {
          if (show) {
            await runQuiet('wmctrl', ['-i', '-r', id, '-b', 'remove,hidden']);
            await runQuiet('wmctrl', ['-i', '-a', id]);
          } else await runQuiet('wmctrl', ['-i', '-r', id, '-b', 'add,hidden']);
        }
      }
      if (ids.length) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {}
}

// ----------------------------------------------------------- prompt hints

// Pieces of the agent system prompt that depend on the OS. The Windows values
// reproduce the original prompt text exactly.
const osPromptHint = IS_WIN ? {
  os: 'Windows',
  shell: 'cmd/PowerShell',
  downloader: 'curl or powershell',
  downloadCmd: 'powershell -Command "Invoke-WebRequest -Uri \'https://site.com/file.zip\' -OutFile \'assets/file.zip\'"',
  pathKind: 'Windows',
  pathExample: 'D:\\OtherProject',
} : {
  os: IS_MAC ? 'macOS' : 'Linux',
  shell: 'bash',
  downloader: 'curl or wget',
  downloadCmd: 'curl -L -o \'assets/file.zip\' \'https://site.com/file.zip\'',
  pathKind: IS_MAC ? 'macOS' : 'Linux',
  pathExample: IS_MAC ? '/Users/me/OtherProject' : '/home/me/OtherProject',
};

module.exports = { commandShell, spawnTerminal, pickFolder, revealInFileManager, setBrowserVisibility, osPromptHint };
