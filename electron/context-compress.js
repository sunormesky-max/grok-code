/**
 * 四档上下文压缩
 *
 * L0 即时原文  — 最近若干轮完整保留（高保真）
 * L1 近端摘要  — 滑出 L0 的消息做成要点摘要
 * L2 会话脉络  — 本任务全局：目标 / 已做 / 进行中 / 关键文件 / 决策
 * L3 项目记忆  — 跨会话耐久：约定、架构、偏好、长期事实
 *
 * 纯本地启发式，不额外调 API；稳定、可离线、可预测。
 */

const L0_MAX_MESSAGES = 8;
const L0_MAX_CHARS = 12000;
const L1_MAX_CHARS = 4000;
const L2_MAX_CHARS = 3500;
const L3_MAX_CHARS = 2500;

function clip(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function oneLine(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPaths(text) {
  const set = new Set();
  const re =
    /(?:^|[\s`'"(])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|css|html|vue|toml|yml|yaml))/g;
  let m;
  const src = String(text || '');
  while ((m = re.exec(src))) {
    set.add(m[1]);
    if (set.size > 40) break;
  }
  return [...set];
}

function extractBullets(text, limit = 6) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-*•]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      out.push(t.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, ''));
    } else if (t.length > 20 && t.length < 200 && /[完成|修复|添加|修改|实现|创建|删除|更新|fix|add|fix|create|update|remove]/i.test(t)) {
      out.push(t);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * @param {Array<{role:string, content:string, ts?:number}>} messages
 * @param {{ prev?: object, projectName?: string }} opts
 */
function compressContext(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages.filter((m) => m && m.content) : [];
  const prev = opts.prev || {};

  // ── L0：从尾部回溯，限制条数与字符 ──
  const l0 = [];
  let l0chars = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const c = String(m.content);
    if (l0.length >= L0_MAX_MESSAGES) break;
    if (l0chars + c.length > L0_MAX_CHARS && l0.length >= 2) break;
    l0.unshift({ role: m.role, content: c, ts: m.ts });
    l0chars += c.length;
  }
  const l0Start = msgs.length - l0.length;
  const older = msgs.slice(0, Math.max(0, l0Start));

  // ── L1：近端摘要（older + 与 prev.l1 合并） ──
  const l1Parts = [];
  if (prev.l1) l1Parts.push(String(prev.l1));
  for (const m of older) {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Grok' : m.role;
    const head = oneLine(m.content).slice(0, 180);
    const paths = extractPaths(m.content).slice(0, 5);
    const pathHint = paths.length ? ` 〔${paths.join(', ')}〕` : '';
    l1Parts.push(`- ${role}: ${head}${pathHint}`);
  }
  let l1 = uniqueLines(l1Parts).join('\n');
  l1 = clip(l1, L1_MAX_CHARS);

  // ── L2：会话脉络 ──
  const userGoals = msgs
    .filter((m) => m.role === 'user')
    .map((m) => oneLine(m.content).slice(0, 120))
    .filter(Boolean);
  const recentGoals = uniqueLines(userGoals).slice(-8);

  const allPaths = new Set();
  for (const m of msgs) extractPaths(m.content).forEach((p) => allPaths.add(p));
  if (prev.l2Paths) prev.l2Paths.forEach((p) => allPaths.add(p));

  const outcomes = [];
  for (const m of msgs.filter((x) => x.role === 'assistant')) {
    extractBullets(m.content, 4).forEach((b) => outcomes.push(b));
  }
  const outcomeLines = uniqueLines(outcomes).slice(-12);

  const l2 = clip(
    [
      `项目: ${opts.projectName || 'unknown'}`,
      recentGoals.length ? `目标/请求:\n${recentGoals.map((g) => `  · ${g}`).join('\n')}` : '',
      outcomeLines.length ? `已推进:\n${outcomeLines.map((g) => `  · ${g}`).join('\n')}` : '',
      allPaths.size
        ? `关键文件:\n${[...allPaths]
            .slice(0, 24)
            .map((f) => `  · ${f}`)
            .join('\n')}`
        : '',
      `消息轮次: ${msgs.length} · 更新: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    L2_MAX_CHARS
  );

  // ── L3：项目记忆（耐久，合并 prev） ──
  const durable = [];
  if (prev.l3) durable.push(String(prev.l3));
  // 从用户消息提炼“约定/偏好”
  for (const m of msgs.filter((x) => x.role === 'user')) {
    const t = m.content;
    if (/记得|必须|不要|禁止|约定|偏好|always|never|务必|请用|使用中文|不要改/i.test(t)) {
      durable.push(`· 偏好/约束: ${oneLine(t).slice(0, 160)}`);
    }
  }
  // 高频路径视为架构锚点
  const pathCount = {};
  for (const m of msgs) {
    for (const f of extractPaths(m.content)) {
      pathCount[f] = (pathCount[f] || 0) + 1;
    }
  }
  const hotFiles = Object.entries(pathCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([f, n]) => `· 热点文件: ${f} (×${n})`);
  durable.push(...hotFiles);

  let l3 = uniqueLines(durable).join('\n');
  l3 = clip(l3, L3_MAX_CHARS);

  const stats = {
    messages: msgs.length,
    l0Count: l0.length,
    l0Chars: l0chars,
    l1Chars: l1.length,
    l2Chars: l2.length,
    l3Chars: l3.length,
    olderCount: older.length,
    updatedAt: Date.now(),
  };

  return {
    l0,
    l1,
    l2,
    l3,
    l2Paths: [...allPaths].slice(0, 40),
    stats,
    tiers: [
      { id: 'L0', name: '即时原文', desc: '最近对话完整保留', chars: l0chars, count: l0.length },
      { id: 'L1', name: '近端摘要', desc: '滑出窗口的要点压缩', chars: l1.length, count: older.length },
      { id: 'L2', name: '会话脉络', desc: '目标/进展/关键文件', chars: l2.length },
      { id: 'L3', name: '项目记忆', desc: '跨会话耐久事实与约束', chars: l3.length },
    ],
  };
}

function uniqueLines(arr) {
  const seen = new Set();
  const out = [];
  for (const line of arr) {
    const k = oneLine(line);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out;
}

/**
 * 拼装注入 CLI 的上下文前缀
 */
function buildContextPrompt(context, userMessage, meta = {}) {
  const c = context || {};
  const parts = [];
  parts.push('【GrokCode 上下文继承 · 四档压缩】');
  parts.push(
    `项目: ${meta.projectName || '?'} · 任务: ${meta.taskTitle || '?'} · 已继承历史对话（关闭重开可续）`
  );

  if (c.l3 && String(c.l3).trim()) {
    parts.push('\n## L3 项目记忆（耐久）\n' + String(c.l3).trim());
  }
  if (c.l2 && String(c.l2).trim()) {
    parts.push('\n## L2 会话脉络\n' + String(c.l2).trim());
  }
  if (c.l1 && String(c.l1).trim()) {
    parts.push('\n## L1 近端摘要\n' + String(c.l1).trim());
  }
  if (Array.isArray(c.l0) && c.l0.length) {
    parts.push('\n## L0 近期原文');
    for (const m of c.l0) {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
      parts.push(`\n### ${role}\n${clip(m.content, 4000)}`);
    }
  }

  parts.push('\n## 当前用户请求\n' + String(userMessage || '').trim());
  parts.push(
    '\n（请在完整继承上述上下文的前提下继续工作；不要假装遗忘已完成事项；改动保持聚焦。）'
  );

  return parts.join('\n');
}

module.exports = {
  compressContext,
  buildContextPrompt,
  L0_MAX_MESSAGES,
  L0_MAX_CHARS,
};
