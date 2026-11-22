const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const backend = path.join(__dirname, '../src-tauri/resources/backend');
const WebSocket = require(path.join(backend, 'node_modules/ws'));

async function until(read, label) {
  for (let i = 0; i < 1000; i++) {
    const result = read();
    if (result) return result;
    await delay(10);
  }
  throw Error('Timed out waiting for ' + label);
}
function alive(pid) {
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return true; }
    catch (err) { if (err.code === 'ESRCH') return false; throw err; }
  }
  try { return !fs.readFileSync('/proc/' + pid + '/stat', 'utf8').includes(') Z '); }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}
test('two clients, scoped process trees, reconnect and retry', { skip: !['linux', 'win32'].includes(process.platform) }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnum-ownership-'));
  const server = spawn(process.execPath, ['--require', path.join(__dirname, 'provider-fixture.cjs'), 'server.js'], {
    cwd: backend, env: { ...process.env, MAGNUM_DATA_DIR: dir, MAGNUM_BACKEND_PORT: '0' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const exited = once(server, 'exit');
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    server.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => fs.existsSync(path.join(dir, '.ws-token')), 'test backend');
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${read('.backend-port')}?token=${read('.ws-token')}`);
    sockets.push(ws);
    const events = [];
    ws.on('message', msg => events.push(JSON.parse(msg)));
    await once(ws, 'open');
    return {
      send: (action, fields = {}) => ws.send(JSON.stringify({ action, ...fields })),
      event: (name, match = () => true) => until(() => {
        const index = events.findIndex(e => e.event === name && match(e));
        return index >= 0 && events.splice(index, 1)[0];
      }, name),
      close: () => ws.close()
    };
  }
  const a = await connect(), b = await connect();
  a.send('send_prompt', { prompt: 'no workspace' });
  await a.event('task_stopped');
  fs.writeFileSync(path.join(dir, 'worker.cjs'), `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(process.argv[2] + '.pids', process.pid + ' ' + child.pid);
  `);
  fs.writeFileSync(path.join(dir, 'sink.cjs'), `
    require('node:fs').writeFileSync(process.argv[2] + '.sink', String(process.pid));
    process.stdin.resume();
  `);
  a.send('set_workspace', { path: dir });
  await a.event('workspace_loaded');
  const request = { prompt: 'test-pipeline', autoApproveCommand: true };
  a.send('send_prompt', { ...request, requestId: 'preflight' });
  const preflight = await a.event('run_started', e => e.requestId === 'preflight');
  a.send('stop_task', { runId: preflight.runId });
  await a.event('task_stopped', e => e.runId === preflight.runId);
  assert.ok(!fs.existsSync(path.join(dir, 'agent.pids')));
  a.send('send_prompt', { ...request, requestId: 'a' });
  b.send('send_prompt', { ...request, requestId: 'b' });
  const first = await a.event('run_started', e => Boolean(e.requestId));
  const loser = first.requestId === 'a' ? b : a;
  assert.equal((await loser.event('run_busy')).runId, first.runId);
  loser.send('send_prompt', { prompt: 'other provider', provider: 'gemini' });
  assert.equal((await loser.event('run_busy')).accountKey, first.accountKey);
  a.send('terminal_input', { text: 'node worker.cjs terminal | node sink.cjs terminal' });
  const term = await a.event('terminal_echo');
  async function pids(label) {
    return until(() => {
      const file = label + '.pids';
      const sink = label + '.sink';
      if (fs.existsSync(path.join(dir, file)) && fs.existsSync(path.join(dir, sink)) && read(file) && read(sink)) {
        return [...read(file).trim().split(' '), read(sink)].map(Number);
      }
    }, label + ' descendants');
  }
  const agentPids = await pids('agent'), terminalPids = await pids('terminal');
  a.close();
  const c = await connect();
  const snapshot = await c.event('execution_state');
  assert.equal(snapshot.run.runId, first.runId);
  assert.equal(snapshot.commandId, term.commandId);
  c.send('terminal_interrupt', { commandId: first.runId });
  c.send('stop_task', { runId: first.runId });
  c.send('stop_task', { runId: first.runId });
  c.send('send_prompt', request);
  assert.equal((await c.event('run_busy')).runId, first.runId);
  await c.event('task_stopped', e => e.runId === first.runId);
  await until(() => agentPids.every(pid => !alive(pid)), 'agent cleanup');
  assert.ok(terminalPids.every(alive));
  c.send('send_prompt', { prompt: 'hello' });
  const retry = await c.event('run_started');
  assert.notEqual(retry.runId, first.runId);
  c.send('stop_task', { runId: first.runId });
  await c.event('task_finished', e => e.runId === retry.runId);
  c.send('terminal_interrupt', { commandId: term.commandId });
  await c.event('terminal_prompt', e => e.commandId === term.commandId);
  await until(() => terminalPids.every(pid => !alive(pid)), 'terminal cleanup');
  c.send('terminal_input', { text: 'echo retry' });
  c.send('terminal_interrupt', { commandId: term.commandId });
  await c.event('terminal_live_output', e => e.line === 'retry');
  await c.event('terminal_prompt', e => e.commandId !== term.commandId);
});

test('a command timeout cleans up before the next MCP command', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnum-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createTools, callTool } = require(path.join(backend, 'mcp-tools'));
  const tools = createTools(dir);
  const timed = await tools.executeCommand('node -e "setInterval(() => {}, 60000)"', undefined, 100);
  assert.equal(timed.success, false);
  assert.match(timed.output, /timed out/i);
  const reply = await callTool(tools, 'execute_command', { command: 'echo ready' });
  assert.equal(reply.content[0].text, 'ready');
});

test('MCP stdio cancellation selects the request and leaves its peer running', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnum-mcp-'));
  fs.writeFileSync(path.join(dir, 'wait.cjs'), `
    require('node:fs').writeFileSync(process.argv[2], String(process.pid));
    const timer = setInterval(() => {
      if (require('node:fs').existsSync('finish')) {
        clearInterval(timer);
        console.log('finished');
      }
    }, 25);
  `);
  const mcp = spawn(process.execPath, [path.join(backend, 'mcp-server.js'), '--workspace', dir]);
  const exited = once(mcp, 'exit');
  t.after(async () => {
    mcp.stdin.end();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const replies = [];
  require('node:readline').createInterface({ input: mcp.stdout }).on('line', line => replies.push(JSON.parse(line)));
  const send = msg => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  for (const id of ['one', 'two']) {
    send({ id, method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'node wait.cjs ' + id } } });
  }
  const pid = id => {
    const file = path.join(dir, id);
    return fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8'));
  };
  await until(() => pid('one') && pid('two'), 'two MCP commands');
  send({ method: 'notifications/cancelled', params: { requestId: 'one' } });
  await until(() => !alive(pid('one')), 'cancelled MCP process');
  assert.ok(alive(pid('two')));
  fs.writeFileSync(path.join(dir, 'finish'), '');
  const peer = await until(() => replies.find(r => r.id === 'two'), 'peer MCP response');
  assert.equal(peer.result.content[0].text, 'finished');
  assert.ok(!replies.some(r => r.id === 'one'));
});
