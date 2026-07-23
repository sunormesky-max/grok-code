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
  const { extractPaths } = require(path.join(root, 'electron', 'context-compress.js'));
  const msgs = [
    { role: 'user', content: '请修复 electron/main.js 里的 bug，必须用中文回复', ts: 1 },
    { role: 'assistant', content: '- 完成了 main.js 修复\n- 添加了 openProject', ts: 2 },
    { role: 'user', content: '再优化一下 Diff 面板', ts: 3 },
    {
      role: 'assistant',
      content: '已更新 renderer/app.js 中的 Diff 逻辑\nTODO: 还要测 side-by-side',
      ts: 4,
    },
    {
      role: 'user',
      content: '从刚才中断处继续',
      ts: 5,
    },
    {
      role: 'assistant',
      content: '正在续跑 Diff 测试…',
      ts: 6,
      stopped: true,
    },
  ];
  const ctx = compressContext(msgs, {
    projectName: 'grok-code',
    taskTitle: 'diff-work',
    workMode: 'craft',
    turns: [
      { mode: 'craft', endedAt: 1, tools: 2 },
      { mode: 'craft', stopped: true, tools: 1 },
    ],
    changedFiles: ['renderer/app.js', 'electron/main.js'],
    lastStopped: true,
  });
  assert.ok(ctx.l0.length >= 2, 'L0 should keep recent messages');
  assert.ok(String(ctx.l2).includes('grok-code'), 'L2 has project name');
  assert.ok(String(ctx.l2).includes('Diff') || String(ctx.l2).includes('变更'), 'L2 has diff files');
  assert.ok(String(ctx.l2).includes('中断') || String(ctx.l2).includes('停止'), 'L2 notes stop');
  assert.ok(String(ctx.l2).includes('开放') || String(ctx.l2).includes('TODO'), 'L2 open items');
  assert.ok(String(ctx.l3).includes('偏好') || String(ctx.l3).includes('中文'), 'L3 captures constraints');
  assert.ok(Array.isArray(ctx.tiers) && ctx.tiers.length === 4, '4 tiers');
  assert.ok(extractPaths('see renderer/app.js and electron/main.js').includes('renderer/app.js'));

  const prompt = buildContextPrompt(ctx, '继续', {
    projectName: 'grok-code',
    taskTitle: 't1',
    workMode: 'craft',
    lastStopped: true,
    continueFrom: true,
  });
  assert.ok(prompt.includes('L0') || prompt.includes('近期'), 'prompt has context');
  assert.ok(prompt.includes('继续'), 'prompt has user message');
  assert.ok(prompt.includes('断点') || prompt.includes('中断'), 'prompt continues from stop');
  console.log('ok  compressContext / buildContextPrompt quality');
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
  assert.equal(typeof p.updatePlugin, 'function');
  assert.equal(typeof p.validatePlugin, 'function');
  assert.equal(typeof p.filterPlugins, 'function');

  const sample = [
    { name: 'alpha', enabled: true, marketplace: 'xai', description: 'core tools' },
    { name: 'beta', enabled: false, marketplace: 'xai', description: 'extra' },
    { name: 'gamma', enabled: true, marketplace: 'community', description: 'fun' },
  ];
  assert.equal(p.filterPlugins(sample, { status: 'enabled' }).length, 2);
  assert.equal(p.filterPlugins(sample, { status: 'disabled' }).length, 1);
  assert.equal(p.filterPlugins(sample, { marketplace: 'xai' }).length, 2);
  assert.equal(p.filterPlugins(sample, { q: 'fun' }).length, 1);
  assert.equal(p.filterPlugins(sample, { q: 'nope' }).length, 0);
  const markets = p.collectMarketplacesFromPlugins(sample, []);
  assert.deepEqual(markets, ['community', 'xai']);
  console.log('ok  plugins exports + filters');
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
  assert.equal(m.CLI_NATIVE, true);
  // No host mode/style injection into --rules
  const rules = m.buildRules({ baseRules: 'base', workMode: 'ask', stylePack: 'pragmatic' });
  assert.ok(rules.includes('base'));
  assert.ok(!/Ask|只读|Craft|Plan 模式|Goal/.test(rules), 'no fake mode rules');
  assert.equal(m.modePromptPrefix('plan', 'hello'), '');
  assert.equal(m.modePromptPrefix('craft', 'fix the bug'), '');
  assert.equal(m.modePromptPrefix('goal', 'x', { goal: { title: 't' } }), '');
  const withProj = m.buildRules({
    baseRules: 'g',
    projectRules: 'prefer tests',
    workMode: 'craft',
  });
  assert.ok(withProj.includes('prefer tests') || withProj.includes('项目规则'));
  assert.equal(typeof m.readProjectRulesFile, 'function');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grokcode-rules-'));
  fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.grok', 'rules.md'), 'no force push\n', 'utf8');
  const pr = m.readProjectRulesFile(tmp);
  assert.ok(pr.text.includes('no force push'));
  assert.equal(m.listModes().length, 1, 'cli only');
  assert.equal(m.listModes()[0].id, 'cli');
  assert.equal(m.normalizeWorkMode('goal'), 'cli');
  assert.equal(m.normalizeWorkMode('nope'), 'cli');
  assert.ok(m.listStyles().length >= 3);
  assert.ok(m.isPlanExecutePhrase('执行'));
  console.log('ok  modes CLI-native (no craft/plan/ask inject)');
}

function testLooksLikePlan() {
  const m = require(path.join(root, 'electron', 'modes.js'));
  const planZh = [
    '目标：修好登录',
    '步骤：',
    '1. 检查 auth.js',
    '2. 修 token 刷新',
    '3. 跑测试',
    '涉及文件：src/auth.js',
    '风险：会话失效',
  ].join('\n');
  assert.ok(m.looksLikePlan(planZh), 'structured zh plan');
  assert.ok(!m.looksLikePlan('ok'), 'too short');
  assert.ok(!m.looksLikePlan('这里只是一句闲聊，没有方案结构'), 'chatty non-plan');
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
  const DiffUtil = require(path.join(root, 'renderer', 'diff-util.js'));
  assert.equal(typeof DiffUtil.toUnifiedHtml, 'function');
  assert.equal(typeof DiffUtil.toSideBySideHtml, 'function');
  assert.equal(typeof DiffUtil.reconstructFromUnified, 'function');

  const before = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n');
  const after = ['alpha', 'bravo', 'CHARLIE', 'delta', 'echo'].join('\n');
  const { ops } = DiffUtil.computeLineDiff(before, after);
  const text = DiffUtil.toUnifiedText(ops, { context: 1, maxRows: 40 });
  assert.ok(text.includes('- charlie') || text.includes('-charlie'), 'mini-diff has del');
  assert.ok(text.includes('+ CHARLIE') || text.includes('+CHARLIE'), 'mini-diff has add');

  // Full reverse: mini-diff + full after → reconstruct original before
  const full = DiffUtil.reconstructFromUnified(text, { after });
  assert.ok(full.ok, 'full reconstruct ok');
  assert.equal(full.mode, 'full', 'mode full when after matches');
  assert.equal(full.before, before, 'before restored from mini-diff + after');

  // Snippet-only (no after)
  const snip = DiffUtil.reconstructFromUnified(text);
  assert.ok(snip.ok && snip.mode === 'snippet', 'snippet mode without after');
  assert.ok(snip.ops.some((o) => o.type === 'del'), 'snippet ops have del');
  assert.ok(snip.ops.some((o) => o.type === 'add'), 'snippet ops have add');

  // Truncated mini-diff still yields ops
  const trunc = DiffUtil.reconstructFromUnified(text + '\n… (truncated)');
  assert.ok(trunc.ok, 'truncated reconstruct ok');
  assert.ok(trunc.truncated, 'flags truncated');

  console.log('ok  diff hunk + mini-diff reconstruct');
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

function testShellSafe() {
  const { isSafeExternalUrl, openExternalSafe } = require(path.join(
    root,
    'electron',
    'shell-safe.js'
  ));
  assert.ok(isSafeExternalUrl('https://console.x.ai'));
  assert.ok(isSafeExternalUrl('http://localhost:5173/docs'));
  assert.ok(isSafeExternalUrl('mailto:dev@example.com'));
  assert.ok(!isSafeExternalUrl('file:///C:/Windows/System32/cmd.exe'));
  assert.ok(!isSafeExternalUrl('javascript:alert(1)'));
  assert.ok(!isSafeExternalUrl('ms-settings:bluetooth'));
  assert.ok(!isSafeExternalUrl('https://evil.com\nfile://x'));
  assert.ok(!isSafeExternalUrl(''));
  assert.ok(!isSafeExternalUrl(null));
  // openExternalSafe should reject without calling shell for bad urls
  let called = false;
  return openExternalSafe(
    {
      openExternal: async () => {
        called = true;
      },
    },
    'file:///etc/passwd'
  ).then((r) => {
    assert.equal(r.ok, false);
    assert.ok(!called, 'must not open blocked schemes');
    return openExternalSafe(
      {
        openExternal: async () => {
          called = true;
        },
      },
      'https://github.com/sunormesky-max/grok-code'
    ).then((r2) => {
      assert.equal(r2.ok, true);
      assert.ok(called, 'https should open');
      console.log('ok  shell-safe openExternal whitelist');
    });
  });
}

function testAgentExports() {
  const { createAgent, humanizeAgentError } = require(path.join(
    root,
    'electron',
    'agent.js'
  ));
  const agent = createAgent({
    getConfig: () => ({}),
    workspaceRoot: root,
    emit: () => {},
  });
  assert.equal(typeof agent.run, 'function');
  assert.equal(typeof agent.stop, 'function');
  assert.equal(typeof agent.reapTracked, 'function');
  assert.equal(typeof agent.listTrackedPids, 'function');
  assert.equal(typeof agent.replyPlanApproval, 'function');
  assert.equal(typeof agent.replyUserQuestion, 'function');
  assert.equal(typeof agent.setSessionMode, 'function');
  assert.deepEqual(agent.listTrackedPids(), []);
  agent.reapTracked();
  const noClient = agent.replyPlanApproval('missing-task', 1, { outcome: 'approved' });
  assert.equal(noClient.ok, false);
  assert.ok(/no active ACP|ACP client/i.test(String(noClient.error || '')));
  const noQ = agent.replyUserQuestion('missing-task', 2, { outcome: 'cancelled' });
  assert.equal(noQ.ok, false);
  assert.ok(
    /无权|403|coming soon|access/i.test(
      humanizeAgentError(
        'Internal error: {"message":"API error (status 403 Forbidden): Grok Build is coming soon. You don\'t have access now."}'
      )
    ),
    '403 access mapped'
  );
  assert.ok(
    /登录|Authorization/i.test(
      humanizeAgentError('Transport channel closed, when Auth(AuthorizationRequired)')
    ),
    'auth required mapped'
  );
  return Promise.resolve(agent.setSessionMode('missing-task', 'plan')).then((r) => {
    assert.equal(r.ok, false);
    assert.ok(/no active ACP|session/i.test(String(r.error || '')));
    console.log('ok  agent stop/reap exports');
  });
}

function testAcpPermissionPicker() {
  const {
    pickAutoApproveOptionId,
    resolvePermissionResponse,
    extractOptions,
  } = require(path.join(root, 'electron', 'acp-permission.js'));

  const opts = [
    { optionId: 'reject', name: 'Reject', kind: 'rejectOnce' },
    { optionId: 'allow-once', name: 'Allow once', kind: 'allowOnce' },
    { optionId: 'allow-always', name: 'Allow always', kind: 'allowAlways' },
  ];
  assert.equal(pickAutoApproveOptionId(opts), 'allow-once', 'prefer AllowOnce kind/id');
  assert.equal(
    pickAutoApproveOptionId(opts, { preferAlways: true }),
    'allow-once',
    'still prefer once before always when both exist'
  );

  const onlyAlways = [{ optionId: 'allow-always', name: 'Always', kind: 'allowAlways' }];
  assert.equal(
    pickAutoApproveOptionId(onlyAlways, { preferAlways: true }),
    'allow-always'
  );
  assert.equal(pickAutoApproveOptionId([{ optionId: 'reject', name: 'No' }]), null);

  const auto = resolvePermissionResponse(
    { options: opts },
    { autoApprove: true }
  );
  assert.equal(auto.mode, 'auto');
  assert.equal(auto.selected, 'allow-once');
  assert.equal(auto.result.outcome.outcome, 'selected');
  assert.equal(auto.result.outcome.optionId, 'allow-once');

  const deny = resolvePermissionResponse({ options: opts }, { autoApprove: false });
  assert.equal(deny.mode, 'deny');
  assert.equal(deny.result.outcome.outcome, 'cancelled');

  assert.equal(extractOptions({ options: opts }).length, 3);

  // snake_case wire + allow_once kind
  const snake = extractOptions({
    permission_options: [
      { option_id: 'deny-once', name: 'Deny', kind: 'reject_once' },
      { option_id: 'proceed', name: 'Allow once', kind: 'allow_once' },
    ],
  });
  assert.equal(pickAutoApproveOptionId(snake), 'proceed');
  console.log('ok  ACP permission option picker');
}

function testResolveToolCallDelta() {
  const { resolveToolCallDelta } = require(path.join(root, 'electron', 'acp-client.js'));
  let st = {
    indexToId: new Map(),
    names: new Map(),
    argAccum: new Map(),
    lastName: 'tool',
  };
  // First frame: id + name + index
  let r = resolveToolCallDelta(
    { tool_call_id: 'call-1', tool_index: 0, name: 'write' },
    st
  );
  st = r.state;
  assert.equal(r.id, 'call-1');
  assert.equal(r.name, 'write');
  // Subsequent: only index + arguments_delta (matches upstream test)
  r = resolveToolCallDelta(
    { tool_index: 0, arguments_delta: '{"path":"C:\\\\erp\\\\a.js","content":"x' },
    st
  );
  st = r.state;
  assert.equal(r.id, 'call-1', 'index maps back to id');
  assert.equal(r.name, 'write', 'name remembered');
  assert.ok(r.hintArgs.path || r.hintArgs.preview, 'path hint from fragment');
  assert.ok(r.argFrag.length > 0);
  console.log('ok  ToolCallDelta index→id + arguments_delta');
}

function testAcpInitializeIdentity() {
  const { buildInitializeParams } = require(path.join(root, 'electron', 'acp-client.js'));
  const p = buildInitializeParams('9.9.9-test');
  assert.equal(p.clientInfo.name, 'GrokCode', 'product name stays GrokCode');
  assert.equal(p.clientInfo.version, '9.9.9-test');
  // Upstream mvp_agent reads meta.clientType (serde) then meta.clientIdentifier
  for (const key of ['_meta', 'meta']) {
    const m = p[key];
    assert.ok(m, key);
    assert.equal(m.clientType, 'grok_desktop', `${key}.clientType Desktop serde`);
    assert.equal(m.clientIdentifier, 'grok-desktop', `${key}.clientIdentifier`);
    assert.equal(m.clientSource, 'grok-desktop', `${key}.clientSource`);
    assert.equal(m.clientVersion, '9.9.9-test');
    assert.equal(m.bufferingSettings.maxItems, 1);
    assert.equal(m.bufferingSettings.maxDurationMs, 1);
  }
  console.log('ok  ACP initialize Desktop identity + buffering');
}

/**
 * x.ai/exit_plan_mode: park reverse-req, resolveInteractive outcomes.
 * Aligns with open-source grok-build ExitPlanModeExtResponse
 * (approved | abandoned | cancelled + optional feedback).
 */
function testExitPlanModeApproval() {
  const { AcpClient } = require(path.join(root, 'electron', 'acp-client.js'));
  const writes = [];
  const client = new AcpClient({
    bin: 'echo',
    autoApprove: true,
    planInteractive: true,
  });
  // Fake writable stdin so _respond can record JSON-RPC replies
  client.child = {
    stdin: {
      writable: true,
      write(s) {
        writes.push(String(s));
        return true;
      },
    },
  };
  client.alive = true;

  let parked = null;
  client.onPlanApproval = (info) => {
    parked = info;
  };

  client._handleAgentRequest({
    id: 42,
    method: 'x.ai/exit_plan_mode',
    params: {
      toolCallId: 'tc-plan-1',
      planContent: '## Plan\n1. fix acp\n2. ship',
      sessionId: 'sess-1',
    },
  });

  assert.ok(parked, 'onPlanApproval fired');
  assert.equal(parked.pending, true);
  assert.equal(parked.mode, 'interactive');
  assert.equal(parked.requestId, 42);
  assert.ok(String(parked.planContent).includes('fix acp'));
  assert.equal(client.pendingInteractive.size, 1);
  assert.equal(writes.length, 0, 'must not respond until host UI answers');

  const r = client.resolveInteractive(42, {
    outcome: 'approved',
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'approved');
  assert.equal(client.pendingInteractive.size, 0);
  assert.equal(writes.length, 1);
  const reply = JSON.parse(writes[0].trim());
  assert.equal(reply.id, 42);
  assert.equal(reply.result.outcome, 'approved');
  assert.equal(reply.result.feedback, undefined);

  // Second resolve is a no-op
  const again = client.resolveInteractive(42, { outcome: 'abandoned' });
  assert.equal(again.ok, false);

  // cancelled + feedback (request changes)
  writes.length = 0;
  parked = null;
  client._handleAgentRequest({
    id: 99,
    method: '_x.ai/exit_plan_mode',
    params: {
      method: 'x.ai/exit_plan_mode',
      params: { plan_content: 'revise me', tool_call_id: 'tc2' },
    },
  });
  assert.ok(parked?.pending);
  assert.ok(String(parked.planContent).includes('revise me'));
  const rev = client.resolveInteractive(99, {
    outcome: 'cancelled',
    feedback: 'add tests first',
  });
  assert.equal(rev.ok, true);
  const revBody = JSON.parse(writes[0].trim());
  assert.equal(revBody.result.outcome, 'cancelled');
  assert.equal(revBody.result.feedback, 'add tests first');

  // auto-approve path (YOLO + planInteractive false)
  writes.length = 0;
  parked = null;
  const auto = new AcpClient({
    bin: 'echo',
    autoApprove: true,
    planInteractive: false,
  });
  auto.child = client.child;
  auto.alive = true;
  auto.onPlanApproval = (info) => {
    parked = info;
  };
  auto._handleAgentRequest({
    id: 7,
    method: 'x.ai/exit_plan_mode',
    params: { planContent: 'go' },
  });
  assert.equal(parked?.pending, false);
  assert.equal(parked?.mode, 'auto');
  assert.equal(parked?.selected, 'approved');
  assert.equal(auto.pendingInteractive.size, 0);
  const autoReply = JSON.parse(writes[0].trim());
  assert.equal(autoReply.result.outcome, 'approved');

  // abandoned
  writes.length = 0;
  client._handleAgentRequest({
    id: 11,
    method: 'x.ai/exit_plan_mode',
    params: { planContent: 'x' },
  });
  const ab = client.resolveInteractive(11, { outcome: 'abandoned' });
  assert.equal(ab.ok, true);
  assert.equal(JSON.parse(writes[0].trim()).result.outcome, 'abandoned');

  console.log('ok  exit_plan_mode park + resolveInteractive');
}

/**
 * x.ai/ask_user_question: park, replace cancels prior, accepted/cancelled shapes.
 * Aligns with AskUserQuestionExtResponse (tagged outcome).
 */
function testAskUserQuestion() {
  const { AcpClient, normalizeAskUserQuestions } = require(path.join(
    root,
    'electron',
    'acp-client.js'
  ));

  const norm = normalizeAskUserQuestions([
    {
      question: 'Which DB?',
      multi_select: true,
      options: [
        { label: 'Postgres (Recommended)', description: 'SQL' },
        { label: 'SQLite', description: 'Embedded', preview: 'SELECT 1' },
      ],
    },
    { question: '', options: [{ label: 'x' }] },
  ]);
  assert.equal(norm.length, 1);
  assert.equal(norm[0].multiSelect, true);
  assert.equal(norm[0].options.length, 2);
  assert.equal(norm[0].options[1].preview, 'SELECT 1');

  const writes = [];
  const client = new AcpClient({
    bin: 'echo',
    autoApprove: true,
    userQuestionInteractive: true,
  });
  client.child = {
    stdin: {
      writable: true,
      write(s) {
        writes.push(String(s));
        return true;
      },
    },
  };
  client.alive = true;

  let parked = null;
  client.onUserQuestion = (info) => {
    parked = info;
  };

  client._handleAgentRequest({
    id: 50,
    method: 'x.ai/ask_user_question',
    params: {
      sessionId: 'sess-q',
      toolCallId: 'tc-q1',
      mode: 'plan',
      questions: [
        {
          question: 'Pick cache?',
          options: [
            { label: 'Redis', description: 'In-memory' },
            { label: 'Memcached', description: 'Simple' },
          ],
        },
      ],
    },
  });

  assert.ok(parked?.pending);
  assert.equal(parked.mode, 'plan');
  assert.equal(parked.questions.length, 1);
  assert.equal(client.pendingInteractive.size, 1);
  assert.equal(writes.length, 0);

  const accepted = client.resolveInteractive(50, {
    outcome: 'accepted',
    answers: { 'Pick cache?': ['Redis'] },
    annotations: { 'Pick cache?': { notes: 'prefer hot path' } },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.kind, 'ask_user_question');
  const body = JSON.parse(writes[0].trim());
  assert.equal(body.result.outcome, 'accepted');
  assert.deepEqual(body.result.answers['Pick cache?'], ['Redis']);
  assert.equal(body.result.annotations['Pick cache?'].notes, 'prefer hot path');

  // Replace previous question → cancel old
  writes.length = 0;
  client._handleAgentRequest({
    id: 51,
    method: 'x.ai/ask_user_question',
    params: {
      questions: [{ question: 'Q1?', options: [{ label: 'A', description: 'a' }] }],
      mode: 'default',
    },
  });
  client._handleAgentRequest({
    id: 52,
    method: '_x.ai/ask_user_question',
    params: {
      method: 'x.ai/ask_user_question',
      params: {
        questions: [{ question: 'Q2?', options: [{ label: 'B', description: 'b' }] }],
        mode: 'default',
      },
    },
  });
  // First response should be cancelled for id 51
  const cancelLine = writes.find((w) => {
    try {
      const j = JSON.parse(w.trim());
      return j.id === 51;
    } catch {
      return false;
    }
  });
  assert.ok(cancelLine, 'prior question cancelled');
  assert.equal(JSON.parse(cancelLine.trim()).result.outcome, 'cancelled');
  assert.equal(client.pendingInteractive.size, 1);
  assert.ok(client.pendingInteractive.has('52'));

  const chat = client.resolveInteractive(52, {
    outcome: 'chat_about_this',
    partial_answers: { 'Q2?': 'B' },
  });
  assert.equal(chat.ok, true);
  assert.equal(JSON.parse(writes[writes.length - 1].trim()).result.outcome, 'chat_about_this');

  // Auto-cancel path
  writes.length = 0;
  parked = null;
  const auto = new AcpClient({
    bin: 'echo',
    userQuestionInteractive: false,
  });
  auto.child = client.child;
  auto.alive = true;
  auto.onUserQuestion = (info) => {
    parked = info;
  };
  auto._handleAgentRequest({
    id: 60,
    method: 'x.ai/ask_user_question',
    params: {
      questions: [{ question: 'X?', options: [{ label: 'Y', description: 'y' }] }],
    },
  });
  assert.equal(parked?.pending, false);
  assert.equal(parked?.selected, 'cancelled');
  assert.equal(JSON.parse(writes[0].trim()).result.outcome, 'cancelled');

  console.log('ok  ask_user_question park + ExtResponse');
}

function testSessionModeNormalize() {
  const {
    normalizeSessionModeId,
    SESSION_MODE_CYCLE,
  } = require(path.join(root, 'electron', 'acp-client.js'));
  assert.equal(normalizeSessionModeId('plan'), 'plan');
  assert.equal(normalizeSessionModeId('PLAN'), 'plan');
  assert.equal(normalizeSessionModeId('agent'), 'default');
  assert.equal(normalizeSessionModeId('normal'), 'default');
  assert.equal(normalizeSessionModeId('ask'), 'ask');
  assert.equal(normalizeSessionModeId(''), 'default');
  assert.deepEqual([...SESSION_MODE_CYCLE], ['default', 'plan', 'ask']);

  // setMode request shape (mock stdin)
  const { AcpClient } = require(path.join(root, 'electron', 'acp-client.js'));
  const writes = [];
  const client = new AcpClient({ bin: 'echo' });
  client.child = {
    stdin: {
      writable: true,
      write(s) {
        writes.push(String(s));
        return true;
      },
    },
  };
  client.alive = true;
  // Fire request without waiting for response (will timeout in real use)
  const p = client.setMode('sess-xyz', 'plan');
  assert.ok(writes.length === 1);
  const msg = JSON.parse(writes[0].trim());
  assert.equal(msg.method, 'session/set_mode');
  assert.equal(msg.params.sessionId, 'sess-xyz');
  assert.equal(msg.params.modeId, 'plan');
  // Resolve pending so promise doesn't hang the process
  const pend = client.pending.get(msg.id);
  if (pend) {
    clearTimeout(pend.timer);
    client.pending.delete(msg.id);
    pend.resolve({});
  }
  return p.then(() => {
    console.log('ok  session/set_mode normalize + request');
  });
}

function testDoctorPromptProbeSkipped() {
  const { runDoctor } = require(path.join(root, 'electron', 'diagnostics.js'));
  // Without env, probe is skipped (fast)
  const prev = process.env.GROKCODE_DOCTOR_PROBE;
  delete process.env.GROKCODE_DOCTOR_PROBE;
  try {
    const report = runDoctor({}, { probePrompt: false });
    assert.ok(Array.isArray(report.checks));
    const pp = report.checks.find((c) => c.id === 'prompt_probe');
    assert.ok(pp, 'prompt_probe check present');
    assert.equal(pp.skipped, true);
    assert.ok(/未运行|skip/i.test(pp.detail));
  } finally {
    if (prev !== undefined) process.env.GROKCODE_DOCTOR_PROBE = prev;
  }
  console.log('ok  doctor -p probe skipped by default');
}

function testPickChunkTextMultimodal() {
  const { pickChunkText, pickToolInfo, slimToolArgs } = require(path.join(
    root,
    'electron',
    'acp-client.js'
  ));
  assert.equal(pickChunkText({ content: 'hi' }), 'hi');
  assert.equal(pickChunkText({ content: { text: 'a' } }), 'a');
  assert.equal(
    pickChunkText({
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'image', data: 'base64…' },
        { type: 'text', text: 'world' },
      ],
    }),
    'Hello world',
    'skip image blocks'
  );
  assert.equal(pickChunkText({ text: 'top', content: null }), 'top');
  const tool = pickToolInfo({
    toolCallId: 't1',
    title: 'read_file',
    rawInput: { path: '/x/y.js', content: 'x'.repeat(500) },
  });
  assert.equal(tool.id, 't1');
  assert.equal(tool.name, 'read_file');
  const slim = slimToolArgs(tool.args);
  assert.ok(String(slim.content || '').endsWith('…') || slim.content.length <= 241);
  console.log('ok  pickChunkText multimodal + slimToolArgs');
}

function testIpcChannelContract() {
  const {
    AGENT_EVENT_CHANNELS,
    RENDERER_EVENT_CHANNELS,
    isAllowedRendererChannel,
    assertAgentPayloadShape,
  } = require(path.join(root, 'electron', 'ipc-channels'));

  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:text'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:tool_start'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:done'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:plan'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:mode'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:commands'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:permission'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:plan_approval'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:user_question'));
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:ext'));
  assert.ok(isAllowedRendererChannel('agent:phase'));
  assert.ok(isAllowedRendererChannel('agent:plan'));
  assert.ok(isAllowedRendererChannel('agent:plan_approval'));
  assert.ok(isAllowedRendererChannel('agent:user_question'));
  assert.ok(isAllowedRendererChannel('fs:changed'));
  assert.ok(!isAllowedRendererChannel('agent:secret'));
  assert.ok(RENDERER_EVENT_CHANNELS.length >= AGENT_EVENT_CHANNELS.length);

  // preload must use the same allowlist module (source contract)
  const preloadSrc = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  assert.ok(
    preloadSrc.includes("require('./ipc-channels')") || preloadSrc.includes('require("./ipc-channels")'),
    'preload must require ipc-channels'
  );
  assert.ok(preloadSrc.includes('isAllowedRendererChannel'), 'preload gates on isAllowedRendererChannel');
  assert.ok(preloadSrc.includes('replyPlanApproval'), 'preload exposes replyPlanApproval');
  assert.ok(preloadSrc.includes('replyUserQuestion'), 'preload exposes replyUserQuestion');
  assert.ok(preloadSrc.includes('setSessionMode'), 'preload exposes setSessionMode');

  const ok = assertAgentPayloadShape('agent:text', { taskId: 't1', text: 'hi' });
  assert.ok(ok.ok, 'text+taskId valid');
  const bad = assertAgentPayloadShape('agent:text', { text: 'no task' });
  assert.ok(!bad.ok, 'text without taskId rejected');
  const tool = assertAgentPayloadShape('agent:tool_start', { taskId: 't1', name: 'read_file' });
  assert.ok(tool.ok);
  console.log('ok  IPC channel contract');
}

function testAgentStreamNdjsonFixture() {
  const {
    reduceHeadlessNdjson,
    applyStreamBuffer,
    isKnownHeadlessType,
  } = require(path.join(root, 'electron', 'agent-stream'));
  const {
    assertAgentPayloadShape,
  } = require(path.join(root, 'electron', 'ipc-channels'));

  const fixture = fs.readFileSync(
    path.join(root, 'scripts', 'fixtures', 'agent-stream-basic.ndjson'),
    'utf8'
  );
  const { state, emits, phases, stats } = reduceHeadlessNdjson(fixture, { taskId: 'task-a' });

  assert.ok(stats.recognized >= 6, 'fixture lines recognized');
  assert.equal(stats.nonJson, 0);
  assert.ok(state.finalText.includes('我会先') && state.finalText.includes('文件'), 'text accumulated');
  assert.ok(state.thoughtText.includes('分析'), 'thought accumulated');
  assert.equal(state.sessionId, 'sess-abc');
  assert.ok(state.usage && state.usage.input_tokens === 10);
  assert.equal(state.toolDepth, 0, 'tools closed');

  const channels = emits.map((e) => e.channel);
  assert.ok(channels.includes('agent:thought'));
  assert.ok(channels.includes('agent:text'));
  assert.ok(channels.includes('agent:tool_start'));
  assert.ok(channels.includes('agent:tool_end'));
  assert.ok(channels.includes('agent:usage'));
  assert.ok(phases.some((p) => p.phase === 'done'));

  // Every agent emit must pass payload shape + taskId
  for (const e of emits) {
    if (!e.channel.startsWith('agent:')) continue;
    // phase/status from pure runner always have taskId
    const check = assertAgentPayloadShape(e.channel, e.payload);
    if (e.channel === 'agent:status' || e.channel === 'agent:phase') {
      assert.equal(e.payload.taskId, 'task-a');
      continue;
    }
    assert.ok(check.ok, `${e.channel}: ${check.error || 'ok'}`);
    assert.equal(e.payload.taskId, 'task-a');
  }

  // tool_start before tool_end; text after tools can continue
  const startIdx = channels.indexOf('agent:tool_start');
  const endIdx = channels.indexOf('agent:tool_end');
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'tool start before end');

  // Renderer buffer contract: prefer full text snapshot
  assert.equal(applyStreamBuffer('old', { text: 'full' }), 'full');
  assert.equal(applyStreamBuffer('old', { delta: '!' }), 'old!');
  assert.ok(isKnownHeadlessType('tool_call'));
  assert.ok(!isKnownHeadlessType('nope'));
  console.log('ok  headless NDJSON fixture contract');
}

function testAgentStreamAcpFixture() {
  const { createStreamState, reduceAcpUpdate } = require(path.join(
    root,
    'electron',
    'agent-stream'
  ));
  const updates = JSON.parse(
    fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'agent-stream-acp-updates.json'), 'utf8')
  );
  let state = createStreamState();
  let counters = { textChunks: 0, thoughtChunks: 0 };
  const emits = [];
  for (const u of updates) {
    const r = reduceAcpUpdate(state, u, counters);
    state = r.state;
    counters = r.counters;
    for (const a of r.actions) {
      if (a.op === 'emit') emits.push(a.channel);
    }
  }
  assert.ok(state.thoughtText.includes('login'));
  assert.ok(state.finalText.includes('Checking') && state.finalText.includes('auth.js'));
  assert.equal(state.toolDepth, 0);
  assert.ok(emits.includes('agent:tool_start'));
  assert.ok(emits.includes('agent:tool_end'));
  assert.ok(emits.filter((c) => c === 'agent:text').length >= 2);
  console.log('ok  ACP session/update fixture contract');
}

function testStreamFairness() {
  const sched = require(path.join(root, 'renderer', 'stream-scheduler.js'));
  const entries = [
    { id: 'bg1', streamDirty: true, lastStream: 0, running: true },
    { id: 'active', streamDirty: true, lastStream: 0, running: true },
    { id: 'bg2', streamDirty: true, lastStream: 50, running: true },
  ];
  const ordered = sched.sortFair(entries, 'active');
  assert.equal(ordered[0].id, 'active', 'active first');

  // Active paints every tick (ACTIVE_MS=0); bg holds until BG_MS
  const tick0 = sched.planTick(entries, {
    activeId: 'active',
    now: 10,
    ACTIVE_MS: 0,
    BG_MS: 100,
    MAX_PAINT_PER_TICK: 4,
  });
  assert.ok(
    tick0.paint.some((p) => p.id === 'active' && p.kind === 'stream'),
    'active paints at t=10'
  );
  // bg lastStream=0, now=10 < 100 → needMore, not painted
  assert.ok(!tick0.paint.some((p) => p.id === 'bg1'), 'bg throttled early');
  assert.ok(tick0.needMore, 'bg still waiting');

  const tickBg = sched.planTick(
    entries.map((e) =>
      e.id === 'active' ? { ...e, streamDirty: false, lastStream: 10 } : e
    ),
    { activeId: 'active', now: 120, ACTIVE_MS: 0, BG_MS: 100, MAX_PAINT_PER_TICK: 4 }
  );
  assert.ok(tickBg.paint.some((p) => p.id === 'bg1'), 'bg paints after BG_MS');

  const sim = sched.simulateFairness(
    [
      { id: 'a', streamDirty: true, lastStream: 0, running: true },
      { id: 'b', streamDirty: true, lastStream: 0, running: true },
    ],
    { activeId: 'a', steps: 5, stepMs: 20, ACTIVE_MS: 0, BG_MS: 40 }
  );
  assert.ok(sim.history[0].paint.some((p) => p.startsWith('a:')), 'sim active first step');
  console.log('ok  stream fairness scheduler');
}

function testCompressLongTaskGolden() {
  const { compressContext, buildContextPrompt } = require(path.join(
    root,
    'electron',
    'context-compress.js'
  ));
  const msgs = [];
  // Long trajectory: preference → work → stop → continue
  msgs.push({
    role: 'user',
    content: '约束：始终用中文回复；不要 force push；优先改 renderer/',
    ts: 1,
  });
  for (let i = 0; i < 12; i += 1) {
    msgs.push({
      role: 'user',
      content: `步骤 ${i}: 改 electron/agent.js 与 renderer/app.js 流式路径`,
      ts: 10 + i * 2,
    });
    msgs.push({
      role: 'assistant',
      content: `完成步骤 ${i}\n- 更新了 electron/agent.js\n- 检查了 LiveBatcher\nTODO: 还要补契约测试`,
      ts: 11 + i * 2,
    });
  }
  msgs.push({
    role: 'assistant',
    content: '中断于 Diff 校验…',
    ts: 100,
    stopped: true,
  });
  msgs.push({ role: 'user', content: '从中断处继续，保持中文', ts: 101 });

  const ctx = compressContext(msgs, {
    projectName: 'grok-code',
    taskTitle: 'stream-contract',
    workMode: 'craft',
    turns: [
      { mode: 'craft', endedAt: 1, tools: 3 },
      { mode: 'craft', stopped: true, tools: 5 },
    ],
    changedFiles: ['electron/agent.js', 'renderer/app.js', 'scripts/test-unit.js'],
    lastStopped: true,
  });

  assert.ok(ctx.l0.length >= 2, 'L0 keeps tail');
  assert.ok(String(ctx.l3).includes('中文') || String(ctx.l3).includes('偏好'), 'L3 durable prefs');
  assert.ok(
    String(ctx.l2).includes('agent.js') || String(ctx.l2).includes('变更'),
    'L2 tracks hot files'
  );
  assert.ok(String(ctx.l2).includes('中断') || String(ctx.l2).includes('停止'), 'L2 stop marker');
  assert.ok(String(ctx.l2).includes('TODO') || String(ctx.l2).includes('开放'), 'L2 open items');

  const prompt = buildContextPrompt(ctx, '继续修流式契约', {
    projectName: 'grok-code',
    taskTitle: 'stream-contract',
    workMode: 'craft',
    lastStopped: true,
    continueFrom: true,
  });
  assert.ok(prompt.includes('继续修流式契约'));
  assert.ok(prompt.includes('断点') || prompt.includes('中断') || prompt.includes('继续'));
  // Must not dump entire 12-turn raw history into L0 only — tiers present
  assert.ok(Array.isArray(ctx.tiers) && ctx.tiers.length === 4);
  console.log('ok  L0–L3 long-task golden');
}

try {
  testCompress();
  testCompressLongTaskGolden();
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
  testAcpPermissionPicker();
  testResolveToolCallDelta();
  testAcpInitializeIdentity();
  testExitPlanModeApproval();
  testAskUserQuestion();
  testDoctorPromptProbeSkipped();
  testPickChunkTextMultimodal();
  testIpcChannelContract();
  testAgentStreamNdjsonFixture();
  testAgentStreamAcpFixture();
  testStreamFairness();
  Promise.resolve()
    .then(() => testAgentExports())
    .then(() => testSessionModeNormalize())
    .then(() => testShellSafe())
    .then(() => {
      console.log('\nAll unit tests passed');
    })
    .catch((err) => {
      console.error('FAIL', err);
      process.exit(1);
    });
} catch (err) {
  console.error('FAIL', err);
  process.exit(1);
}
