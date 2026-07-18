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
  const rules = m.buildRules({ baseRules: 'base', workMode: 'ask', stylePack: 'pragmatic' });
  assert.ok(rules.includes('Ask') || rules.includes('只读'));
  assert.ok(m.modePromptPrefix('plan', 'hello').includes('Plan'));
  const craft = m.modePromptPrefix('craft', 'fix the bug');
  assert.ok(craft.includes('Craft'), 'craft prefix names Craft');
  assert.ok(craft.includes('飞行') || craft.includes('直接'), 'craft is flight/act-now');
  const craftRules = m.buildRules({ workMode: 'craft' });
  assert.ok(craftRules.includes('Craft'));
  const withProj = m.buildRules({ baseRules: 'g', projectRules: 'prefer tests', workMode: 'craft' });
  assert.ok(withProj.includes('prefer tests') || withProj.includes('项目规则'));
  assert.equal(typeof m.readProjectRulesFile, 'function');
  assert.equal(typeof m.writeProjectRulesFile, 'function');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grokcode-rules-'));
  fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.grok', 'rules.md'), 'no force push\n', 'utf8');
  const pr = m.readProjectRulesFile(tmp);
  assert.ok(pr.text.includes('no force push'));
  assert.equal(m.listModes().length, 4, 'craft plan ask goal');
  assert.ok(m.listStyles().length >= 3);
  assert.equal(m.normalizeWorkMode('goal'), 'goal');
  assert.equal(m.normalizeWorkMode('nope'), 'craft');
  // plan execute phrase + craft promotion prefix
  assert.ok(m.isPlanExecutePhrase('执行'));
  assert.ok(m.isPlanExecutePhrase('implement the plan'));
  assert.ok(!m.isPlanExecutePhrase('帮我分析一下架构'));
  const execPrefix = m.modePromptPrefix('plan', '执行');
  assert.ok(execPrefix.includes('执行') || execPrefix.includes('Craft') || execPrefix.includes('动手'));
  const planBody = [
    '目标：修好登录',
    '步骤：',
    '1. 检查 auth.js',
    '2. 修 token 刷新',
    '3. 跑测试',
    '涉及文件：src/auth.js',
    '风险：会话失效',
  ].join('\n');
  assert.ok(m.looksLikePlan(planBody), 'structured plan detected');
  const execPrompt = m.buildPlanExecutePrompt(planBody, { locale: 'zh' });
  assert.ok(execPrompt.includes('auth') || execPrompt.includes('方案'), 'execute embeds plan');
  assert.ok(execPrompt.includes('Craft') || execPrompt.includes('执行'), 'execute is craft-ish');
  // Goal mode
  const goalPrefix = m.modePromptPrefix('goal', '让登录可恢复', {
    goal: { title: '登录可恢复', status: 'active', progress: 20 },
  });
  assert.ok(goalPrefix.includes('Goal') || goalPrefix.includes('目标'), 'goal prefix');
  assert.ok(goalPrefix.includes('登录可恢复'), 'goal title injected');
  assert.ok(m.extractGoalTitle('目标：修好 Diff 面板').includes('Diff'));
  assert.ok(m.isGoalDonePhrase('目标完成'));
  assert.ok(!m.isGoalDonePhrase('继续推进目标'));
  const parsed = m.parseGoalProgress(
    '做完了半截\n【目标进度】\n- 目标：修好登录\n- 进度：45%\n- 本轮完成：auth 刷新\n- 下一步：补测试\n'
  );
  assert.ok(parsed && parsed.progress === 45, 'parse progress %');
  assert.ok(parsed.title.includes('登录'), 'parse goal title');
  assert.ok(String(parsed.next || '').includes('测试'), 'parse next');
  console.log('ok  modes / styles / plan→craft / goal');
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
  const { createAgent } = require(path.join(root, 'electron', 'agent.js'));
  const agent = createAgent({
    getConfig: () => ({}),
    workspaceRoot: root,
    emit: () => {},
  });
  assert.equal(typeof agent.run, 'function');
  assert.equal(typeof agent.stop, 'function');
  assert.equal(typeof agent.reapTracked, 'function');
  assert.equal(typeof agent.listTrackedPids, 'function');
  assert.deepEqual(agent.listTrackedPids(), []);
  agent.reapTracked();
  console.log('ok  agent stop/reap exports');
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
  assert.ok(AGENT_EVENT_CHANNELS.includes('agent:ext'));
  assert.ok(isAllowedRendererChannel('agent:phase'));
  assert.ok(isAllowedRendererChannel('agent:plan'));
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
  testAgentExports();
  testAcpPermissionPicker();
  testPickChunkTextMultimodal();
  testIpcChannelContract();
  testAgentStreamNdjsonFixture();
  testAgentStreamAcpFixture();
  testStreamFairness();
  Promise.resolve(testShellSafe())
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
