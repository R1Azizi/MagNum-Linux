// Only the provider is simulated. The server, agent, tools and sockets are real.
const backend = '../src-tauri/resources/backend/';
const { setTimeout: delay } = require('node:timers/promises');
let url = 'https://chat.deepseek.com/';
const conversation = 'https://chat.deepseek.com/a/chat/s/fixture';
const page = {
  isClosed: () => false,
  url: () => url,
  goto: async target => {
    url = target;
    return { status: () => 200 };
  },
  waitForFunction: async () => ({ jsonValue: async () => 'ready' }),
  title: async () => 'Test provider',
  on() {},
  evaluate: async fn => String(fn).includes('hasToken') ? { hasToken: true, hasChatInput: true } : false
};
function replace(name, exports) {
  const id = require.resolve(backend + name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
replace('stealth', { ...require(backend + 'stealth'), launchStealthContext: async () => {
  await delay(150);
  return { on() {}, pages: () => [page], close: async () => {} };
} });
replace('browser-driver', class {
  async sendMessage(message) {
    this.message = message;
    if (message.includes('test-activity')) this.activityStep = 0;
  }
  async startNewChat() {
    await page.goto('https://chat.deepseek.com/');
    return true;
  }
  checkConversation(target, diagnose) {
    return require(backend + 'conversation-access').checkConversation(page, 'deepseek', target, diagnose);
  }
  getDeepThinkState() { return false; }
  getChatUrl() { return page.url(); }
  async waitForCompletion() {
    url = conversation;
    if (this.activityStep !== undefined) {
      return JSON.stringify([
        { action: 'execute_command', params: { command: 'node activity.cjs' } },
        { action: 'patch_file', params: { patches: [
          { file: 'file.txt', search: 'agent target', replace: 'agent update' },
          { file: '../mixed.txt', search: 'untouched target', replace: 'will not write outside workspace' }
        ] } },
        { action: 'create_file', params: { file: 'created.txt', content: 'written by MagNum' } },
        { action: 'execute_command', params: { command: 'node wait.cjs' } }
      ][this.activityStep++]);
    }
    if (this.message.includes('test-pipeline')) {
      return JSON.stringify({ action: 'execute_command', params: { command: 'node worker.cjs agent | node sink.cjs agent' } });
    }
    return JSON.stringify({ action: 'finish', params: { summary: 'Retry completed.' } });
  }
  abort() { return delay(250); } // provider cleanup is intentionally slower than shell cleanup
});

// Keep the inspection fixture independent of randomized provider pacing.
const agent = require(backend + 'agent');
const randomDelay = agent.prototype.randomDelay;
agent.prototype.randomDelay = function (...args) {
  return this.activeTask === 'test-activity' ? Promise.resolve() : randomDelay.apply(this, args);
};
