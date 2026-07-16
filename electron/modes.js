/**
 * Work modes & style packs — inspired by desktop agent UX patterns,
 * content is GrokCode / Grok-native (not third-party prompts).
 */

/** Canonical work-mode ids (UI + config + IPC) */
const WORK_MODE_IDS = ['craft', 'plan', 'ask', 'goal'];

function normalizeWorkMode(mode) {
  const m = String(mode || '').toLowerCase();
  return WORK_MODE_IDS.includes(m) ? m : 'craft';
}

const MODES = {
  craft: {
    id: 'craft',
    labelZh: 'Craft',
    labelEn: 'Craft',
    descZh: '直接动手：读写跑命令',
    descEn: 'Act now: read, write, run',
    rules: [
      '【工作模式：Craft · 飞行模式】用户要结果就直接干。',
      '改动聚焦需求；能写文件就写；该跑命令就跑；改完做必要检查；少废话。',
      '多步骤时按序推进，不要只列方案就停（除非明显缺关键信息）。',
      '默认在项目工作区内操作，不要越权改系统/用户主目录。',
    ].join('\n'),
  },
  plan: {
    id: 'plan',
    labelZh: 'Plan',
    labelEn: 'Plan',
    descZh: '先方案，确认后再改',
    descEn: 'Plan first, act after confirm',
    rules: [
      '【工作模式：Plan】先想清楚再动手。',
      '第一步：用简短中文给出目标、步骤、涉及文件、风险；不要立刻大改代码。',
      '只有用户明确说「执行」「开干」「按方案做」「implement the plan」后，才开始写文件/跑破坏性命令。',
      '若信息不足，先提问再列方案。',
    ].join('\n'),
  },
  ask: {
    id: 'ask',
    labelZh: 'Ask',
    labelEn: 'Ask',
    descZh: '只读问答，不改磁盘',
    descEn: 'Read-only Q&A',
    rules: [
      '【工作模式：Ask · 只读】',
      '可以读文件、解释代码、分析问题。',
      '禁止：写文件、删文件、改配置、跑会修改系统状态的命令（安装包、git push、rm 等）。',
      '若用户要求动手，提示切换到 Craft、Plan 或 Goal 模式。',
      '回复给方案与示例代码块即可，不要声称已写入磁盘。',
    ].join('\n'),
  },
  goal: {
    id: 'goal',
    labelZh: 'Goal',
    labelEn: 'Goal',
    descZh: '锚定目标 · 分里程碑推进到完成',
    descEn: 'Anchor a goal · ship by milestones',
    rules: [
      '【工作模式：Goal · 目标模式】',
      '用户给出的是「要达成的目标」，不是一次性闲聊。',
      '先用 1–2 行确认目标与成功标准，再拆成 3–7 个可验证里程碑，然后立即动手推进（可读可写可跑命令）。',
      '每一轮结束用固定小节汇报进度（便于 UI 解析）：',
      '【目标进度】',
      '- 目标：…',
      '- 进度：N%（或 已完成/受阻）',
      '- 本轮完成：…',
      '- 下一步：…',
      '未完成目标时优先继续推进，不要半途只停在方案；信息不足再问。',
      '用户说「目标完成 / goal done / 算了」时收尾并总结验收。',
    ].join('\n'),
  },
};

const STYLES = {
  default: {
    id: 'default',
    labelZh: '默认 · Grok',
    labelEn: 'Default · Grok',
    rules: '语气：锐利、直接、有态度；优先中文。',
  },
  pragmatic: {
    id: 'pragmatic',
    labelZh: '高效务实',
    labelEn: 'Pragmatic',
    rules: '语气：极简、高信息密度；少寒暄；列表/要点优先。',
  },
  teaching: {
    id: 'teaching',
    labelZh: '启发教学',
    labelEn: 'Socratic',
    rules: '语气：像老师；关键处用简短问题引导理解；仍要给出可执行结论。',
  },
  warm: {
    id: 'warm',
    labelZh: '亲和友善',
    labelEn: 'Warm',
    rules: '语气：友好鼓励；错误时先安抚再给修复步骤；仍要准确。',
  },
  blunt: {
    id: 'blunt',
    labelZh: '直言不讳',
    labelEn: 'Blunt',
    rules: '语气：直球；坏设计直接说；不绕弯；保持专业不人身攻击。',
  },
};

/** Personal-path protection levels */
const PERSONAL_PROTECT = {
  off: 'off',
  standard: 'standard',
  strict: 'strict',
};

function isPersonalPath(absPath) {
  const os = require('os');
  const path = require('path');
  const home = os.homedir();
  const abs = path.resolve(absPath);
  const homeAbs = path.resolve(home);
  if (abs === homeAbs) return true;
  const rel = path.relative(homeAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // under home
  const top = rel.split(/[/\\]/)[0].toLowerCase();
  const hot = new Set([
    'desktop',
    'downloads',
    'documents',
    'pictures',
    'videos',
    'music',
    'onedrive',
    'appdata',
    // Chinese Windows folder names (common)
    '桌面',
    '下载',
    '文档',
    '图片',
    '视频',
    '音乐',
  ]);
  if (hot.has(top)) return true;
  // any path under home treated as personal in strict mode is handled by caller
  return rel.length > 0; // under home but not necessarily "hot" — caller uses level
}

function isHotPersonalPath(absPath) {
  const os = require('os');
  const path = require('path');
  const home = path.resolve(os.homedir());
  const abs = path.resolve(absPath);
  const rel = path.relative(home, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const top = (rel.split(/[/\\]/)[0] || '').toLowerCase();
  return [
    'desktop',
    'downloads',
    'documents',
    'pictures',
    'videos',
    'music',
    'onedrive',
    '桌面',
    '下载',
    '文档',
    '图片',
    '视频',
    '音乐',
  ].includes(top);
}

/**
 * Merge base rules + project rules + style + mode for CLI --rules
 * projectRules typically from workspace `.grok/rules` or `.grok/rules.md`
 */
function buildRules({
  baseRules = '',
  projectRules = '',
  workMode = 'craft',
  stylePack = 'default',
} = {}) {
  const mode = MODES[normalizeWorkMode(workMode)] || MODES.craft;
  const style = STYLES[stylePack] || STYLES.default;
  const parts = [
    String(baseRules || '').trim(),
    String(projectRules || '').trim()
      ? `【项目规则 · .grok/rules】\n${String(projectRules).trim()}`
      : '',
    style.rules,
    mode.rules,
  ].filter(Boolean);
  return parts.join('\n\n');
}

/** Read project-level rules file if present */
function readProjectRulesFile(projectPath) {
  if (!projectPath) return { text: '', file: null };
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(projectPath, '.grok', 'rules.md'),
    path.join(projectPath, '.grok', 'rules'),
    path.join(projectPath, '.grok', 'RULES.md'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const text = fs.readFileSync(file, 'utf8');
        return { text: String(text || '').slice(0, 20_000), file };
      }
    } catch {
      /* ignore */
    }
  }
  return { text: '', file: null };
}

function writeProjectRulesFile(projectPath, content) {
  if (!projectPath) throw new Error('需要项目路径');
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(projectPath, '.grok');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rules.md');
  fs.writeFileSync(file, String(content ?? ''), 'utf8');
  return { ok: true, file };
}

/** User confirmed “go implement the plan” */
function isPlanExecutePhrase(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Short confirmations
  if (
    /^(执行|开干|按方案|按方案做|按方案执行|implement|execute|do it|lgtm|开搞|动手|开始改|开始实现|go|ship it|run it)[\s!！。.~]*$/i.test(
      t
    )
  ) {
    return true;
  }
  // Longer “execute the plan …” messages
  if (
    /^(执行方案|执行计划|implement the plan|execute the plan|start implementing)/i.test(t) ||
    /^(请)?(开始)?(执行|实现|落地).{0,24}(方案|计划|plan)/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Heuristic: assistant reply looks like an actionable plan (shared with desktop UI tests)
 */
function looksLikePlan(text) {
  const t = String(text || '');
  if (t.length < 60) return false;
  let score = 0;
  if (
    /(目标|步骤|涉及文件|风险|实施计划|执行步骤|验收|plan|steps?|risks?|files?\s*(to\s*)?(change|touch|edit)?)/i.test(
      t
    )
  ) {
    score += 2;
  }
  const nums = t.match(/(^|\n)\s*(\d+[\.\)、]|[一二三四五六七八九十]+[、\.\)])\s+\S+/g);
  if (nums && nums.length >= 2) score += 3;
  else if (nums && nums.length === 1) score += 1;
  const bullets = t.match(/(^|\n)\s*[-*•]\s+\S+/g);
  if (bullets && bullets.length >= 3) score += 2;
  if (/(接下来|然后|首先|最后|TODO|实施|改动|建议)/i.test(t)) score += 1;
  if (
    /`[^`]+\.(js|ts|tsx|py|go|rs|java|css|html|md)`/i.test(t) ||
    /[\w./\\-]+\.(js|ts|tsx|py|go|rs)\b/.test(t)
  ) {
    score += 1;
  }
  const codeBlocks = (t.match(/```/g) || []).length;
  if (codeBlocks >= 4 && score < 4) return false;
  return score >= 4;
}

/**
 * Build the Craft-turn prompt used when user confirms a plan.
 * Embeds a capped plan excerpt so CLI has the steps even if session is thin.
 */
function buildPlanExecutePrompt(planText, { locale = 'zh' } = {}) {
  const plan = String(planText || '').trim();
  const cap = 7000;
  const body = plan.length > cap ? plan.slice(0, cap) + '\n…' : plan;
  if (locale === 'en') {
    if (!body) {
      return (
        'Execute the plan from your previous message. Implement step by step, ' +
        'skip finished items, keep changes focused, then run necessary checks.'
      );
    }
    return (
      'Execute this plan now (Craft flight). Implement remaining steps; do not re-plan unless blocked.\n\n' +
      '—— PLAN ——\n' +
      body +
      '\n—— END PLAN ——\n\n' +
      'Work through the steps, write the code, and summarize what changed + how to verify.'
    );
  }
  if (!body) {
    return '执行方案：按你上一条给出的步骤动手实现，跳过已完成项，保持聚焦，改完做必要检查。';
  }
  return (
    '执行下列方案（Craft 飞行模式）。按步骤落地；已完成的跳过；缺信息再问；改完做必要检查。\n\n' +
    '—— 方案 ——\n' +
    body +
    '\n—— 方案结束 ——\n\n' +
    '动手改代码；结束后用 2–5 行说明改了什么、怎么验。'
  );
}

/** Short title from a free-form goal statement */
function extractGoalTitle(text, { maxLen = 72 } = {}) {
  let t = String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!t) return '';
  // Strip common prefixes
  t = t.replace(
    /^(目标[:：\s]*|goal\s*[:：-]?\s*|我希望|我想要|请帮我|帮我|实现|完成|做到)\s*/i,
    ''
  );
  const firstLine = t.split(/[\n。！？.!?]/)[0] || t;
  const s = firstLine.trim() || t;
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/** User ends / abandons the goal */
function isGoalDonePhrase(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /^(目标完成|完成目标|goal\s*done|goal\s*complete|mark\s*done|算了|放弃目标|取消目标)[\s!！。.~]*$/i.test(
    t
  );
}

/**
 * Parse 【目标进度】 block (or loose %) from assistant text
 * @returns {{ progress?: number, status?: string, title?: string, next?: string } | null}
 */
function parseGoalProgress(text) {
  const t = String(text || '');
  if (!t) return null;
  const out = {};
  const block = t.match(/【目标进度】([\s\S]{0,800}?)(?=\n【|\n##\s|$)/);
  const body = block ? block[1] : t.slice(-1200);
  const titleM = body.match(/(?:目标|Goal)\s*[:：]\s*(.+)/i);
  if (titleM) out.title = titleM[1].trim().slice(0, 120);
  const progM = body.match(/(?:进度|Progress)\s*[:：]\s*(\d{1,3})\s*%/i);
  if (progM) out.progress = Math.max(0, Math.min(100, parseInt(progM[1], 10)));
  else {
    const loose = body.match(/\b(\d{1,3})\s*%/);
    if (loose && /进度|progress|完成/i.test(body)) {
      out.progress = Math.max(0, Math.min(100, parseInt(loose[1], 10)));
    }
  }
  if (
    /进度\s*[:：]\s*(已完成|完成|done|complete)/i.test(body) ||
    /目标完成|goal\s*(done|complete|achieved)/i.test(t)
  ) {
    out.status = 'done';
    out.progress = 100;
  } else if (/进度\s*[:：]\s*(受阻|blocked|卡住)/i.test(body)) {
    out.status = 'blocked';
  } else if (out.progress === 100) {
    out.status = 'done';
  } else if (out.progress != null || out.title) {
    out.status = 'active';
  }
  const nextM = body.match(/(?:下一步|Next)\s*[:：]\s*(.+)/i);
  if (nextM) out.next = nextM[1].trim().slice(0, 160);
  if (out.progress == null && !out.status && !out.title) return null;
  return out;
}

/** Inject sticky goal into prompt (renderer passes task.goal) */
function buildGoalPromptBlock(goal) {
  if (!goal || !goal.title) return '';
  const status = goal.status || 'active';
  const prog = goal.progress != null ? `${goal.progress}%` : '—';
  const next = goal.next ? `\n- 下一步提示：${String(goal.next).slice(0, 160)}` : '';
  return (
    `【锚定目标 · Goal track】\n` +
    `- 目标：${String(goal.title).slice(0, 200)}\n` +
    `- 状态：${status}\n` +
    `- 进度：${prog}${next}\n` +
    `请继续向该目标推进；回合末输出【目标进度】小节。\n\n`
  );
}

/**
 * Extra prompt prefix for modes
 */
function modePromptPrefix(workMode, userMessage, opts = {}) {
  const mode = normalizeWorkMode(workMode);
  if (mode === 'plan') {
    if (isPlanExecutePhrase(userMessage)) {
      return (
        '【Plan → Craft 执行确认】用户已确认执行方案。' +
        '现在切换为动手模式：按先前（或本消息附带的）方案改代码/跑命令；' +
        '不要只复述方案；跳过已完成步骤；改完做必要检查。\n\n'
      );
    }
    return (
      '【Plan 模式】先输出简洁可执行方案，建议结构：\n' +
      '1) 目标 2) 步骤（编号）3) 涉及文件 4) 风险/验收\n' +
      '除非用户已确认执行（如「执行」「开干」「implement the plan」），否则不要批量改代码。\n' +
      '方案要短而可执行，避免空话。\n\n'
    );
  }
  if (mode === 'ask') {
    return '【Ask 模式 · 只读】只分析与回答；不要写文件、不要删文件、不要跑修改性命令。\n\n';
  }
  if (mode === 'goal') {
    const goalBlock = buildGoalPromptBlock(opts.goal);
    if (isGoalDonePhrase(userMessage)) {
      return (
        goalBlock +
        '【Goal 收尾】用户要求结束目标。汇总已完成项、未完成项与如何验收；不要再大范围改代码，除非用户又提新目标。\n\n'
      );
    }
    return (
      goalBlock +
      '【Goal 模式 · 目标驱动】确认/继承锚定目标 → 拆里程碑 → 立即动手推进。' +
      '每轮末必须有【目标进度】（目标 / 进度% / 本轮完成 / 下一步）。少空话，多可验证进展。\n\n'
    );
  }
  // Craft — default flight mode
  return (
    '【工作模式：Craft · 飞行模式】直接完成用户请求。' +
    '优先改代码与跑必要命令；少寒暄；改动聚焦；多步骤连续推进直到可交付。' +
    '完成后用 2–5 行说明改了什么、怎么验；工作区外危险操作要先说明风险。\n\n'
  );
}

function listModes() {
  return Object.values(MODES).map((m) => ({
    id: m.id,
    labelZh: m.labelZh,
    labelEn: m.labelEn,
    descZh: m.descZh,
    descEn: m.descEn,
  }));
}

function listStyles() {
  return Object.values(STYLES).map((s) => ({
    id: s.id,
    labelZh: s.labelZh,
    labelEn: s.labelEn,
  }));
}

module.exports = {
  MODES,
  WORK_MODE_IDS,
  STYLES,
  PERSONAL_PROTECT,
  normalizeWorkMode,
  buildRules,
  readProjectRulesFile,
  writeProjectRulesFile,
  modePromptPrefix,
  isPlanExecutePhrase,
  isGoalDonePhrase,
  extractGoalTitle,
  parseGoalProgress,
  buildGoalPromptBlock,
  looksLikePlan,
  buildPlanExecutePrompt,
  listModes,
  listStyles,
  isPersonalPath,
  isHotPersonalPath,
};
