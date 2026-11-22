'use strict';

const { execFile } = require('node:child_process');

function git(cwd, args, { diff = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '--literal-pathspecs', ...args], {
      cwd, windowsHide: true, timeout: 5000, maxBuffer: diff ? 160 * 1024 : 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    }, (error, stdout, stderr) => {
      if (!error || (diff && error.code === 1 && !stderr)) {
        resolve({ stdout, truncated: false });
      } else if (diff && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        resolve({ stdout, truncated: true });
      } else {
        reject(error);
      }
    });
  });
}

async function workspaceChanges(cwd, selection) {
  if (!cwd) return { status: 'no-workspace' };
  let root;
  try {
    const result = await git(cwd, ['rev-parse', '--show-toplevel']);
    root = result.stdout.replace(/\r?\n$/, '');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'unavailable' };
    if (error.message.includes('not a git repository')) return { status: 'non-git' };
    return { status: 'error', message: 'Could not locate the Git working tree.' };
  }

  try {
    const { stdout } = await git(root, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const records = stdout.split('\0');
    const files = [];
    for (let i = 0; i < records.length - 1; i++) {
      const state = records[i].slice(0, 2);
      const file = records[i].slice(3);
      const original = /[RC]/.test(state) ? records[++i] : undefined;
      files.push({ file, state, original });
    }
    if (!selection) return { status: 'ready', root, files: files.slice(0, 1000), truncated: files.length > 1000 };

    const entry = files.find(item => item.file === selection.file);
    if (!entry) return { status: 'error', message: 'This file is no longer changed. Refresh the workspace list.' };
    const { layer } = selection;
    const args = ['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color'];
    if (entry.state === '??' && layer === 'untracked') {
      const relative = './' + entry.file;
      args.push('--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', relative);
    } else if (entry.state !== '??' && (
      (layer === 'staged' && entry.state[0] !== ' ') || (layer === 'unstaged' && entry.state[1] !== ' ')
    )) {
      if (layer === 'staged') args.push('--cached');
      args.push('--', entry.file);
      if (entry.original) args.push(entry.original);
    } else {
      return { status: 'error', message: 'This change is no longer available. Refresh the workspace list.' };
    }

    const { stdout: patch, truncated } = await git(root, args, { diff: true });
    const lines = patch ? patch.replace(/\n$/, '').split('\n') : [];
    let inHunk = false;
    const diff = lines.slice(0, 400).map(text => {
      if (text.startsWith('diff ')) inHunk = false;
      if (text.startsWith('@@')) inHunk = true;
      const type = inHunk && text.startsWith('+') ? 'add' : inHunk && text.startsWith('-') ? 'del' : 'ctx';
      return { type, text: type === 'ctx' ? text : text.slice(1) };
    });
    return { status: 'ready', diff, truncated: truncated || lines.length > 400 };
  } catch {
    return { status: 'error', message: 'Git could not read these changes. Refresh to try again.' };
  }
}

module.exports = workspaceChanges;
