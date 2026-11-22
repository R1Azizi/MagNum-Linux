import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChatMessage, FileNode, SessionMeta, RightPanelTab, Attachment, EditSummary, EditDetail } from '../types';
import type { AndroidTool } from './androidAgent';
import { LocalRunActivity } from './localRunActivity';
import { embeddedBrowser } from '../utils/embeddedBrowser';
import { isAndroid } from '../utils/platform';
import { AndroidProviderTransport, type ChatTransport } from './androidProviderTransport';
import {
  bindAttachmentSender, stageAttachments as stageAtts,
  unstageAttachment as unstageAtt
} from '../utils/attachmentStaging';

const PROVIDER_IDS = ['deepseek', 'gemini', 'chatgpt'] as const;
type ProviderId = typeof PROVIDER_IDS[number];
const accessLabels: Record<string, string> = {
  checking: 'Checking conversation access…',
  missing: 'The provider reports that this conversation is missing. Your local history is available below.',
  denied: 'This account cannot access the saved conversation. Your local history is available below.',
  disconnected: 'The provider browser is disconnected.',
  sign_in: 'Sign in to the provider, then check access again.',
  temporary: 'The provider could not verify access. Try again.'
};
function readDefaultProvider(): ProviderId {
  if (isAndroid) return 'deepseek';
  const saved = localStorage.getItem('magnum_default_provider') as ProviderId | null;
  return saved && PROVIDER_IDS.includes(saved) ? saved : 'deepseek';
}
function readDeepThinkDefault(): boolean {
  return localStorage.getItem('magnum_deepseek_deepthink') !== '0';
}


export async function getBackendPort(): Promise<number> {
  // Prefer the blocking variant which waits for the freshly-spawned server
  // to write .backend-port (avoids reading a stale value left by a previous
  // run and hanging on a wrong/dead port).
  try {
    const port = await invoke<number>('wait_backend_port');
    if (port && typeof port === 'number' && port > 0) {
      return port;
    }
  } catch (err) {
    console.warn('[backend-port] wait_backend_port failed, falling back:', err);
  }
  try {
    const port = await invoke<number>('get_backend_port');
    if (port && typeof port === 'number' && port > 0) {
      return port;
    }
  } catch (err) {
    console.warn('[backend-port] Rust command failed:', err);
  }
  return 5454;
}

async function getWsToken(port: number): Promise<string> {
  try {
    const token = await invoke<string>('read_ws_token');
    if (token && typeof token === 'string' && token.length === 64) {
      return token;
    }
  } catch (err) {
    console.warn('[ws-token] Rust command failed, trying HTTP fallback:', err);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ws-token`);
    const data = await res.json();
    if (data?.token) return data.token;
  } catch (err) {
    console.warn('[ws-token] HTTP fallback also failed:', err);
  }

  if (import.meta.env.DEV) {
    console.warn('[ws-token] Using empty token in DEV mode — unsafe for production!');
    return '';
  }
  throw new Error('Could not obtain WebSocket token');
}

export function useMagNumSocket(onOpenRightTab: (tab: RightPanelTab) => void) {
  const [ws, setWs] = useState<ChatTransport | null>(null);
  const sendActionRef = useRef<(action: string, payload?: Record<string, any>) => void>(() => {});
  useEffect(() => {
    bindAttachmentSender((action, payload) => sendActionRef.current(action, payload));
    return () => bindAttachmentSender(null);
  }, []);

  const [accountInfo, setAccountInfo] = useState<{ isLoggedIn: boolean; email?: string }>({ isLoggedIn: false });
  const [activeWorkspace, setActiveWorkspace] = useState<string>('');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [selectedFileName, setSelectedFileName] = useState('');
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingState, setStreamingState] = useState<{ text?: string; thought?: string; action?: string | null } | null>(null);
  const streamingTextRef = useRef<string>('');
const lastErrorRef = useRef<{ text: string; ts: number }>({ text: '', ts: 0 });
  const [animateId, setAnimateId] = useState<string | null>(null);
  const desktopProtocol = useRef(false);
  const activityProtocol = useRef(false);
  const localActivity = useRef<LocalRunActivity | null>(null);
  localActivity.current ??= new LocalRunActivity();
  const [inspectorCapabilities, setInspectorCapabilities] = useState({ runActivity: false, gitChanges: false });
  const [engineConnected, setEngineConnected] = useState(false);
  const [inspectionRevision, setInspectionRevision] = useState(0);
  const inspectorSequence = useRef(0);
  const inspectorReplies = useRef(new Map<string, (data?: any) => void>());
  const activeRun = useRef<string | null>(null);
  const activeCommand = useRef<string | null>(null);
  const pendingRequest = useRef<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>('');
const [networkRetry, setNetworkRetry] = useState<{ attempt: number; max: number } | null>(null);
  const [isDeepThink, setIsDeepThink] = useState(readDeepThinkDefault);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(readDefaultProvider);
  const navigationId = useRef(0);
  const selectedRef = useRef(selectedProvider);
  selectedRef.current = selectedProvider;
  const [access, setAccess] = useState({ status: isAndroid ? 'checking' : 'ready', detail: '' });
  const [defaultProvider, setDefaultProviderState] = useState<ProviderId>(readDefaultProvider);
  const [geminiThinking, setGeminiThinkingLevel] = useState<'low' | 'medium' | 'high'>(() => {
    const saved = localStorage.getItem('magnum_gemini_thinking');
    return saved === 'low' || saved === 'high' ? saved : 'medium';
  });
  const geminiThinkingRef = useRef(geminiThinking);
  useEffect(() => { geminiThinkingRef.current = geminiThinking; }, [geminiThinking]);
  const [chatgptThink, setChatgptThinkState] = useState<boolean>(() => {
    const saved = localStorage.getItem('magnum_chatgpt_think');
    return saved === null ? true : saved === '1';
  });
  const chatgptThinkRef = useRef(chatgptThink);
  useEffect(() => { chatgptThinkRef.current = chatgptThink; }, [chatgptThink]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [pendingPatches, setPendingPatches] = useState<EditSummary[]>([]);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [editDetails, setEditDetails] = useState<Record<number, EditDetail>>({});
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [providersStatus, setProvidersStatus] = useState<{ deepseek: 'disconnected' | 'connecting' | 'connected'; gemini: 'disconnected' | 'connecting' | 'connected'; chatgpt: 'disconnected' | 'connecting' | 'connected' }>({ deepseek: 'disconnected', gemini: 'disconnected', chatgpt: 'disconnected' });
  const [androidTools, setAndroidTools] = useState<AndroidTool[] | null>(null);
  const [androidWorkspaceStatus, setAndroidWorkspaceStatus] = useState({ busy: false, message: '' });
  const [androidRunWorkspace, setAndroidRunWorkspace] = useState('');
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<{ line: string; kind: string; ts: number }[]>([]);
  const [patchHistory, setPatchHistory] = useState<{ file: string; success: boolean; message?: string; ts: number }[]>([]);
  const [termLines, setTermLines] = useState<{ type: 'out' | 'err' | 'echo' | 'sys'; text?: string; cwd?: string; command?: string }[]>([]);
  const [termCwd, setTermCwd] = useState<string>('');
  const pushTerm = (l: any) => setTermLines(prev => { const n = [...prev, l]; return n.length > 2000 ? n.slice(n.length - 2000) : n; });
  const [revertedEditIds, setRevertedEditIds] = useState<number[]>([]);
  const [diagnosticResult, setDiagnosticResult] = useState<any>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerNotice, setFolderPickerNotice] = useState('');
  const browsePending = useRef(new Map<string, (d: any) => void>());
  const selectedFileNameRef = useRef(selectedFileName);
const currentSessionIdRef = useRef<string | null>(currentSessionId);


  useEffect(() => {
    selectedFileNameRef.current = selectedFileName;
  }, [selectedFileName]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    let socket: ChatTransport | null = null;
    let retries = 0;
    let disposed = false; 
    let wsToken: string = '';
    let port: number = 5454;

    const resolveAtts = (msgs: ChatMessage[]): ChatMessage[] => msgs.map(m => {
      if (!Array.isArray(m.attachments) || m.attachments.length === 0) return m;
      return {
        ...m,
        attachments: m.attachments.map(a =>
          (a.base64 || a.url || !a.file) ? a : {
            ...a,
            url: `http://127.0.0.1:${port}/api/attachment?file=${encodeURIComponent(a.file!)}&token=${encodeURIComponent(wsToken)}`
          }
        )
      };
    });

    const initializeAndConnect = async () => {
      if (isAndroid) {
        connect();
        return;
      }
      try {
        port = await getBackendPort();
        embeddedBrowser.setPort(port);
        wsToken = await getWsToken(port);

      } catch (err) {
        console.error('[ws] Could not get token/port:', err);
      }
      connect();
    };

    const connect = () => {
      let needsRestore = true;
      if (disposed) return;
      const wsUrl = wsToken
        ? `ws://127.0.0.1:${port}?token=${encodeURIComponent(wsToken)}`
        : `ws://127.0.0.1:${port}`;
      socket = isAndroid ? new AndroidProviderTransport() : new WebSocket(wsUrl);
      socket.onopen = () => {
        setEngineConnected(true);
        retries = 0;
        if (isAndroid) {
          socket?.send(JSON.stringify({ action: 'get_sessions' }));
          return;
        }
        const lang = localStorage.getItem('magnum_lang') === 'fa' ? 'fa' : 'en';
        const savedDefault = localStorage.getItem('magnum_default_provider');
        const defProvider = savedDefault === 'chatgpt' || savedDefault === 'gemini' ? savedDefault : 'deepseek';
        socket?.send(JSON.stringify({ action: 'set_default_provider', provider: defProvider }));
        socket?.send(JSON.stringify({ action: 'set_language', lang }));
        socket?.send(JSON.stringify({ action: 'set_chatgpt_think', enabled: localStorage.getItem('magnum_chatgpt_think') !== '0' }));
        socket?.send(JSON.stringify({ action: 'set_deep_think', enabled: localStorage.getItem('magnum_deepseek_deepthink') !== '0' }));
        socket?.send(JSON.stringify({ action: 'set_thinking_level', level: localStorage.getItem('magnum_gemini_thinking') || 'medium' }));
        socket?.send(JSON.stringify({ action: 'get_sessions' }));
        socket?.send(JSON.stringify({ action: 'get_terminal_logs' }));
        socket?.send(JSON.stringify({ action: 'get_recent_workspaces' }));
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string' && event.data.length > 2_000_000) {
          console.warn('[ws] dropped oversized payload:', event.data.length);
          return;
        }
        const data = JSON.parse(event.data);
        if (data.navigationId !== undefined && data.navigationId !== navigationId.current) return;
        if (['run_history', 'run_activity', 'workspace_changes'].includes(data.event)) {
          inspectorReplies.current.get(data.requestId)?.(data);
          return;
        }
        if (data.event === 'run_activity_changed') {
          setInspectionRevision(value => value + 1);
          return;
        }
        if (!activityProtocol.current && data.event !== 'execution_state' && localActivity.current?.receive(data)) {
          setInspectionRevision(value => value + 1);
        }
        if (data.runId && !['run_started', 'run_busy', 'runtime_busy'].includes(data.event) && data.runId !== activeRun.current) return;
        if (data.commandId && data.event !== 'terminal_echo' && data.event !== 'execution_state' && data.commandId !== activeCommand.current) return;
        switch (data.event) {
          case 'execution_state':
            desktopProtocol.current = true;
            activityProtocol.current = Boolean(data.capabilities?.runActivity);
            setInspectorCapabilities({ runActivity: activityProtocol.current, gitChanges: Boolean(data.capabilities?.gitChanges) });
            setInspectionRevision(value => value + 1);
            activeRun.current = data.run?.runId || null;
            activeCommand.current = data.commandId || null;
            setRunId(activeRun.current);
            setIsRunning(Boolean(activeRun.current));
            if (data.run?.provider) {
              setSelectedProvider(data.run.provider);
              currentSessionIdRef.current = data.run.sessionId;
              setCurrentSessionId(data.run.sessionId);
              setMessages(resolveAtts(data.session?.messages || []));
              setHasMoreMessages(Boolean(data.session?.hasMore));
              setAccess({ status: 'ready', detail: '' });
            }
            setAgentStatus(data.run ? `Run ${data.run.runId} is active on ${data.run.provider}.` : '');
            setCommandId(activeCommand.current);
            setTermCwd(data.cwd || '');
            setPendingCommand(data.pendingCommand || null);
            setPendingPatches(data.pendingPatches || []);
            break;
          case 'run_started':
            if (data.sessionId !== currentSessionIdRef.current || selectedRef.current !== data.provider) {
              setMessages(resolveAtts(data.session?.messages || []));
              currentSessionIdRef.current = data.sessionId;
              setCurrentSessionId(data.sessionId);
              setHasMoreMessages(Boolean(data.session?.hasMore));
              setAccess({ status: 'ready', detail: '' });
            }
            activeRun.current = data.runId;
            setRunId(data.runId);
            setSelectedProvider(data.provider);
            setIsRunning(true);
            if (pendingRequest.current === data.requestId) pendingRequest.current = null;
            break;
          case 'run_busy':
          case 'runtime_busy':
            if (data.requestId && data.requestId === pendingRequest.current) {
              pendingRequest.current = null;
              setMessages(prev => prev.filter(m => m.id !== data.requestId));
            }
            setAgentStatus(`Run ${data.runId} is active on ${data.provider}.`);
            break;
          case 'android_provider_status': {
            const status = ['ready', 'busy', 'missing'].includes(data.status) ? 'connected' : data.status === 'checking' ? 'connecting' : 'disconnected';
            setConnectionStatus(status);
            setProvidersStatus(p => ({ ...p, deepseek: status }));
            setAccountInfo({ isLoggedIn: status === 'connected' });
            setAccess({ status: data.status, detail: data.detail || '' });
            break;
          }
          case 'auth_status':
          case 'logged_in':
            setAccountInfo({ isLoggedIn: data.isLoggedIn ?? true, email: data.email || 'DeepSeek Online' });
            setConnectionStatus(data.isLoggedIn ?? true ? 'connected' : 'disconnected');
            setProvidersStatus(p => ({ ...p, deepseek: (data.isLoggedIn ?? true) ? 'connected' : 'disconnected' }));
            setAgentStatus('');
            break;
          case 'logged_out':
            setAccountInfo({ isLoggedIn: false, email: '' });
            setConnectionStatus('disconnected');
            setProvidersStatus(p => ({ ...p, deepseek: 'disconnected' }));
            break;
          case 'sessions_list':
            setSessions(data.sessions || []);
            if (data.runId && data.currentSessionId) {
              setCurrentSessionId(data.currentSessionId);
              currentSessionIdRef.current = data.currentSessionId;
              localStorage.setItem('magnum_last_chat_' + data.provider, data.currentSessionId);
            } else if (data.deletedSessionId && data.deletedSessionId === currentSessionIdRef.current) {
              localActivity.current?.remove(data.deletedSessionId);
              currentSessionIdRef.current = null;
              setCurrentSessionId(null);
              setMessages([]);
              setAccess({ status: 'ready', detail: '' });
            } else if (needsRestore && !activeRun.current && desktopProtocol.current) {
              const provider = selectedRef.current;
              const shared = data.sessions?.find((session: SessionMeta) => session.id === data.currentSessionId && session.provider === provider);
              const id = currentSessionIdRef.current || localStorage.getItem('magnum_last_chat_' + provider) || shared?.id;
              if (id && data.sessions?.some((s: SessionMeta) => s.id === id)) {
                setAccess({ status: 'checking', detail: '' });
                socket?.send(JSON.stringify({ action: 'load_session', sessionId: id, navigationId: ++navigationId.current }));
              } else if (data.currentSessionId) {
                setAccess({ status: 'checking', detail: '' });
                socket?.send(JSON.stringify({ action: 'new_chat', provider, navigationId: ++navigationId.current }));
              } else setAccess({ status: 'ready', detail: '' });
            } else if (!isAndroid && !desktopProtocol.current && data.currentSessionId) setCurrentSessionId(data.currentSessionId);
            needsRestore = false;
            break;
          case 'chat_reset':
            currentSessionIdRef.current = null;
            if (data.provider) localStorage.removeItem('magnum_last_chat_' + data.provider);
            if (!desktopProtocol.current) setAccess({ status: 'ready', detail: '' });
            setMessages([]);
            setStreamingState(null);
            if (!activeRun.current) setIsRunning(false);
            setCurrentSessionId(null);
            setSessions(data.sessions || []);
            setAgentStatus('');
            setNetworkRetry(null);
            setPatchHistory([]);
            setPendingPatches([]);
            setPendingCommand(null);
            setRevertedEditIds([]);
            setHasMoreMessages(false);
            setTotalMessageCount(0);
            setIsLoadingOlder(false);
            break;
          case 'provider_restore_failed':
            if (data.provider === selectedRef.current && navigationId.current === 0)
              setAccess({ status: data.status, detail: data.detail || '' });
            break;
          case 'session_access':
            if (data.runId && data.sessionId !== currentSessionIdRef.current) break;
            setAccess({ status: data.status, detail: data.detail || '' });
            if (data.status === 'ready' && data.sessionId) localStorage.setItem('magnum_last_chat_' + data.provider, data.sessionId);
            if (data.requestId) setMessages(prev => prev.filter(m => m.id !== data.requestId));
            break;
          case 'session_loaded':
            currentSessionIdRef.current = data.session?.id || null;
            if (!isAndroid) setAccess({ status: desktopProtocol.current ? 'checking' : 'ready', detail: '' });
            if (!isAndroid && data.session?.id && data.session.provider) {
              localStorage.setItem('magnum_last_chat_' + data.session.provider, data.session.id);
            }
            setCurrentSessionId(data.session?.id || null);
            setMessages(resolveAtts(data.session?.messages || []));
            if (data.session?.provider) {
              setSelectedProvider(data.session.provider === 'gemini' ? 'gemini' : data.session.provider === 'chatgpt' ? 'chatgpt' : 'deepseek');
            }
            if (!isAndroid) {
              setPendingPatches([]);
              setPendingCommand(null);
            }
            setRevertedEditIds([]);
            setTerminalLogs([]);
            setHasMoreMessages(Boolean(data.session?.hasMore));
            setTotalMessageCount(data.session?.totalMessageCount || (data.session?.messages || []).length);
            setIsLoadingOlder(false);
            setNetworkRetry(null);
            break;
          case 'android_workspace_capabilities':
            setAndroidTools(data.tools);
            break;
          case 'android_workspace_status':
            setAndroidWorkspaceStatus({ busy: Boolean(data.busy), message: data.message || '' });
            break;
          case 'android_run_workspace':
            setAndroidRunWorkspace(data.path || '');
            break;
          case 'workspace_loaded':
            if (isAndroid) {
              setSelectedFileName('');
              setSelectedFileContent(null);
              if (!activeCommand.current) setTermCwd(data.path);
            }
            setActiveWorkspace(data.path);
            setFileTree(data.tree || []);
            break;
          case 'file_content':
            setSelectedFileName(data.filename);
            setSelectedFileContent(data.content);
            onOpenRightTab('files');
            break;
          case 'agent_status':
            setAgentStatus(data.text);
            break;
          case 'network_retry':
            setNetworkRetry({ attempt: data.attempt, max: data.max });
            setAgentStatus(typeof data.text === 'string' ? data.text : `Network error — retrying (${data.attempt}/${data.max})...`);
            break;
          case 'agent_streaming':
            streamingTextRef.current = typeof data.text === 'string' ? data.text : '';
            setStreamingState({
              text: typeof data.text === 'string' ? data.text : '',
              thought: typeof data.thought === 'string' ? data.thought : '',
              action: data.action || null
            });
            setNetworkRetry(null);
            break;
          case 'agent_streaming_end':
            setStreamingState(null);
            break;
          case 'agent_message':
            
            if (data.sessionId && (isAndroid || currentSessionIdRef.current) && data.sessionId !== currentSessionIdRef.current) {
              console.log('Skipping background message for inactive view:', data.sessionId);
              break;
            }

            const finalText = typeof data.text === 'string' ? data.text : '';
            const commitId = data.msgId ? String(data.msgId) : Math.random().toString(36).substring(2, 9);

            
            if (finalText.length > 5 && (!data.action || data.action === 'finish')) {
              setAnimateId(commitId);
            } else {
              setAnimateId(null);
            }

            streamingTextRef.current = '';
            setMessages(prev => {
              const stableId = data.msgId ? String(data.msgId) : commitId;
              if (prev.some(m => m.id === stableId)) return prev;
              return [...prev, {
                id: stableId,
                role: data.role || 'agent',
                text: data.text,
                thought: data.thought || '',
                action: data.action,
                skill: data.skill || undefined,
                edits: Array.isArray(data.edits) ? data.edits : undefined,
                files: Array.isArray(data.files) ? data.files : undefined,
                file: typeof data.file === 'string' ? data.file : undefined,
                command: typeof data.command === 'string' ? data.command : undefined,
                isError: false,
                ts: data.ts || Date.now(),
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              }];
            });
            setStreamingState(null);
            break;
          case 'deep_think_status':
            setIsDeepThink(Boolean(data.enabled));
            break;
          case 'thinking_level':
            if (data.level === 'low' || data.level === 'medium' || data.level === 'high') {
              setGeminiThinkingLevel(data.level);
              localStorage.setItem('magnum_gemini_thinking', data.level);
            }
            break;
          case 'task_finished':
          case 'task_stopped':
            if (desktopProtocol.current && !data.runId) break;
            activeRun.current = null;
            setRunId(null);
            setPendingCommand(null);
            setPendingPatches([]);
            setIsRunning(false);
            setAgentStatus('');
            setStreamingState(null);
            setNetworkRetry(null);
            break;
          case 'error': {
            const errText = String(data.message || '');
            const now = Date.now();
            if (errText === lastErrorRef.current.text && now - lastErrorRef.current.ts < 2000) break;
            lastErrorRef.current = { text: errText, ts: now };
            if (!desktopProtocol.current) setIsRunning(false);
            setAgentStatus('');
            setStreamingState(null);
            setNetworkRetry(null);
            setMessages(prev => [...prev, {
              id: Math.random().toString(36).substring(2, 9),
              role: 'agent',
              text: `Error: ${data.message}`,
              isError: true,
              ts: Date.now(),
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }]);
            break;
          }
          case 'terminal_log':
            setTerminalLogs(prev => {
              const next = [...prev, { line: data.line, kind: data.kind, ts: data.ts }];
              return next.length > 400 ? next.slice(next.length - 400) : next;
            });
            break;
          case 'terminal_history':
            setTerminalLogs(data.logs || []);
            break;
          case 'recent_workspaces':
            setRecentWorkspaces(data.workspaces || []);
            break;
          case 'embedded_navigate': {
            (async () => {
              try {
                onOpenRightTab('browser');
                await embeddedBrowser.navigate(data.input || '');
                
                setTimeout(() => embeddedBrowser.syncPageContent(), 1200);
                socket?.send(JSON.stringify({
                  action: 'embedded_navigate_ack', requestId: data.requestId,
                  url: embeddedBrowser.getActiveUrl()
                }));
              } catch (e: any) {
                socket?.send(JSON.stringify({ action: 'embedded_navigate_ack', requestId: data.requestId, error: String(e?.message || e) }));
              }
            })();
            break;
          }
          case 'embedded_read_page': {
            (async () => {
              await embeddedBrowser.syncPageContent();
              socket?.send(JSON.stringify({
                action: 'embedded_read_ack', requestId: data.requestId,
                url: embeddedBrowser.getActiveUrl()
              }));
            })();
            break;
          }
          case 'terminal_live_output':
            pushTerm({ type: data.isErr ? 'err' : 'out', text: String(data.line ?? '') });
            break;
          case 'terminal_echo':
            activeCommand.current = data.commandId || null;
            setCommandId(activeCommand.current);
            pushTerm({ type: 'echo', cwd: data.cwd || '', command: String(data.command ?? '') });
            if (isAndroid) {
              setTermCwd(data.cwd || '');
              onOpenRightTab('terminal');
            }
            break;
          case 'terminal_prompt':
            activeCommand.current = null;
            setCommandId(null);
            setTermCwd(typeof data.cwd === 'string' ? data.cwd : '');
            break;
          case 'terminal_clear':
            setTermLines([]);
            break;
          case 'terminal_exit':
            pushTerm({ type: 'sys', text: isAndroid
              ? `Command ${String(data.status || 'failed').replace(/_/g, ' ')}${data.code == null ? '' : ` · Exit code ${data.code}`}`
              : `[powershell exited — code ${data.code ?? 0}]` });
            break;
          case 'patch_applied':
            setPatchHistory(prev => [...prev, ...(data.details || []).map((d: any) => ({ ...d, ts: Date.now() }))].slice(-60));
            break;
          case 'diagnostic_result':
            setDiagnosticResult(data);
            if (data.ok) setConnectionStatus('connected');
            else if (data.status === 'closed') setConnectionStatus('disconnected');
            break;
          case 'session_purged_remote':
            setSessions(data.sessions || []);
            setCurrentSessionId(null);
            setMessages([]);
            if (!activeRun.current) setIsRunning(false);
            setAgentStatus('');
            setStreamingState(null);
            setNetworkRetry(null);
            break;
          case 'sync_completed':
            setSessions(data.sessions || []);
            setAgentStatus(data.message || 'Sync completed.');
            break;
          case 'login_browser_opened':
            setAgentStatus(data.message || 'Browser window is open.');
            if (data.provider === 'gemini') setProvidersStatus(p => ({ ...p, gemini: 'connecting' }));
            else if (data.provider === 'chatgpt') setProvidersStatus(p => ({ ...p, chatgpt: 'connecting' }));
            else { setProvidersStatus(p => ({ ...p, deepseek: 'connecting' })); setConnectionStatus('connecting'); }
            break;
          case 'providers_status':
            setProvidersStatus({ deepseek: data.deepseek || 'disconnected', gemini: data.gemini || 'disconnected', chatgpt: data.chatgpt || 'disconnected' });
            break;
          case 'gemini_logged_in':
            setProvidersStatus(p => ({ ...p, gemini: 'connected' }));
            break;
          case 'gemini_logged_out':
            setProvidersStatus(p => ({ ...p, gemini: 'disconnected' }));
            break;
          case 'chatgpt_logged_in':
            setProvidersStatus(p => ({ ...p, chatgpt: 'connected' }));
            break;
          case 'chatgpt_logged_out':
            setProvidersStatus(p => ({ ...p, chatgpt: 'disconnected' }));
            break;
          case 'chatgpt_think_status':
            setChatgptThinkState(Boolean(data.enabled));
            localStorage.setItem('magnum_chatgpt_think', data.enabled ? '1' : '0');
            break;
          case 'older_messages_loaded':
            if (data.session?.id !== currentSessionIdRef.current) break;
            setIsLoadingOlder(false);
            setMessages(prev => {
              const older = resolveAtts(Array.isArray(data.session?.messages) ? data.session.messages : []);
              const existing = new Set(prev.map(m => m.id));
              const toPrepend = older.filter((m: any) => !existing.has(m.id));
              return [...toPrepend, ...prev];
            });
            setHasMoreMessages(Boolean(data.session?.hasMore));
            if (data.session?.totalMessageCount) setTotalMessageCount(data.session.totalMessageCount);
            break;
          case 'message_edits':
          case 'edits_detail':
            setEditDetails(prev => {
              const next = { ...prev };
              for (const e of (data.edits || [])) next[e.id] = e;
              return next;
            });
            break;
          case 'patch_proposed':
            setPendingPatches(Array.isArray(data.summaries) ? data.summaries : []);
            onOpenRightTab('review');
            break;
          case 'command_proposed':
            setPendingCommand(typeof data.command === 'string' ? data.command : null);
            onOpenRightTab('review');
            break;
          case 'command_result':
            setPendingCommand(null);
            break;
          case 'patch_result':
          case 'file_patched':
            setPendingPatches([]);
            if (data.file && data.file === selectedFileNameRef.current) {
              socket?.send(JSON.stringify({ action: 'read_file', filename: data.file }));
            }
            break;
          case 'edits_reverted': {
            const okIds = (data.results || []).filter((r: any) => r.success).map((r: any) => Number(r.id));
            if (okIds.length) setRevertedEditIds(prev => Array.from(new Set([...prev, ...okIds])));
            break;
          }
          case 'folder_dialog_failed':
            setFolderPickerNotice(typeof data.message === 'string' ? data.message : '');
            setFolderPickerOpen(true);
            break;
          case 'dir_listing': {
            const pending = browsePending.current.get(data.requestId);
            if (pending) {
              browsePending.current.delete(data.requestId);
              pending(data);
            }
            break;
          }
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setEngineConnected(false);
        for (const settle of inspectorReplies.current.values()) settle();
        setAccess({ status: 'disconnected', detail: 'Engine reconnecting…' });
        activeCommand.current = activeRun.current = pendingRequest.current = null;
        setCommandId(null);
        setRunId(null);
        setNetworkRetry(null);
        setStreamingState(null);
        setPendingCommand(null);
        setPendingPatches([]);
        setConnectionStatus('disconnected');
        setIsRunning(false);
        setAgentStatus('Engine disconnected — reconnecting...');
        retries++;
        const delay = Math.min(500 * retries, 5000);
        setTimeout(initializeAndConnect, delay);
      };
      setWs(socket);
    };
    initializeAndConnect();
    return () => {
      disposed = true;
      if (socket) {
        socket.onmessage = null; 
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  const sendAction = useCallback((action: string, payload: Record<string, any> = {}) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const target = ['approve_command', 'reject_command', 'approve_patch', 'reject_patch'].includes(action) ? { runId } : {};
      ws.send(JSON.stringify({ action, ...target, ...payload }));
    } else {
      console.warn('[ws] sendAction dropped — socket not open:', action);
    }
  }, [ws, runId]);

  useEffect(() => { sendActionRef.current = sendAction; }, [sendAction]);

  const requestInspector = useCallback(<T,>(action: string, fields: Record<string, unknown>): Promise<T | undefined> => {
    if (ws?.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const requestId = String(++inspectorSequence.current);
      const settle = (reply?: T) => {
        clearTimeout(timer);
        inspectorReplies.current.delete(requestId);
        resolve(reply);
      };
      const timer = setTimeout(settle, 12000);
      inspectorReplies.current.set(requestId, settle);
      ws.send(JSON.stringify({ action, requestId, ...fields }));
    });
  }, [ws]);

  const stageAttachments = useCallback((attachments: Attachment[]) => {
    stageAtts(selectedProvider, attachments);
  }, [selectedProvider]);

  const unstageAttachment = useCallback((id: string) => {
    unstageAtt(selectedProvider, id);
  }, [selectedProvider]);

  const openWorkspace = useCallback((path: string) => {
    sendAction('open_workspace', { path });
  }, [sendAction]);

  const navigate = useCallback((provider: ProviderId, id: string | null) => {
    if ((isAndroid && provider !== 'deepseek') || activeRun.current || pendingRequest.current || ws?.readyState !== WebSocket.OPEN) return;
    const session = sessions.find(item => item.id === id);
    setSelectedProvider(provider);
    selectedRef.current = provider;
    setAccess({ status: 'checking', detail: '' });
    if (id !== currentSessionIdRef.current) setMessages([]);
    setCurrentSessionId(id);
    currentSessionIdRef.current = id;
    setIsLoadingOlder(false);
    setHasMoreMessages(false);
    setStreamingState(null);
    const sequence = ++navigationId.current;
    sendAction(id ? 'load_session' : 'new_chat', { provider, sessionId: id, navigationId: sequence });
    if (!isAndroid && session?.workspacePath && session.workspacePath !== activeWorkspace) sendAction('open_workspace', { path: session.workspacePath, navigationId: sequence });
  }, [ws, sessions, sendAction, activeWorkspace]);

  const loadSession = (id: string) => navigate(sessions.find(s => s.id === id)?.provider || 'deepseek', id);
  const selectProvider = (provider: ProviderId) => {
    const remembered = localStorage.getItem('magnum_last_chat_' + provider);
    navigate(provider, sessions.some(s => s.id === remembered) ? remembered : null);
  };
  const newChat = () => {
    if (activeRun.current || pendingRequest.current) return;
    localStorage.removeItem('magnum_last_chat_' + selectedProvider);
    navigate(selectedProvider, null);
  };
  const reconnect = () => navigate(selectedProvider, currentSessionId);
  const accessStatus = access.status === 'ready' && currentSessionId && desktopProtocol.current
    && providersStatus[selectedProvider] === 'disconnected' ? 'disconnected' : access.status;
  const sendBlocked = accessStatus !== 'ready';

  const setGeminiThinking = useCallback((level: 'low' | 'medium' | 'high') => {
    setGeminiThinkingLevel(level);
    localStorage.setItem('magnum_gemini_thinking', level);
    sendAction('set_thinking_level', { level });
  }, [sendAction]);

  const setChatgptThink = useCallback((enabled: boolean) => {
    setChatgptThinkState(enabled);
    localStorage.setItem('magnum_chatgpt_think', enabled ? '1' : '0');
    sendAction('set_chatgpt_think', { enabled });
  }, [sendAction]);

  const setDefaultProvider = useCallback((p: ProviderId) => {
    setDefaultProviderState(p);
    localStorage.setItem('magnum_default_provider', p);
    sendAction('set_default_provider', { provider: p });
  }, [sendAction]);

  const setDeepThink = useCallback((enabled: boolean) => {
    setIsDeepThink(enabled);
    localStorage.setItem('magnum_deepseek_deepthink', enabled ? '1' : '0');
    sendAction('set_deep_think', { enabled });
  }, [sendAction]);

  const sendPrompt = useCallback((
    promptText: string,
    autoApplyPatch: boolean,
    excludedPaths: string[],
    ignoredPatterns: string[],
    attachments: Attachment[] = [],
    skillId: string | null = null,
    autoApproveCommand: boolean = false
  ) => {
    if ((!promptText.trim() && attachments.length === 0) || sendBlocked || isRunning || pendingRequest.current) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setMessages(prev => [...prev, {
        id: Math.random().toString(36).substring(2, 9),
        role: 'agent',
        text: 'Error: Engine disconnected. Reconnecting to backend... please try again in a moment.',
        isError: true,
        ts: Date.now(),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
      setAgentStatus('Engine disconnected — reconnecting...');
      return;
    }
    const userMsgId = Math.random().toString(36).substring(2, 9);
    setMessages(prev => [...prev, {
      id: userMsgId,
      role: 'user',
      text: promptText,
      skill: skillId || undefined,
      attachments,
      ts: Date.now(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
    if (desktopProtocol.current) pendingRequest.current = userMsgId;
    else setIsRunning(true);
    if (!activityProtocol.current) {
      localActivity.current?.start(userMsgId, currentSessionIdRef.current, selectedProvider, activeWorkspace);
      setInspectionRevision(value => value + 1);
    }
    setAgentStatus(isAndroid ? 'Sending to DeepSeek…' : 'Uploading context & planning next moves...');
    sendAction('send_prompt', {
      sessionId: currentSessionIdRef.current,
      requestId: userMsgId,
      prompt: promptText,
      provider: selectedProvider,
      thinkingLevel: geminiThinkingRef.current,
      chatgptThink: chatgptThinkRef.current,
      deepThink: isDeepThink,
      autoApplyPatch,
      autoApproveCommand,
      excludedPaths,
      ignoredPatterns,
      attachments,
      skill: skillId || undefined
    });
  }, [sendBlocked, isRunning, isDeepThink, selectedProvider, activeWorkspace, sendAction, ws]);

  const loadOlderMessages = useCallback(() => {
    if (!currentSessionId || isLoadingOlder || !hasMoreMessages) return;
    setIsLoadingOlder(true);
    sendAction('load_older_messages', { navigationId: navigationId.current, sessionId: currentSessionId, limit: 30, offset: messages.length });
  }, [currentSessionId, isLoadingOlder, hasMoreMessages, messages.length, sendAction]);

  const requestMessageEdits = useCallback((messageId: number) => sendAction('get_message_edits', { messageId }), [sendAction]);
  const requestEditsIds = useCallback((ids: number[]) => {
    for (let i = 0; i < ids.length; i += 8) sendAction('get_edits_detail', { editIds: ids.slice(i, i + 8) });
  }, [sendAction]);
  const sendTerminalInput = useCallback((text: string) => sendAction('terminal_input', { text }), [sendAction]);
  const sendTerminalInterrupt = useCallback(() => sendAction('terminal_interrupt', { commandId }), [sendAction, commandId]);
  const sendTerminalRestart = useCallback(() => sendAction('terminal_restart', { commandId }), [sendAction, commandId]);

  const browseDir = useCallback((dirPath?: string): Promise<any> => {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ path: dirPath || '', parent: null, entries: [], error: 'Engine disconnected' });
        return;
      }
      const requestId = Math.random().toString(36).slice(2, 10);
      const timer = setTimeout(() => {
        browsePending.current.delete(requestId);
        resolve({ path: dirPath || '', parent: null, entries: [], error: 'Timeout' });
      }, 15000);
      browsePending.current.set(requestId, (d: any) => { clearTimeout(timer); resolve(d); });
      ws.send(JSON.stringify({ action: 'browse_dir', path: dirPath || '', requestId }));
    });
  }, [ws]);

  return {
    accountInfo,
    inspectorCapabilities, engineConnected, inspectionRevision, requestInspector, localActivity: localActivity.current,
    activeWorkspace,
    fileTree,
    selectedFileName,
    selectedFileContent,
    messages,
    streamingState,
    isRunning,
    runId,
    commandId,
    networkRetry,
    agentStatus,
    isDeepThink,
    setIsDeepThink,
    selectedProvider,
    setSelectedProvider: selectProvider,
    accessStatus, accessDetail: access.detail, sendBlocked,
    accessMessage: accessStatus === 'missing' && access.detail
      ? access.detail
      : [accessLabels[accessStatus], access.detail].filter(Boolean).join(' '),
    newChat, reconnect, composerSequence: navigationId.current,
    defaultProvider,
    setDefaultProvider,
    setDeepThink,
    sessions,
    currentSessionId,
    pendingPatches,
    pendingCommand,
    setPendingCommand,
    editDetails,
    terminalLogs,
    patchHistory,
    diagnosticResult,
    connectionStatus,
    providersStatus,
    geminiThinking,
    setGeminiThinking,
    chatgptThink,
    setChatgptThink,
    recentWorkspaces,
    androidTools, androidWorkspaceStatus, androidRunWorkspace,
    sendAction,
    sendPrompt,
    stageAttachments,
    unstageAttachment,
    loadSession,
    openWorkspace,
    hasMoreMessages,
    totalMessageCount,
    isLoadingOlder,
    loadOlderMessages,
    requestMessageEdits,
    requestEditsIds,
    revertedEditIds,
    animateId,
    termLines,
    termCwd,
    sendTerminalInput,
    sendTerminalInterrupt,
    sendTerminalRestart,
    folderPickerOpen,
    setFolderPickerOpen,
    folderPickerNotice,
    setFolderPickerNotice,
    browseDir,
  };
}
