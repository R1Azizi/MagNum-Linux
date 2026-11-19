'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { exec, spawn } = require('node:child_process');
const { commandShell } = require('./platform');

let FS_BIN_CACHE = null;
function resolveFsBin() {
  if (FS_BIN_CACHE) return FS_BIN_CACHE;
  const name = process.platform === 'win32' ? 'magnum-fs.exe' : 'magnum-fs';
  const candidates = [
    process.env.MAGNUM_FS_BIN,
    path.join(__dirname, name),
    path.join(__dirname, '..', '..', 'magnum-fs', 'target', 'release', name)
  ].filter(Boolean);
  for (const c of candidates) {
    try { fsSync.accessSync(c); FS_BIN_CACHE = c; return c; } catch {}
  }
  return null;
}

function runRustFs(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const bin = resolveFsBin();
    if (!bin) return reject(new Error('magnum-fs binary not found. Run: npm run build:fs'));

    const child = spawn(bin, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      reject(new Error('magnum-fs timed out'));
    }, timeoutMs);

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.stdin.on('error', () => {});
    child.on('error', e => {
      if (done) return;
      done = true; clearTimeout(timer); reject(e);
    });
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(
          `magnum-fs bad output (exit ${code}): ${text.slice(0, 300)} ${Buffer.concat(err).toString('utf8').slice(0, 300)}`
        ));
      }
    });

    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

const MAX_LINES_PER_BATCH = 1000; // HARD universal cap — every delivery is ONE ≤1000-line window

class ProjectTools {
  constructor(workspaceDir, ignoredPatterns = []) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.excludedPaths = new Set();
    this.ignoredPatterns = new Set(ignoredPatterns);
    this.logger = null;
  }

  setIgnoredPatterns(patterns = []) {
    this.ignoredPatterns = new Set(patterns);
  }
  setLogger(fn) {
    this.logger = typeof fn === 'function' ? fn : null;
  }
  log(line, kind = 'sys') {
    if (this.logger) {
      try { this.logger(line, kind); } catch {}
    }
  }

  setExcludedPaths(paths = []) {
    this.excludedPaths = new Set(paths.map(p => p.replace(/\\/g, '/')));
  }

  isExcluded(relPath) {
    const norm = relPath.replace(/\\/g, '/');
    const segments = norm.split('/');

    for (const segment of segments) {
      if (this.ignoredPatterns.has(segment)) return true;
    }
    if (this.ignoredPatterns.has(norm)) return true;

    for (const ex of this.excludedPaths) {
      if (norm === ex || norm.startsWith(ex + '/')) return true;
    }
    return false;
  }

  
  async readMultipleFiles(filePaths = []) {
    const results = {};
    for (const relPath of filePaths) {
      try {
        const fullPath = path.resolve(this.workspaceDir, relPath);
        const content = await fs.readFile(fullPath, 'utf-8');
        results[relPath] = content;
      } catch (err) {
        results[relPath] = `[ERROR: ${err.message}]`;
      }
    }
    return results;
  }

  
  async readFileDetails(relPath, range = null) {
    try {
      const fullPath = path.resolve(this.workspaceDir, relPath);
      const rawContent = await fs.readFile(fullPath, 'utf-8');
      const normalized = rawContent.replace(/\r\n/g, '\n');
      const allLines = normalized.split('\n');
      const totalLines = allLines.length;

      let start = 1;
      let end = totalLines;

      if (range) {
        if (typeof range.start_line === 'number' && range.start_line >= 1) {
          start = Math.max(1, Math.min(totalLines, range.start_line));
        }
        if (typeof range.end_line === 'number' && range.end_line >= start) {
          end = Math.min(totalLines, range.end_line);
        }
      }

      const selectedLines = [];
      for (let i = start; i <= end; i++) {
        selectedLines.push({
          lineNum: i,
          text: allLines[i - 1]
        });
      }

      return {
        path: relPath.replace(/\\/g, '/'),
        exists: true,
        totalLines,
        startLine: start,
        endLine: end,
        lines: selectedLines,
        error: null
      };
    } catch (err) {
      return {
        path: relPath.replace(/\\/g, '/'),
        exists: false,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        lines: [],
        error: err.message
      };
    }
  }

  
  async prepareFileChunks(filePaths = [], ranges = {}, maxLinesPerBatch = MAX_LINES_PER_BATCH, onProgress = null) {
    // Universal hard cap: ONE contiguous window of at most 1000 lines total, never more.
    const cap = Math.min(Math.max(1, Number(maxLinesPerBatch) || MAX_LINES_PER_BATCH), MAX_LINES_PER_BATCH);

    const fileDetailsList = [];
    for (const filePath of filePaths) {
      const range = ranges[filePath] || null;
      if (typeof onProgress === 'function') onProgress(filePath, range);
      fileDetailsList.push(await this.readFileDetails(filePath, range));
    }

    let totalRequestedLines = 0;
    for (const f of fileDetailsList) totalRequestedLines += f.error ? 1 : f.lines.length;

    const segments = [];
    const remaining = []; // resume plan for the NEXT window — no gaps, no overlaps
    let used = 0;

    for (const fd of fileDetailsList) {
      if (fd.error) {
        if (used >= cap) { remaining.push({ path: fd.path, startLine: 0, endLine: 0, error: fd.error }); continue; }
        segments.push({ path: fd.path, error: fd.error, totalFileLines: 0, startLine: 0, endLine: 0, isComplete: false, isStartOfFile: false, isEndOfFile: false, lines: [] });
        used += 1;
        continue;
      }
      if (used >= cap) {
        remaining.push({ path: fd.path, startLine: fd.startLine, endLine: fd.endLine, totalLines: fd.totalLines });
        continue;
      }
      const take = Math.min(fd.lines.length, cap - used);
      const segLines = fd.lines.slice(0, take);
      if (take > 0) {
        const startLine = segLines[0].lineNum;
        const endLine = segLines[segLines.length - 1].lineNum;
        segments.push({
          path: fd.path, error: null, totalFileLines: fd.totalLines,
          startLine, endLine,
          isStartOfFile: startLine === fd.startLine,
          isEndOfFile: endLine === fd.endLine,
          isComplete: startLine === fd.startLine && endLine === fd.endLine && take === fd.totalLines,
          lines: segLines
        });
        used += take;
      }
      if (take < fd.lines.length) {
        remaining.push({ path: fd.path, startLine: fd.lines[take].lineNum, endLine: fd.endLine, totalLines: fd.totalLines });
      }
    }

    const hasMore = remaining.length > 0;
    const formattedMessage = this.formatFileChunkMessage({ segments, chunkLinesCount: used, totalRequestedLines, remaining, hasMore });

    return [{
      batchIndex: 1,
      totalBatches: 1,
      chunkLinesCount: used,
      totalRequestedLines,
      hasMore,
      pendingCount: remaining.reduce((acc, r) => acc + (r.error ? 1 : Math.max(0, r.endLine - r.startLine + 1)), 0),
      remaining,
      segments: segments.map(s => ({ path: s.path, error: s.error, startLine: s.startLine, endLine: s.endLine, totalFileLines: s.totalFileLines, isComplete: s.isComplete })),
      formattedMessage
    }];
  }

  
  formatFileChunkMessage({ segments, chunkLinesCount, totalRequestedLines, remaining, hasMore }) {
    let msg = '';
    msg += `=== TOOL RESULT: FILE WINDOW (${chunkLinesCount}/${MAX_LINES_PER_BATCH} lines — HARD UNIVERSAL LIMIT) ===\n`;
    msg += `Every reading delivery is ONE contiguous window of at most ${MAX_LINES_PER_BATCH} lines total, across the requested files in order. Nothing is skipped.\n`;
    msg += `================================================================================\n`;
    for (const seg of segments) {
      if (seg.error) {
        msg += `📄 FILE: ${seg.path}\n❌ ERROR: ${seg.error}\n`;
        continue;
      }
      const continues = remaining.some(r => r.path === seg.path && !r.error && r.startLine === seg.endLine + 1);
      const statusTag = seg.isComplete
        ? `[COMPLETE — lines ${seg.startLine} to ${seg.endLine} of ${seg.totalFileLines}]`
        : continues
          ? `[WINDOW — lines ${seg.startLine} to ${seg.endLine} of ${seg.totalFileLines} | continues at line ${seg.endLine + 1}]`
          : seg.endLine >= seg.totalFileLines
            ? `[END OF FILE — lines ${seg.startLine} to ${seg.endLine} of ${seg.totalFileLines}]`
            : `[WINDOW — lines ${seg.startLine} to ${seg.endLine} of ${seg.totalFileLines} | requested range complete]`;
      msg += `📄 FILE: ${seg.path} ${statusTag}\n`;
      msg += `--------------------------------------------------------------------------------\n`;
      for (const line of seg.lines) msg += `${line.lineNum} | ${line.text}\n`;
      msg += `--------------------------------------------------------------------------------\n`;
    }
    msg += `================================================================================\n`;
    if (hasMore) {
      msg += `⏳ NOT FINISHED — remaining content (the next window continues EXACTLY here, no gaps/overlaps):\n`;
      for (const r of remaining) {
        if (r.error) msg += `  • ${r.path}: unreadable (${r.error})\n`;
        else msg += `  • ${r.path}: lines ${r.startLine} to ${r.endLine} (${r.endLine - r.startLine + 1} lines remaining of ${r.totalLines})\n`;
      }
      msg += `\nHOW TO CONTINUE:\n`;
      msg += `- If this window is enough for your task, proceed now ("patch_file" / "search_code" / "finish").\n`;
      msg += `- If you need the NEXT ${MAX_LINES_PER_BATCH} lines, reply ONLY with:\n`;
      msg += '\`\`\`json\n{ "thought": "Need the next window", "action": "continue_reading" }\n\`\`\`\n';
      msg += `- Do NOT re-request lines already delivered above. A file is fully read ONLY if its header says COMPLETE.\n`;
    } else {
      msg += `✅ ALL requested content delivered COMPLETELY inside this window (${chunkLinesCount} lines). Proceed with your next action.\n`;
    }
    msg += `================================================================================`;
    return msg;
  }

  
  async patchFileJs(filePath, searchCode, replaceCode) {
    try {
      const fullPath = path.resolve(this.workspaceDir, filePath);
      let content = await fs.readFile(fullPath, 'utf-8');
      const isCRLF = content.includes('\r\n');
      const normalizedContent = content.replace(/\r\n/g, '\n');

      let cleanSearch = searchCode.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
      let cleanReplace = replaceCode.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');

      
      const normalizeSpaces = (s) => s.replace(/\u00A0/g, ' ').replace(/[ \t]+/g, ' ').trim();

      
      if (normalizedContent.includes(cleanSearch)) {
        const updated = normalizedContent.replace(cleanSearch, cleanReplace);
        await fs.writeFile(fullPath, isCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf-8');
        return { success: true, message: `Successfully updated ${filePath}` };
      }

      
      const stripNumbers = (code) => code.split('\n').map((l) => l.replace(/^\s*\d+[\s:|]+\s?/, '')).join('\n');
      const noNumSearch = stripNumbers(cleanSearch);
      const noNumReplace = stripNumbers(cleanReplace);
      if (normalizedContent.includes(noNumSearch)) {
        const updated = normalizedContent.replace(noNumSearch, noNumReplace);
        await fs.writeFile(fullPath, isCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf-8');
        return { success: true, message: `Successfully updated ${filePath}` };
      }

      
      const searchLines = cleanSearch.split('\n');
      const contentLines = normalizedContent.split('\n');

      let matchIndex = -1;
      for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
          const cLine = normalizeSpaces(contentLines[i + j]);
          const sLine = normalizeSpaces(searchLines[j]);

          
          if (cLine !== sLine && cLine.replace(/\\\\/g, '\\') !== sLine.replace(/\\\\/g, '\\')) {
            match = false;
            break;
          }
        }
        if (match) {
          matchIndex = i;
          break;
        }
      }

      if (matchIndex !== -1) {
        
        const fileBaseIndent = contentLines[matchIndex].match(/^\s*/)[0];
        const searchBaseIndent = searchLines[0].match(/^\s*/)[0];

        const adjustedReplaceLines = cleanReplace.split('\n').map((line) => {
          if (!line.trim()) return '';
          if (line.startsWith(searchBaseIndent)) {
            return fileBaseIndent + line.slice(searchBaseIndent.length);
          }
          return fileBaseIndent + line.replace(/^\s*/, '');
        });

        contentLines.splice(matchIndex, searchLines.length, ...adjustedReplaceLines);
        const updated = contentLines.join('\n');
        await fs.writeFile(fullPath, isCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf-8');
        return { success: true, message: `Successfully updated ${filePath}` };
      }

      
      if (searchLines.length === 1 && searchLines[0].includes('=')) {
        const varPrefix = searchLines[0].split('=')[0].trim();
        const foundIdx = contentLines.findIndex(l => normalizeSpaces(l).startsWith(varPrefix + ' =') || normalizeSpaces(l).startsWith(varPrefix + '='));
        if (foundIdx !== -1) {
          const fileBaseIndent = contentLines[foundIdx].match(/^\s*/)[0];
          contentLines[foundIdx] = fileBaseIndent + cleanReplace.trim();
          const updated = contentLines.join('\n');
          await fs.writeFile(fullPath, isCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf-8');
          return { success: true, message: `Successfully updated ${filePath} (matched by variable anchor)` };
        }
      }

      return {
        success: false,
        error: `Search block was not found in ${filePath}. Check indentation, backslashes, or surrounding code.`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }


  async patchBatchJs(patches = []) {
    const results = [];
    const seen = new Set();
    const uniquePatches = [];
    for (const p of patches) {
      const k = p.file + '||' + p.search + '||' + p.replace;
      if (seen.has(k)) continue;
      seen.add(k);
      uniquePatches.push(p);
    }

    const fileGroups = {};
    for (const p of uniquePatches) {
      if (!fileGroups[p.file]) fileGroups[p.file] = [];
      fileGroups[p.file].push(p);
    }

    const appliedAnchors = new Map();

    for (const [file, patchList] of Object.entries(fileGroups)) {
      for (const p of patchList) {
        const anchors = appliedAnchors.get(file);
        if (anchors && anchors.has(p.search) && (p.replace || '').includes(p.search)) {
          try {
            const fullPath = path.resolve(this.workspaceDir, file);
            const content = await fs.readFile(fullPath, 'utf-8');
            if (content.includes(p.search)) {
              results.push({ file, success: true, message: 'Skipped duplicate patch (anchor still present)' });
              this.log('skipped duplicate ' + file, 'out');
              continue;
            }
          } catch (e) {  }
        }

        const res = await this.patchFileJs(file, p.search, p.replace);
        results.push({ file, success: res.success, message: res.message || res.error });
        this.log(res.success ? 'patched ' + file : 'patch failed ' + file + ': ' + (res.message || res.error), res.success ? 'out' : 'err');

        if (res.success && (p.replace || '').includes(p.search)) {
          if (!appliedAnchors.has(file)) appliedAnchors.set(file, new Set());
          appliedAnchors.get(file).add(p.search);
        }
      }
    }

    const allSuccess = results.every(r => r.success);
    return {
      success: allSuccess,
      total: results.length,
      successful: results.filter(r => r.success).length,
      details: results
    };
  }
  async createFileJs(filePath, content) {
    try {
      const fullPath = path.resolve(this.workspaceDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      this.log(`+ created ${filePath}`, 'out');
      return { success: true, message: `Created new file ${filePath}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  _replayLogs(logs) {
    if (Array.isArray(logs)) for (const l of logs) this.log(l.line, l.kind || 'sys');
  }

  _useJsFallback() {
    return process.env.MAGNUM_FS_FALLBACK === '1' && !resolveFsBin();
  }

  async patchFile(filePath, searchCode, replaceCode) {
    if (this._useJsFallback()) return this.patchFileJs(filePath, searchCode, replaceCode);
    try {
      const res = await runRustFs({
        op: 'patch_file',
        workspace: this.workspaceDir,
        file: filePath,
        search: searchCode ?? '',
        replace: replaceCode ?? ''
      });
      this._replayLogs(res.logs);
      return res.success
        ? { success: true, message: res.message }
        : { success: false, error: res.error || res.message };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async patchBatch(patches = []) {
    if (this._useJsFallback()) return this.patchBatchJs(patches);
    try {
      const res = await runRustFs({
        op: 'patch_batch',
        workspace: this.workspaceDir,
        patches: patches.map(p => ({
          file: p.file,
          search: p.search ?? '',
          replace: p.replace ?? ''
        }))
      });
      this._replayLogs(res.logs);
      return {
        success: Boolean(res.success),
        total: res.total ?? 0,
        successful: res.successful ?? 0,
        details: res.details || []
      };
    } catch (err) {
      return {
        success: false,
        total: patches.length,
        successful: 0,
        details: patches.map(p => ({ file: p.file, success: false, message: err.message }))
      };
    }
  }

  async createFile(filePath, content) {
    if (this._useJsFallback()) return this.createFileJs(filePath, content);
    try {
      const res = await runRustFs({
        op: 'create_file',
        workspace: this.workspaceDir,
        file: filePath,
        content: content ?? ''
      });
      this._replayLogs(res.logs);
      return res.success
        ? { success: true, message: res.message }
        : { success: false, error: res.error || res.message };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async executeCommand(command) {
    return new Promise((resolve) => {
      exec(command, { cwd: this.workspaceDir, timeout: 300000, maxBuffer: 10 * 1024 * 1024, shell: commandShell }, (error, stdout, stderr) => {
        let output = stdout || '';
        if (stderr) output += `\n[STDERR]:\n${stderr}`;
        if (error) output += `\n[ERROR]:\n${error.message}`;

        if (output.length > 5000) {
          output = output.slice(0, 5000) + '\n...[Output truncated]';
        }
          this.log(`$ ${command}`, 'cmd');
          if (stdout) this.log(stdout.trim(), 'out');
          if (stderr) this.log(stderr.trim(), 'err');
          if (error) this.log(`[exit error] ${error.message}`, 'err');
          resolve({
          success: !error,
          output: output.trim() || 'Command executed with no console output.'
        });
      });
    });
  }

  
  async listDirectory(targetPath, depth = 3, maxPerDir = 50) {
    let base;
    const cleanTarget = (targetPath || '').trim();
    
    // اگر خالی بود یا نقطه بود، حتماً از دایرکتوری ورک‌اسپیس استفاده کن
    if (!cleanTarget || cleanTarget === '.' || cleanTarget === './' || cleanTarget === '.\\') {
      base = this.workspaceDir;
    } else if (path.isAbsolute(cleanTarget)) {
      base = path.resolve(cleanTarget);
    } else {
      // مسیر نسبی باید همیشه داخل ورک‌اسپیس حل شود
      base = path.resolve(this.workspaceDir, cleanTarget);
    }
    const safeDepth = Math.min(Math.max(Number(depth) || 3, 1), 4);
    const build = async (dir, d) => {
      if (d > safeDepth) return '';
      let res = '';
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const showing = entries.slice(0, maxPerDir);
        for (const e of showing) {
          const indent = '  '.repeat(d);
          if (e.isDirectory()) {
            res += `${indent}📁 ${e.name}/
`;
            res += await build(path.join(dir, e.name), d + 1);
          } else {
            res += `${indent}📄 ${e.name}
`;
          }
        }
        if (entries.length > showing.length) {
          res += `${'  '.repeat(d)}↳ ... (${entries.length - showing.length} more items omitted)
`;
        }
      } catch (e) {
        res += `[ERROR: ${e.message}]
`;
      }
      return res;
    };
    const tree = await build(base, 0);
    return { path: base, tree: tree || 'Directory is empty.' };
  }
  
  async searchCode(query, maxResults = 25, rootDir = null) {
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Query parameter is required' };
    }

    const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.pdf', '.zip', '.tar', '.gz', '.lock', '.map', '.exe', '.dll', '.bin'];

    const matches = [];
    const searchRoot = rootDir 
      ? (path.isAbsolute(rootDir) ? path.resolve(rootDir) : path.resolve(this.workspaceDir, rootDir))
      : this.workspaceDir;
    const searchDir = async (dir) => {
      if (matches.length >= maxResults) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= maxResults) break;

          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(this.workspaceDir, fullPath).replace(/\\/g, '/');
          
          if (this.isExcluded(relPath) || this.isExcluded(entry.name)) continue;

          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTS.includes(ext)) continue;

            try {
              const stat = await fs.stat(fullPath);
              if (stat.size > 1024 * 1024) continue; 

              const content = await fs.readFile(fullPath, 'utf-8');
              if (content.includes(query)) {
                const lines = content.replace(/\r\n/g, '\n').split('\n');
                const relPath = path.relative(this.workspaceDir, fullPath).replace(/\\/g, '/');

                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].includes(query)) {
                    const hit = i + 1;
                    matches.push({
                      file: relPath,
                      line: hit,
                      totalLines: lines.length,
                      window: {
                        start_line: Math.max(1, hit - 30),
                        end_line: Math.min(lines.length, hit + 120)
                      },
                      snippet: lines[i].trim().slice(0, 160)
                    });
                    if (matches.length >= maxResults) break;
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}
    };

    await searchDir(searchRoot);

    return {
      query,
      root: searchRoot,
      totalMatches: matches.length,
      hasMore: matches.length >= maxResults,
      matches
    };
  }

  
  async getProjectTree(depth = 4, maxPerDir = 20) {
    const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.pdf', '.zip', '.tar', '.map', '.lock'];

    const build = async (currentDir, currentDepth) => {
      if (currentDepth > depth) return '';
      let res = '';
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        const filtered = entries.filter(e => {
          const rel = path.relative(this.workspaceDir, path.join(currentDir, e.name)).replace(/\\/g, '/');
          if (this.isExcluded(rel) || this.isExcluded(e.name)) return false;

          if (!e.isDirectory() && BINARY_EXTS.includes(path.extname(e.name).toLowerCase())) return false;
          return true;
        });

        const showing = filtered.slice(0, maxPerDir);
        const omittedCount = filtered.length - showing.length;

        for (const entry of showing) {
          const fullPath = path.join(currentDir, entry.name);
          const indent = '  '.repeat(currentDepth);

          if (entry.isDirectory()) {
            res += `${indent}📁 ${entry.name}/\n`;
            res += await build(fullPath, currentDepth + 1);
          } else {
            res += `${indent}📄 ${entry.name}\n`;
          }
        }

        if (omittedCount > 0) {
          const indent = '  '.repeat(currentDepth);
          res += `${indent}↳ ... (${omittedCount} more files omitted)\n`;
        }
      } catch (e) {}
      return res;
    };

    return (await build(this.workspaceDir, 0)) || 'Directory is empty.';
  }
}

module.exports = ProjectTools;
