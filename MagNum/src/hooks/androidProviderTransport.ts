import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, EditDetail, FileNode, SessionMeta } from '../types';
import { androidAgent, agentPrompt, editDetail, errorMessage, parseDecision, proposedEdits } from './androidAgent.ts';
import type { AndroidTool, Decision, Edit } from './androidAgent.ts';

export type ChatTransport = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose'>;

type Session = SessionMeta & { messages: ChatMessage[]; path?: string; systemPromptSent?: boolean; editDetails?: EditDetail[] };
type BrowserState = { state: string; path?: string; detail?: string; busy?: boolean; text?: string; code?: string; rawText?: string; presented?: boolean };
type Action = {
  action: string;
  navigationId?: number;
  sessionId?: string;
  requestId?: string;
  prompt?: string;
  deepThink?: boolean;
  attachments?: unknown[];
  skill?: string;
  path?: string;
  name?: string;
  filename?: string;
  commandId?: string;
  editIds?: number[];
  autoApplyPatch?: boolean;
  autoApproveCommand?: boolean;
};
type Run = {
  id: string;
  workspace: string;
  sessionId?: string;
  cancelled: boolean;
  submitted: boolean;
  providerPending: boolean;
  approval?: { kind: 'patch' | 'command'; respond: (approved: boolean) => void };
};

type ToolResult = {
  success?: boolean;
  details?: { file: string; success: boolean; message: string; edit?: Omit<Edit, 'file'> }[];
  error?: string;
  message?: string;
  exitCode?: number;
  status?: string;
  output?: string;
};

const systemPrompt = `# MAGNUM — SOFTWARE ENGINEERING ASSISTANT

You are MagNum, a practical software engineering assistant. Follow the user's requested scope. Answer direct questions directly. For coding tasks, give concrete implementation steps, usable code or a focused patch, and a way to verify it. Preserve unrelated behavior, make assumptions explicit, and use the user's language. Keep explanations concise.

This conversation runs in MagNum for Android. Work from the code and context the user shares. Ask for the specific missing snippet or error when it is needed. Explain how to run checks without claiming to have opened local files, changed a workspace, or executed commands. Return the answer in ordinary Markdown.`;

const storageKey = 'magnum_android_deepseek_sessions_v1';
const workspaceKey = 'magnum_android_workspace';
const lastChatKey = 'magnum_last_chat_deepseek';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const page = (operation: string, fields: Record<string, string | boolean> = {}) =>
  invoke<BrowserState>('plugin:android-provider|provider', { request: { operation, ...fields } });

function readSessions(): Session[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || '[]');
  } catch {
    return [];
  }
}

function timestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export class AndroidProviderTransport implements ChatTransport {
  readyState: ChatTransport['readyState'] = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private sessions = readSessions();
  private current = this.sessions.find(session => session.id === localStorage.getItem(lastChatKey));
  private timer?: ReturnType<typeof setTimeout>;
  private viewVersion = 0;
  private navigationId?: number;
  private access = '';
  private statusDetail = '';
  private statusKey = '';
  private checkDeadline = 0;
  private needsRestore = false;
  private run?: Run;
  private workspace = '';
  private workspaceVersion = 0;
  private tools: AndroidTool[] = [];
  private workspaceBusy = false;
  private nextEditId = Date.now() * 1000;
  private pendingEdits: EditDetail[] = [];

  constructor() {
    queueMicrotask(() => {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event('open'));
      void this.open(this.current);
      void this.restoreWorkspace();
    });
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    clearTimeout(this.timer);
    this.stopRun();
  }

  private emit(event: string, fields: Record<string, unknown> = {}) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ event, ...fields }) }));
  }

  private list(deletedSessionId?: string) {
    this.emit('sessions_list', {
      sessions: this.sessions.map(({ id, title, provider, updatedAt }) => ({ id, title, provider, updatedAt })),
      deletedSessionId, currentSessionId: this.run?.sessionId ?? this.current?.id
    });
  }

  private save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.sessions));
      this.remember();
    } catch {
      this.emit('error', { message: 'Android could not save chat history. Free up app storage to keep this chat after reopening.' });
    }
    this.list();
  }

  private remember() {
    if (this.current) localStorage.setItem(lastChatKey, this.current.id);
    else localStorage.removeItem(lastChatKey);
  }

  private async open(session?: Session, navigationId?: number) {
    const version = ++this.viewVersion;
    clearTimeout(this.timer);
    this.current = session;
    this.navigationId = navigationId;
    this.needsRestore = false;
    try { this.remember(); } catch { /* Session history remains readable. */ }
    this.emit('session_loaded', { session, navigationId });
    if (this.run) {
      this.report('busy', 'The current DeepSeek run is still active.');
      return;
    }
    this.report('checking');
    try {
      await page('navigate', { path: session?.path || '/' });
    } catch {
      this.report('temporary', 'The Android provider browser could not open.');
    }
    this.checkDeadline = Date.now() + 20000;
    void this.check(version);
  }

  private report(status: string, detail = '') {
    this.access = status;
    this.statusDetail = detail;
    const key = JSON.stringify([status, detail, this.navigationId]);
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.emit('android_provider_status', { status, detail, navigationId: this.navigationId });
  }

  private applyStatus(result: BrowserState) {
    if (result.state === 'ready') {
      const expected = this.current?.path;
      if (this.current && !expected) {
        this.report('missing', 'This chat has no saved DeepSeek conversation. Start a new chat to continue.');
      } else if (expected && result.path !== expected) {
        this.report('missing');
      } else if (!this.current && result.path) {
        this.report('temporary', 'Open a new DeepSeek conversation to send from MagNum.');
      } else {
        this.report(result.busy ? 'busy' : 'ready', result.busy ? 'DeepSeek is finishing a reply.' : '');
      }
    } else if (result.state === 'sign_in') {
      this.needsRestore = true;
      this.report('sign_in');
    } else if (result.state === 'challenge') {
      this.report('challenge', 'Complete DeepSeek’s verification on its website.');
    } else if (result.state === 'loading' && Date.now() < this.checkDeadline) {
      this.report('checking');
    } else {
      this.report('temporary', result.detail || 'DeepSeek’s chat page did not become ready.');
    }
  }

  private async check(version: number) {
    if (this.readyState !== WebSocket.OPEN || version !== this.viewVersion || this.run) return;
    try {
      const result = await page('status');
      if (version !== this.viewVersion || this.run) return;
      if (result.state === 'ready' && !result.presented && this.needsRestore && result.path !== this.current?.path) {
        this.needsRestore = false;
        this.checkDeadline = Date.now() + 20000;
        this.report('checking');
        await page('navigate', { path: this.current?.path || '/' });
      } else {
        if (result.state === 'ready' && !result.presented) this.needsRestore = false;
        this.applyStatus(result);
      }
    } catch {
      if (version === this.viewVersion) this.report('temporary', 'The Android provider browser is unavailable.');
    }
    if (this.readyState === WebSocket.OPEN && version === this.viewVersion && !this.run) {
      this.timer = setTimeout(() => void this.check(version), 1200);
    }
  }

  private async restoreWorkspace() {
    try {
      this.tools = (await androidAgent<{ tools: AndroidTool[] }>('capabilities')).tools;
      const paths = await this.listWorkspaces();
      const saved = localStorage.getItem(workspaceKey);
      if (saved && paths.includes(saved) && !this.workspaceVersion) await this.selectWorkspace(saved);
    } catch (error) {
      this.emit('android_workspace_status', { message: errorMessage(error) });
    } finally {
      this.emit('android_workspace_capabilities', { tools: this.tools });
    }
  }

  private async listWorkspaces() {
    const { paths } = await androidAgent<{ paths: string[] }>('workspaces');
    this.emit('recent_workspaces', { workspaces: paths });
    return paths;
  }

  private async selectWorkspace(path: string) {
    const version = ++this.workspaceVersion;
    const { tree } = path ? await androidAgent<{ tree: FileNode[] }>('inspect', { path }) : { tree: [] };
    if (version !== this.workspaceVersion) return;
    localStorage.setItem(workspaceKey, path);
    this.workspace = path;
    this.emit('workspace_loaded', { path, tree });
  }

  private async changeWorkspace(action: Action) {
    if (this.workspaceBusy) return;
    this.workspaceBusy = true;
    this.emit('android_workspace_status', { busy: true });
    try {
      if (action.action === 'open_workspace') {
        await this.selectWorkspace(action.path || '');
      } else {
        const operation = action.action === 'create_workspace' ? 'create' : 'import';
        const { path } = await androidAgent<{ path?: string }>(operation, { name: action.name || '' });
        if (path) {
          await this.listWorkspaces();
          await this.selectWorkspace(path);
        }
      }
      this.emit('android_workspace_status');
    } catch (error) {
      this.emit('android_workspace_status', { message: errorMessage(error) });
    } finally {
      this.workspaceBusy = false;
    }
  }

  private async inspectFile(filename: string) {
    const path = this.workspace;
    if (!path) return;
    try {
      const { content } = await androidAgent<{ content: string }>('inspect', { path, file: filename });
      if (this.workspace === path) this.emit('file_content', { filename, content });
    } catch (error) {
      this.emit('android_workspace_status', { message: errorMessage(error) });
    }
  }

  private stopRun() {
    const run = this.run;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    run.approval?.respond(false);
    if (run.workspace) void androidAgent('stop', { runId: run.id }).catch(() => {});
    this.emit('agent_status', { text: 'Stopping…' });
  }

  private async submit(run: Run, prompt: string, path: string, deepThink?: boolean) {
    this.emit('agent_status', { text: 'Sending to DeepSeek…' });
    const fields = { prompt, path, ...(typeof deepThink === 'boolean' ? { deepThink } : {}) };
    let filled = await page('fill', fields);
    for (let retry = 0; retry < 4 && filled.state === 'checking_thinking' && !run.cancelled; retry++) {
      await pause(150);
      if (!run.cancelled) filled = await page('fill', { ...fields, confirmThinking: true });
    }
    if (run.cancelled) return;
    if (filled.state !== 'filled') {
      if (filled.state !== 'checking_thinking' && filled.state !== 'thinking_unavailable') this.applyStatus(filled);
      throw new Error(filled.detail || (filled.state === 'busy' ? 'DeepSeek is still generating a reply.' : 'DeepSeek could not prepare this prompt.'));
    }
    let submitted = await page('submit');
    for (let retry = 0; retry < 4 && submitted.state === 'awaiting_send' && !run.cancelled; retry++) {
      await pause(150);
      if (!run.cancelled) submitted = await page('submit');
    }
    if (submitted.state === 'submitted') {
      run.submitted = run.providerPending = true;
      return submitted;
    }
    if (!run.cancelled) {
      this.applyStatus(submitted);
      throw new Error(submitted.detail || 'DeepSeek did not accept the prompt.');
    }
  }

  private async waitForReply(run: Run, session: Session) {
    this.emit('agent_status', { text: 'Waiting for DeepSeek…' });
    let text = '';
    let stableSince = Date.now();
    const deadline = Date.now() + 180000;
    while (!run.cancelled && Date.now() < deadline) {
      await pause(750);
      if (run.cancelled) return;
      const result = await page('poll');
      if (result.path && result.path !== session.path) {
        session.path = result.path;
        this.save();
      }
      if (result.state === 'sign_in' || result.state === 'challenge' || result.state === 'unavailable') {
        this.applyStatus(result);
        throw new Error(result.detail || 'DeepSeek needs attention on its website before it can reply.');
      }
      if (result.state !== 'reply' || !result.text) continue;
      if (result.text !== text) {
        text = result.text;
        stableSince = Date.now();
        if (!run.workspace && this.current === session) this.emit('agent_streaming', { text });
      }
      if (result.busy) stableSince = Date.now();
      if (Date.now() - stableSince < 3000) continue;
      run.providerPending = false;
      return { text, code: result.code, rawText: result.rawText };
    }
    if (!run.cancelled) throw new Error('DeepSeek did not finish a reply within three minutes. Check the conversation on its website.');
  }

  private message(session: Session, text: string, fields: Partial<ChatMessage> = {}) {
    const ts = Date.now();
    const reply: ChatMessage = { id: crypto.randomUUID(), role: 'agent', text, ts, timestamp: timestamp(ts), ...fields };
    session.messages.push(reply);
    session.updatedAt = new Date(ts).toISOString();
    this.save();
    this.emit('agent_message', { ...reply, msgId: reply.id, sessionId: session.id });
  }

  private review(run: Run, kind: 'patch' | 'command', fields: Record<string, unknown>) {
    return new Promise<boolean>(resolve => {
      run.approval = { kind, respond: resolve };
      this.emit('agent_status', { text: kind === 'patch' ? 'Waiting for edit review…' : 'Waiting for command approval…' });
      this.emit(`${kind}_proposed`, fields);
    });
  }

  private async useTool(run: Run, session: Session, decision: Decision, settings: Action): Promise<ToolResult> {
    const { action, params } = decision;
    if (!this.tools.some(tool => tool.action === action)) return { success: false, error: `Unsupported workspace tool: ${action}` };
    const edits = proposedEdits(decision);
    const command = action === 'execute_command' && typeof params.command === 'string' ? params.command : '';
    const target = command || edits[0]?.file || params.file || params.path || params.query || (Array.isArray(params.files) ? params.files.join(', ') : '');
    if (edits.length && !settings.autoApplyPatch) {
      this.pendingEdits = edits.map(edit => editDetail(++this.nextEditId, edit, 'pending'));
      this.emit('edits_detail', { edits: this.pendingEdits });
      const approved = await this.review(run, 'patch', { summaries: this.pendingEdits });
      run.approval = undefined;
      this.pendingEdits = [];
      this.emit('patch_result', { success: approved && !run.cancelled });
      if (!approved || run.cancelled) return { success: false, error: 'The user declined or stopped the edit.' };
    }
    if (command && !settings.autoApproveCommand) {
      const approved = await this.review(run, 'command', { command });
      run.approval = undefined;
      this.emit('command_result', { success: approved && !run.cancelled });
      if (!approved || run.cancelled) return { success: false, error: 'The user declined or stopped the command.' };
    }
    this.emit('tool_started', { action, target, sessionId: session.id });
    const label = `${action.replace(/_/g, ' ')}${target ? ` · ${target}` : ''}`;
    this.emit('agent_status', { text: label });
    if (command) this.emit('terminal_echo', { commandId: run.id, command, cwd: run.workspace });
    let result: ToolResult;
    try {
      result = await androidAgent<ToolResult>('tool', {
        runId: run.id, tool: { ...params, action }
      }, output => this.emit('terminal_live_output', { ...output, commandId: run.id }));
    } catch (error) {
      result = { success: false, error: errorMessage(error) };
      if (command) this.emit('terminal_live_output', { line: result.error, isErr: true, commandId: run.id });
    }
    if (command) {
      this.emit('terminal_exit', { commandId: run.id, code: result.exitCode, status: result.status || 'failed' });
      this.emit('terminal_prompt', { commandId: run.id, cwd: this.workspace });
    }
    this.emit('tool_result', { ...result, action, target, sessionId: session.id,
      status: result.status || (result.success === false ? 'failed' : 'completed'), message: result.error || result.message });
    const applied: Edit[] = result.details?.flatMap(detail => detail.edit ? [{ file: detail.file, ...detail.edit }] : [])
      || (action === 'create_file' && result.success ? edits : []);
    const details = applied.map(edit => editDetail(++this.nextEditId, edit, 'applied'));
    if (details.length) {
      session.editDetails = [...(session.editDetails || []), ...details];
      if (result.details) this.emit('patch_applied', { details: result.details });
      else this.emit('file_written', { file: applied[0].file });
      if (this.workspace === run.workspace) {
        const version = this.workspaceVersion;
        const tree = await androidAgent<{ tree: FileNode[] }>('inspect', { path: run.workspace }).catch(() => undefined);
        if (tree && version === this.workspaceVersion) this.emit('workspace_loaded', { path: run.workspace, tree: tree.tree });
      }
    }
    const note = command
      ? `Executing command: ${command} · ${result.status || 'failed'}${result.exitCode == null ? '' : ` (exit ${result.exitCode})`}`
      : result.error || result.message || label;
    this.message(session, note, { action, command: command || undefined, file: edits[0]?.file,
      files: Array.isArray(params.files) ? params.files.filter(file => typeof file === 'string') : undefined,
      edits: details.map(({ id, file, added, deleted, status }) => ({ id, file, added, deleted, status })) });
    return result;
  }

  private async sendPrompt(action: Action) {
    const prompt = action.prompt?.trim();
    if (!prompt || prompt.length > 65000 || action.attachments?.length || action.skill) {
      this.emit('session_access', { status: this.access, detail: this.statusDetail, requestId: action.requestId });
      this.emit('error', { message: 'Android provider chat accepts up to 65,000 characters of plain text.' });
      return;
    }
    if (this.run || this.access !== 'ready' || (action.sessionId || undefined) !== this.current?.id) {
      this.emit('session_access', { status: this.access, detail: this.statusDetail, requestId: action.requestId });
      this.emit('error', { message: 'DeepSeek is still connecting or changing chats. Try again when it is connected.' });
      return;
    }

    const run: Run = { id: crypto.randomUUID(), workspace: this.workspace, cancelled: false, submitted: false, providerPending: false };
    this.run = run;
    clearTimeout(this.timer);
    this.emit('android_run_workspace', { path: run.workspace });
    let session = this.current;
    const viewVersion = this.viewVersion;
    let failure = false;
    try {
      if (run.workspace) {
        await androidAgent('begin', { runId: run.id, path: run.workspace });
        if (run.cancelled) return;
        this.tools = (await androidAgent<{ tools: AndroidTool[] }>('capabilities')).tools;
      }
      const providerPrompt = run.workspace ? agentPrompt(run.workspace, this.tools, prompt)
        : session?.systemPromptSent && !session.workspacePath ? prompt : `${systemPrompt}

USER TASK:
${prompt}`;
      if (run.cancelled) return;
      const submitted = await this.submit(run, providerPrompt, session?.path || '/', action.deepThink);
      if (!submitted) return;
      const ts = Date.now();
      if (!session) {
        session = { id: crypto.randomUUID(), title: prompt.slice(0, 70), updatedAt: '', provider: 'deepseek', messages: [] };
        this.sessions.unshift(session);
      }
      session.path = submitted.path || session.path;
      session.workspacePath = run.workspace || undefined;
      session.systemPromptSent = true;
      session.updatedAt = new Date(ts).toISOString();
      session.messages.push({ id: action.requestId || crypto.randomUUID(), role: 'user', text: prompt, ts, timestamp: timestamp(ts) });
      run.sessionId = session.id;
      const viewingThisRun = this.viewVersion === viewVersion;
      if (viewingThisRun) this.current = session;
      this.save();
      if (viewingThisRun || this.current === session) this.emit('session_loaded', { session });
      let retries = 0;
      for (let turn = 0; turn < 30 && !run.cancelled; turn++) {
        const reply = await this.waitForReply(run, session);
        if (!reply || run.cancelled) return;
        if (!run.workspace) {
          this.message(session, reply.text);
          return;
        }
        const decision = parseDecision(reply.code, reply.rawText, reply.text);
        if (decision?.action === 'finish' && typeof decision.params.summary === 'string' && decision.params.summary.trim()) {
          this.message(session, decision.params.summary, { action: 'finish' });
          return;
        }
        let followup: string;
        if (!decision || decision.action === 'finish') {
          if (++retries > 2) throw new Error('DeepSeek did not return a usable Android agent action after three attempts.');
          followup = 'Reply with exactly one fenced JSON code block in the requested action format. Use finish with a plain-text params.summary when done.';
        } else {
          retries = 0;
          const result = await this.useTool(run, session, decision, action);
          followup = `TOOL RESULT (${decision.action}):
${JSON.stringify(result)}
Continue the requested task with exactly one fenced JSON action.`;
        }
        if (run.cancelled) return;
        await this.submit(run, followup, session.path || '/', action.deepThink);
      }
      if (!run.cancelled) throw new Error('The Android agent reached the 30-turn limit.');
    } catch (error) {
      failure = true;
      if (!run.cancelled) this.emit('error', { message: errorMessage(error) });
    } finally {
      if (!run.submitted) this.emit('session_access', { status: this.access, detail: this.statusDetail, requestId: action.requestId });
      if (run.providerPending) await page('stop').catch(() => {});
      if (run.workspace) await androidAgent('end', { runId: run.id }).catch(() => {});
      this.run = undefined;
      this.emit('android_run_workspace');
      this.emit(run.cancelled ? 'task_stopped' : 'task_finished', { outcome: failure ? 'failed' : 'completed' });
      if (this.viewVersion !== viewVersion && this.current !== session && this.readyState === WebSocket.OPEN) {
        void this.open(this.current, this.navigationId);
      } else {
        void this.check(this.viewVersion);
      }
    }
  }

  send(raw: string) {
    const action: Action = JSON.parse(raw);
    switch (action.action) {
      case 'get_sessions':
        this.list();
        break;
      case 'new_chat':
      case 'load_session':
        void this.open(this.sessions.find(s => action.action === 'load_session' && s.id === action.sessionId), action.navigationId);
        break;
      case 'delete_session':
        if (this.run) break;
        if (this.current?.id === action.sessionId) void this.open(undefined, this.navigationId);
        this.sessions = this.sessions.filter(session => session.id !== action.sessionId);
        this.save();
        this.list(action.sessionId);
        break;
      case 'show_provider_browser':
      case 'switch_provider_account':
      case 'open_browser':
      case 'login':
        void page('show', { signIn: String(this.access === 'sign_in') }).catch(() => this.report('temporary', 'The Android provider browser could not open.'));
        break;
      case 'hide_provider_browser':
        void page('hide').catch(() => {});
        break;
      case 'send_prompt':
        void this.sendPrompt(action);
        break;
      case 'create_workspace':
      case 'import_workspace':
      case 'open_workspace':
        void this.changeWorkspace(action);
        break;
      case 'browse_workspaces':
        this.emit('android_workspace_status');
        void androidAgent('browse').catch(error => {
          this.emit('android_workspace_status', { message: errorMessage(error) });
        });
        break;
      case 'read_file':
        if (action.filename) void this.inspectFile(action.filename);
        break;
      case 'get_edits_detail': {
        const wanted = new Set(action.editIds || []);
        const details = [...(this.current?.editDetails || []), ...this.pendingEdits];
        this.emit('edits_detail', { edits: details.filter(edit => wanted.has(edit.id)) });
        break;
      }
      case 'approve_patch':
      case 'reject_patch':
      case 'approve_command':
      case 'reject_command': {
        const approval = this.run?.approval;
        if (approval && action.action.endsWith(approval.kind)) approval.respond(action.action.startsWith('approve'));
        break;
      }
      case 'terminal_interrupt':
        if (action.commandId === this.run?.id) this.stopRun();
        break;
      case 'stop_task':
        this.stopRun();
        break;
    }
  }
}
