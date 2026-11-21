# MagNum MCP Integration (Phase 1 + 2)

MagNum acts as an MCP (Model Context Protocol) server. Two transports are supported:

- **stdio** (Phase 1) — for Zed, Cursor, Claude Desktop, Cline, Roo Code, Continue.dev
- **HTTP JSON-RPC** (Phase 2) — `POST http://127.0.0.1:<PORT>/mcp` for HTTP-only clients

## Files in this folder

| File | Target |
|---|---|
| zed.json | `~/.config/zed/settings.json` under `context_servers` |
| cursor.json | `~/.cursor/mcp.json` |
| claude-desktop.json | `claude_desktop_config.json` |
| vscode-cline.json | Cline / Roo Code settings |
| continue.json | `~/.continue/config.json` |

In every file, replace the two placeholders:

- `/ABSOLUTE/PATH/TO/MagNum` → absolute path to your MagNum checkout
- `/ABSOLUTE/PATH/TO/YOUR/PROJECT` → absolute path to the project you want MagNum to operate on

## Manual stdio run

    node MagNum/src-tauri/resources/backend/mcp-server.js --workspace /path/to/project

Speaks JSON-RPC over stdin/stdout. Safe to launch from any MCP client.

## HTTP / JSON-RPC

When MagNum is running, the backend exposes:

- `POST /mcp` — JSON-RPC over HTTP. Uses the *currently open* workspace inside MagNum.
- `GET  /mcp/info` — discovery: workspace path, tool list, tool count.

Example:

    curl -s http://127.0.0.1:5454/mcp \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

The actual port is written to `<DATA_DIR>/.backend-port` (usually `~/.magnum/.backend-port`).

## Tools

read_files, read_file_range, patch_file, patch_batch, create_file, execute_command, list_dir, search_code, get_project_tree.

## OpenAI-compatible API (Phase 3)

- `GET  /v1/models` — returns `magnum-agent`.
- `POST /v1/chat/completions` — standard OpenAI chat completions with **native tool calling**:

  - MagNum advertises all MCP tools as OpenAI `tools` (function schemas).
  - Any OpenAI SDK / Goddot / Continue can call `POST /v1/chat/completions` with `messages` and let the model emit `tool_calls`.
  - When the client sends back `role: "tool"` messages, MagNum executes the referenced `tool_calls` and returns the combined result.
  - Legacy text shortcut `TOOL_CALL:<name>\n<json>` is still accepted for simple clients.

Example (native tool calling):

    curl -s http://127.0.0.1:5454/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{
        "model": "magnum-agent",
        "messages": [{"role":"user","content":"list files in src"}],
        "tools": [{"type":"function","function":{"name":"list_dir","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}]
      }'
