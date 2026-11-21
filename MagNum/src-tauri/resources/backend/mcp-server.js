'use strict';

/**
 * MagNum MCP Server (stdio)
 * ---------------------------------------------------------
 * Exposes MagNum's ProjectTools as standard MCP tools so that
 * editors/agents such as Zed, Cursor, Cline, Continue.dev and
 * Claude Desktop can use MagNum as their file/exec engine.
 *
 * Usage:
 *   node mcp-server.js --workspace /path/to/project
 *   MAGNUM_WORKSPACE=/path/to/project node mcp-server.js
 *
 * The server speaks JSON-RPC over stdin/stdout per the MCP spec
 * (https://modelcontextprotocol.io). No external deps required —
 * the tiny protocol layer is implemented inline so it keeps
 * working even inside MagNum's bundled Node runtime.
 */

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

const { TOOL_DEFS, DEFAULT_IGNORED, createTools, callTool } = require('./mcp-tools');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'magnum';
const SERVER_VERSION = '1.0.0';

// ── parse args ──────────────────────────────────────────────────────
function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return null;
}

const workspaceArg =
  getArg('--workspace') ||
  getArg('-w') ||
  process.env.MAGNUM_WORKSPACE ||
  process.cwd();

const WORKSPACE = path.resolve(workspaceArg);
try {
  const st = fs.statSync(WORKSPACE);
  if (!st.isDirectory()) throw new Error('not a directory');
} catch (e) {
  process.stderr.write(`[magnum-mcp] Invalid workspace: ${WORKSPACE} (${e.message})\n`);
  process.exit(1);
}

const tools = createTools(WORKSPACE);

// ── tool schemas ────────────────────────────────────────────────────
// ── JSON-RPC loop ───────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
              workspace: WORKSPACE
            }
          }
        });
      case 'notifications/initialized':
        return; // no response for notifications
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const result = await callTool(tools, name, args || {});
        return send({ jsonrpc: '2.0', id, result });
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      default:
        return sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return sendError(id, -32603, err.message || String(err));
  }
}

// ── boot ────────────────────────────────────────────────────────────
process.stderr.write(`[magnum-mcp] Ready. Workspace: ${WORKSPACE}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch (e) { return sendError(null, -32700, 'Parse error'); }
  handle(msg);
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
