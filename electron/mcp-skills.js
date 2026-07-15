const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { resolveGrokBinary } = require('./grok-cli');

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const USER_CONFIG = path.join(GROK_HOME, 'config.toml');
const USER_SKILLS = path.join(GROK_HOME, 'skills');
const BUNDLED_SKILLS = path.join(GROK_HOME, 'bundled', 'skills');

function runGrok(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveGrokBinary(opts.grokPath);
    if (!bin) {
      reject(new Error('找不到 Grok CLI'));
      return;
    }
    execFile(
      bin,
      args,
      {
        encoding: 'utf8',
        timeout: opts.timeout || 60000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
      }
    );
  });
}

// ── MCP ─────────────────────────────────────────────────
async function listMcp(grokPath) {
  try {
    const { stdout } = await runGrok(['mcp', 'list', '--json'], { grokPath });
    const text = stdout.trim();
    if (!text) return [];
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : data.servers || [];
  } catch (e) {
    // fallback: parse plain list
    try {
      const { stdout } = await runGrok(['mcp', 'list'], { grokPath });
      return parseMcpListPlain(stdout);
    } catch {
      throw e;
    }
  }
}

function parseMcpListPlain(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    // "  name: command ..."
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
    if (m) {
      out.push({ name: m[1], command: m[2], enabled: true, scope: 'user' });
    }
  }
  return out;
}

async function addMcp(payload, grokPath) {
  const name = String(payload.name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!name) throw new Error('需要有效的服务器名称（字母数字-_）');

  const transport = payload.transport || 'stdio';
  const args = ['mcp', 'add'];

  if (transport === 'http' || transport === 'sse') {
    args.push('--transport', transport);
    if (!payload.url) throw new Error('HTTP/SSE 需要 URL');
    args.push(name, payload.url);
    if (payload.header) {
      // "Authorization: Bearer xxx"
      args.push('--header', payload.header);
    }
  } else {
    // stdio
    args.push(name);
    if (payload.env && typeof payload.env === 'object') {
      for (const [k, v] of Object.entries(payload.env)) {
        if (k) args.push('-e', `${k}=${v}`);
      }
    }
    args.push('--');
    const cmd = String(payload.command || '').trim();
    if (!cmd) throw new Error('stdio 需要 command');
    // support "npx -y pkg arg" as single command string
    const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
    args.push(...parts.map((p) => p.replace(/^"|"$/g, '')));
    if (Array.isArray(payload.args)) {
      args.push(...payload.args.map(String));
    }
  }

  if (payload.scope === 'project') args.splice(2, 0, '--scope', 'project');

  const { stdout, stderr, code } = await runGrok(args, { grokPath, timeout: 120000 });
  if (code && code !== 0) {
    throw new Error(stderr || stdout || `mcp add failed (${code})`);
  }

  // enable/disable via config if requested
  if (payload.enabled === false) {
    await setMcpEnabled(name, false);
  }

  return { ok: true, stdout: stdout.trim() };
}

async function removeMcp(name, grokPath, scope) {
  const args = ['mcp', 'remove', name];
  if (scope) args.push('--scope', scope);
  const { stdout, stderr, code } = await runGrok(args, { grokPath });
  if (code && code !== 0) {
    throw new Error(stderr || stdout || `remove failed`);
  }
  return { ok: true };
}

async function doctorMcp(name, grokPath) {
  // 远程 mcp-remote 常 >30s，doctor 放宽到 150s
  const args = name ? ['mcp', 'doctor', name, '--json'] : ['mcp', 'doctor', '--json'];
  try {
    const { stdout, stderr, code } = await runGrok(args, { grokPath, timeout: 150000 });
    const text = (stdout || '').trim() || (stderr || '').trim();
    try {
      const data = JSON.parse(text || '{}');
      return { ...data, exitCode: code, ok: data.healthy_count > 0 || data.healthy === true };
    } catch {
      return { raw: text, exitCode: code, ok: false };
    }
  } catch (e) {
    try {
      const args2 = name ? ['mcp', 'doctor', name] : ['mcp', 'doctor'];
      const { stdout, stderr, code } = await runGrok(args2, { grokPath, timeout: 150000 });
      return {
        raw: stdout || stderr || e.message,
        exitCode: code,
        ok: false,
        error: e.message,
      };
    } catch (e2) {
      return { ok: false, error: e2.message || e.message, raw: String(e2.message || e.message) };
    }
  }
}

/** 提高某 MCP 的 startup_timeout_sec（远程 server 常用） */
function setMcpStartupTimeout(name, seconds = 120) {
  ensureConfigFile();
  let text = fs.readFileSync(USER_CONFIG, 'utf8');
  const section = `[mcp_servers.${name}]`;
  if (!text.includes(section)) {
    throw new Error(`配置中找不到 [mcp_servers.${name}]`);
  }
  const sec = Math.max(15, Number(seconds) || 120);
  const blockRe = new RegExp(
    `(\\[mcp_servers\\.${escapeReg(name)}\\])([^\\[]*)`,
    'm'
  );
  const m = text.match(blockRe);
  if (!m) throw new Error('无法定位 MCP 配置块');
  let body = m[2];
  if (/startup_timeout_sec\s*=/.test(body)) {
    body = body.replace(/startup_timeout_sec\s*=\s*\d+/, `startup_timeout_sec = ${sec}`);
  } else {
    body = body.replace(/^\r?\n?/, `\nstartup_timeout_sec = ${sec}\n`);
  }
  text = text.replace(blockRe, `$1${body}`);
  fs.writeFileSync(USER_CONFIG, text, 'utf8');
  return { ok: true, startup_timeout_sec: sec };
}

/** Toggle enabled in user config.toml */
async function setMcpEnabled(name, enabled) {
  ensureConfigFile();
  let text = fs.readFileSync(USER_CONFIG, 'utf8');
  const section = `[mcp_servers.${name}]`;
  if (!text.includes(section)) {
    // append minimal section
    text += `\n${section}\nenabled = ${enabled ? 'true' : 'false'}\n`;
    fs.writeFileSync(USER_CONFIG, text, 'utf8');
    return { ok: true };
  }
  const re = new RegExp(
    `(\\[mcp_servers\\.${escapeReg(name)}\\][^\\[]*?)(^enabled\\s*=\\s*)(true|false)`,
    'm'
  );
  if (re.test(text)) {
    text = text.replace(re, `$1$2${enabled ? 'true' : 'false'}`);
  } else {
    text = text.replace(section, `${section}\nenabled = ${enabled ? 'true' : 'false'}`);
  }
  fs.writeFileSync(USER_CONFIG, text, 'utf8');
  return { ok: true };
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureConfigFile() {
  if (!fs.existsSync(GROK_HOME)) fs.mkdirSync(GROK_HOME, { recursive: true });
  if (!fs.existsSync(USER_CONFIG)) {
    fs.writeFileSync(USER_CONFIG, '# Grok config managed partly by GrokCode\n', 'utf8');
  }
}

// ── Skills ──────────────────────────────────────────────
function parseFrontmatter(md) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(md || '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] || '' };
}

function readDisabledSkills() {
  if (!fs.existsSync(USER_CONFIG)) return [];
  const text = fs.readFileSync(USER_CONFIG, 'utf8');
  // disabled = ["a", "b"] or disabled = ["a"]
  const m = text.match(/^\s*disabled\s*=\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.replace(/["'\s]/g, ''))
    .filter(Boolean);
}

function writeDisabledSkills(names) {
  ensureConfigFile();
  let text = fs.readFileSync(USER_CONFIG, 'utf8');
  const arr = `[${names.map((n) => `"${n}"`).join(', ')}]`;
  if (/^\s*disabled\s*=/m.test(text)) {
    text = text.replace(/^\s*disabled\s*=\s*\[[^\]]*\]/m, `disabled = ${arr}`);
  } else if (/\[skills\]/.test(text)) {
    text = text.replace(/\[skills\]/, `[skills]\ndisabled = ${arr}`);
  } else {
    text += `\n[skills]\ndisabled = ${arr}\n`;
  }
  fs.writeFileSync(USER_CONFIG, text, 'utf8');
}

function scanSkillsDir(dir, scope) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillMd = path.join(dir, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    try {
      const raw = fs.readFileSync(skillMd, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      out.push({
        name: meta.name || ent.name,
        description: meta.description || body.split(/\n\n/)[0]?.replace(/^#.*\n/, '').slice(0, 200) || '',
        path: path.join(dir, ent.name),
        skillFile: skillMd,
        scope,
        enabled: true,
        frontmatter: meta,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

function listSkills(projectPath) {
  const disabled = new Set(readDisabledSkills());
  const map = new Map();

  const addAll = (items) => {
    for (const s of items) {
      // higher priority overwrites by name
      map.set(s.name, s);
    }
  };

  // lower priority first
  addAll(scanSkillsDir(path.join(os.homedir(), '.cursor', 'skills'), 'cursor'));
  addAll(scanSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'claude'));
  addAll(scanSkillsDir(BUNDLED_SKILLS, 'bundled'));
  addAll(scanSkillsDir(USER_SKILLS, 'user'));

  if (projectPath) {
    addAll(scanSkillsDir(path.join(projectPath, '.cursor', 'skills'), 'project-cursor'));
    addAll(scanSkillsDir(path.join(projectPath, '.claude', 'skills'), 'project-claude'));
    addAll(scanSkillsDir(path.join(projectPath, '.grok', 'skills'), 'project'));
  }

  return [...map.values()]
    .map((s) => ({
      ...s,
      enabled: !disabled.has(s.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Progressive skill index for agent injection:
 * only name + description (L1), not full SKILL.md bodies.
 * Agent should read SKILL.md when a skill matches.
 */
function buildSkillsIndexPrompt(projectPath, { maxItems = 24, maxDesc = 160 } = {}) {
  const list = listSkills(projectPath).filter((s) => s.enabled !== false);
  if (!list.length) return '';
  const lines = list.slice(0, maxItems).map((s) => {
    const desc = String(s.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxDesc);
    const loc = s.skillFile || s.path || '';
    return `- ${s.name}: ${desc}${loc ? ` 〔${loc}〕` : ''}`;
  });
  return [
    '【可用 Skills 索引 · 渐进加载】',
    '以下仅元数据。若某 skill 的 description 匹配当前任务，请用读文件工具打开对应 SKILL.md 再按其中步骤执行；不要假装已内置全文。',
    ...lines,
  ].join('\n');
}

function setSkillEnabled(name, enabled) {
  const disabled = new Set(readDisabledSkills());
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeDisabledSkills([...disabled]);
  return { ok: true, disabled: [...disabled] };
}

function createSkill({ name, description, body, scope = 'user', projectPath }) {
  const safe = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
  if (!safe) throw new Error('技能名称无效');

  let root;
  if (scope === 'project') {
    if (!projectPath) throw new Error('项目技能需要 projectPath');
    root = path.join(projectPath, '.grok', 'skills');
  } else {
    root = USER_SKILLS;
  }
  const dir = path.join(root, safe);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && !arguments[0]?.overwrite) {
    // allow overwrite if exists for edit
  }
  const desc = description || `Skill: ${safe}`;
  const content =
    body && String(body).includes('---')
      ? body
      : `---
name: ${safe}
description: ${desc}
---

# ${safe}

${body || '在此编写技能步骤与约定。'}
`;
  fs.writeFileSync(file, content, 'utf8');
  return { ok: true, path: dir, skillFile: file, name: safe };
}

function readSkill(skillPath) {
  const file = skillPath.endsWith('SKILL.md')
    ? skillPath
    : path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error('SKILL.md 不存在');
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return { path: file, meta, body, raw };
}

function writeSkill(skillFile, rawContent) {
  if (!skillFile || !fs.existsSync(path.dirname(skillFile))) {
    throw new Error('技能路径无效');
  }
  fs.writeFileSync(skillFile, rawContent, 'utf8');
  return { ok: true };
}

function deleteSkill(skillDir) {
  // safety: only under known skill roots
  const resolved = path.resolve(skillDir);
  const allowed = [USER_SKILLS, BUNDLED_SKILLS].map((p) => path.resolve(p));
  const ok =
    allowed.some((a) => resolved.startsWith(a + path.sep)) ||
    resolved.includes(`${path.sep}.grok${path.sep}skills${path.sep}`);
  if (!ok) throw new Error('只能删除用户/项目技能目录');
  if (resolved.startsWith(path.resolve(BUNDLED_SKILLS))) {
    throw new Error('不能删除 bundled 技能，请改用禁用');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return { ok: true };
}

function openPath(target) {
  return target;
}

module.exports = {
  listMcp,
  addMcp,
  removeMcp,
  doctorMcp,
  setMcpEnabled,
  setMcpStartupTimeout,
  buildSkillsIndexPrompt,
  listSkills,
  setSkillEnabled,
  createSkill,
  readSkill,
  writeSkill,
  deleteSkill,
  USER_SKILLS,
  USER_CONFIG,
  GROK_HOME,
  openPath,
};
