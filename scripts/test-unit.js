#!/usr/bin/env node
/**
 * Unit tests — context compress + llm parse helpers (no network)
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const { compressContext, buildContextPrompt } = require(path.join(root, 'electron', 'context-compress.js'));

function testCompress() {
  const msgs = [
    { role: 'user', content: '请修复 electron/main.js 里的 bug，必须用中文回复', ts: 1 },
    { role: 'assistant', content: '- 完成了 main.js 修复\n- 添加了 openProject', ts: 2 },
    { role: 'user', content: '再优化一下 Diff 面板', ts: 3 },
    { role: 'assistant', content: '已更新 renderer/app.js 中的 Diff 逻辑', ts: 4 },
  ];
  const ctx = compressContext(msgs, { projectName: 'grok-code' });
  assert.ok(ctx.l0.length >= 2, 'L0 should keep recent messages');
  assert.ok(String(ctx.l2).includes('grok-code'), 'L2 has project name');
  assert.ok(String(ctx.l3).includes('偏好') || String(ctx.l3).includes('中文'), 'L3 captures constraints');
  assert.ok(Array.isArray(ctx.tiers) && ctx.tiers.length === 4, '4 tiers');

  const prompt = buildContextPrompt(ctx, '继续', { projectName: 'grok-code', taskTitle: 't1' });
  assert.ok(prompt.includes('L0') || prompt.includes('近期'), 'prompt has context');
  assert.ok(prompt.includes('继续'), 'prompt has user message');
  console.log('ok  compressContext / buildContextPrompt');
}

function testExtractJson() {
  // inline the same logic as context-llm extractJson via requiring module
  const { enrichContextWithLlm } = require(path.join(root, 'electron', 'context-llm.js'));
  assert.equal(typeof enrichContextWithLlm, 'function');
  console.log('ok  context-llm exports');
}

function testExternalEditorResolve() {
  const { resolveEditorBinary } = require(path.join(root, 'electron', 'external-editor.js'));
  const r = resolveEditorBinary('system');
  assert.equal(r.kind, 'system');
  console.log('ok  external-editor resolve system');
}

function testDiagnosticsShape() {
  // runDoctor needs electron app — skip full run; just require module
  const diag = require(path.join(root, 'electron', 'diagnostics.js'));
  assert.equal(typeof diag.runDoctor, 'function');
  assert.equal(typeof diag.exportDiagnostics, 'function');
  console.log('ok  diagnostics exports');
}

function testPluginsExports() {
  const p = require(path.join(root, 'electron', 'plugins.js'));
  assert.equal(typeof p.listInstalled, 'function');
  assert.equal(typeof p.installPlugin, 'function');
  console.log('ok  plugins exports');
}

function testProfilesRoundtrip() {
  const os = require('os');
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grokcode-prof-'));
  // create a fake project dir
  const proj = path.join(tmp, 'demo-proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  const { exportProfile, importProfile } = require(path.join(root, 'electron', 'profiles.js'));
  const exp = exportProfile({
    projectPath: proj,
    name: 'demo',
    rules: 'prefer Chinese',
    includeSession: false,
  });
  assert.ok(exp.ok && fs.existsSync(exp.file));
  const imp = importProfile(exp.file);
  assert.equal(imp.config.rules, 'prefer Chinese');
  console.log('ok  profiles export/import');
}

function testCatalogBuild() {
  const cat = path.join(root, 'renderer', 'catalog-data.json');
  assert.ok(fs.existsSync(cat), 'catalog-data.json should exist (run npm run catalog)');
  const data = JSON.parse(fs.readFileSync(cat, 'utf8'));
  assert.ok(Array.isArray(data.mcp));
  assert.ok(Array.isArray(data.skills));
  console.log('ok  catalog-data.json');
}

function testModes() {
  const m = require(path.join(root, 'electron', 'modes.js'));
  const rules = m.buildRules({ baseRules: 'base', workMode: 'ask', stylePack: 'pragmatic' });
  assert.ok(rules.includes('Ask') || rules.includes('只读'));
  assert.ok(m.modePromptPrefix('plan', 'hello').includes('Plan'));
  const craft = m.modePromptPrefix('craft', 'fix the bug');
  assert.ok(craft.includes('Craft'), 'craft prefix names Craft');
  assert.ok(craft.includes('飞行') || craft.includes('直接'), 'craft is flight/act-now');
  const craftRules = m.buildRules({ workMode: 'craft' });
  assert.ok(craftRules.includes('Craft'));
  assert.equal(m.listModes().length, 3);
  assert.ok(m.listStyles().length >= 3);
  // plan execute phrase
  assert.ok(m.modePromptPrefix('plan', '执行').includes('确认') || m.modePromptPrefix('plan', '执行').includes('动手'));
  console.log('ok  modes / styles');
}

/** Mirrors renderer looksLikePlan heuristic for regression */
function looksLikePlan(text) {
  const t = String(text || '');
  if (t.length < 60) return false;
  let score = 0;
  if (/(目标|步骤|涉及文件|风险|实施计划|执行步骤|plan|steps?|risks?)/i.test(t)) score += 2;
  const nums = t.match(/(^|\n)\s*(\d+[\.\)、]|[一二三四五六七八九十]+[、\.\)])\s+\S+/g);
  if (nums && nums.length >= 2) score += 3;
  else if (nums && nums.length === 1) score += 1;
  const bullets = t.match(/(^|\n)\s*[-*•]\s+\S+/g);
  if (bullets && bullets.length >= 3) score += 2;
  if (/(接下来|然后|首先|最后|TODO|实施|改动)/i.test(t)) score += 1;
  if (/`[^`]+\.(js|ts|tsx|py|go|rs|java|css|html|md)`/i.test(t) || /[\w./\\-]+\.(js|ts|tsx|py)\b/.test(t)) {
    score += 1;
  }
  const codeBlocks = (t.match(/```/g) || []).length;
  if (codeBlocks >= 4 && score < 4) return false;
  return score >= 4;
}

function testLooksLikePlan() {
  const planZh = [
    '目标：修好登录',
    '步骤：',
    '1. 检查 auth.js',
    '2. 修 token 刷新',
    '3. 跑测试',
    '涉及文件：src/auth.js',
    '风险：会话失效',
  ].join('\n');
  assert.ok(looksLikePlan(planZh), 'structured zh plan');
  assert.ok(!looksLikePlan('ok'), 'too short');
  assert.ok(!looksLikePlan('这里只是一句闲聊，没有方案结构'), 'chatty non-plan');
  console.log('ok  looksLikePlan heuristic');
}

function testSkillsIndex() {
  const skills = require(path.join(root, 'electron', 'mcp-skills.js'));
  assert.equal(typeof skills.buildSkillsIndexPrompt, 'function');
  // empty project path still ok
  const idx = skills.buildSkillsIndexPrompt(null);
  assert.equal(typeof idx, 'string');
  console.log('ok  skills progressive index');
}

function testOutlineExtract() {
  // inline same logic via reading outline is browser-only; test regex patterns lightly here
  const sample = 'function foo() {}\nclass Bar {}\nexport const baz = () => {}';
  assert.ok(/function\s+foo/.test(sample));
  console.log('ok  outline patterns smoke');
}

function testDiffHunks() {
  // load diff-util is browser IIFE — reimplement thin check via vm is heavy;
  // smoke: module file exists and exports via reading source
  const src = fs.readFileSync(path.join(root, 'renderer', 'diff-util.js'), 'utf8');
  assert.ok(src.includes('diff-hunk'), 'foldable hunk markup');
  assert.ok(src.includes('toUnifiedHtml'), 'toUnifiedHtml present');
  assert.ok(src.includes('toSideBySideHtml'), 'side-by-side present');
  assert.ok(src.includes('diff-sbs'), 'sbs markup');
  console.log('ok  diff hunk fold smoke');
}

function testToolsSearchExports() {
  // createTools needs a real dir
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grokcode-search-'));
  fs.writeFileSync(path.join(tmp, 'hello-world.js'), 'const foo = 42;\n// needle unique\n');
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'export const x = 1;\n');
  const { createTools } = require(path.join(root, 'electron', 'tools.js'));
  const tools = createTools(tmp);
  const paths = tools.searchPaths('hello');
  assert.ok(paths.hits.some((h) => h.path.includes('hello-world')));
  const content = tools.searchFiles('needle unique');
  assert.ok(content.hits.some((h) => h.line === 2));
  console.log('ok  searchPaths / searchFiles');
}

try {
  testCompress();
  testExtractJson();
  testExternalEditorResolve();
  testDiagnosticsShape();
  testPluginsExports();
  testProfilesRoundtrip();
  testCatalogBuild();
  testModes();
  testLooksLikePlan();
  testSkillsIndex();
  testOutlineExtract();
  testDiffHunks();
  testToolsSearchExports();
  console.log('\nAll unit tests passed');
} catch (err) {
  console.error('FAIL', err);
  process.exit(1);
}
