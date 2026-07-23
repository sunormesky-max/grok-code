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

/** Local CLI login file from open-source grok-build (~/.grok/auth.json) */
function checkGrokAuthFile() {
  const authPath = path.join(os.homedir(), '.grok', 'auth.json');
  try {
    if (!fs.existsSync(authPath)) {
      return {
        id: 'cli_auth_file',
        name: 'CLI 登录文件',
        ok: true,
        level: 'warn',
        detail: '未找到 ~/.grok/auth.json',
        fix: '终端执行 grok login（与开源 grok-build 相同凭据路径）',
      };
    }
    const st = fs.statSync(authPath);
    const raw = fs.readFileSync(authPath, 'utf8');
    const hasRefresh = /refresh_token|refreshToken/i.test(raw);
    return {
      id: 'cli_auth_file',
      name: 'CLI 登录文件',
      ok: true,
      level: hasRefresh ? 'ok' : 'warn',
      detail: hasRefresh
        ? `auth.json 存在 · ${Math.round(st.size / 1024)}KB · 含 refresh`
        : `auth.json 存在 · ${Math.round(st.size / 1024)}KB · 可能缺 refresh`,
      path: authPath,
      fix: hasRefresh ? null : '建议重新 grok login',
    };
  } catch (err) {
    return {
      id: 'cli_auth_file',
      name: 'CLI 登录文件',
      ok: true,
      level: 'warn',
      detail: err.message || String(err),
      fix: null,
    };
  }
}

/**
 * Recent stream log: ACP agent stdio 403 (cli-chat-proxy) while -p may still work.
 * Aligns with upstream: host uses grok agent stdio; Build gate is server-side.
 */
function checkBuildGateLog() {
  const logPath = path.join(os.tmpdir(), 'grokcode-stream.log');
  try {
    if (!fs.existsSync(logPath)) {
      return {
        id: 'build_gate',
        name: 'Build API 门控',
        ok: true,
        level: 'ok',
        detail: '尚无 stream 日志（未跑过 agent）',
        fix: null,
      };
    }
    const st = fs.statSync(logPath);
    const max = 120_000;
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(Math.min(max, st.size));
    const start = Math.max(0, st.size - buf.length);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const gated =
      /coming soon|don't have access|cli-chat-proxy\.grok\.com\/v1\/responses/i.test(
        tail
      ) && /403|Forbidden|Internal error/i.test(tail);
    if (gated) {
      return {
        id: 'build_gate',
        name: 'Build API 门控',
        ok: true,
        level: 'warn',
        detail:
          '最近 stream 日志出现 ACP/agent stdio 403（Grok Build coming soon）。' +
          '终端 grok -p 可能仍可用。GrokCode 会自动 headless 回退。',
        path: logPath,
        fix:
          '设置 → Agent transport 选 headless 或 auto；或待账号开通 agent stdio / cli-chat-proxy',
      };
    }
    return {
      id: 'build_gate',
      name: 'Build API 门控',
      ok: true,
      level: 'ok',
      detail: '最近日志未见 agent 403 门控',
      path: logPath,
      fix: null,
    };
  } catch (err) {
    return {
      id: 'build_gate',
      name: 'Build API 门控',
      ok: true,
      level: 'ok',
      detail: err.message || String(err),
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
 * Opt-in live probe: `grok -p` one-shot (slow — network + model).
 * @param {string|null} bin
 * @param {{ run?: boolean }} opts  run=false → skipped placeholder
 */
function checkGrokPromptProbe(bin, opts = {}) {
  if (!opts.run) {
    return {
      id: 'prompt_probe',
      name: 'CLI -p 探测',
      ok: true,
      level: 'ok',
      detail:
        '未运行（慢项）。需要时设 GROKCODE_DOCTOR_PROBE=1 或体检时勾选「探测 -p」',
      fix: null,
      skipped: true,
    };
  }
  if (!bin) {
    return {
      id: 'prompt_probe',
      name: 'CLI -p 探测',
      ok: false,
      level: 'bad',
      detail: '无 CLI 二进制，跳过 -p',
      fix: '先修好 Grok CLI 路径',
    };
  }
  const ms = Math.min(
    120_000,
    Math.max(8_000, Number(process.env.GROKCODE_DOCTOR_PROBE_MS) || 45_000)
  );
  const t0 = Date.now();
  // Minimal headless-style prompt — same family as desktop headless fallback
  const r = safeExec(
    bin,
    ['-p', 'Reply with exactly: pong', '--output-format', 'text'],
    { timeout: ms }
  );
  const elapsed = Date.now() - t0;
  if (r.ok && /pong/i.test(r.out || '')) {
    return {
      id: 'prompt_probe',
      name: 'CLI -p 探测',
      ok: true,
      level: 'ok',
      detail: `grok -p 成功 · ${elapsed}ms · 输出含 pong`,
      elapsedMs: elapsed,
      fix: null,
    };
  }
  if (r.ok && (r.out || '').trim()) {
    return {
      id: 'prompt_probe',
      name: 'CLI -p 探测',
      ok: true,
      level: 'warn',
      detail: `grok -p 有输出但未见 pong · ${elapsed}ms · ${(r.out || '').slice(0, 120)}`,
      elapsedMs: elapsed,
      fix: '检查模型/网络；agent stdio 仍可能 403',
    };
  }
  return {
    id: 'prompt_probe',
    name: 'CLI -p 探测',
    ok: false,
    level: 'bad',
    detail: `grok -p 失败 · ${elapsed}ms · ${r.error || r.stderr || 'no output'}`.slice(
      0,
      400
    ),
    elapsedMs: elapsed,
    fix: '终端试 grok login 后 grok -p "hi"；对照 Build 门控',
  };
}

/**
 * @param {{ grokPath?: string, apiKey?: string }} cfg
 * @param {{ probePrompt?: boolean }} [opts]
 */
function runDoctor(cfg = {}, opts = {}) {
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
  checks.push(checkGrokAuthFile());
  checks.push(checkBuildGateLog());
  const wantProbe =
    opts.probePrompt === true ||
    process.env.GROKCODE_DOCTOR_PROBE === '1' ||
    process.env.GROKCODE_DOCTOR_PROBE === 'true';
  checks.push(checkGrokPromptProbe(bin, { run: wantProbe }));
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
