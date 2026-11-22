import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RightPanelTab } from './types';
import { Language } from './i18n/translations';
import { useMagNumSocket } from './hooks/useMagNumSocket';
import { AndroidWorkspace } from './components/layout/AndroidWorkspace';
import { TopMenuBar } from './components/layout/TopMenuBar';
import { confirmDialog, AppDialogHost } from './components/modals/AppDialog';
import { ConnectionDock } from './components/layout/ConnectionDock';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { EmptyState } from './components/chat/EmptyState';
import { MessageList } from './components/chat/MessageList';
import { ChatInputBar } from './components/chat/ChatInputBar';
import { InspectorDrawer } from './components/inspector/InspectorDrawer';
import { stripSkillPrefix } from './utils/skills';
import { FilterModal } from './components/modals/FilterModal';
import { SettingsView } from './components/settings/SettingsView';
import { UpdateGate } from './components/update/UpdateGate';
import { ImageViewerHost } from './components/shared/ImageViewer';
import { FolderPickerModal } from './components/shared/FolderPickerModal';
import { isAndroid } from './utils/platform';

import './App.css';

export default function App() {
  type PanelKey = Exclude<RightPanelTab, null>;



  const [narrowLayout, setNarrowLayout] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const compactLayout = isAndroid || narrowLayout;
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isSidebarOpen = compactLayout ? mobileSidebarOpen : desktopSidebarOpen;

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const onChange = () => setNarrowLayout(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(null);
  const [openTabs, setOpenTabs] = useState<PanelKey[]>([]);
  const openTabsRef = useRef<PanelKey[]>([]);
  useEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);

  const closeDrawer = useCallback(() => {
    setMobileSidebarOpen(false);
    setRightPanelTab(null);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (compactLayout) {
      setRightPanelTab(null);
      setMobileSidebarOpen(open => !open);
    } else {
      setDesktopSidebarOpen(open => !open);
    }
  }, [compactLayout]);

  const openRightTab = useCallback((tb: PanelKey) => {
    setMobileSidebarOpen(false);
    setOpenTabs(prev => (prev.includes(tb) ? prev : [...prev, tb]));
    setRightPanelTab(tb);
  }, []);

  
  const closeRightTab = useCallback((tb: PanelKey) => {
    const next = openTabsRef.current.filter(x => x !== tb);
    openTabsRef.current = next;
    setOpenTabs(next);
    setRightPanelTab(cur => (cur === tb ? (next[next.length - 1] ?? null) : cur));
  }, []);

  
  const toggleRightPanel = useCallback(() => {
    if (rightPanelTab !== null) {
      setRightPanelTab(null);
    } else {
      const target = openTabsRef.current[openTabsRef.current.length - 1] || 'activity';
      openRightTab(target);
    }
  }, [rightPanelTab, openRightTab]);

  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [workspaceControlsOpen, setWorkspaceControlsOpen] = useState(false);
  const [autoApplyPatch, setAutoApplyPatch] = useState<boolean>(() => {
    const saved = localStorage.getItem('magnum_autopatch');
    return saved === null ? true : saved === '1';
  });
  useEffect(() => {
    localStorage.setItem('magnum_autopatch', autoApplyPatch ? '1' : '0');
  }, [autoApplyPatch]);
  const [requireCommandApproval, setRequireCommandApproval] = useState<boolean>(() => {
    const saved = localStorage.getItem('magnum_cmdapproval');
    return saved === null ? true : saved === '1'; 
  });
  useEffect(() => {
    localStorage.setItem('magnum_cmdapproval', requireCommandApproval ? '1' : '0');
  }, [requireCommandApproval]);

  const [language, setLanguage] = useState<Language>(() => {
    return (localStorage.getItem('magnum_lang') as Language) || 'en';
  });

const [theme, setTheme] = useState<'dark' | 'light'>(() => {
  return localStorage.getItem('magnum_theme') === 'light' ? 'light' : 'dark';
});

  const [ignoredPatterns, setIgnoredPatterns] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('magnum_ignored_list');
      return saved ? JSON.parse(saved) : ['node_modules', '.git', 'dist', 'build', '.next'];
    } catch {
      return ['node_modules', '.git', 'dist', 'build', '.next'];
    }
  });

  const {
    activeWorkspace,
    inspectorCapabilities, engineConnected, inspectionRevision, requestInspector, localActivity,
    fileTree,
    selectedFileName,
    selectedFileContent,
    messages,
    streamingState,
    isRunning,
    runId,
    commandId,
    agentStatus,
    isDeepThink,
    selectedProvider,
    setSelectedProvider, newChat, reconnect, composerSequence, accessStatus, accessDetail, accessMessage, sendBlocked,
    defaultProvider,
    setDefaultProvider,
    setDeepThink,
    sessions,
    currentSessionId,
    pendingPatches,
    pendingCommand,
    editDetails,
    terminalLogs,
    patchHistory,
    diagnosticResult,
    providersStatus,
    recentWorkspaces,
    androidTools, androidWorkspaceStatus, androidRunWorkspace,
    sendAction,
    sendPrompt,
    loadSession,
    openWorkspace,
    hasMoreMessages,
    isLoadingOlder,
    loadOlderMessages,
    requestEditsIds,
    revertedEditIds,
    animateId,
    networkRetry,
    geminiThinking,
    setGeminiThinking,
    chatgptThink,
    setChatgptThink,
    termLines,
    termCwd,
    sendTerminalInput,
    sendTerminalInterrupt,
    sendTerminalRestart,
    folderPickerOpen,
    setFolderPickerOpen,
    folderPickerNotice,
    setFolderPickerNotice,
    browseDir
  } = useMagNumSocket((tab) => { if (tab) openRightTab(tab); });

  const cycleGeminiThinking = useCallback(() => {
    const order: ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];
    setGeminiThinking(order[(order.indexOf(geminiThinking) + 1) % 3]);
  }, [geminiThinking, setGeminiThinking]);

  const handleOpenFolder = useCallback(async () => {
    if (isAndroid) {
      setIsSettingsOpen(false);
      setWorkspaceControlsOpen(open => !open);
      return;
    }
    try {
      const picked = await invoke<string | null>('pick_folder');
      if (picked) { openWorkspace(picked); return; }
    } catch {}
    // Native picker unavailable (Linux/macOS) or cancelled → backend picker
    // (zenity/kdialog on Linux, osascript on macOS, PowerShell on Windows).
    sendAction('choose_folder');
  }, [openWorkspace, sendAction]);

  const handleBrowseInApp = useCallback(() => {
    setFolderPickerNotice('');
    setFolderPickerOpen(true);
  }, [setFolderPickerNotice, setFolderPickerOpen]);



  const repoName = activeWorkspace ? activeWorkspace.split(/[\\/]/).filter(Boolean).pop() || activeWorkspace : 'No Repo';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem('magnum_theme', theme);
    
    try {
      invoke('set_app_theme', { theme }).catch(() => {});
    } catch {}
  }, [theme]);


  const handleLanguageChange = (newLang: Language) => {
    setLanguage(newLang);
    localStorage.setItem('magnum_lang', newLang);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (compactLayout && e.key === 'Escape') closeDrawer();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      }
      
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); openRightTab('files'); }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); openRightTab('terminal'); }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); openRightTab('changes'); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); openRightTab('browser'); }
      
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleRightPanel();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setIsSettingsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [compactLayout, closeDrawer, toggleSidebar, toggleRightPanel, openRightTab]);



  const drawerOpen = compactLayout && (isSidebarOpen || rightPanelTab !== null);

  return (
    <UpdateGate>
    <div className={`app-shell${compactLayout ? ' app-shell--compact' : ''}`}>
      
<TopMenuBar
  activeWorkspace={activeWorkspace}
  isSidebarOpen={isSidebarOpen}
  onToggleSidebar={toggleSidebar}
  onNewChat={newChat}
  onOpenFolder={handleOpenFolder}
  onToggleTab={(t) => { if (rightPanelTab === t) setRightPanelTab(null); else openRightTab(t); }}
  onOpenFilters={() => setIsSettingsOpen(true)}
  onDiagnose={() => sendAction('diagnose')}
/>

      {isSettingsOpen ? (
        <SettingsView
          defaultProvider={defaultProvider}
          onDefaultProviderChange={setDefaultProvider}
          geminiThinking={geminiThinking}
          onGeminiThinkingChange={setGeminiThinking}
          chatgptThink={chatgptThink}
          onChatgptThinkChange={setChatgptThink}
          currentLang={language}
          onLanguageChange={handleLanguageChange}
          currentTheme={theme}
          onThemeChange={setTheme}
          isDeepThink={isDeepThink}
          onDeepThinkChange={setDeepThink}
          autoApplyPatch={autoApplyPatch}
          onToggleAutoPatch={() => setAutoApplyPatch(!autoApplyPatch)}
          requireCommandApproval={requireCommandApproval}
          onToggleCommandApproval={() => setRequireCommandApproval(!requireCommandApproval)}
          onClose={() => setIsSettingsOpen(false)}
           onRunDiagnostic={() => sendAction('diagnose')}
           diagnosticResult={diagnosticResult}
         />
      ) : (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' }}>
          {drawerOpen && <button className="drawer-backdrop" aria-label="Close drawer" onClick={closeDrawer} />}
          {isSidebarOpen && (
            <LeftSidebar
              activeWorkspace={activeWorkspace}
              selectedProvider={selectedProvider}
              sessions={sessions}
              currentSessionId={currentSessionId}

              recentWorkspaces={recentWorkspaces}
              onNewChat={() => {
                newChat();
                if (compactLayout) closeDrawer();
              }}
              onOpenFolder={handleOpenFolder}
              onBrowseInApp={handleBrowseInApp}
              onOpenWorkspace={(p) => openWorkspace(p)}
              onStartScratch={() => sendAction('start_scratch')}
              onOpenFilters={() => setIsSettingsOpen(true)}
              onLoadSession={(id) => {
                loadSession(id);
                if (compactLayout) closeDrawer();
              }}
              onDeleteSession={(id) => sendAction('delete_session', { sessionId: id })}
              onDiagnose={() => setIsSettingsOpen(true)}
              onToggleSidebar={toggleSidebar}
            />
          )}

          <main inert={drawerOpen || undefined} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', overflow: 'hidden', position: 'relative' }}>
            {!compactLayout && !isSidebarOpen && <button onClick={newChat} disabled={isRunning}>New Chat</button>}
            {isAndroid && (
              <section className="mobile-provider-status" aria-label="Provider connection">
                <p role="status">{accessDetail || ({
                  ready: 'DeepSeek connected',
                  checking: 'Checking DeepSeek connection…',
                  sign_in: 'Sign in with your DeepSeek email to chat.',
                  missing: 'DeepSeek could not open this conversation. Your local history is available below.'
                } as Record<string, string>)[accessStatus]}</p>
                {accessStatus === 'missing' && <button className="prompt-chip" onClick={newChat}>New chat</button>}
                {accessStatus === 'temporary' && <button className="prompt-chip" onClick={reconnect}>Retry</button>}
                <button className="prompt-chip" disabled={isRunning} onClick={() => sendAction('show_provider_browser')}>
                  {accessStatus === 'sign_in' ? 'Sign in to DeepSeek' : 'Open DeepSeek'}
                </button>
              </section>
            )}
            {isAndroid && <AndroidWorkspace
              path={activeWorkspace}
              runPath={androidRunWorkspace}
              paths={recentWorkspaces}
              tools={androidTools}
              status={androidWorkspaceStatus}
              expanded={workspaceControlsOpen}
              onToggle={() => setWorkspaceControlsOpen(open => !open)}
              onSelect={openWorkspace}
              onCreate={name => sendAction('create_workspace', { name })}
              onImport={() => sendAction('import_workspace')}
              onViewFiles={() => openRightTab('files')}
              onBrowseFiles={() => sendAction('browse_workspaces')}
              onTerminal={() => openRightTab('terminal')}
            />}
            {!isAndroid && sendBlocked && <section role="status" style={{ padding: '10px 16px', background: 'var(--bg-card)' }}>
              <span>{accessMessage}</span>
              {accessStatus !== 'checking' && <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button onClick={newChat}>Start a New Chat</button>
                <button onClick={() => sendAction('switch_provider_account', { provider: selectedProvider })}>{accessStatus === 'sign_in' ? 'Sign In' : 'Switch Account'}</button>
                <button onClick={reconnect}>{accessStatus === 'disconnected' ? 'Reconnect' : 'Check Again'}</button>
              </div>}
            </section>}
            {!currentSessionId && messages.length === 0 && !isRunning && !streamingState ? (
              <EmptyState
                key={selectedProvider + composerSequence}
                sendBlocked={sendBlocked}
                repoName={repoName}
                activeWorkspace={activeWorkspace}
                recentWorkspaces={recentWorkspaces}
                onOpenWorkspace={(p) => openWorkspace(p)}
                onStartScratch={() => sendAction('start_scratch')}
                isDeepThink={isDeepThink}
                autoApplyPatch={autoApplyPatch}
                onToggleDeepThink={() => setDeepThink(!isDeepThink)}
                onToggleAutoPatch={() => setAutoApplyPatch(!autoApplyPatch)}
                onOpenFolder={handleOpenFolder}
                onBrowseInApp={handleBrowseInApp}
                onSubmit={(text, attachments, skillId) => sendPrompt(text, autoApplyPatch, [], ignoredPatterns, attachments, skillId, !requireCommandApproval)}
                onOpenIDE={() => sendAction('open_workspace_explorer')}
                activeRightTab={rightPanelTab}
                onTogglePanel={toggleRightPanel}
                isSidebarOpen={isSidebarOpen}
                onToggleSidebar={toggleSidebar}
                selectedProvider={selectedProvider}
                onSelectProvider={setSelectedProvider}
                geminiThinking={geminiThinking}
                onCycleThinking={cycleGeminiThinking}
                chatgptThink={chatgptThink}
                onToggleChatgptThink={() => setChatgptThink(!chatgptThink)}
                providers={providersStatus}
                onShowProvider={(p) => sendAction('show_provider_browser', { provider: p })}
                onHideProvider={(p) => sendAction('hide_provider_browser', { provider: p })}
                onDisconnectProvider={async (p) => {
                  const ok = await confirmDialog({
                    title: p === 'gemini' ? 'Disconnect Gemini' : p === 'chatgpt' ? 'Disconnect ChatGPT' : 'Disconnect DeepSeek',
                    message: p === 'gemini'
                      ? 'Disconnect Gemini? The saved Google profile is kept for fast reconnect.'
                      : p === 'chatgpt'
                        ? 'Disconnect ChatGPT? The saved OpenAI profile is kept for fast reconnect.'
                        : 'Disconnect from DeepSeek? Your saved login profile will be kept, so the app reconnects automatically next time.',
                    confirmLabel: 'Disconnect',
                    cancelLabel: 'Cancel',
                    danger: true
                  });
                  if (ok) sendAction(p === 'gemini' ? 'logout_gemini' : p === 'chatgpt' ? 'logout_chatgpt' : 'logout');
                }}
                providerLocked={isRunning}
              />
            ) : (
              <MessageList
                  sessionTitle={stripSkillPrefix(messages[0]?.text || '').slice(0, 30) || 'Project overview insights'}
                  repoName={repoName}
                  messages={messages}
                  streamingState={streamingState}
                  agentStatus={agentStatus}
                  isSidebarOpen={isSidebarOpen}
                  onToggleSidebar={toggleSidebar}
                  onOpenRightTab={(tab) => { if (tab) openRightTab(tab); else setRightPanelTab(null); }}
                  activeRightTab={rightPanelTab}
                  openTabs={openTabs}
                  onCloseTab={closeRightTab}
                  onReRunPrompt={(text, skillId) => sendPrompt(text, autoApplyPatch, [], ignoredPatterns, [], skillId || null, !requireCommandApproval)}
                   onOpenIDE={() => sendAction('open_workspace_explorer')}
                   lang={language}
                   hasMoreMessages={hasMoreMessages}
                   isLoadingOlder={isLoadingOlder}
                   onLoadOlder={loadOlderMessages}
                   editDetails={editDetails}
                   onRequestEditsIds={requestEditsIds}
isRunning={isRunning}
                    animateId={animateId}
                    networkRetry={networkRetry}
                    sessionId={currentSessionId}
                    inputBar={
                      <ChatInputBar
                        key={currentSessionId || selectedProvider}
                        sendBlocked={sendBlocked}
                        onSelectProvider={setSelectedProvider}
                        isRunning={isRunning}
                        isDeepThink={isDeepThink}
                        provider={selectedProvider}
                        providerControl={isAndroid ? <ConnectionDock
                          providers={providersStatus}
                          selectedProvider={selectedProvider}
                          onSelectProvider={setSelectedProvider}
                          onShowBrowser={p => sendAction('show_provider_browser', { provider: p })}
                          locked={isRunning}
                        /> : undefined}
                        geminiThinking={geminiThinking}
                        onCycleThinking={cycleGeminiThinking}
                        chatgptThink={chatgptThink}
                        onToggleChatgptThink={() => setChatgptThink(!chatgptThink)}
                        onToggleDeepThink={() => setDeepThink(!isDeepThink)}
                        onSend={(text, attachments) => sendPrompt(text, autoApplyPatch, [], ignoredPatterns, attachments, null, !requireCommandApproval)}
                        onStop={() => sendAction('stop_task', { runId })}
                        onOpenFolder={handleOpenFolder}
                        onShowBrowser={() => sendAction('show_provider_browser', { provider: selectedProvider })}
                        onHideBrowser={() => sendAction('hide_provider_browser', { provider: selectedProvider })}
                      />
                    }
                 />
            )}
          </main>

          <InspectorDrawer
            tab={rightPanelTab}
            inspection={{
              sessionId: currentSessionId, provider: selectedProvider, activeRunId: runId, workspace: activeWorkspace,
              revision: inspectionRevision, connected: engineConnected, capabilities: inspectorCapabilities,
              request: requestInspector, localActivity
            }}
            openTabs={openTabs}
            onSelectTab={(k) => setRightPanelTab(k)}
            onCloseTab={closeRightTab}
            onAddTab={openRightTab}
            pendingPatches={pendingPatches}
            pendingCommand={pendingCommand}
            editDetails={editDetails}
            onRequestEditsIds={requestEditsIds}
            messages={messages}
            revertedIds={revertedEditIds}
            onRevertEdits={isAndroid ? undefined : ids => sendAction('revert_edits', { editIds: ids })}
            androidRunWorkspace={androidRunWorkspace}
            androidCommandHelp={androidTools?.find(tool => tool.action === 'execute_command')?.description}
            onStopRun={() => sendAction('stop_task', { runId })}
            terminalLogs={terminalLogs}
            patchHistory={patchHistory}
            fileTree={fileTree}
            selectedFileName={selectedFileName}
            selectedFileContent={selectedFileContent}
            agentStatus={agentStatus}
            isRunning={isRunning}
            onClose={() => setRightPanelTab(null)}
            onApprovePatch={() => sendAction('approve_patch')}
            onRejectPatch={() => sendAction('reject_patch')}
            onApproveCommand={() => sendAction('approve_command')}
            onRejectCommand={() => sendAction('reject_command')}
            onOpenFile={(name) => sendAction('read_file', { filename: name })}
            onOpenBrowser={() => sendAction('open_browser')}
            lang={language}
            termLines={termLines}
            termCwd={termCwd}
            onTerminalInput={sendTerminalInput}
            terminalRunning={Boolean(commandId)}
            onTerminalInterrupt={sendTerminalInterrupt}
            onTerminalRestart={sendTerminalRestart}
          />
        </div>
      )}

      <FilterModal
        isOpen={isFilterModalOpen}
        ignoredPatterns={ignoredPatterns}
        onClose={() => setIsFilterModalOpen(false)}
        onUpdateFilters={(list) => {
          setIgnoredPatterns(list);
          localStorage.setItem('magnum_ignored_list', JSON.stringify(list));
          sendAction('update_ignored_list', { ignored: list, path: activeWorkspace });
        }}
      />
      <AppDialogHost />
      <ImageViewerHost />
      <FolderPickerModal
        open={folderPickerOpen}
        notice={folderPickerNotice}
        onClose={() => setFolderPickerOpen(false)}
        onPick={(p) => { setFolderPickerOpen(false); openWorkspace(p); }}
        browseDir={browseDir}
      />
    </div>
    </UpdateGate>
  );
}
