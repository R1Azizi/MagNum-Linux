'use strict';

/**
 * Shared MCP tool definitions + dispatcher.
 * Used by both mcp-server.js (stdio) and server.js (/mcp HTTP endpoint).
 */

const path = require('node:path');

const DEFAULT_IGNORED = [
  'node_modules', '.git', 'dist', 'build', '.next',
  'magnum-profile', 'target', '.kilo', '.clinerules'
];

const TOOL_DEFS = [
  { name: 'read_files', description: 'Read one or more files from the workspace (max 1000 lines total).', inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } },
  { name: 'read_file_range', description: 'Read a specific line range from one file.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['file', 'start_line', 'end_line'] } },
  { name: 'patch_file', description: 'Apply a search/replace patch to a file.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['file', 'search', 'replace'] } },
  { name: 'patch_batch', description: 'Apply multiple search/replace patches.', inputSchema: { type: 'object', properties: { patches: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['file', 'search', 'replace'] } } }, required: ['patches'] } },
  { name: 'create_file', description: 'Create or overwrite a file.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] } },
  { name: 'execute_command', description: 'Run a shell command inside the workspace.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'list_dir', description: 'List directory contents.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } }, required: ['path'] } },
  { name: 'search_code', description: 'Fast text search across workspace files.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] } },
  { name: 'get_project_tree', description: 'Return a textual tree of the workspace.', inputSchema: { type: 'object', properties: { depth: { type: 'number' } } } }
];

function createTools(workspace) {
  const ProjectTools = require('./tools');
  const tools = new ProjectTools(path.resolve(workspace), DEFAULT_IGNORED);
  tools.setLogger((line, kind) => {
    if (kind === 'err') process.stderr.write(`[magnum-mcp] ${line}\n`);
  });
  return tools;
}

async function callTool(tools, name, args = {}) {
  switch (name) {
    case 'read_files': {
      const files = Array.isArray(args.files) ? args.files.slice(0, 5) : [];
      const chunks = await tools.prepareFileChunks(files, {});
      return { content: [{ type: 'text', text: chunks[0].formattedMessage }] };
    }
    case 'read_file_range': {
      const r = await tools.readFileDetails(args.file, {
        start_line: Number(args.start_line) || 1,
        end_line: Number(args.end_line) || 500
      });
      const text = r.exists
        ? r.lines.map(l => `${l.lineNum} | ${l.text}`).join('\n')
        : `[ERROR: ${r.error}]`;
      return { content: [{ type: 'text', text }] };
    }
    case 'patch_file': {
      const res = await tools.patchFile(args.file, args.search, args.replace);
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    }
    case 'patch_batch': {
      const res = await tools.patchBatch(args.patches || []);
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    }
    case 'create_file': {
      const res = await tools.createFile(args.file, args.content ?? '');
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    }
    case 'execute_command': {
      const res = await tools.executeCommand(String(args.command || ''));
      return { content: [{ type: 'text', text: res.output }] };
    }
    case 'list_dir': {
      const res = await tools.listDirectory(args.path || '.', Number(args.depth) || 3);
      return { content: [{ type: 'text', text: `${res.path}\n${res.tree}` }] };
    }
    case 'search_code': {
      const res = await tools.searchCode(args.query, Number(args.maxResults) || 25);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'get_project_tree': {
      const text = await tools.getProjectTree(Number(args.depth) || 4, 20);
      return { content: [{ type: 'text', text }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOL_DEFS, DEFAULT_IGNORED, createTools, callTool };
