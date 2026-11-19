import { Attachment } from '../types';

export type StageProvider = 'deepseek' | 'gemini' | 'chatgpt';
type SendFn = (action: string, payload?: Record<string, any>) => void;

let sender: SendFn | null = null;
export function bindAttachmentSender(fn: SendFn | null) { sender = fn; }

// Live composer-attachment registry — used to re-stage on provider switch
const live = new Map<string, Attachment>();
const listeners = new Set<(atts: Attachment[]) => void>();

export function trackComposerAttachments(atts: Attachment[]) {
  live.clear();
  for (const a of atts) live.set(a.id, a);
  const arr = Array.from(live.values());
  listeners.forEach(fn => { try { fn(arr); } catch {} });
}

export function onLiveAttachmentsChange(fn: (atts: Attachment[]) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const slim = (a: Attachment) => ({
  id: a.id, name: a.name, size: a.size, type: a.type, base64: a.base64
});

/** Immediately upload to the provider (backend queues if offline) */
export function stageAttachments(provider: StageProvider, atts: Attachment[]) {
  if (!sender || atts.length === 0) return;
  sender('stage_attachments', { provider, attachments: atts.map(slim) });
}

export function unstageAttachment(provider: StageProvider, id: string) {
  if (!sender) return;
  sender('unstage_attachment', { provider, id });
}
