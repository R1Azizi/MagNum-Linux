'use strict';

const crypto = require('node:crypto');
const routes = {
  deepseek: ['chat.deepseek.com', /^\/(?:a\/)?chat\/(?:s\/)?[^/]+$/],
  gemini: ['aistudio.google.com', /^\/(?:u\/\d+\/)?prompts\/(?!new_chat$)[^/]+$/],
  chatgpt: ['chatgpt.com', /^\/(?:g\/[^/]+\/)?c\/[^/]+$/]
};

function remoteProvider(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return Object.keys(routes).find(key => routes[key][0] === url.hostname) || null;
  } catch { return null; }
}

function conversationPath(provider, value) {
  if (!Object.hasOwn(routes, provider) || remoteProvider(value) !== provider) return null;
  const pathname = new URL(value).pathname.replace(/\/$/, '');
  return routes[provider][1].test(pathname) ? pathname : null;
}

function conversationId(provider, value) {
  return conversationPath(provider, value)?.split('/').pop() || null;
}

function sameConversation(provider, first, second) {
  const id = conversationId(provider, first);
  return id !== null && id === conversationId(provider, second);
}

function isNewPage(provider, value) {
  if (remoteProvider(value) !== provider) return false;
  const pathname = new URL(value).pathname;
  return provider === 'gemini' ? /^\/(?:u\/\d+\/)?prompts\/new_chat\/?$/.test(pathname) : pathname === '/';
}

// Use first-party session data or account controls. Persist only the digest.
async function accountIdentity(page) {
  const identity = await page.evaluate(async () => {
    if (location.hostname === 'chatgpt.com') {
      try {
        const response = await fetch('/api/auth/session', { signal: AbortSignal.timeout(2500) });
        const user = response.ok && (await response.json()).user;
        if (typeof user?.id === 'string') return user.id;
      } catch {}
    }
    if (location.hostname === 'chat.deepseek.com') {
      try {
        const stored = JSON.parse(localStorage.getItem('userInfo') || 'null');
        const user = stored?.value || stored;
        if (typeof user?.id === 'string') return user.id;
      } catch {}
    }
    const controls = document.querySelectorAll('[aria-label*="Google Account"], [data-testid="accounts-profile-button"], [data-testid="profile-button"], [aria-label*="account" i][title]');
    for (const control of controls) {
      const match = [control.getAttribute('aria-label'), control.title, control.textContent]
        .join(' ').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
      if (match) return match[0].toLowerCase();
    }
    return null;
  }).catch(() => null);
  return typeof identity === 'string' ? crypto.createHash('sha256').update(identity).digest('hex') : null;
}

function diagnosisStatus(diag) {
  if (diag.ok) return 'ready';
  if (['not_logged_in', 'google_login', 'login_page'].includes(diag.status)) return 'sign_in';
  return diag.status === 'closed' ? 'disconnected' : 'temporary';
}

async function checkConversation(page, provider, target, diagnose) {
  if (!page || page.isClosed()) return 'disconnected';
  const expected = conversationId(provider, target);
  if (!expected) return 'temporary';
  try {
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = response?.status();
    if (status === 401 || /^(https:\/\/(accounts\.google\.com|auth\.openai\.com)\/)|\/sign_in\b|\/auth\/login\b/.test(page.url())) return 'sign_in';
    if (sameConversation(provider, target, page.url())) {
      if (status === 404 || status === 410) return 'missing';
      if (status === 403) {
        // CDNs also serve 403 for regional restrictions and verification challenges.
        const denied = await page.evaluate(() => /you (?:do not|don.t) have (?:access|permission)|permission denied|request access/i.test(document.body?.innerText || ''));
        return denied ? 'denied' : 'temporary';
      }
    }
    if (status >= 400) return 'temporary';
    // SPA error banners and conversation turns arrive after the document shell.
    const result = await page.waitForFunction(({ host, route, expected, turns, composer }) => {
      const notice = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], [class*="error-page"], [class*="not-found"], mat-snack-bar-container, h1'))
        .filter(el => !el.closest('article, [data-message-author-role], ms-chat-turn, .ds-message'))
        .map(el => el.innerText).join(' ');
      if (/conversation not found|chat not found|session does not exist|conversation (?:was|has been) deleted|prompt not found/i.test(notice)) return 'missing';
      if (/access denied|do not have access|don.t have (?:access|permission)|permission denied|request access/i.test(notice)) return 'denied';
      if (/accounts\.google\.com|auth\.openai\.com|\/sign_in|\/auth\/login/.test(location.href)) return 'sign_in';
      const pathname = location.pathname.replace(/\/$/, '');
      return location.hostname === host && new RegExp(route).test(pathname)
        && pathname.split('/').pop() === expected && document.querySelector(turns)
        && document.querySelector(composer) ? 'ready' : false;
    }, {
      host: routes[provider][0], route: routes[provider][1].source, expected,
      turns: {
        deepseek: '.ds-message, .ds-user-message, .ds-markdown, [class*="chat-message"], [data-message-author-role]',
        gemini: 'ms-chat-turn, ms-prompt-chunk, ms-user-message, ms-model-message',
        chatgpt: '[data-message-author-role]'
      }[provider],
      composer: 'textarea, [contenteditable="true"]'
    }, { timeout: 12000 }).then(handle => handle.jsonValue()).catch(() => null);
    if (result && result !== 'ready') return result;
    const auth = diagnosisStatus(await diagnose(page));
    return auth === 'ready' && (!result || !sameConversation(provider, target, page.url())) ? 'temporary' : auth;
  } catch { return page.isClosed() ? 'disconnected' : 'temporary'; }
}

module.exports = { remoteProvider, conversationPath, sameConversation, isNewPage, checkConversation, diagnosisStatus, accountIdentity };
