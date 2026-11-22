import { useState } from 'react';
import type { AndroidTool } from '../../hooks/androidAgent';

interface Props {
  path: string;
  runPath: string;
  paths: string[];
  tools: AndroidTool[] | null;
  status: { busy: boolean; message: string };
  expanded: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onCreate: (name: string) => void;
  onImport: () => void;
  onViewFiles: () => void;
  onBrowseFiles: () => void;
  onTerminal: () => void;
}

const nameOf = (path: string) => path.split('/').pop();

export function AndroidWorkspace({ path, runPath, paths, tools, status, expanded, onToggle, onSelect, onCreate, onImport, onViewFiles, onBrowseFiles, onTerminal }: Props) {
  const [name, setName] = useState('');
  const disabled = status.busy || !tools?.length;
  return <section className="android-workspace" aria-label="Agent workspace">
    <div className="android-workspace-bar">
      <button type="button" className="prompt-chip" aria-expanded={expanded} onClick={onToggle}>Workspace</button>
      <span title={nameOf(path)}>{path ? nameOf(path) : 'Chat only'}</span>
      <button type="button" className="prompt-chip" onClick={onTerminal}>Command output</button>
    </div>
    {runPath && runPath !== path && <p role="status">Current run uses {nameOf(runPath)}.</p>}
    {status.message && <p role="alert">{status.message}</p>}
    {status.busy && <p role="status">Opening workspace…</p>}
    {expanded && <div className="android-workspace-actions">
      <label>
        Active workspace
        <select value={path} onChange={e => onSelect(e.target.value)} disabled={disabled}>
          <option value="">Chat only</option>
          {paths.map(item => <option key={item} value={item}>{nameOf(item)}</option>)}
        </select>
      </label>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) onCreate(name.trim()); }}>
        <input aria-label="New workspace name" placeholder="New workspace name" value={name} onChange={e => setName(e.target.value)} maxLength={80} disabled={disabled} />
        <button className="prompt-chip" disabled={disabled || !name.trim()}>Create</button>
      </form>
      <div className="android-workspace-buttons">
        <button type="button" className="prompt-chip" onClick={onImport} disabled={disabled}>Import Android folder</button>
        {path && <button type="button" className="prompt-chip" onClick={onViewFiles}>View files in MagNum</button>}
        {paths.length > 0 && <button type="button" className="prompt-chip" onClick={onBrowseFiles} disabled={status.busy}>Open Android Files</button>}
      </div>
      <p>Imports create working copies. Open MagNum Workspaces in Android Files to read or copy workspace files.</p>
    </div>}
  </section>;
}
