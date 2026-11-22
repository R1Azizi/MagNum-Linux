const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const backend = path.resolve(__dirname, '../src-tauri/resources/backend');
const dist = path.resolve(__dirname, '../dist');
const { chromium } = require(path.join(backend, 'node_modules/playwright'));
const WebSocket = require(path.join(backend, 'node_modules/ws'));

async function until(predicate, label) {
  for (let i = 0; i < 500; i++) {
    const value = await predicate();
    if (value) return value;
    await delay(30);
  }
  assert.fail('Timed out waiting for ' + label);
}

test('Linux sidebar shows a stopped run after reconnecting and reopening the app', { skip: process.platform !== 'linux' }, async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'magnum-inspection-'));
  const dataDir = path.join(tmp, 'data'), repo = path.join(tmp, 'repo'), workspace = path.join(repo, 'nested');
  const nonGit = path.join(tmp, 'plain');
  await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspace, { recursive: true }), fs.mkdir(nonGit)]);
  const write = (cwd, file, text) => fs.writeFile(path.join(cwd, file), text);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await write(repo, 'mixed.txt', 'base\nuntouched target\n');
  await write(workspace, 'file.txt', 'base context\nagent target\n');
  git('add', '.');
  git('-c', 'user.name=MagNum', '-c', 'user.email=magnum@example.test', 'commit', '-qm', 'Baseline');
  await write(repo, 'mixed.txt', 'staged line\nuntouched target\n');
  git('add', 'mixed.txt');
  await write(repo, 'mixed.txt', 'staged line\nunstaged line\nuntouched target\n');
  await write(repo, 'preexisting name.txt', 'untracked line\n');
  await write(workspace, 'file.txt', 'preexisting context\nagent target\n');
  const originalIndex = await fs.readFile(path.join(repo, '.git', 'index'));
  await write(workspace, 'activity.cjs', "console.log('fixture command output'); console.log('x'.repeat(12000)); process.exitCode = 7;");
  await write(workspace, 'wait.cjs', "require('node:fs').writeFileSync('running.marker', 'ready'); setInterval(() => {}, 1000);");
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  let server, ws, ui, context;
  async function stopEngine() {
    ws?.terminate();
    if (!server) return;
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
    server = null;
  }
  t.after(async () => {
    await context?.close();
    await browser.close();
    await stopEngine();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const read = name => fs.readFile(path.join(dataDir, name), 'utf8');
  async function startEngine() {
    await Promise.allSettled(['.ws-token', '.backend-port'].map(file => fs.unlink(path.join(dataDir, file))));
    server = spawn(process.execPath, ['--require', path.join(__dirname, 'provider-fixture.cjs'), 'server.js'], {
      cwd: backend, env: { ...process.env, MAGNUM_DATA_DIR: dataDir, MAGNUM_BACKEND_PORT: '0' },
      stdio: ['ignore', 'ignore', 'inherit']
    });
    const token = await until(() => read('.ws-token').catch(() => null), 'engine token');
    const port = Number(await read('.backend-port'));
    ws = new WebSocket('ws://127.0.0.1:' + port + '?token=' + token);
    const events = [];
    ws.on('message', data => events.push(JSON.parse(data)));
    await once(ws, 'open');
    return {
      port, token,
      send: (action, fields) => ws.send(JSON.stringify({ action, ...fields })),
      event: (name, match = () => true) => until(() => {
        const index = events.findIndex(event => event.event === name && match(event));
        return index >= 0 && events.splice(index, 1)[0];
      }, name)
    };
  }
  async function openUI({ port, token }) {
    context = await browser.newContext({ permissions: ['local-network-access'] });
    ui = await context.newPage();
    await ui.addInitScript(({ port, token }) => {
      window.__TAURI_INTERNALS__ = { invoke: async command =>
        command.includes('backend_port') ? port : command === 'read_ws_token' ? token : null };
      localStorage.setItem('magnum_cmdapproval', '0');
    }, { port, token });
    await ui.route('http://localhost:1430/**', route => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      return route.fulfill({ path: path.join(dist, file) });
    });
    await ui.goto('http://localhost:1430/');
    await ui.getByRole('button', { name: 'View', exact: true }).waitFor();
  }
  async function openPanel(name) {
    await ui.getByRole('button', { name: 'View', exact: true }).click();
    await ui.locator('.dropdown-item').getByText(name, { exact: true }).click();
  }
  let engine = await startEngine();
  await engine.event('execution_state', event => event.capabilities.runActivity);
  engine.send('set_workspace', { path: workspace });
  await engine.event('workspace_loaded', event => event.path === workspace);
  await openUI(engine);
  await openPanel('Activity');
  engine.send('send_prompt', { prompt: 'test-activity', autoApproveCommand: false, autoApplyPatch: true });
  const run = await engine.event('run_started');
  const session = await engine.event('sessions_list', event => event.runId === run.runId && event.currentSessionId);
  const sessionId = session.currentSessionId;
  const execute = ui.getByRole('button', { name: 'Execute', exact: true });
  await execute.click();
  await ui.getByText('$ node wait.cjs', { exact: true }).waitFor();
  await execute.click();
  await until(() => fs.stat(path.join(workspace, 'running.marker')).catch(() => null), 'second command to start');
  await openPanel('Activity');
  await write(workspace, 'concurrent.txt', 'concurrent change\n');
  const activity = () => ui.getByRole('region', { name: 'Run activity' });
  await activity().getByText('Command failed', { exact: true }).waitFor();
  await activity().getByText('Exit code 7').waitFor();
  await activity().locator('.inspection-status').getByText(/node wait\.cjs/).waitFor();
  assert.equal(await activity().getByTitle('Run workspace').textContent(), workspace);
  assert.match(await activity().locator('.inspection-status .inspection-row span').textContent(), /\d+s/);
  assert.equal(await activity().getByText('Command started', { exact: true }).count(), 2);
  assert.equal(await activity().getByText('Command approved', { exact: true }).count(), 2);

  await ui.reload();
  await openPanel('Activity');
  await activity().getByText('File written', { exact: true }).waitFor();
  await activity().getByText('Command started', { exact: true }).nth(1).waitFor();
  await ui.getByRole('button', { name: 'Stop', exact: true }).click();
  await engine.event('task_stopped', event => event.runId === run.runId);
  await activity().getByText('Stopped', { exact: true }).waitFor();
  await activity().getByText('Command cancelled', { exact: true }).waitFor();
  await activity().getByText('Stop requested', { exact: true }).waitFor();
  const failedCommand = activity().locator('li').filter({ hasText: 'Exit code 7' });
  await failedCommand.getByText('Command output', { exact: true }).click();
  const output = await failedCommand.locator('pre').textContent();
  assert.ok(output.startsWith('fixture command output'));
  assert.ok(output.length < 5200);
  assert.match(output, /truncated/);
  assert.equal(await fs.readFile(path.join(workspace, 'file.txt'), 'utf8'), 'preexisting context\nagent update\n');

  // Close the webview and restart the engine using the same data directory.
  await context.close();
  await stopEngine();
  engine = await startEngine();
  await openUI(engine);
  const savedChat = ui.locator('.session-row').filter({ hasText: 'test-activity' });
  await savedChat.click();
  await openPanel('Activity');
  await activity().getByText('Stopped', { exact: true }).waitFor();
  await activity().getByText('Patch applied', { exact: true }).waitFor();
  assert.equal(await activity().getByRole('combobox').inputValue(), run.runId);
  await ui.locator('aside').getByRole('button', { name: 'New Chat' }).click();
  await activity().getByText('No recorded runs for this chat.').waitFor();
  await savedChat.click();
  await activity().getByText('Stopped', { exact: true }).waitFor();

  await openPanel('Changes');
  const changes = ui.getByRole('region', { name: 'Changes' });
  const gitFile = name => changes.locator('.inspection-git-file').filter({ hasText: name });
  await gitFile('mixed.txt').getByRole('button', { name: 'Staged · Modified', exact: true }).click();
  await gitFile('mixed.txt').getByText('staged line', { exact: true }).waitFor();
  await gitFile('mixed.txt').getByRole('button', { name: 'Unstaged · Modified', exact: true }).click();
  await gitFile('mixed.txt').getByText('unstaged line', { exact: true }).waitFor();
  await gitFile('preexisting name.txt').getByRole('button', { name: 'Untracked' }).click();
  await gitFile('preexisting name.txt').getByText('untracked line', { exact: true }).waitFor();
  await gitFile('concurrent.txt').getByText('nested/concurrent.txt', { exact: true }).waitFor();
  assert.deepEqual(await fs.readFile(path.join(repo, '.git', 'index')), originalIndex);
  await changes.getByRole('button', { name: 'Run edits' }).click();
  const patch = changes.getByRole('button', { name: /Edit file\.txt/ });
  await patch.click();
  await changes.getByText('agent update', { exact: true }).waitFor();
  await changes.getByRole('button', { name: /Edit created\.txt/ }).click();
  await changes.getByText('written by MagNum', { exact: true }).waitFor();
  assert.equal(await changes.getByText(/preexisting context|preexisting name|concurrent\.txt|mixed\.txt/).count(), 0);
  await openPanel('Edit Review');
  await ui.getByText('All Chat Changes', { exact: true }).waitFor();
  await openPanel('Changes');

  engine.send('open_workspace', { path: nonGit });
  await engine.event('workspace_loaded', event => event.path === nonGit);
  await changes.getByRole('button', { name: 'Workspace Git' }).click();
  await changes.getByText('This workspace is outside a Git repository.').waitFor();
  engine.send('send_prompt', { prompt: 'hello from plain workspace', sessionId });
  const plainRun = await engine.event('run_started');
  await engine.event('task_finished', event => event.runId === plainRun.runId);
  await openPanel('Activity');
  await activity().getByText('Completed', { exact: true }).waitFor();
  await activity().getByRole('combobox').selectOption(run.runId);
  await activity().getByText('Stopped', { exact: true }).waitFor();
});

test('Git absence is reported without preventing workspace inspection', async t => {
  const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'magnum-no-git-'));
  t.after(() => fs.rm(emptyPath, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, ['-e',
    "require(process.argv[1])(process.cwd()).then(result => console.log(JSON.stringify(result)))",
    path.join(backend, 'git-changes.js')], { cwd: emptyPath, env: { ...process.env, PATH: emptyPath }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { status: 'unavailable' });
});

test('older command previews expire while the activity and outcomes persist', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnum-activity-retention-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = script => execFileSync(process.execPath, ['-e', 'const store = require(process.argv[1]);\n' + script,
    path.join(backend, 'session-store.js')], { env: { ...process.env, MAGNUM_DATA_DIR: dir }, encoding: 'utf8' });
  run(`
    store.startRun({ id: 'test', provider: 'deepseek', sessionId: null });
    for (let i = 0; i < 15; i++) store.addRunActivity('test', {
      type: 'tool_result', action: 'execute_command', exitCode: i, output: 'x'.repeat(6000)
    });
    store.finishRun('test', 'stopped', 'Stopped.');
    store.startRun({ id: 'left-running', provider: 'deepseek', sessionId: null });
  `);
  const activity = JSON.parse(run(`
    const get = id => store.getRunActivity(id, null, 'deepseek', Number.MAX_SAFE_INTEGER);
    console.log(JSON.stringify([get('test'), get('left-running')]));
  `));
  assert.equal(activity[0].outcome, 'stopped');
  assert.equal(activity[1].outcome, 'interrupted');
  assert.equal(activity[0].events.length, 15);
  assert.equal(activity[0].events[0].exitCode, 0);
  assert.equal(activity[0].events[0].output, null);
  assert.equal(activity[0].events[0].hadOutput, true);
  assert.equal(activity[0].events.filter(event => event.output).length, 12);
  assert.equal(activity[0].events[14].output.length, 5100);
});

test('older activity databases gain the run workspace column without losing history', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnum-activity-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = script => execFileSync(process.execPath, ['-e', 'const store = require(process.argv[1]);\n' + script,
    path.join(backend, 'session-store.js')], { env: { ...process.env, MAGNUM_DATA_DIR: dir }, encoding: 'utf8' });
  run(`
    store.startRun({ id: 'old-run', provider: 'deepseek', sessionId: null });
    store.addRunActivity('old-run', { type: 'tool_result', exitCode: 0 });
    store.finishRun('old-run', 'completed', 'Done');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(require('node:path').join(process.env.MAGNUM_DATA_DIR, 'magnum.db'));
    db.exec('ALTER TABLE runs DROP COLUMN workspace_path');
    db.close();
  `);
  const checkHistory = `
    const get = id => store.getRunActivity(id, null, 'deepseek', Number.MAX_SAFE_INTEGER);
    console.log(JSON.stringify({ list: store.listRuns(null, 'deepseek', 0), old: get('old-run'), fresh: get('new-run') }));
  `;
  const migrated = JSON.parse(run(checkHistory));
  assert.equal(migrated.list.runs[0].workspace, null);
  assert.equal(migrated.old.outcome, 'completed');
  assert.equal(migrated.old.events[0].exitCode, 0);
  const reopened = JSON.parse(run(`
    store.startRun({ id: 'new-run', provider: 'deepseek', sessionId: null });
    store.setRunWorkspace('new-run', 'example-workspace');
    ${checkHistory}
  `));
  assert.equal(reopened.list.runs.length, 2);
  assert.equal(reopened.fresh.workspace, 'example-workspace');
});

test('mobile viewport with a legacy engine records tool events without Git', { skip: process.platform !== 'linux' }, async t => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  t.after(() => browser.close());
  const ui = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await ui.addInitScript(() => {
    const actions = [];
    window.inspectorTestActions = actions;
    window.__TAURI_INTERNALS__ = { invoke: async command =>
      command.includes('backend_port') ? 5454 : command === 'read_ws_token' ? 'a'.repeat(64) : null };
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          this.emit({ event: 'auth_status', isLoggedIn: true });
          this.emit({ event: 'workspace_loaded', path: 'mobile-workspace', tree: [] });
        }, 10);
      }
      emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
      send(raw) {
        const { action } = JSON.parse(raw);
        actions.push(action);
        if (action === 'send_prompt') setTimeout(() => {
          this.emit({ event: 'tool_started', action: 'execute_command', target: 'limited command' });
          this.emit({ event: 'tool_result', action: 'execute_command', status: 'succeeded', exitCode: 0 });
          this.emit({ event: 'file_patched', file: 'mobile.txt' });
          this.emit({ event: 'task_finished', summary: 'Finished on the legacy engine.' });
        });
      }
      close() {}
    };
  });
  await ui.route('http://localhost:1430/**', route => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    return route.fulfill({ path: path.join(dist, file) });
  });
  async function panel(name) {
    await ui.getByRole('button', { name: 'View', exact: true }).click();
    await ui.locator('.dropdown-item').getByText(name, { exact: true }).click();
  }
  await ui.goto('http://localhost:1430/');
  await ui.locator('main textarea').fill('Track this legacy run');
  await ui.locator('main textarea').press('Enter');
  await panel('Activity');
  const activity = ui.getByRole('region', { name: 'Run activity' });
  await activity.getByText('Completed', { exact: true }).waitFor();
  await activity.getByText('Exit code 0', { exact: true }).waitFor();
  await activity.getByText('mobile.txt', { exact: true }).waitFor();
  await panel('Changes');
  assert.equal(await ui.getByRole('button', { name: 'Workspace Git' }).count(), 0);
  assert.equal(await ui.evaluate(() => window.inspectorTestActions.includes('get_workspace_changes')), false);
  await ui.reload();
  await panel('Activity');
  await activity.getByText('Completed', { exact: true }).waitFor();
  await activity.getByText('mobile.txt', { exact: true }).waitFor();
});
