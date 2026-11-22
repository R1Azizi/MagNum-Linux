import { ModelProvider, RunActivity, RunActivityEvent } from '../types';

// Legacy engines send tool events without the desktop history protocol.
const storageKey = 'magnum_local_run_activity';
type LocalRun = RunActivity & { sessionId: string | null };

function restore(): LocalRun[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]') as LocalRun[];
    return saved.map(run => run.endedAt ? run : {
      ...run, endedAt: run.events[run.events.length - 1]?.ts ?? run.startedAt,
      outcome: 'interrupted', step: 'Activity recording ended when the app closed'
    });
  } catch {
    return [];
  }
}

export class LocalRunActivity {
  private runs = restore();
  private active: LocalRun | undefined;

  private save() {
    try { localStorage.setItem(storageKey, JSON.stringify(this.runs)); } catch {}
  }

  start(runId: string, sessionId: string | null, provider: ModelProvider, workspace: string) {
    this.end('interrupted', 'Activity recording interrupted');
    this.active = {
      runId, sessionId, provider, workspace, startedAt: Date.now(), endedAt: null,
      step: 'Preparing run', outcome: null, events: [], hasEarlier: false
    };
    this.runs = [this.active, ...this.runs].slice(0, 25);
    this.save();
  }

  end(outcome: NonNullable<RunActivity['outcome']>, step: string) {
    if (!this.active) return false;
    Object.assign(this.active, { outcome, step: step.slice(0, 1000), endedAt: Date.now() });
    this.active = undefined;
    this.save();
    return true;
  }

  list(sessionId: string | null, provider: ModelProvider) {
    return this.runs.filter(run => run.sessionId === sessionId && run.provider === provider);
  }

  remove(sessionId: string) {
    this.runs = this.runs.filter(run => run.sessionId !== sessionId);
    this.save();
  }

  receive(data: Record<string, any>) {
    const run = this.active;
    if (!run || (run.sessionId && data.sessionId && data.sessionId !== run.sessionId)) return false;
    const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 1000) : undefined;
    const add = (fields: Omit<RunActivityEvent, 'id' | 'ts'>) => {
      const id = (run.events[run.events.length - 1]?.id || 0) + 1;
      run.events.push({ id, ts: Date.now(), ...fields });
      run.events = run.events.slice(-100);
      for (const event of run.events.filter(item => item.output).slice(0, -5)) delete event.output;
    };
    switch (data.event) {
      case 'sessions_list':
        if (run.sessionId || typeof data.currentSessionId !== 'string') return false;
        run.sessionId = data.currentSessionId;
        break;
      case 'run_step':
        run.step = text(data.text) || run.step;
        break;
      case 'tool_started':
      case 'tool_result':
        run.step = data.event === 'tool_started' ? text(data.action)?.replace(/_/g, ' ') || 'Running tool' : 'Processing tool result';
        add({
          type: data.event, action: text(data.action), target: text(data.target), message: text(data.message),
          status: text(data.status), exitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
          signal: text(data.signal), output: typeof data.output === 'string' ? data.output.slice(0, 2000) : undefined
        });
        break;
      case 'command_proposed':
      case 'patch_proposed':
        run.step = data.event === 'command_proposed' ? 'Waiting for command approval' : 'Waiting for patch approval';
        add({ type: 'approval', action: data.event === 'command_proposed' ? 'execute_command' : 'patch_file',
          status: 'waiting', target: text(data.command) });
        break;
      case 'file_patched':
      case 'file_written':
        add({ type: 'file_edit', target: text(data.file), message: 'File written' });
        break;
      case 'command_result':
      case 'patch_result':
        add({ type: 'approval', action: data.event === 'command_result' ? 'execute_command' : 'patch_file',
          status: data.success ? 'approved' : 'rejected', message: text(data.message) });
        break;
      case 'patch_applied':
        if (!Array.isArray(data.details)) return false;
        for (const detail of data.details) {
          add({ type: detail.success ? 'file_edit' : 'error', target: text(detail.file), message: text(detail.message) });
        }
        break;
      case 'error':
        add({ type: 'error', message: text(data.message) });
        return this.end('failed', text(data.message) || 'Run failed');
      case 'task_finished':
        return this.end(data.outcome === 'failed' ? 'failed' : 'completed', text(data.summary) || '');
      case 'task_stopped':
        return this.end('stopped', text(data.message) || '');
      default:
        return false;
    }
    this.save();
    return true;
  }
}
