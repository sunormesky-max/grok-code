const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * 会话持久化
 * 默认目录：%USERPROFILE%\.grok-code\sessions\
 * 以项目绝对路径 hash 为键，重启后可按 path 找回。
 */

function defaultRoot() {
  return path.join(os.homedir(), '.grok-code', 'sessions');
}

function hashPath(projectPath) {
  const norm = path.resolve(projectPath).toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sessionFile(root, projectPath) {
  return path.join(root, hashPath(projectPath) + '.json');
}

function createPersist(opts = {}) {
  const root = opts.root || defaultRoot();
  ensureDir(root);

  function saveProjectSnapshot(snapshot) {
    if (!snapshot?.path) throw new Error('snapshot.path required');
    const file = sessionFile(root, snapshot.path);
    const prev = loadProjectSnapshot(snapshot.path) || {};
    const data = {
      version: 2,
      path: path.resolve(snapshot.path),
      name: snapshot.name || prev.name || path.basename(snapshot.path),
      activeTaskId: snapshot.activeTaskId || null,
      tasks: snapshot.tasks || [],
      // 编辑器轻量状态
      currentFile: snapshot.currentFile || null,
      updatedAt: Date.now(),
      savedAt: new Date().toISOString(),
    };
    // 原子写
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);

    // 索引
    writeIndex(data);
    return { ok: true, file, updatedAt: data.updatedAt };
  }

  function loadProjectSnapshot(projectPath) {
    if (!projectPath) return null;
    const file = sessionFile(root, projectPath);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function writeIndex(data) {
    const indexFile = path.join(root, 'index.json');
    let index = { projects: [] };
    try {
      if (fs.existsSync(indexFile)) {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      }
    } catch {
      index = { projects: [] };
    }
    const list = Array.isArray(index.projects) ? index.projects : [];
    const entry = {
      path: data.path,
      name: data.name,
      updatedAt: data.updatedAt,
      hash: hashPath(data.path),
      taskCount: (data.tasks || []).length,
    };
    const next = [entry, ...list.filter((p) => path.resolve(p.path) !== path.resolve(data.path))];
    index = { projects: next.slice(0, 30), updatedAt: Date.now() };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');
  }

  function listSnapshots() {
    const indexFile = path.join(root, 'index.json');
    try {
      if (fs.existsSync(indexFile)) {
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        return (index.projects || []).filter((p) => p.path && fs.existsSync(p.path));
      }
    } catch {
      /* fall through */
    }
    // 扫目录
    const out = [];
    try {
      for (const name of fs.readdirSync(root)) {
        if (!name.endsWith('.json') || name === 'index.json') continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
          if (data.path && fs.existsSync(data.path)) {
            out.push({
              path: data.path,
              name: data.name,
              updatedAt: data.updatedAt,
              taskCount: (data.tasks || []).length,
            });
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* ignore */
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function deleteSnapshot(projectPath) {
    const file = sessionFile(root, projectPath);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return true;
  }

  return {
    root,
    hashPath,
    saveProjectSnapshot,
    loadProjectSnapshot,
    listSnapshots,
    deleteSnapshot,
  };
}

module.exports = { createPersist, hashPath, defaultRoot };
