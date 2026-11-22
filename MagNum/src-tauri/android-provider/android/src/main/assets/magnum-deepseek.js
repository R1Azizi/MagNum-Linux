(operation, args) => {
  if (location.origin !== 'https://chat.deepseek.com') return { state: 'unavailable' };

  const visible = el => Boolean(el?.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const buttons = root => [...root.querySelectorAll('button, [role="button"]')].filter(visible);
  const enabled = el => !el.matches('[disabled], [aria-disabled="true"], .ds-button--disabled');
  const input = [...document.querySelectorAll('#chat-input, textarea')].find(visible);
  const dialog = [...document.querySelectorAll('[role="dialog"], .ds-modal, .ds-dialog')].find(visible);
  const challenge = [...document.querySelectorAll('iframe')].some(frame =>
    visible(frame) && frame.clientHeight >= 65 &&
    /captcha|challenges\.cloudflare\.com/i.test(frame.title + ' ' + frame.src));
  const path = /^\/(?:a\/)?chat\/(?:s\/)?[\w-]+$/.test(location.pathname) ? location.pathname : undefined;
  if (/^\/(?:sign_in|sign_up|login|reset_password)(?:\/|$)/.test(location.pathname) ||
      [...document.querySelectorAll('input[type="password"]')].some(visible)) {
    return { state: 'sign_in' };
  }
  if (challenge && (dialog || !input)) return { state: 'challenge' };
  if (!input) return { state: 'loading', path };
  // Read only the presence of the site's session marker. Its value stays in WebView.
  if (localStorage.getItem('userToken') === null) return { state: 'sign_in' };

  const isSend = el => el.matches('.ds-button--primary.ds-button--circle, [aria-label="Send" i]');
  const isStop = el =>
    /^(stop|停止)( generating| response)?$/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || '') ||
    (el.matches('.ds-button--circle') && el.querySelector('svg rect'));
  let controls = [];
  let composer = input.parentElement;
  for (; composer && composer !== document.body; composer = composer.parentElement) {
    controls = buttons(composer).filter(el => isSend(el) || isStop(el));
    if (controls.length) break;
  }
  const stop = controls.find(el => enabled(el) && isStop(el));
  const send = controls.find(el => enabled(el) && el !== stop && isSend(el));
  if (operation === 'status') return { state: 'ready', path, busy: Boolean(stop) };
  if (operation === 'stop') {
    stop?.click();
    return { state: stop ? 'stopped' : 'ready', path };
  }

  const userSelector = '.ds-user-message, [class*="user-message"], [data-message-author-role="user"]';
  const replySelector = '.ds-markdown, [data-message-author-role="assistant"]';
  const replies = [...document.querySelectorAll(replySelector)].filter(el =>
    visible(el) && !el.parentElement.closest(replySelector) && !el.closest(userSelector + ', [class*="think-content"], [class*="thinking"], .ds-think-block') &&
    (el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING));
  const lastUser = [...document.querySelectorAll(userSelector)].filter(visible).at(-1);
  const afterLastUser = el => !lastUser || Boolean(lastUser.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const readReply = el => el?.innerText.trim() || '';

  if (operation === 'fill') {
    if ((path || '/') !== args.path) return { state: 'unavailable', detail: 'The active DeepSeek conversation changed. Open the chat again.' };
    if (stop) return { state: 'busy' };
    if (!controls.length || !(input instanceof HTMLTextAreaElement) || input.disabled || input.readOnly) {
      return { state: 'unavailable', detail: 'The DeepSeek send control could not be found.' };
    }
    if (typeof args.deepThink === 'boolean') {
      const isThinkingControl = el => [el.textContent, el.getAttribute('aria-label'), el.title]
        .some(label => /^(?:deep\s*think(?:\s*\(r1\))?|深度思考(?:\s*\(r1\))?)$/i.test(label?.trim()));
      const thinking = buttons(composer).find(isThinkingControl) ||
        [...document.querySelectorAll('.ds-toggle-button')].find(el => visible(el) && isThinkingControl(el));
      if (!thinking || !enabled(thinking)) {
        return { state: 'thinking_unavailable', detail: 'DeepSeek’s DeepThink control is unavailable on this page.' };
      }
      const pressed = thinking.getAttribute('aria-pressed') ?? thinking.getAttribute('aria-checked');
      const active = pressed === null
        ? /(?:^|[ _-])(?:selected|active|checked)(?:\s|$)/i.test(thinking.className)
        : pressed === 'true';
      if (active !== args.deepThink) {
        if (!args.confirmThinking) thinking.click();
        return { state: 'checking_thinking', detail: 'DeepSeek did not confirm the selected DeepThink setting.' };
      }
    }
    window.__magnumDeepSeekTurn = {
      prior: [...replies], last: readReply(replies.at(-1)), path: path || '/', submitted: false
    };
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, args.prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { state: 'filled', path };
  }

  const turn = window.__magnumDeepSeekTurn;
  if (operation === 'submit') {
    if (!turn || turn.path !== (path || '/') || turn.submitted || !input.value.trim()) {
      return { state: 'unavailable', detail: 'DeepSeek’s chat composer changed before sending.' };
    }
    if (!send) return { state: 'awaiting_send' };
    turn.submitted = true;
    send.click();
    return { state: 'submitted', path };
  }

  if (operation === 'poll') {
    if (!turn?.submitted) return { state: 'unavailable', detail: 'DeepSeek reloaded while the prompt was running.' };
    const fresh = replies.filter(el => afterLastUser(el));
    const reply = fresh.at(-1);
    const text = readReply(reply);
    if (!text || (turn.prior.includes(reply) && text === turn.last)) {
      return { state: 'waiting', path, busy: Boolean(stop) };
    }
    const blocks = [...reply.querySelectorAll('pre code, pre:not(:has(code))')]
      .map(block => block.textContent.trim()).filter(code => code.startsWith('{'));
    const raw = reply.textContent.trim();
    return { state: 'reply', path, text: text.slice(0, 300000),
      ...(raw && raw !== text ? { rawText: raw.slice(0, 300000) } : {}),
      ...(blocks.length === 1 ? { code: blocks[0].slice(0, 300000) } : {}), busy: Boolean(stop) };
  }

  return { state: 'unavailable' };
}
