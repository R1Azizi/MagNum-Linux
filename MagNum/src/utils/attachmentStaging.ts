import { Attachment } from '../types';

export type StageProvider = 'deepseek' | 'gemini' | 'chatgpt';
type SendFn = (action: string, payload?: Record<string, any>) => void;

let sender: SendFn | null = null;
export function bindAttachmentSender(fn: SendFn | null) { sender = fn; }

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
