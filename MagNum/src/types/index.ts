export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  base64?: string;
  url?: string;
  file?: string;
}

export interface EditSummary { id: number; file: string; added: number; deleted: number; status?: string; }
export interface DiffLineData { type: 'add' | 'del' | 'ctx'; text: string; }
export interface EditDetail { id: number; file: string; status?: string; added: number; deleted: number; truncated?: boolean; diff: DiffLineData[]; }

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  skill?: string;
  thought?: string;
  action?: string;
  isError?: boolean;
  timestamp?: string;
  ts?: number;
  attachments?: Attachment[];
  edits?: EditSummary[];
  files?: string[];
  file?: string;
  command?: string;
}

export interface FileNode {
  name: string;
  relPath: string;
  isDir: boolean;
  children?: FileNode[];
}

export type ModelProvider = 'deepseek' | 'gemini' | 'chatgpt';

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  workspacePath?: string;
  provider?: ModelProvider;
}

export interface PatchProposal {
  file: string;
  search?: string;
  replace?: string;
}

export type RightPanelTab = 'activity' | 'review' | 'changes' | 'browser' | 'terminal' | 'files' | null;

export interface BrowserViewState {
  url: string;
  title: string;
  isLoading: boolean;
  viewport?: { width: number; height: number };
  screenshot: string | null;
  textPreview?: string;
}

export interface RunSummary {
  runId: string;
  provider: ModelProvider;
  startedAt: number;
  workspace?: string | null;
  endedAt: number | null;
  step: string;
  outcome: 'completed' | 'stopped' | 'failed' | 'interrupted' | null;
}

export interface RunActivityEvent {
  id: number;
  ts: number;
  type: 'tool_started' | 'tool_result' | 'file_edit' | 'approval' | 'error' | 'stop_requested';
  action?: string;
  target?: string;
  message?: string;
  status?: string;
  exitCode?: number | null;
  signal?: string | null;
  output?: string | null;
  hadOutput?: boolean;
  editId?: number;
}

export interface RunActivity extends RunSummary {
  events: RunActivityEvent[];
  hasEarlier: boolean;
  edits?: EditSummary[];
}

export type GitLayer = 'staged' | 'unstaged' | 'untracked';
export interface GitChange { file: string; original?: string; state: string; }
export type GitResult =
  | { status: 'ready'; files?: GitChange[]; root?: string; diff?: DiffLineData[]; truncated?: boolean }
  | { status: 'no-workspace' | 'non-git' | 'unavailable' | 'error'; message?: string };
