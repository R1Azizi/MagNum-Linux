const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const backend = path.resolve(__dirname, '../src-tauri/resources/backend');
const { chromium } = require(path.join(backend, 'node_modules/playwright'));
const WebSocket = require(path.join(backend, 'node_modules/ws'));
const { launchStealthContext, releaseProviderContext } = require(path.join(backend, 'stealth'));
const { conversationPath } = require(path.join(backend, 'conversation-access'));
const GeminiDriver = require(path.join(backend, 'gemini-driver'));
const linux = process.platform === 'linux' && !!process.env.DISPLAY;
const options = { executablePath: '/usr/bin/chromium', headless: true };
const launchOptions = { ...options, args: ['--remote-debugging-port=0'] };

test('Linux engine attaches to open provider profiles and preserves inaccessible history', { skip: !linux }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnum-navigation-'));
  process.env.MAGNUM_DATA_DIR = dir;
  const store = require(path.join(backend, 'session-store'));
  const contexts = [];
  let server, socket;
  t.after(async () => {
    socket?.terminate();
    if (server) { const exit = once(server, 'exit'); server.kill(); await exit; }
    await Promise.all(contexts.map(context => context.close()));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const fixtures = [];
  for (const [provider, profile, url] of [
    ['deepseek', 'magnum-profile', 'https://chat.deepseek.com/a/chat/s/test'],
    ['gemini', 'gemini-profile', 'https://aistudio.google.com/u/0/prompts/test'],
    ['chatgpt', 'chatgpt-profile', 'https://chatgpt.com/c/test']
  ]) {
    const context = await chromium.launchPersistentContext(path.join(dir, profile), launchOptions);
    contexts.push(context);
    const [unrelated] = context.pages();
    await unrelated.goto('data:text/html,unrelated');
    const page = await context.newPage();
    const fixture = { provider, url, page, unrelated, response: 200 };
    fixtures.push(fixture);
    await context.route('https://**/*', route => {
      const target = route.request().url();
      return route.fulfill({
        status: target === url ? fixture.response : 200,
        contentType: 'text/html',
        body: fixture.response === 403 && target === url ? 'You do not have permission to access this chat' : `
          <div class="ds-message" data-message-author-role="user"><ms-chat-turn>Original history</ms-chat-turn></div>
          <textarea id="prompt-textarea"></textarea>
          <script>
            if (${target === fixture.redirectFrom}) history.replaceState(null, '', ${JSON.stringify(url)});
            const input = document.querySelector('textarea');
            if (${Boolean(fixture.changeOnInput)}) input.addEventListener('input', () => history.pushState(null, '', '/u/0/prompts/new_chat'));
            input.addEventListener('keydown', event => {
              if (event.ctrlKey && event.key === 'Enter') {
                document.body.dataset.sent = location.pathname;
                event.target.value = '';
              }
            });
          </script>`
      });
    });
    await page.goto(url);
    const session = store.createSession(provider, { provider, accountKey: JSON.stringify([provider, profile]) });
    session.deepseekUrl = url;
    store.saveSession(session);
    store.appendMessage(session.id, { role: 'user', text: provider + ' history' });
    fixture.id = session.id;
  }
  server = spawn(process.execPath, ['server.js'], { cwd: backend, env: { ...process.env, MAGNUM_BACKEND_PORT: '0' }, stdio: 'ignore' });
  await fs.stat(path.join(dir, '.ws-token')).catch(async () => {
    for (let i = 0; i < 100; ++i) {
      await delay(50);
      if (await fs.stat(path.join(dir, '.ws-token')).catch(() => null)) return;
    }
  });
  const read = file => fs.readFile(path.join(dir, file), 'utf8');
  socket = new WebSocket('ws://127.0.0.1:' + await read('.backend-port') + '?token=' + await read('.ws-token'));
  const events = [];
  socket.on('message', raw => events.push(JSON.parse(raw)));
  await once(socket, 'open');
  const send = (action, fields) => socket.send(JSON.stringify({ action, ...fields }));
  let sequence = 0;
  async function navigate(fixture, action = 'load_session', fields = {}) {
    const navigationId = ++sequence;
    send(action, { provider: fixture.provider, sessionId: action === 'load_session' ? fixture.id : null, navigationId, ...fields });
    for (let i = 0; i < 600; i++) {
      const result = events.find(e => e.event === 'session_access' && e.navigationId === navigationId);
      if (result) return result;
      await delay(50);
    }
    assert.fail('Navigation timed out for ' + fixture.provider);
  }
  send('set_default_provider', { provider: 'deepseek' });
  for (const fixture of fixtures) {
    for (const [response, expected] of [[200, 'ready'], [403, 'denied'], [404, 'missing'], [401, 'sign_in'], [503, 'temporary']]) {
      fixture.response = response;
      const result = await navigate(fixture);
      assert.equal(result.status, expected, JSON.stringify(result));
      assert.equal(fixture.page.url(), fixture.url);
      const local = store.loadSession(fixture.id);
      assert.equal(local.deepseekUrl, fixture.url);
      assert.equal(local.messages[0].text, fixture.provider + ' history');
    }
    fixture.response = 404;
    const restored = await navigate(fixture, 'load_session', { restore: true });
    assert.equal(restored.sessionId, fixture.id);
    assert.equal(restored.status, 'missing');
    assert.equal(fixture.page.url(), fixture.url);
    assert.match(fixture.unrelated.url(), /unrelated/);
    fixture.response = 200;
  }
  const gemini = fixtures[1];
  gemini.redirectFrom = 'https://aistudio.google.com/prompts/test';
  const redirected = store.createSession('Redirected Gemini URL', { provider: 'gemini' });
  redirected.deepseekUrl = gemini.redirectFrom;
  store.saveSession(redirected);
  assert.equal((await navigate({ id: redirected.id, provider: 'gemini' })).status, 'ready');
  await new GeminiDriver(gemini.page).sendMessage('Continue this conversation');
  assert.equal(gemini.page.url(), gemini.url);
  assert.equal(await gemini.page.locator('body').getAttribute('data-sent'), '/u/0/prompts/test');
  send('set_workspace', { path: dir });
  gemini.changeOnInput = true;
  send('send_prompt', { provider: 'gemini', sessionId: redirected.id, prompt: 'Stay in this chat', requestId: 'changed' });
  for (let i = 0; i < 200 && !events.some(e => e.event === 'task_stopped' && e.sessionId === redirected.id); i++) await delay(50);
  assert.ok(events.some(e => e.event === 'session_access' && e.requestId === 'changed' && e.status === 'temporary'));
  assert.equal(await gemini.page.locator('body').getAttribute('data-sent'), null);
  assert.equal(store.loadSession(redirected.id).messageCount, 0);
  gemini.changeOnInput = false;
  send('load_session', { sessionId: fixtures[0].id, navigationId: ++sequence });
  send('load_session', { sessionId: fixtures[1].id, navigationId: ++sequence });
  assert.equal((await navigate(fixtures[2])).sessionId, fixtures[2].id);
  assert.equal((await navigate(fixtures[2], 'new_chat')).status, 'ready');
  assert.equal(conversationPath('chatgpt', fixtures[2].page.url()), null);
  const legacy = store.createSession('Legacy');
  store.appendMessage(legacy.id, { text: 'Local legacy message' });
  assert.equal((await navigate({ id: legacy.id, provider: 'deepseek' })).status, 'missing');
  assert.equal(store.loadSession(legacy.id).messages.length, 1);
  assert.equal(fixtures[0].page.url(), fixtures[0].url);
  send('set_workspace', { path: dir });
  send('send_prompt', { provider: 'deepseek', sessionId: legacy.id, prompt: 'must stay local', requestId: 'unlinked' });
  for (let i = 0; i < 100 && !events.some(e => e.event === 'task_stopped' && e.sessionId === legacy.id); i++) await delay(50);
  assert.ok(events.some(e => e.event === 'session_access' && e.requestId === 'unlinked' && e.status === 'missing'));
  assert.equal(store.loadSession(legacy.id).messages.length, 1);
  const identity = require('node:crypto').createHash('sha256').update('original@example.test').digest('hex');
  const sameProfile = store.createSession('Account changed inside its profile', { provider: 'gemini', accountIdentity: identity });
  sameProfile.deepseekUrl = fixtures[1].url;
  store.saveSession(sameProfile);
  await fixtures[1].page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const control = document.createElement('button');
    control.setAttribute('aria-label', 'Google Account: second@example.test');
    document.body.appendChild(control);
  }));
  assert.equal((await navigate({ id: sameProfile.id, provider: 'gemini' })).status, 'denied');
  const differentOwner = store.createSession('Original account', {
    provider: 'gemini', accountKey: JSON.stringify(['gemini', 'other-profile'])
  });
  differentOwner.deepseekUrl = fixtures[1].url;
  store.saveSession(differentOwner);
  assert.equal((await navigate({ id: differentOwner.id, provider: 'gemini' })).status, 'denied');
  send('set_workspace', { path: dir });
  send('send_prompt', { provider: 'gemini', sessionId: differentOwner.id, prompt: 'must stay local' });
  for (let i = 0; i < 100 && !events.some(e => e.event === 'task_stopped' && e.sessionId === differentOwner.id); i++) await delay(50);
  assert.ok(events.some(e => e.event === 'session_access' && e.runId && e.status === 'denied'));
  assert.equal(store.loadSession(differentOwner.id).messageCount, 0);
  assert.equal(store.getSessions().length, 7);
  await t.test('built chat UI gates Send and restores the selected provider', async uiTest => {
    const dist = path.resolve(__dirname, '../dist');
    if (!await fs.stat(path.join(dist, 'index.html')).catch(() => null)) return uiTest.skip('Run npm run build first');
    const browser = await chromium.launch(options);
    uiTest.after(() => browser.close());
    const ui = await browser.newPage({ permissions: ['local-network-access'] });
    await ui.addInitScript(({ port, token, lastChat }) => {
      window.__TAURI_INTERNALS__ = { invoke: async command =>
        command.includes('backend_port') ? port : command === 'read_ws_token' ? token : null };
      localStorage.setItem('magnum_last_chat_deepseek', lastChat);
    }, { port: Number(await read('.backend-port')), token: await read('.ws-token'), lastChat: fixtures[0].id });
    await ui.route('http://localhost:1430/**', route => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      return route.fulfill({ path: path.join(dist, file) });
    });
    fixtures[0].response = 404;
    await ui.goto('http://localhost:1430/');
    const saved = provider => ui.locator('aside .session-row').filter({ hasText: provider + ' history' });
    await ui.getByText('The provider reports that this conversation is missing.', { exact: false }).waitFor();
    await ui.locator('main').getByText('deepseek history', { exact: true }).first().waitFor();
    await ui.locator('main textarea').fill('keep this draft');
    assert.ok(await ui.getByRole('button', { name: 'Send', exact: true }).isDisabled());
    await ui.locator('main textarea').press('Enter');
    assert.equal(await ui.locator('main textarea').inputValue(), 'keep this draft');
    await ui.getByRole('button', { name: 'Switch Account', exact: true }).click();
    fixtures[0].response = 200;
    await ui.getByRole('button', { name: 'Check Again' }).click();
    await ui.waitForFunction(() => !document.querySelector('[aria-label="Send"]').disabled);
    await saved('gemini').click();
    await ui.locator('main [title="Select provider or show browser"]').hover();
    await ui.getByRole('button', { name: 'DeepSeek', exact: true }).click();
    await ui.locator('main textarea').fill('restored');
    await ui.waitForFunction(() => !document.querySelector('[aria-label="Send"]').disabled);
    assert.ok(await ui.locator('main').getByText('deepseek history', { exact: true }).count());
    await ui.locator('aside').getByRole('button', { name: 'New Chat' }).click();
    await ui.getByTitle('AI model & connection').waitFor();
    assert.match(await ui.getByTitle('AI model & connection').textContent(), /DeepSeek/);
  });

});

test('ordinary Chrome or Chromium stays open during stale-endpoint fallback and locked-profile recovery', { skip: !linux }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnum-profile-'));
  const ordinary = path.join(dir, 'ordinary'), managed = path.join(dir, 'managed');
  const executable = await fs.access('/opt/google/chrome/chrome').then(() => '/opt/google/chrome/chrome', () => options.executablePath);
  const child = spawn(executable, ['--headless', '--no-sandbox', '--user-data-dir=' + ordinary, 'data:text/html,ordinary'], { stdio: 'ignore' });
  const exit = once(child, 'exit');
  let context;
  t.after(async () => {
    if (context) await releaseProviderContext(context);
    child.kill(); await exit;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  for (let i = 0; i < 100 && !await fs.lstat(path.join(ordinary, 'SingletonLock')).catch(() => null); i++) await delay(50);
  await assert.rejects(launchStealthContext(ordinary), /profile is in use.*Reconnect/);
  await fs.mkdir(managed);
  await fs.writeFile(path.join(managed, 'DevToolsActivePort'), '1\n/devtools/browser/deadbeef');
  context = await launchStealthContext(managed);
  const page = context.pages()[0];
  await page.goto('data:text/html,recovered');
  assert.equal(await page.locator('body').textContent(), 'recovered');
  assert.equal(child.exitCode, null);
});
