# Desktop run ownership — handoff for Sessions 2 and 3

The server assigns a fresh UUID to every accepted prompt. Its account key is the JSON encoding of a pair, for example `["deepseek","magnum-profile"]`. The second element is the backend's persistent profile ID, or `null` for the provider-wide fallback. Future account selection should resolve a stable profile ID on the server. Desktop currently holds one global run slot because provider switching parks other browsers and the session and workspace are shared.

| Socket message | Contract |
| --- | --- |
| `send_prompt` | An optional client `requestId` correlates the optimistic message. The backend reserves synchronously, then broadcasts `run_started` with the request ID, `runId`, `provider`, `accountKey`, and current `sessionId`. A new chat can acquire its session ID during preparation. |
| `run_busy` | Only the requester receives the rejected request ID and the active run descriptor. The active run continues. `runtime_busy` identifies the run holding the shared browser during conflicting workspace or navigation actions. |
| `stop_task` and approval actions | Supply the selected `runId`. Connected desktop windows share the active run. Missing and stale IDs have no effect. An accepted Stop signals cancellation and keeps the slot until execution and provider cleanup settle. |
| `task_finished` or `task_stopped` | One final event carries the released run ID. Retry is valid on receipt. An `error` can arrive earlier. |
| `execution_state` | First server message on every desktop connection. Contains the current run or null, pending approvals, terminal command ID or null, and terminal cwd. A socket disconnect leaves work running. |
| Terminal | `terminal_echo` announces a fresh `commandId`. Use it for `terminal_interrupt` or active `terminal_restart`. Matching `terminal_prompt` ends that command. Terminal and agent cancellation are independent. |

Agent tools, MCP and the live terminal share the desktop shell supervisor. The command lifetime includes descendants. Linux uses a child subreaper and Windows uses a kill-on-close Job Object. MCP stdio uses JSON-RPC request IDs for cancellation. HTTP tool requests use the lifetime of their own response connection. The shared UI accepts legacy untagged Android events and displays the terminal Stop control when the backend supplies a command ID. Android retains its restricted executor.

From `MagNum/`, run `npm run build:fs` and `node tests/run-ownership.test.cjs`. The suite uses two WebSocket clients, a simulated browser provider, real shell processes, and an isolated temporary workspace. Linux was exercised. Windows and Android runtime verification remain pending.

## Chat navigation and browser ownership

The desktop UI sends `load_session` or `new_chat` with the selected provider and a per-window `navigationId`. A saved session supplies its own provider. The backend returns local messages in `session_loaded`, then reports `ready`, `missing`, `denied`, `sign_in`, `disconnected`, or `temporary` in `session_access`. The UI accepts navigation and pagination replies for its current selection. Desktop sends include the selected session ID, and the engine checks the remote conversation again under the run lease.

Session ownership uses the persistent provider profile and a digest of the provider account identity when available. Legacy rows can infer their provider from the remote URL. Rows without a conversation URL can continue from a fresh provider chat and retain their local messages. A failed access check leaves the saved reference and messages intact.

The desktop shell starts the Node engine. On Windows, Tauri reserves `MAGNUM_CDP_PORT` for its embedded WebView2 browser panel. On Linux the panel uses WebKitGTK and the embedded-browser bridge. Provider drivers use a separate Chrome, Edge, or Chromium profile for each provider. The desktop backend reads that profile’s `DevToolsActivePort`, connects on loopback using the browser ID, and selects the saved conversation tab when available. Switching away disconnects an attached CDP client or closes a context launched by this engine. If attachment fails, the engine attempts a managed launch. A locked profile can be released by closing the window using that specific profile and choosing Reconnect.

From `MagNum/`, run `npm run build` and `node --test tests/chat-navigation.test.cjs tests/run-ownership.test.cjs`. The navigation suite uses isolated Linux browser profiles, controlled provider pages, real WebSocket messages, and the built React UI.
