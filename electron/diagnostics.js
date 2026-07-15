/**
 * 环境体检 + 诊断包导出
 * 供首启向导 / 设置「一键诊断」使用
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { resolveGrokBinary, probeGrok } = require('./grok-cli');
const { defaultRoot } = require('./persist');
function safeExec(bin, args, opts = {}) {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: opts.timeout || 8000,
      windowsHide: true,
      env: opts.env || process.env,
    });
    return { ok: true, out: String(out || '').trim() };
  } catch (err) {
    return {
      ok: false,
      out: '',
      error: err.message || String(err),
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

function checkAuth(bin, apiKey) {
  if (apiKey || process.env.XAI_API_KEY) {
    return {
      id: 'auth',
      name: '认证',
      ok: true,
      level: 'ok',
      detail: apiKey ? '已配置 XAI_API_KEY（应用设置）' : '已从环境变量读取 XAI_API_KEY',
      fix: null,
    };
  }
  // 尝试 grok 是否已 login（无密钥时也可能用本地凭据）
  if (bin) {
    const r = safeExec(bin, ['version'], { timeout: 5000 });
    // 部分版本有 auth status；没有也不当失败
    const authTry = safeExec(bin, ['auth', 'status'], { timeout: 6000 });
    if (authTry.ok && /logged|ok|authenticated|yes/i.test(authTry.out)) {
      return {
        id: 'auth',
        name: '认证',
        ok: true,
        level: 'ok',
        detail: 'CLI 本地登录状态可用',
        fix: null,
      };
    }
    if (r.ok) {
      return {
        id: 'auth',
        name: '认证',
        ok: true,
        level: 'warn',
        detail: '未配置 API Key；若 CLI 已 `grok login` 仍可工作。建议在设置中保存密钥或执行 grok login。',
        fix: '运行 `grok login`，或在设置中填写 XAI_API_KEY',
      };
    }
  }
  return {
    id: 'auth',
    name: '认证',
    ok: false,
    level: 'bad',
    detail: '未检测到 API Key 或 CLI 登录',
    fix: 'console.x.ai 创建密钥，或终端执行 grok login',
  };
}

function checkSessionsDir() {
  const root = defaultRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    const test = path.join(root, '.write-test');
    fs.writeFileSync(test, 'ok');
    fs.unlinkSync(test);
    let count = 0;
    try {
      count = fs.readdirSync(root).filter((n) => n.endsWith('.json')).length;
    } catch {
      /* ignore */
    }
    return {
      id: 'sessions',
      name: '会话存储',
      ok: true,
      level: 'ok',
      detail: `${root} · ${count} 个文件`,
      path: root,
      fix: null,
    };
  } catch (err) {
    return {
      id: 'sessions',
      name: '会话存储',
      ok: false,
      level: 'bad',
      detail: err.message || String(err),
      path: root,
      fix: '检查主目录写权限',
    };
  }
}

function checkMcp() {
  try {
    const cfgPath = path.join(os.homedir(), '.grok', 'config.toml');
    const exists = fs.existsSync(cfgPath);
    return {
      id: 'mcp_config',
      name: 'Grok 配置',
      ok: true,
      level: exists ? 'ok' : 'warn',
      detail: exists ? `已找到 ${cfgPath}` : '尚未创建 ~/.grok/config.toml（可选）',
      path: cfgPath,
      fix: exists ? null : '可在设置 → MCP 中添加服务器',
    };
  } catch (err) {
    return {
      id: 'mcp_config',
      name: 'Grok 配置',
      ok: true,
      level: 'warn',
      detail: err.message,
      fix: null,
    };
  }
}

function checkEditors() {
  const found = [];
  const tryWhich = (name) => {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('where.exe', [name], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000,
        });
        const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (first) found.push({ name, path: first });
      } else {
        const out = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 });
        const first = out.trim().split(/\n/)[0];
        if (first) found.push({ name, path: first });
      }
    } catch {
      /* not found */
    }
  };
  tryWhich('code');
  tryWhich('cursor');
  tryWhich('code-insiders');
  return {
    id: 'editors',
    name: '外部编辑器',
    ok: true,
    level: found.length ? 'ok' : 'warn',
    detail: found.length
      ? found.map((e) => `${e.name}: ${e.path}`).join(' · ')
      : '未在 PATH 中找到 code / cursor（仍可用系统默认打开）',
    editors: found,
    fix: found.length ? null : '安装 VS Code / Cursor 并启用 shell 命令',
  };
}

/**
 * @param {{ grokPath?: string, apiKey?: string }} cfg
 */
function runDoctor(cfg = {}) {
  const probe = probeGrok(cfg.grokPath);
  const bin = probe.binary || resolveGrokBinary(cfg.grokPath);
  const checks = [];

  checks.push({
    id: 'cli',
    name: 'Grok CLI',
    ok: Boolean(probe.ok),
    level: probe.ok ? 'ok' : 'bad',
    detail: probe.ok
      ? `${probe.version || 'OK'}\n${probe.binary}`
      : probe.error || '未找到 Grok CLI',
    binary: probe.binary,
    version: probe.version,
    fix: probe.ok
      ? null
      : '安装 Grok Build，或在设置中填写 grok 可执行文件完整路径（通常 %USERPROFILE%\\.grok\\bin\\grok.exe）',
  });

  checks.push(checkAuth(bin, cfg.apiKey));
  checks.push(checkSessionsDir());
  checks.push(checkMcp());
  checks.push(checkEditors());

  // 平台 / 应用
  let appVersion = 'unknown';
  try {
    appVersion = app.getVersion();
  } catch {
    try {
      appVersion = require('../package.json').version;
    } catch {
      /* ignore */
    }
  }
  checks.push({
    id: 'app',
    name: 'GrokCode',
    ok: true,
    level: 'ok',
    detail: `v${appVersion} · ${process.platform} ${os.release()} · Node ${process.versions.node} · Electron ${process.versions.electron || '—'}`,
    fix: null,
  });

  const ready = checks.filter((c) => c.id === 'cli').every((c) => c.ok);
  const hardFail = checks.some((c) => !c.ok && c.level === 'bad');
  const warnCount = checks.filter((c) => c.level === 'warn').length;

  return {
    ok: ready && !hardFail,
    ready,
    warnCount,
    checks,
    ts: Date.now(),
    summary: ready
      ? warnCount
        ? `环境可用（${warnCount} 项建议优化）`
        : '环境就绪'
      : '环境未就绪 — 请先修复 Grok CLI / 认证',
  };
}

/**
 * 导出诊断包到用户选择的目录（或默认桌面）
 * @returns {{ ok: boolean, dir?: string, file?: string, error?: string }}
 */
function exportDiagnostics(cfg = {}, extra = {}) {
  const doctor = runDoctor(cfg);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseDir = path.join(os.homedir(), '.grok-code', 'diagnostics');
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = path.join(baseDir, `diag-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    doctor,
    env: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      homedir: os.homedir(),
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    },
    config: {
      hasApiKey: Boolean(cfg.apiKey || process.env.XAI_API_KEY),
      model: cfg.model || '',
      grokPath: cfg.grokPath || '',
      alwaysApprove: cfg.alwaysApprove,
      maxTurns: cfg.maxTurns,
      contextMode: cfg.contextMode || 'heuristic',
      preferredEditor: cfg.preferredEditor || 'auto',
      // 绝不写入真实密钥
    },
    recentProjects: (extra.recentProjects || []).slice(0, 12),
    runningAgents: extra.runningAgents || [],
    sessionsRoot: defaultRoot(),
    note: '本包不含 API Key 与完整对话内容。可附在 GitHub Issue 中协助排查。',
  };

  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

  // 复制会话索引（不含全文消息，只 index）
  try {
    const indexFile = path.join(defaultRoot(), 'index.json');
    if (fs.existsSync(indexFile)) {
      fs.copyFileSync(indexFile, path.join(dir, 'sessions-index.json'));
    }
  } catch {
    /* ignore */
  }

  // 写 README
  fs.writeFileSync(
    path.join(dir, 'README.txt'),
    [
      'GrokCode Diagnostic Bundle',
      `Generated: ${report.generatedAt}`,
      '',
      doctor.summary,
      '',
      'Files:',
      '  report.json          — full doctor + env (no secrets)',
      '  sessions-index.json  — session index if present',
      '',
      'Attach this folder (or zip it) when filing a GitHub issue.',
      'https://github.com/sunormesky-max/grok-code/issues',
    ].join('\n'),
    'utf8'
  );

  return { ok: true, dir, file: reportFile };
}

module.exports = { runDoctor, exportDiagnostics, checkEditors };
