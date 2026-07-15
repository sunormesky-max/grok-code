#!/usr/bin/env node
/**
 * Unit tests — context compress + llm parse helpers (no network)
 */
const assert = require('assert');
const path = require('path');

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

try {
  testCompress();
  testExtractJson();
  testExternalEditorResolve();
  testDiagnosticsShape();
  console.log('\nAll unit tests passed');
} catch (err) {
  console.error('FAIL', err);
  process.exit(1);
}
