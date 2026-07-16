/**
 * Work modes & style packs — inspired by desktop agent UX patterns,
 * content is GrokCode / Grok-native (not third-party prompts).
 */

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
      '若用户要求动手，提示切换到 Craft 或 Plan 模式。',
      '回复给方案与示例代码块即可，不要声称已写入磁盘。',
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
 * Merge base rules + style + mode for CLI --rules
 */
function buildRules({ baseRules = '', workMode = 'craft', stylePack = 'default' } = {}) {
  const mode = MODES[workMode] || MODES.craft;
  const style = STYLES[stylePack] || STYLES.default;
  const parts = [String(baseRules || '').trim(), style.rules, mode.rules].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * Extra prompt prefix for modes
 */
function modePromptPrefix(workMode, userMessage) {
  if (workMode === 'plan') {
    const exec =
      /^(执行|开干|按方案|implement|execute|do it|lgtm|开搞)/i.test(String(userMessage || '').trim());
    if (exec) {
      return '【Plan 模式 · 用户已确认执行】现在按先前方案动手；保持聚焦，改完检查。\n\n';
    }
    return '【Plan 模式】先输出简洁可执行方案（目标/步骤/文件/风险），除非用户已确认执行，否则不要批量改代码。\n\n';
  }
  if (workMode === 'ask') {
    return '【Ask 模式 · 只读】只分析与回答；不要写文件、不要删文件、不要跑修改性命令。\n\n';
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
  STYLES,
  PERSONAL_PROTECT,
  buildRules,
  modePromptPrefix,
  listModes,
  listStyles,
  isPersonalPath,
  isHotPersonalPath,
};
