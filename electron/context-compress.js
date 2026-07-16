/**
 * 四档上下文压缩（v1.9.3 quality pass）
 *
 * L0 即时原文  — 最近完整轮次（优先 user+assistant 成对）
 * L1 近端摘要  — 滑出 L0 的要点：决策 / 路径 / 未完成
 * L2 会话脉络  — 目标 / 已推进 / 开放问题 / 关键文件 / 回合状态
 * L3 项目记忆  — 约束偏好 + 热点文件 + 跨会话耐久事实
 *
 * 纯本地启发式；可注入 turns / changedFiles 提升续跑质量。
 */

const L0_MAX_MESSAGES = 10;
const L0_MAX_CHARS = 14000;
const L1_MAX_CHARS = 4500;
const L2_MAX_CHARS = 4000;
const L3_MAX_CHARS = 2800;

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
    /(?:^|[\s`'"(])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json|md|css|scss|html|vue|svelte|toml|yml|yaml|sql|sh|ps1))/g;
  let m;
  const src = String(text || '');
  while ((m = re.exec(src))) {
    set.add(m[1].replace(/\\/g, '/'));
    if (set.size > 48) break;
  }
  return [...set];
}

function extractBullets(text, limit = 6) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-*•]\s+/.test(t) || /^\d+[\.)、]\s+/.test(t)) {
      out.push(t.replace(/^[-*•]\s+/, '').replace(/^\d+[\.)、]\s+/, ''));
    } else if (
      t.length > 16 &&
      t.length < 220 &&
      /[完成|修复|添加|修改|实现|创建|删除|更新|重构|迁移|fix|add|implement|create|update|remove|refactor|ship|done]/i.test(
        t
      )
    ) {
      out.push(t);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function extractOpenQuestions(text, limit = 4) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (
      /[？?]\s*$/.test(t) ||
      /^(TODO|FIXME|待办|需要确认|是否|要不要|should we|need to decide)/i.test(t) ||
      /未完成|暂未|后续|还差|blocked|WIP/i.test(t)
    ) {
      out.push(oneLine(t).slice(0, 140));
    }
    if (out.length >= limit) break;
  }
  return out;
}

function isConstraintMessage(text) {
  return /记得|必须|不要|禁止|约定|偏好|务必|请用|始终|永远|always|never|prefer|must not|don't|do not|使用中文|用中文|不要改|严禁/i.test(
    String(text || '')
  );
}

function uniqueLines(arr) {
  const seen = new Set();
  const out = [];
  for (const line of arr) {
    const k = oneLine(line).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out;
}

/**
 * Prefer keeping complete user→assistant pairs in L0 from the tail.
 */
function pickL0(msgs) {
  const l0 = [];
  let l0chars = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const c = String(m.content);
    if (l0.length >= L0_MAX_MESSAGES) break;
    if (l0chars + c.length > L0_MAX_CHARS && l0.length >= 2) break;
    l0.unshift({
      role: m.role,
      content: c,
      ts: m.ts,
      stopped: Boolean(m.stopped),
    });
    l0chars += c.length;
  }
  // If L0 starts mid-assistant without its user, try to pull one more user message
  if (l0.length && l0[0].role === 'assistant') {
    const idx = msgs.length - l0.length - 1;
    if (idx >= 0 && msgs[idx].role === 'user') {
      const u = msgs[idx];
      const c = String(u.content);
      if (l0chars + c.length <= L0_MAX_CHARS + 2000) {
        l0.unshift({ role: 'user', content: c, ts: u.ts });
        l0chars += c.length;
      }
    }
  }
  return { l0, l0chars };
}

/**
 * @param {Array<{role:string, content:string, ts?:number, stopped?:boolean}>} messages
 * @param {{
 *   prev?: object,
 *   projectName?: string,
 *   taskTitle?: string,
 *   workMode?: string,
 *   turns?: Array<object>,
 *   changedFiles?: string[],
 *   lastStopped?: boolean,
 * }} opts
 */
function compressContext(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages.filter((m) => m && m.content) : [];
  const prev = opts.prev || {};
  const workMode = opts.workMode || prev.workMode || '';
  const turns = Array.isArray(opts.turns) ? opts.turns : prev.turns || [];
  const changedFiles = Array.isArray(opts.changedFiles)
    ? opts.changedFiles
    : prev.changedFiles || [];

  const { l0, l0chars } = pickL0(msgs);
  const l0Start = msgs.length - l0.length;
  const older = msgs.slice(0, Math.max(0, l0Start));

  // ── L1：近端摘要 ──
  const l1Parts = [];
  if (prev.l1) {
    // Keep only denser prior L1 lines (avoid unbounded growth of stale bullets)
    const prevLines = String(prev.l1)
      .split(/\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(-24);
    l1Parts.push(...prevLines);
  }
  for (const m of older) {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Grok' : m.role;
    const head = oneLine(m.content).slice(0, 160);
    const paths = extractPaths(m.content).slice(0, 4);
    const pathHint = paths.length ? ` 〔${paths.join(', ')}〕` : '';
    const flag = m.stopped ? ' [中断]' : '';
    const bullets = m.role === 'assistant' ? extractBullets(m.content, 2) : [];
    if (bullets.length) {
      l1Parts.push(`- ${role}${flag}: ${head}${pathHint}`);
      bullets.forEach((b) => l1Parts.push(`  · ${oneLine(b).slice(0, 120)}`));
    } else {
      l1Parts.push(`- ${role}${flag}: ${head}${pathHint}`);
    }
  }
  let l1 = uniqueLines(l1Parts).join('\n');
  l1 = clip(l1, L1_MAX_CHARS);

  // ── L2：会话脉络 ──
  const userGoals = msgs
    .filter((m) => m.role === 'user')
    .map((m) => oneLine(m.content).slice(0, 140))
    .filter(Boolean);
  const recentGoals = uniqueLines(userGoals).slice(-8);

  const allPaths = new Set();
  for (const m of msgs) extractPaths(m.content).forEach((p) => allPaths.add(p));
  if (prev.l2Paths) prev.l2Paths.forEach((p) => allPaths.add(p));
  for (const f of changedFiles) {
    if (f) allPaths.add(String(f).replace(/\\/g, '/'));
  }

  const outcomes = [];
  const openQs = [];
  for (const m of msgs.filter((x) => x.role === 'assistant')) {
    extractBullets(m.content, 5).forEach((b) => outcomes.push(b));
    extractOpenQuestions(m.content, 3).forEach((q) => openQs.push(q));
  }
  for (const m of msgs.filter((x) => x.role === 'user')) {
    extractOpenQuestions(m.content, 2).forEach((q) => openQs.push(q));
  }
  const outcomeLines = uniqueLines(outcomes).slice(-14);
  const openLines = uniqueLines(openQs).slice(-8);

  const stoppedCount = msgs.filter((m) => m.stopped).length;
  const turnBits = [];
  if (turns.length) {
    const recentTurns = turns.slice(-6);
    for (const t of recentTurns) {
      const mode = (t.mode || '?').toUpperCase();
      const st = t.stopped ? '停' : t.error ? '败' : t.endedAt ? '完' : '中';
      const tools = t.tools != null ? ` ${t.tools}t` : '';
      turnBits.push(`${mode}/${st}${tools}`);
    }
  }

  const l2Sections = [
    `项目: ${opts.projectName || 'unknown'}${opts.taskTitle ? ` · 任务: ${opts.taskTitle}` : ''}${
      workMode ? ` · 模式: ${workMode}` : ''
    }`,
    recentGoals.length ? `目标/请求:\n${recentGoals.map((g) => `  · ${g}`).join('\n')}` : '',
    outcomeLines.length ? `已推进:\n${outcomeLines.map((g) => `  · ${g}`).join('\n')}` : '',
    openLines.length ? `开放/待办:\n${openLines.map((g) => `  · ${g}`).join('\n')}` : '',
    allPaths.size
      ? `关键文件:\n${[...allPaths]
          .slice(0, 28)
          .map((f) => `  · ${f}`)
          .join('\n')}`
      : '',
    changedFiles.length
      ? `本会话 Diff 变更:\n${changedFiles
          .slice(0, 20)
          .map((f) => `  · ${String(f).replace(/\\/g, '/')}`)
          .join('\n')}`
      : '',
    turnBits.length ? `回合轨迹: ${turnBits.join(' → ')}` : '',
    stoppedCount ? `注意: 历史中有 ${stoppedCount} 条中断输出，续跑时勿重复已完成步骤` : '',
    opts.lastStopped ? `注意: 上一轮被用户停止，优先从断点继续` : '',
    `消息数: ${msgs.length} · 更新: ${new Date().toISOString()}`,
  ];

  const l2 = clip(l2Sections.filter(Boolean).join('\n\n'), L2_MAX_CHARS);

  // ── L3：项目记忆 ──
  const durable = [];
  if (prev.l3) {
    String(prev.l3)
      .split(/\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(-30)
      .forEach((line) => durable.push(line));
  }
  for (const m of msgs.filter((x) => x.role === 'user')) {
    if (isConstraintMessage(m.content)) {
      durable.push(`· 偏好/约束: ${oneLine(m.content).slice(0, 180)}`);
    }
  }
  const pathCount = {};
  for (const m of msgs) {
    for (const f of extractPaths(m.content)) {
      pathCount[f] = (pathCount[f] || 0) + 1;
    }
  }
  for (const f of changedFiles) {
    const k = String(f).replace(/\\/g, '/');
    pathCount[k] = (pathCount[k] || 0) + 2; // weight live diffs
  }
  const hotFiles = Object.entries(pathCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
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
    stoppedCount,
    changedFiles: changedFiles.length,
    updatedAt: Date.now(),
  };

  return {
    l0,
    l1,
    l2,
    l3,
    l2Paths: [...allPaths].slice(0, 48),
    workMode: workMode || undefined,
    turns: turns.slice(-12),
    changedFiles: changedFiles.slice(0, 40),
    stats,
    tiers: [
      {
        id: 'L0',
        name: '即时原文',
        desc: '最近对话完整保留（成对优先）',
        chars: l0chars,
        count: l0.length,
      },
      {
        id: 'L1',
        name: '近端摘要',
        desc: '滑出窗口的要点压缩',
        chars: l1.length,
        count: older.length,
      },
      {
        id: 'L2',
        name: '会话脉络',
        desc: '目标/进展/待办/文件/回合',
        chars: l2.length,
      },
      {
        id: 'L3',
        name: '项目记忆',
        desc: '跨会话耐久事实与约束',
        chars: l3.length,
      },
    ],
  };
}

/**
 * 拼装注入 CLI 的上下文前缀
 */
function buildContextPrompt(context, userMessage, meta = {}) {
  const c = context || {};
  const parts = [];
  parts.push('【GrokCode 上下文继承 · 四档压缩】');
  parts.push(
    `项目: ${meta.projectName || '?'} · 任务: ${meta.taskTitle || '?'}${
      meta.workMode ? ` · 模式: ${meta.workMode}` : ''
    } · 已继承历史（关窗可续）`
  );

  if (c.l3 && String(c.l3).trim()) {
    parts.push('\n## L3 项目记忆（耐久 · 优先遵守约束）\n' + String(c.l3).trim());
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
      const stop = m.stopped ? ' · interrupted' : '';
      parts.push(`\n### ${role}${stop}\n${clip(m.content, 4500)}`);
    }
  }

  parts.push('\n## 当前用户请求\n' + String(userMessage || '').trim());

  const contHints = [];
  if (meta.continueFrom || meta.lastStopped || c.stats?.stoppedCount) {
    contHints.push('上一轮可能被中断：从断点继续，不要重复已完成步骤。');
  }
  if (Array.isArray(c.changedFiles) && c.changedFiles.length) {
    contHints.push(
      `本会话已改文件（Diff）：${c.changedFiles
        .slice(0, 12)
        .map((f) => String(f).replace(/\\/g, '/'))
        .join(', ')}`
    );
  }
  contHints.push('请在完整继承上述上下文的前提下继续；不要假装遗忘已完成事项；改动保持聚焦。');
  parts.push('\n（' + contHints.join(' ') + '）');

  return parts.join('\n');
}

module.exports = {
  compressContext,
  buildContextPrompt,
  extractPaths,
  extractBullets,
  extractOpenQuestions,
  L0_MAX_MESSAGES,
  L0_MAX_CHARS,
};
