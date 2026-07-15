const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  '.grok',
  '.cache',
  'target',
  'coverage',
]);

function createTools(workspaceRoot) {
  const root = path.resolve(workspaceRoot);

  function resolveSafe(relPath) {
    const cleaned = String(relPath || '.').replace(/^[/\\]+/, '');
    const abs = path.resolve(root, cleaned);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace: ${relPath}`);
    }
    return abs;
  }

  function toRel(abs) {
    return path.relative(root, abs).split(path.sep).join('/');
  }

  function listTree(relPath = '.', depth = 2) {
    const abs = resolveSafe(relPath);
    if (!fs.existsSync(abs)) return [];

    function buildTree(dir, currentDepth) {
      if (currentDepth > depth) return [];
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      entries = entries.filter((e) => {
        if (e.name === '.' || e.name === '..') return false;
        if (IGNORE.has(e.name)) return false;
        if (e.name.startsWith('.') && !['.env.example', '.gitignore'].includes(e.name)) return false;
        return true;
      });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries.map((ent) => {
        const full = path.join(dir, ent.name);
        const node = {
          name: ent.name,
          path: toRel(full),
          type: ent.isDirectory() ? 'dir' : 'file',
        };
        if (ent.isDirectory() && currentDepth < depth) {
          node.children = buildTree(full, currentDepth + 1);
        }
        return node;
      });
    }

    return buildTree(abs, 1);
  }

  function exists(relPath) {
    try {
      return fs.existsSync(resolveSafe(relPath));
    } catch {
      return false;
    }
  }

  function statFile(relPath) {
    try {
      const abs = resolveSafe(relPath);
      if (!fs.existsSync(abs)) return { path: relPath, exists: false };
      const st = fs.statSync(abs);
      return {
        path: toRel(abs),
        exists: true,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch (e) {
      return { path: relPath, exists: false, error: e.message };
    }
  }

  function readFile(relPath, maxBytes = 200_000) {
    const abs = resolveSafe(relPath);
    if (!fs.existsSync(abs)) return { error: `File not found: ${relPath}` };
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { error: `Is a directory: ${relPath}` };
    if (stat.size > maxBytes) {
      const buf = fs.readFileSync(abs, { encoding: null }).subarray(0, maxBytes);
      return {
        path: toRel(abs),
        content: buf.toString('utf8') + `\n\n… truncated (${stat.size} bytes total)`,
        truncated: true,
      };
    }
    return {
      path: toRel(abs),
      content: fs.readFileSync(abs, 'utf8'),
      truncated: false,
    };
  }

  function writeFile(relPath, content) {
    const abs = resolveSafe(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    let before = '';
    if (existed) {
      try {
        before = fs.readFileSync(abs, 'utf8');
      } catch {
        before = '';
      }
    }
    fs.writeFileSync(abs, content, 'utf8');
    return {
      path: toRel(abs),
      created: !existed,
      bytes: Buffer.byteLength(content, 'utf8'),
      before,
      after: content,
    };
  }

  /**
   * 删除工作区内文件
   * @param {string} relPath
   * @param {{ trash?: boolean }} opts  trash=true 时尽量进回收站（Windows）
   */
  function deleteFile(relPath, opts = {}) {
    const abs = resolveSafe(relPath);
    if (!fs.existsSync(abs)) {
      return { path: toRel(abs), deleted: false, reason: 'not_found' };
    }
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      throw new Error(`拒绝删除目录: ${relPath}`);
    }
    if (opts.trash !== false && process.platform === 'win32') {
      try {
        // Send to Recycle Bin via PowerShell / VisualBasic
        const { execFileSync } = require('child_process');
        const ps = `
          Add-Type -AssemblyName Microsoft.VisualBasic;
          [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
            '${abs.replace(/'/g, "''")}',
            'OnlyErrorDialogs',
            'SendToRecycleBin'
          )
        `;
        execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
          windowsHide: true,
          timeout: 15000,
        });
        return { path: toRel(abs), deleted: true, trash: true };
      } catch {
        /* fall through hard delete */
      }
    }
    fs.unlinkSync(abs);
    return { path: toRel(abs), deleted: true, trash: false };
  }

  function searchFiles(query, globHint = '', maxHits = 40) {
    const hits = [];
    const q = String(query || '').toLowerCase();
    if (!q) return { hits: [], error: 'Empty query' };
    const hint = String(globHint || '')
      .replace(/^\*\./, '.')
      .toLowerCase();

    function walk(dir) {
      if (hits.length >= maxHits) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (hits.length >= maxHits) break;
        if (IGNORE.has(ent.name)) continue;
        if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (hint && !ent.name.toLowerCase().includes(hint) && !full.toLowerCase().includes(hint)) {
          continue;
        }
        try {
          const stat = fs.statSync(full);
          if (stat.size > 500_000) continue;
          const text = fs.readFileSync(full, 'utf8');
          const lines = text.split(/\r?\n/);
          lines.forEach((line, i) => {
            if (hits.length >= maxHits) return;
            if (line.toLowerCase().includes(q)) {
              hits.push({
                path: toRel(full),
                line: i + 1,
                text: line.trim().slice(0, 240),
              });
            }
          });
        } catch {
          // binary or unreadable
        }
      }
    }

    walk(root);
    return { hits, count: hits.length };
  }

  /** Path / filename search (quick open) */
  function searchPaths(query, maxHits = 80) {
    const hits = [];
    const q = String(query || '').toLowerCase().replace(/\\/g, '/');
    if (!q) return { hits: [], count: 0 };

    function score(rel, name) {
      const r = rel.toLowerCase();
      const n = name.toLowerCase();
      if (n === q) return 100;
      if (n.startsWith(q)) return 80;
      if (n.includes(q)) return 60;
      if (r.includes(q)) return 40;
      // fuzzy chars in order
      let j = 0;
      for (let i = 0; i < n.length && j < q.length; i++) {
        if (n[i] === q[j]) j++;
      }
      return j === q.length ? 20 : 0;
    }

    function walk(dir) {
      if (hits.length >= maxHits * 3) return; // gather then rank
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (IGNORE.has(ent.name)) continue;
        if (ent.name.startsWith('.') && ent.name !== '.gitignore' && ent.name !== '.env') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = toRel(full);
        const s = score(rel, ent.name);
        if (s > 0) hits.push({ path: rel, name: ent.name, score: s });
      }
    }

    walk(root);
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const top = hits.slice(0, maxHits);
    return { hits: top, count: top.length };
  }

  function runCommand(command, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(isWin ? 'powershell.exe' : 'bash', isWin ? ['-NoProfile', '-Command', command] : ['-lc', command], {
        cwd: root,
        env: { ...process.env },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill();
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 80_000) stdout = stdout.slice(-80_000);
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          command,
          code,
          killed,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ command, code: -1, killed, stdout, stderr: err.message });
      });
    });
  }

  const toolDefs = [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List files and folders in a workspace-relative path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path, default "."' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file from the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a text file in the workspace. Prefer editing existing files carefully.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path' },
            content: { type: 'string', description: 'Full file content to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search',
        description: 'Search for a text string across the workspace source files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for' },
            hint: { type: 'string', description: 'Optional filename hint e.g. .ts' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command in the workspace root (PowerShell on Windows). Use for builds, tests, git status, etc. Avoid destructive commands.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to execute' },
          },
          required: ['command'],
        },
      },
    },
  ];

  async function execute(name, args) {
    switch (name) {
      case 'list_dir': {
        const tree = listTree(args.path || '.', 2);
        return JSON.stringify({ path: args.path || '.', entries: tree }, null, 2);
      }
      case 'read_file': {
        return JSON.stringify(readFile(args.path));
      }
      case 'write_file': {
        const result = writeFile(args.path, args.content ?? '');
        return JSON.stringify({
          path: result.path,
          created: result.created,
          bytes: result.bytes,
          ok: true,
        });
      }
      case 'search': {
        return JSON.stringify(searchFiles(args.query, args.hint || ''));
      }
      case 'run_command': {
        const result = await runCommand(args.command);
        return JSON.stringify(result);
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return {
    root,
    listTree,
    readFile,
    writeFile,
    deleteFile,
    searchFiles,
    searchPaths,
    runCommand,
    exists,
    statFile,
    toolDefs,
    execute,
  };
}

module.exports = { createTools };
