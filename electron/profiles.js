/**
 * Team / personal project profiles — export / import workspace + rules snapshot
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createPersist } = require('./persist');

const PROFILE_VERSION = 1;

function profilesDir() {
  const dir = path.join(os.homedir(), '.grok-code', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {{
 *   projectPath: string,
 *   name?: string,
 *   rules?: string,
 *   model?: string,
 *   maxTurns?: number,
 *   alwaysApprove?: boolean,
 *   contextMode?: string,
 *   preferredEditor?: string,
 *   includeSession?: boolean,
 * }} opts
 */
function exportProfile(opts = {}) {
  const projectPath = opts.projectPath;
  if (!projectPath || !fs.existsSync(projectPath)) {
    throw new Error('项目路径无效');
  }

  let session = null;
  if (opts.includeSession) {
    try {
      const persist = createPersist();
      session = persist.loadProjectSnapshot(projectPath);
      // strip huge message bodies for portability (keep titles + context tiers)
      if (session?.tasks) {
        session = {
          ...session,
          tasks: session.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            context: t.context
              ? { l1: t.context.l1, l2: t.context.l2, l3: t.context.l3, tiers: t.context.tiers }
              : null,
            messageCount: (t.messages || []).length,
            // no full messages / sessionId secrets
          })),
        };
      }
    } catch {
      session = null;
    }
  }

  const profile = {
    version: PROFILE_VERSION,
    kind: 'grokcode-project-profile',
    exportedAt: new Date().toISOString(),
    name: opts.name || path.basename(projectPath),
    // 路径仅作参考，导入时由用户选择目标目录
    sourcePath: path.resolve(projectPath),
    config: {
      rules: opts.rules || '',
      model: opts.model || '',
      reasoningEffort: opts.reasoningEffort || '',
      maxTurns: opts.maxTurns || 30,
      alwaysApprove: opts.alwaysApprove !== false,
      contextMode: opts.contextMode || 'heuristic',
      preferredEditor: opts.preferredEditor || 'auto',
    },
    // 轻量项目指纹
    hints: {
      hasPackageJson: fs.existsSync(path.join(projectPath, 'package.json')),
      hasGit: fs.existsSync(path.join(projectPath, '.git')),
      hasGrokDir: fs.existsSync(path.join(projectPath, '.grok')),
    },
    sessionSummary: session,
  };

  const safeName = String(profile.name)
    .replace(/[^\w.\-\u4e00-\u9fff]+/gi, '_')
    .slice(0, 64);
  const file = path.join(profilesDir(), `${safeName}-${Date.now()}.grokcode.json`);
  fs.writeFileSync(file, JSON.stringify(profile, null, 2), 'utf8');
  return { ok: true, file, profile };
}

function importProfile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('配置文件不存在');
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('无效的 JSON 配置文件');
  }
  if (data.kind !== 'grokcode-project-profile' && !data.config) {
    throw new Error('不是 GrokCode 项目配置文件');
  }
  return {
    ok: true,
    profile: data,
    config: data.config || {},
    name: data.name || 'imported',
    sessionSummary: data.sessionSummary || null,
  };
}

function listProfiles() {
  const dir = profilesDir();
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        let meta = { name, file };
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          meta = {
            name: data.name || name,
            file,
            exportedAt: data.exportedAt,
            sourcePath: data.sourcePath,
            mtime: st.mtimeMs,
          };
        } catch {
          meta.mtime = st.mtimeMs;
        }
        out.push(meta);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

module.exports = {
  exportProfile,
  importProfile,
  listProfiles,
  profilesDir,
  PROFILE_VERSION,
};
