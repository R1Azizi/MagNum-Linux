const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const test = require('node:test');
const { chromium } = require('../src-tauri/resources/backend/node_modules/playwright');

test('Android DeepSeek driver requires sign-in and sets DeepThink and reads only the new reply', async t => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true
  });
  t.after(() => browser.close());

  const provider = await browser.newPage();
  await provider.route('https://chat.deepseek.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <main>
        <div class="ds-user-message">Previous question</div>
        <div class="ds-markdown">Previous answer</div>
      </main>
      <div>
        <textarea id="chat-input"></textarea>
        <div role="button" class="ds-toggle-button">DeepThink (R1)</div>
        <button disabled class="ds-button--primary ds-button--circle">Send</button>
      </div>
      <script>
        const input = document.querySelector('textarea');
        const send = document.querySelector('button');
        window.clicks = 0;
        document.querySelector('.ds-toggle-button').onclick = event => {
          event.currentTarget.classList.toggle('ds-toggle-button--selected');
        };
        input.oninput = () => { send.disabled = !input.value.trim(); };
        send.onclick = () => {
          window.clicks++;
          const message = document.createElement('div');
          message.className = 'ds-user-message';
          message.textContent = input.value;
          document.querySelector('main').append(message);
          input.value = '';
          send.disabled = true;
        };
      </script>`
  }));
  await provider.goto('https://chat.deepseek.com/a/chat/s/example');
  const source = await readFile(join(__dirname, '../src-tauri/android-provider/android/src/main/assets/magnum-deepseek.js'), 'utf8');
  const call = (operation, args = {}) => provider.evaluate(`(${source})(${JSON.stringify(operation)}, ${JSON.stringify(args)})`);

  assert.equal((await call('status')).state, 'sign_in');
  assert.equal((await call('fill', { prompt: 'hello', path: '/a/chat/s/example' })).state, 'sign_in');
  assert.equal(await provider.locator('textarea').inputValue(), '');

  await provider.evaluate(() => localStorage.setItem('userToken', 'fixture'));
  assert.equal((await call('status')).state, 'ready');
  assert.equal((await call('fill', { prompt: 'hello', path: '/' })).state, 'unavailable');
  const fill = { prompt: 'hello', path: '/a/chat/s/example', deepThink: true };
  assert.equal((await call('fill', fill)).state, 'checking_thinking');
  assert.equal(await provider.locator('textarea').inputValue(), '');
  assert.equal((await call('fill', { ...fill, confirmThinking: true })).state, 'filled');
  assert.equal(await provider.locator('.ds-toggle-button--selected').count(), 1);
  assert.equal((await call('submit')).state, 'submitted');
  assert.equal((await call('submit')).state, 'unavailable');
  assert.equal(await provider.evaluate(() => window.clicks), 1);
  assert.equal((await call('poll')).state, 'waiting');

  await provider.locator('main').evaluate(el => {
    const reply = document.createElement('div');
    reply.className = 'ds-markdown';
    reply.textContent = 'Hello from the new turn';
    el.append(reply);
    const stop = document.querySelector('button');
    stop.disabled = false;
    stop.setAttribute('aria-label', 'Stop generating');
  });
  assert.deepEqual(await call('poll'), {
    state: 'reply', path: '/a/chat/s/example', text: 'Hello from the new turn', busy: true
  });
  await provider.locator('button').evaluate(el => { el.disabled = true; });
  assert.equal((await call('poll')).busy, false);
  assert.equal((await call('fill', { ...fill, deepThink: false })).state, 'checking_thinking');
  assert.equal((await call('fill', { ...fill, deepThink: false, confirmThinking: true })).state, 'filled');
  assert.equal(await provider.locator('.ds-toggle-button--selected').count(), 0);
});

test('Android chat restores sign-in flow and keeps a reviewed agent run in its original workspace', async () => {
  const saved = new Map();
  const path = '/a/chat/s/fixture-session';
  const operations = [];
  let location = '/';
  let signedIn = false;
  const project = '/data/data/magnum/files/agent-workspaces/project';
  const other = '/data/data/magnum/files/agent-workspaces/other';
  const tools = [
    { action: 'read_files', description: 'Read files.', args: '{"files":["src/math.lua"]}' },
    { action: 'patch_file', description: 'Patch files.', args: '{"patches":[]}' },
    { action: 'execute_command', description: 'Run Lua.', args: '{"command":"lua tests/test.lua"}' },
  ];
  let agentTurn = -1;
  let nativeRun;
  const seenTools = [];

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: key => saved.delete(key)
    }
  });
  globalThis.window = {
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command, { request, output }) => {
        if (command === 'plugin:android-provider|android_agent') {
          if (request.action === 'capabilities') return { tools };
          if (request.action === 'workspaces') return { paths: [project, other] };
          if (request.action === 'inspect') return { tree: [] };
          if (request.action === 'browse') {
            throw new Error('Open Android Files and look for MagNum Workspaces in its locations menu.');
          }
          if (request.action === 'begin') {
            assert.equal(request.path, project);
            nativeRun = request.runId;
            return {};
          }
          assert.equal(request.runId, nativeRun);
          if (['stop', 'end'].includes(request.action)) return {};
          assert.equal(request.action, 'tool');
          const { action, ...params } = request.tool;
          seenTools.push(action);
          if (action === 'read_files') return { files: [{ file: 'src/math.lua', content: '1: return a - b' }] };
          if (action === 'patch_file') {
            assert.deepEqual(params.patches[0], { file: 'src/math.lua', search: 'a - b', replace: 'a + b' });
            return { success: true, details: [{ file: 'src/math.lua', success: true, edit: { search: 'a - b', replace: 'a + b' } }] };
          }
          if (action === 'execute_command') {
            output.onmessage({ line: 'PASS: addition', isErr: false });
            return { success: true, status: 'exited', exitCode: 0, output: 'PASS: addition' };
          }
          assert.fail('Unexpected Android agent tool');
        }
        assert.equal(command, 'plugin:android-provider|provider');
        operations.push(request.operation);
        switch (request.operation) {
          case 'navigate':
            location = request.path;
            return null;
          case 'show':
            assert.equal(request.signIn, 'true');
            signedIn = true;
            return null;
          case 'status':
            return signedIn
              ? { state: 'ready', path: location === '/' ? undefined : location }
              : { state: 'sign_in' };
          case 'fill':
            if (location === '/') {
              assert.match(request.prompt, /^# MAGNUM — SOFTWARE ENGINEERING ASSISTANT/);
              assert.match(request.prompt, /USER TASK:\nPlease say hello$/);
              assert.equal(request.path, '/');
              assert.equal(request.deepThink, true);
            } else if (request.prompt.endsWith('Fix the addition test')) {
              assert.match(request.prompt, /execute_command/);
              assert.ok(request.prompt.includes(project));
              assert.ok(!request.prompt.includes(other));
              agentTurn = 0;
            } else if (agentTurn !== -1) {
              assert.match(request.prompt, /^TOOL RESULT/);
              assert.match(request.prompt, [/return a - b/, /a \+ b/, /"exitCode":0/][agentTurn]);
              agentTurn++;
            } else {
              assert.equal(request.prompt, 'Keep going');
              assert.equal(request.path, path);
              assert.equal(request.deepThink, false);
            }
            return { state: 'filled' };
          case 'submit':
            location = path;
            return { state: 'submitted' };
          case 'poll': {
            const decision = [
              { action: 'read_files', params: { files: ['src/math.lua'] } },
              { action: 'patch_file', params: { patches: [{ file: 'src/math.lua', search: 'a - b', replace: 'a + b' }] } },
              { action: 'execute_command', params: { command: 'lua tests/test.lua' } },
              { action: 'finish', params: { summary: 'Fixed and verified addition.' } },
            ][agentTurn];
            const text = decision ? JSON.stringify(decision) : 'Hello from DeepSeek';
            const code = agentTurn === 3 ? text : undefined;
            return { state: 'reply', path, text: code ? `json\nCopy\n${code}` : text, code };
          }
          default:
            throw new Error('Unexpected browser operation');
        }
      }
    }
  };

  const { AndroidProviderTransport } = await import('../src/hooks/androidProviderTransport.ts');
  const { setTimeout: wait } = require('node:timers/promises');
  const open = () => {
    const socket = new AndroidProviderTransport();
    const events = [];
    socket.onmessage = event => events.push(JSON.parse(event.data));
    return {
      socket,
      send: action => socket.send(JSON.stringify(action)),
      async until(predicate) {
        const deadline = Date.now() + 8500;
        while (Date.now() < deadline) {
          const event = events.find(predicate);
          if (event) return event;
          await wait(10);
        }
        assert.fail('Expected chat protocol event was never received');
      }
    };
  };

  let client = open();
  try {
    await client.until(event => event.event === 'android_provider_status' && event.status === 'sign_in');
    client.send({ action: 'show_provider_browser' });
    await client.until(event => event.event === 'android_provider_status' && event.status === 'ready');
    client.send({ action: 'send_prompt', prompt: 'Please say hello', requestId: 'test-prompt', deepThink: true });
    const reply = await client.until(event => event.event === 'agent_message');
    assert.equal(reply.text, 'Hello from DeepSeek');
    assert.equal(operations.filter(operation => operation === 'submit').length, 1);
    await client.until(event => event.event === 'task_finished');

    client.socket.close();
    client = open();
    const restored = await client.until(event => event.event === 'session_loaded' && event.session);
    await client.until(event => event.event === 'android_provider_status' && event.status === 'ready');
    assert.equal(location, path);
    assert.equal(restored.session.id, reply.sessionId);
    assert.deepEqual(restored.session.messages.map(message => message.text), ['Please say hello', 'Hello from DeepSeek']);
    client.send({ action: 'send_prompt', prompt: 'Keep going', sessionId: reply.sessionId, deepThink: false });
    await client.until(event => event.event === 'agent_message');
    assert.equal(operations.filter(operation => operation === 'submit').length, 2);
    await client.until(event => event.event === 'task_finished');

    client.send({ action: 'open_workspace', path: project });
    await client.until(event => event.event === 'workspace_loaded' && event.path === project);
    client.send({ action: 'browse_workspaces' });
    await client.until(event => event.event === 'android_workspace_status' && event.message?.includes('MagNum Workspaces'));
    client.send({ action: 'send_prompt', prompt: 'Fix the addition test', sessionId: reply.sessionId, autoApproveCommand: true });
    await client.until(event => event.event === 'patch_proposed');
    assert.deepEqual(seenTools, ['read_files']);
    client.send({ action: 'open_workspace', path: other });
    await client.until(event => event.event === 'workspace_loaded' && event.path === other);
    client.send({ action: 'new_chat' });
    await client.until(event => event.event === 'android_provider_status' && event.status === 'busy');
    client.send({ action: 'approve_patch' });
    await client.until(event => event.event === 'terminal_live_output' && event.line === 'PASS: addition');
    const exit = await client.until(event => event.event === 'terminal_exit');
    assert.equal(exit.code, 0);
    const finish = await client.until(event => event.event === 'agent_message' && event.action === 'finish');
    assert.equal(finish.sessionId, reply.sessionId);
    assert.equal(finish.text, 'Fixed and verified addition.');
    assert.deepEqual(seenTools, ['read_files', 'patch_file', 'execute_command']);
  } finally {
    client.socket.close();
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});
