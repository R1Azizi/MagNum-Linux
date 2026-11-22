import { useEffect, useState } from 'react';
import { GitResult, GitLayer, ModelProvider, RunActivity, RunActivityEvent, RunSummary, EditDetail } from '../../types';
import { LocalRunActivity } from '../../hooks/localRunActivity';
import { formatDuration } from '../../utils/time';
import { DiffView, EditSummaryRows } from '../shared/EditDiff';
import './RunInspection.css';

type Request = <T>(action: string, fields: Record<string, unknown>) => Promise<T | undefined>;
export interface InspectionContext {
  sessionId: string | null;
  provider: ModelProvider;
  activeRunId: string | null;
  workspace: string;
  revision: number;
  connected: boolean;
  capabilities: { runActivity: boolean; gitChanges: boolean };
  request: Request;
  localActivity: LocalRunActivity;
}
type History = { runs: RunSummary[]; hasMore: boolean };
type HistoryPage = History & { scope: string };
type OlderEvents = { scope: string; events: RunActivityEvent[]; hasEarlier: boolean };

function mergeById<T>(first: T[], rest: T[], id: (item: T) => string | number) {
  const existing = new Set(first.map(id));
  return [...first, ...rest.filter(item => !existing.has(id(item)))];
}

export function useInspectionRuns(context: InspectionContext, enabled: boolean) {
  const { sessionId, provider, activeRunId, revision, connected, capabilities, request, localActivity } = context;
  const scope = JSON.stringify([provider, sessionId, capabilities.runActivity]);
  const [history, setHistory] = useState<HistoryPage>();
  const [moreRuns, setMoreRuns] = useState<HistoryPage>();
  const [selection, setSelection] = useState<{ scope: string; id: string }>();
  const [activity, setActivity] = useState<{ scope: string; run: RunActivity | null }>();
  const [older, setOlder] = useState<OlderEvents>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const lastPage = history?.scope === scope ? history : undefined;
  const previousPages = moreRuns?.scope === scope ? moreRuns : undefined;
  const localRuns = capabilities.runActivity ? [] : localActivity.list(sessionId, provider);
  const runs = capabilities.runActivity
    ? mergeById(lastPage?.runs || [], previousPages?.runs || [], run => run.runId) : localRuns;
  const selected = selection?.scope === scope && runs.some(run => run.runId === selection.id) ? selection.id
    : runs.find(run => run.runId === activeRunId)?.runId || runs[0]?.runId || '';
  const detailScope = JSON.stringify([scope, selected]);
  const details = capabilities.runActivity
    ? (activity?.scope === detailScope ? activity.run : undefined)
    : localRuns.find(run => run.runId === selected);
  const earlier = older?.scope === detailScope ? older : undefined;
  const events = mergeById(details?.events || [], earlier?.events || [], event => event.id).sort((a, b) => a.id - b.id);
  const hasEarlier = earlier?.hasEarlier ?? details?.hasEarlier ?? false;

  useEffect(() => {
    if (activeRunId) setSelection(undefined);
  }, [activeRunId]);

  useEffect(() => {
    if (!enabled || !connected || !capabilities.runActivity) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const reply = await request<History>('get_run_history', { sessionId, provider });
      if (cancelled) return;
      if (reply) setHistory({ ...reply, scope });
      setRequestError(!reply);
    }, 60);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, connected, capabilities.runActivity, request, sessionId, provider, scope, revision, refresh]);

  useEffect(() => {
    if (!enabled || !connected || !capabilities.runActivity || !selected) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const reply = await request<{ activity: RunActivity | null }>('get_run_activity', { sessionId, provider, activityRunId: selected });
      if (cancelled) return;
      if (reply) setActivity({ scope: detailScope, run: reply.activity });
      else setRequestError(true);
    }, 60);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, connected, capabilities.runActivity, request, sessionId, provider, selected, detailScope, revision, refresh]);

  async function loadRuns() {
    setLoadingRuns(true);
    const reply = await request<History>('get_run_history', { sessionId, provider, offset: runs.length });
    if (reply) {
      setMoreRuns({ scope, hasMore: reply.hasMore,
        runs: mergeById(previousPages?.runs || [], reply.runs, run => run.runId) });
    }
    setRequestError(!reply);
    setLoadingRuns(false);
  }

  async function loadEarlier() {
    setLoadingOlder(true);
    const reply = await request<{ activity: RunActivity | null }>('get_run_activity', {
      sessionId, provider, activityRunId: selected, before: events[0]?.id
    });
    if (reply?.activity) {
      setOlder({ scope: detailScope, hasEarlier: reply.activity.hasEarlier,
        events: mergeById(earlier?.events || [], reply.activity.events, event => event.id) });
    }
    setRequestError(!reply);
    setLoadingOlder(false);
  }

  return {
    runs, selected, details, events, hasEarlier, loadEarlier, loadRuns, loadingRuns, loadingOlder, connected,
    hasMoreRuns: previousPages?.hasMore ?? lastPage?.hasMore ?? false,
    choose: (id: string) => setSelection({ scope, id }),
    pendingHistory: capabilities.runActivity && connected && !lastPage && !requestError,
    requestError,
    retry: () => { setRequestError(false); setRefresh(value => value + 1); }
  };
}

type InspectionRuns = ReturnType<typeof useInspectionRuns>;
const outcomes = { completed: 'Completed', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' };
const outcomeLabel = (run: RunSummary, connected: boolean) => run.outcome ? outcomes[run.outcome] : connected ? 'Running' : 'Disconnected';
const formatDate = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function RunPicker({ state }: { state: InspectionRuns }) {
  return <>
    {state.runs.length > 0 && (
      <label className="inspection-run-picker">
        <span>Run</span>
        <select value={state.selected} onChange={event => state.choose(event.target.value)}>
          {state.runs.map(run => <option key={run.runId} value={run.runId}>
            {formatDate(run.startedAt)} · {outcomeLabel(run, state.connected)}
          </option>)}
        </select>
      </label>
    )}
    {state.hasMoreRuns && <button className="inspection-button" disabled={!state.connected || state.loadingRuns} onClick={state.loadRuns}>Load older runs</button>}
    {state.requestError && <div className="inspection-row">Could not load run history. <button className="inspection-button" onClick={state.retry}>Retry</button></div>}
    {state.pendingHistory && <p>Loading run history…</p>}
    {!state.pendingHistory && !state.requestError && state.runs.length === 0 && <p>No recorded runs for this chat.</p>}
  </>;
}

const actionNames: Record<string, string> = {
  execute_command: 'Command', patch_file: 'Patch', create_file: 'Write file', read_files: 'Read files',
  read_file: 'Read file', continue_reading: 'Continue reading', search_code: 'Search code',
  list_dir: 'List directory', browse_web: 'Open page', read_page: 'Read page'
};

function ActivityEntry({ entry }: { entry: RunActivityEvent }) {
  const action = entry.action ? actionNames[entry.action] || entry.action.replace(/_/g, ' ') : '';
  const status = entry.status?.replace(/-/g, ' ');
  const titles = {
    tool_started: action + ' started',
    tool_result: action + (status ? ' ' + status : ' result'),
    file_edit: entry.message || 'File edited',
    approval: action + (status === 'waiting' ? ' awaiting approval' : status ? ' ' + status : ' approval'),
    error: 'Error',
    stop_requested: 'Stop requested'
  };
  return <li className="inspection-entry" data-status={entry.type === 'error' ? 'failed' : entry.status}>
    <div className="inspection-row">
      <strong>{titles[entry.type]}</strong>
      <time title={formatDate(entry.ts)} dateTime={new Date(entry.ts).toISOString()}>
        {new Date(entry.ts).toLocaleTimeString()}
      </time>
    </div>
    {entry.target && <div className="code-font inspection-target">{entry.target}</div>}
    {(entry.exitCode != null || entry.signal) && <div>{entry.exitCode != null ? 'Exit code ' + entry.exitCode : entry.signal}</div>}
    {entry.message && entry.type !== 'file_edit' && entry.message !== titles[entry.type] && <div>{entry.message}</div>}
    {entry.hadOutput && !entry.output && <div>Command output expired.</div>}
    {entry.output && <details><summary>Command output</summary><pre className="code-font">{entry.output}</pre></details>}
  </li>;
}

export function ActivityPanel({ state }: { state: InspectionRuns }) {
  const run = state.details;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!run || run.endedAt || !state.connected) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.runId, run?.endedAt, state.connected]);

  return <section className="inspection-panel" aria-label="Run activity">
    <RunPicker state={state} />
    {state.selected && !run && !state.requestError && <p>{state.connected ? 'Loading activity…' : 'Waiting for the engine to reconnect.'}</p>}
    {run && <>
      <div className="inspection-status">
        <div className="inspection-row"><strong>{outcomeLabel(run, state.connected)}</strong>
          <span>{formatDuration(Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000)))}</span>
        </div>
        {run.step && <div className="inspection-step">{run.step}</div>}
        {run.workspace && <div className="code-font inspection-target" title="Run workspace">{run.workspace}</div>}
        <div className="inspection-times">
          <span>Started {formatDate(run.startedAt)}</span>
          {run.endedAt && <span>{run.outcome === 'interrupted' ? 'Last recorded' : 'Ended'} {formatDate(run.endedAt)}</span>}
        </div>
      </div>
      {state.events.length > 0 ? <ol className="inspection-timeline">{[...state.events].reverse().map(entry => <ActivityEntry key={entry.id} entry={entry} />)}</ol>
        : <p>No tool activity recorded.</p>}
      {state.hasEarlier && <button className="inspection-button" disabled={!state.connected || state.loadingOlder} onClick={state.loadEarlier}>Load earlier activity</button>}
    </>}
  </section>;
}

const gitMessages = {
  'no-workspace': 'Open a workspace to view changes.',
  'non-git': 'This workspace is outside a Git repository.',
  unavailable: 'Git is unavailable on this engine.',
  error: 'Could not read Git changes.'
};
const gitStates: Record<string, string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked'
};

function WorkspaceChanges({ context }: { context: InspectionContext }) {
  const { workspace, connected, request, activeRunId } = context;
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<{ workspace: string; result: GitResult }>();
  const [selection, setSelection] = useState<{ workspace: string; file: string; layer: GitLayer }>();
  const [fileDiff, setFileDiff] = useState<{ key: string; result: GitResult }>();
  const current = selection?.workspace === workspace ? selection : undefined;
  const key = JSON.stringify([current, refresh]);

  useEffect(() => {
    if (!connected || !workspace) return;
    let cancelled = false;
    request<{ result: GitResult }>('get_workspace_changes', { workspace }).then(reply => {
      if (!cancelled) setList({ workspace, result: reply?.result || { status: 'error' } });
    });
    return () => { cancelled = true; };
  }, [workspace, connected, request, refresh, activeRunId]);

  useEffect(() => {
    if (!connected || !current) return;
    let cancelled = false;
    request<{ result: GitResult }>('get_workspace_changes', { workspace, file: current.file, layer: current.layer }).then(reply => {
      if (!cancelled) setFileDiff({ key, result: reply?.result || { status: 'error' } });
    });
    return () => { cancelled = true; };
  }, [workspace, connected, request, key, current, activeRunId]);

  if (!workspace) return <p>{gitMessages['no-workspace']}</p>;
  const result = list?.workspace === workspace ? list.result : undefined;
  const diff = fileDiff?.key === key ? fileDiff.result : undefined;
  return <>
    <div className="inspection-row">
      <span className="inspection-target" title={result?.status === 'ready' ? result.root : workspace}>{result?.status === 'ready' ? result.root : workspace}</span>
      <button className="inspection-button" disabled={!connected} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
    </div>
    {!connected && <p>Engine disconnected. Showing the last loaded changes.</p>}
    {!result && connected && <p>Reading Git status…</p>}
    {result && result.status !== 'ready' && <p>{result.message || gitMessages[result.status]}</p>}
    {result?.status === 'ready' && <>
      {!result.files?.length && <p>Working tree is clean.</p>}
      {result.files?.map(entry => {
        const layers: GitLayer[] = entry.state === '??' ? ['untracked'] : [];
        if (entry.state !== '??' && entry.state[0] !== ' ') layers.push('staged');
        if (entry.state !== '??' && entry.state[1] !== ' ') layers.push('unstaged');
        return <div key={entry.file} className="inspection-git-file">
          <div className="code-font inspection-target">{entry.original ? entry.original + ' → ' : ''}{entry.file}</div>
          <div className="inspection-actions">{layers.map(layer => {
            const selected = current?.file === entry.file && current.layer === layer;
            const state = entry.state[layer === 'unstaged' ? 1 : 0];
            return <button key={layer} aria-pressed={selected} className="inspection-button" onClick={() =>
              setSelection(selected ? undefined : { workspace, file: entry.file, layer })}>
              {layer === 'untracked' ? 'Untracked' : (layer === 'staged' ? 'Staged' : 'Unstaged') + ' · ' + (gitStates[state] || state)}
            </button>;
          })}</div>
          {current?.file === entry.file && (diff?.status === 'ready'
            ? (diff.diff?.length
              ? <DiffView detail={{ id: 0, file: entry.file, added: 0, deleted: 0, diff: diff.diff, truncated: diff.truncated }} />
              : <p>No textual patch is available for this change.</p>)
            : <p>{diff ? diff.message || gitMessages[diff.status] : connected ? 'Loading diff…' : 'Waiting for the engine to reconnect.'}</p>)}
        </div>;
      })}
      {result.truncated && <p>Showing the first 1,000 changed files.</p>}
    </>}
  </>;
}

export function WorkspaceChangesPanel({ context, state, editDetails, requestEdits }: {
  context: InspectionContext; state: InspectionRuns; editDetails: Record<number, EditDetail>;
  requestEdits?: (ids: number[]) => void;
}) {
  const [section, setSection] = useState<'workspace' | 'run'>('workspace');
  const showWorkspace = context.capabilities.gitChanges && section === 'workspace';
  const applied = state.details?.edits?.filter(edit => edit.status !== 'reverted') || [];
  const reverted = state.details?.edits?.filter(edit => edit.status === 'reverted') || [];
  return <section className="inspection-panel" aria-label="Changes">
    <div className="inspection-actions">
      {context.capabilities.gitChanges && <button className="inspection-button" aria-pressed={section === 'workspace'} onClick={() => setSection('workspace')}>Workspace Git</button>}
      <button className="inspection-button" aria-pressed={!showWorkspace} onClick={() => setSection('run')}>Run edits</button>
    </div>
    {showWorkspace ? <WorkspaceChanges context={context} /> : <>
      <RunPicker state={state} />
      {state.selected && !state.details && !state.requestError && <p>{state.connected ? 'Loading run edits…' : 'Waiting for the engine to reconnect.'}</p>}
      {state.details?.workspace && <div className="code-font inspection-target" title="Run workspace">{state.details.workspace}</div>}
      {state.details && !applied.length && !reverted.length && <p>No file diffs recorded for this run.</p>}
      {applied.length > 0 && <EditSummaryRows key={state.selected} edits={applied} details={editDetails} onRequestIds={requestEdits} label="Edit" />}
      {reverted.length > 0 && <EditSummaryRows key={state.selected + '-reverted'} edits={reverted} details={editDetails} onRequestIds={requestEdits} label="Reverted edit" />}
    </>}
  </section>;
}
