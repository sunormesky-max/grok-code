/**
 * Pure execution-route ledger (流式执行路线).
 * Append-only steps for boot → think → tools → stream → silence → done.
 * No Electron / timers — inject nowMs. Complements agent-stream.js.
 */
const ROUTE_STEP_KINDS = Object.freeze([
  'boot',
  'thinking',
  'tool_start',
  'tool_end',
  'streaming',
  'silence',
  'done',
  'error',
  'stopped',
  'park',
  'goal',
  'compact',
  'retry',
  'subagent',
  'plan',
  'mode',
  'signal',
]);

/**
 * @typedef {object} RouteStep
 * @property {string} kind
 * @property {number} tMs
 * @property {string} [detail]
 * @property {string} [toolId]
 * @property {string} [toolName]
 * @property {boolean} [ok]
 * @property {boolean} [progress]
 * @property {string} [id]
 * @property {object} [meta]
 */

function createRouteState(seed = {}) {
  const t0 = seed.t0Ms != null ? Number(seed.t0Ms) : 0;
  return {
    steps: [],
    lastPhase: null,
    lastDetail: null,
    t0Ms: t0,
    lastActivityMs: t0,
    firstTokenMs: 0,
    maxSilentSec: 0,
    toolDepth: 0,
    lastToolName: null,
    clockMode: 'none',
    bootStartedMs: 0,
    park: null,
    counters: {
      textChunks: 0,
      thoughtChunks: 0,
      toolStarts: 0,
      toolEnds: 0,
      toolInProgress: 0,
    },
    terminal: 'running',
    seq: 0,
  };
}

function relMs(state, nowMs) {
  return Math.max(0, Math.floor(Number(nowMs) - state.t0Ms));
}

/**
 * Dedupe continuous phase steps; always append event-like kinds.
 */
function appendRouteStep(state, step) {
  if (!state || !step || !step.kind) return state;
  const kind = String(step.kind);
  const detail = step.detail != null ? String(step.detail) : '';
  const eventKinds = new Set([
    'tool_start',
    'tool_end',
    'done',
    'error',
    'stopped',
    'goal',
    'compact',
    'retry',
    'subagent',
    'plan',
    'mode',
    'signal',
    'park',
  ]);
  if (!eventKinds.has(kind)) {
    if (state.lastPhase === kind && state.lastDetail === detail) return state;
  }
  // tool progress re-emits: don't spam identical progress rows
  if (kind === 'tool_start' && step.progress) {
    const last = state.steps[state.steps.length - 1];
    if (
      last &&
      last.kind === 'tool_start' &&
      last.progress &&
      last.toolId === step.toolId &&
      last.detail === detail
    ) {
      return state;
    }
  }
  state.seq += 1;
  const row = {
    id: step.id || `s${state.seq}`,
    kind,
    tMs: step.tMs != null ? step.tMs : 0,
    detail: detail || undefined,
    toolId: step.toolId,
    toolName: step.toolName,
    ok: step.ok,
    progress: step.progress,
    meta: step.meta,
  };
  state.steps.push(row);
  if (!eventKinds.has(kind) || kind === 'park') {
    state.lastPhase = kind;
    state.lastDetail = detail;
  } else if (kind === 'tool_start' && !step.progress) {
    state.lastPhase = 'tool';
    state.lastDetail = detail || step.toolName || '';
  } else if (kind === 'streaming' || kind === 'thinking' || kind === 'boot') {
    state.lastPhase = kind;
    state.lastDetail = detail;
  }
  return state;
}

function mapActionToStepKind(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.op === 'phase') {
    const p = String(action.phase || '').toLowerCase();
    if (p === 'boot') return 'boot';
    if (p === 'thinking') return 'thinking';
    if (p === 'streaming') return 'streaming';
    if (p === 'tool') return null; // prefer tool_start events
    if (p === 'done') return 'done';
    if (p === 'error') return 'error';
    if (p === 'stopped') return 'stopped';
    if (p === 'retry') return 'retry';
    return null;
  }
  if (action.op === 'emit') {
    const ch = String(action.channel || '');
    if (ch === 'agent:thought') return 'thinking';
    if (ch === 'agent:text') return 'streaming';
    if (ch === 'agent:tool_start') return 'tool_start';
    if (ch === 'agent:tool_end') return 'tool_end';
    if (ch === 'agent:error') return 'error';
    if (ch === 'agent:done') return 'done';
    if (ch === 'agent:plan') return 'plan';
    if (ch === 'agent:mode') return 'mode';
    if (ch === 'agent:route') return action.payload?.kind || 'signal';
  }
  return null;
}

function reduceRouteFromAction(state, action, ctx = {}) {
  const nowMs = ctx.nowMs != null ? Number(ctx.nowMs) : state.t0Ms;
  const added = [];
  if (!action || action.op === 'flush') return { state, stepsAdded: added };

  if (action.op === 'phase') {
    const kind = mapActionToStepKind(action);
    if (kind) {
      const before = state.steps.length;
      appendRouteStep(state, {
        kind,
        tMs: relMs(state, nowMs),
        detail: action.detail || action.phase,
      });
      if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
    }
    return { state, stepsAdded: added };
  }

  if (action.op !== 'emit') return { state, stepsAdded: added };
  const ch = String(action.channel || '');
  const p = action.payload || {};

  if (ch === 'agent:thought') {
    state.counters.thoughtChunks += 1;
    if (!state.firstTokenMs) state.firstTokenMs = nowMs;
    state.lastActivityMs = nowMs;
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'thinking',
      tMs: relMs(state, nowMs),
      detail: 'thinking…',
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:text') {
    state.counters.textChunks += 1;
    if (!state.firstTokenMs) state.firstTokenMs = nowMs;
    state.lastActivityMs = nowMs;
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'streaming',
      tMs: relMs(state, nowMs),
      detail: 'speaking…',
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:tool_start') {
    const progress = Boolean(p.progress);
    if (!progress) {
      state.counters.toolStarts += 1;
      state.toolDepth += 1;
    } else {
      state.counters.toolInProgress += 1;
    }
    if (!state.firstTokenMs) state.firstTokenMs = nowMs;
    state.lastActivityMs = nowMs;
    if (p.name) state.lastToolName = String(p.name);
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'tool_start',
      tMs: relMs(state, nowMs),
      toolId: p.id != null ? String(p.id) : undefined,
      toolName: p.name ? String(p.name) : undefined,
      progress,
      detail: p.name ? String(p.name) : 'tool',
      id: p.id != null ? `tool:${p.id}` : undefined,
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:tool_end') {
    state.counters.toolEnds += 1;
    state.toolDepth = Math.max(0, state.toolDepth - 1);
    state.lastActivityMs = nowMs;
    if (p.name) state.lastToolName = String(p.name);
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'tool_end',
      tMs: relMs(state, nowMs),
      toolId: p.id != null ? String(p.id) : undefined,
      toolName: p.name ? String(p.name) : undefined,
      ok: p.ok !== false,
      detail: p.name ? String(p.name) : 'tool',
      id: p.id != null ? `tool-end:${p.id}` : undefined,
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:error') {
    state.terminal = 'error';
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'error',
      tMs: relMs(state, nowMs),
      detail: String(p.error || p.message || 'error').slice(0, 160),
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:done') {
    state.terminal = p.stopped ? 'stopped' : 'done';
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: p.stopped ? 'stopped' : 'done',
      tMs: relMs(state, nowMs),
      detail: p.stopped ? 'stopped' : 'done',
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:route' && p.kind) {
    state.lastActivityMs = nowMs;
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: String(p.kind),
      tMs: relMs(state, nowMs),
      detail: p.detail || p.title || p.kind,
      toolName: p.toolName,
      toolId: p.toolId,
      meta: p.meta,
      id: p.id,
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:plan') {
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'plan',
      tMs: relMs(state, nowMs),
      detail: Array.isArray(p.entries) ? p.entries[0] : 'plan',
      meta: { count: Array.isArray(p.entries) ? p.entries.length : 0 },
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  } else if (ch === 'agent:mode') {
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'mode',
      tMs: relMs(state, nowMs),
      detail: p.modeId || p.mode || 'mode',
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  }

  return { state, stepsAdded: added };
}

function reduceRouteFromActions(state, actions, ctx = {}) {
  const added = [];
  for (const a of actions || []) {
    const r = reduceRouteFromAction(state, a, ctx);
    state = r.state;
    added.push(...r.stepsAdded);
  }
  return { state, stepsAdded: added };
}

function routeStartBoot(state, { nowMs, detail } = {}) {
  const t = nowMs != null ? Number(nowMs) : state.t0Ms;
  state.clockMode = 'boot';
  state.bootStartedMs = t;
  if (!state.t0Ms) state.t0Ms = t;
  const before = state.steps.length;
  appendRouteStep(state, {
    kind: 'boot',
    tMs: relMs(state, t),
    detail: detail || 'boot',
  });
  return {
    state,
    stepsAdded: state.steps.length > before ? [state.steps[state.steps.length - 1]] : [],
  };
}

function routeStartPrompt(state, { nowMs } = {}) {
  const t = nowMs != null ? Number(nowMs) : state.t0Ms;
  state.clockMode = 'prompt';
  state.lastActivityMs = t;
  return { state, stepsAdded: [] };
}

function routeSetPark(state, { nowMs, label, toolName, kind } = {}) {
  const t = nowMs != null ? Number(nowMs) : state.t0Ms;
  state.park = {
    kind: kind || 'park',
    label: label || '等待用户…',
    sinceMs: t,
    toolName: toolName || '',
  };
  const before = state.steps.length;
  appendRouteStep(state, {
    kind: 'park',
    tMs: relMs(state, t),
    detail: state.park.label,
    toolName: toolName || undefined,
  });
  return {
    state,
    stepsAdded: state.steps.length > before ? [state.steps[state.steps.length - 1]] : [],
  };
}

function routeClearPark(state, { nowMs } = {}) {
  const t = nowMs != null ? Number(nowMs) : state.t0Ms;
  state.park = null;
  state.lastActivityMs = t;
  return { state, stepsAdded: [] };
}

/**
 * Pure activity-clock tick (host 500ms → fixture op:tick).
 */
function reduceRouteTick(state, { nowMs } = {}) {
  const t = nowMs != null ? Number(nowMs) : state.t0Ms;
  const added = [];

  if (state.park && state.clockMode === 'prompt') {
    const parkSec = Math.max(0, Math.floor((t - state.park.sinceMs) / 1000));
    const who = state.park.toolName ? ` · ${state.park.toolName}` : '';
    const detail = `${state.park.label}${who} ${parkSec}s`;
    // Freeze silence budget
    state.lastActivityMs = t;
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'park',
      tMs: relMs(state, t),
      detail,
      toolName: state.park.toolName || undefined,
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
    return { state, stepsAdded: added };
  }

  if (state.clockMode === 'boot') {
    const sec = Math.max(0, Math.floor((t - (state.bootStartedMs || state.t0Ms)) / 1000));
    const base = String(state.lastDetail || 'ACP 启动中…').replace(/\s+\d+s\s*$/, '');
    const detail = `${base || 'ACP 启动中…'} ${sec}s`;
    const before = state.steps.length;
    appendRouteStep(state, { kind: 'boot', tMs: relMs(state, t), detail });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
    return { state, stepsAdded: added };
  }

  if (state.clockMode !== 'prompt') return { state, stepsAdded: added };

  const silentSec = Math.max(0, Math.floor((t - state.lastActivityMs) / 1000));
  if (silentSec > state.maxSilentSec) state.maxSilentSec = silentSec;

  if (!state.firstTokenMs) {
    if (silentSec >= 1) {
      const detail = `等待模型首包… ${silentSec}s`;
      const before = state.steps.length;
      appendRouteStep(state, {
        kind: 'silence',
        tMs: relMs(state, t),
        detail,
        meta: { reason: 'first_token' },
      });
      if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
    }
    return { state, stepsAdded: added };
  }

  if (state.toolDepth > 0) {
    // tool-running silence — keep last tool identity without spamming new kinds
    return { state, stepsAdded: added };
  }

  if (silentSec >= 1) {
    const last = state.lastToolName ? `上次 ${state.lastToolName} · ` : '';
    const detail = `等待模型继续… ${silentSec}s（${last}CLI 段间静默）`;
    const before = state.steps.length;
    appendRouteStep(state, {
      kind: 'silence',
      tMs: relMs(state, t),
      detail,
      meta: { reason: 'inter_stage', lastTool: state.lastToolName },
    });
    if (state.steps.length > before) added.push(state.steps[state.steps.length - 1]);
  }
  return { state, stepsAdded: added };
}

function summarizeRoute(routeState, opts = {}) {
  const totalMs =
    opts.nowMs != null
      ? Math.max(0, Number(opts.nowMs) - routeState.t0Ms)
      : routeState.steps.length
        ? routeState.steps[routeState.steps.length - 1].tMs
        : 0;
  const firstTokenMs =
    routeState.firstTokenMs > 0 ? Math.max(0, routeState.firstTokenMs - routeState.t0Ms) : -1;
  const c = routeState.counters;
  return {
    transport: opts.transport || 'unknown',
    firstTokenMs,
    totalMs,
    textChunks: c.textChunks,
    thoughtChunks: c.thoughtChunks,
    toolStarts: c.toolStarts,
    toolEnds: c.toolEnds,
    toolInProgress: c.toolInProgress,
    maxSilentSec: routeState.maxSilentSec,
    emptyToolsOnly: c.toolStarts > 0 && c.textChunks === 0 ? 1 : 0,
    terminal: routeState.terminal,
    stepKinds: routeState.steps.map((s) => s.kind),
    stepCount: routeState.steps.length,
  };
}

/**
 * Compact labels for Live route strip (host paint).
 */
function routeStripLabels(steps, { max = 12, en = false } = {}) {
  const labels = [];
  let tools = 0;
  for (const s of steps || []) {
    if (s.kind === 'boot') labels.push(en ? 'boot' : '启动');
    else if (s.kind === 'thinking') labels.push(en ? 'think' : '思考');
    else if (s.kind === 'tool_start' && !s.progress) {
      tools += 1;
      labels.push(s.toolName ? String(s.toolName).slice(0, 16) : en ? 'tool' : '工具');
    } else if (s.kind === 'streaming') labels.push(en ? 'text' : '输出');
    else if (s.kind === 'silence') labels.push(en ? 'wait' : '等待');
    else if (s.kind === 'park') labels.push(en ? 'park' : '授权');
    else if (s.kind === 'goal') labels.push(en ? 'goal' : '目标');
    else if (s.kind === 'compact') labels.push(en ? 'compact' : '压缩');
    else if (s.kind === 'subagent') labels.push(en ? 'sub' : '子代理');
    else if (s.kind === 'retry') labels.push(en ? 'retry' : '重试');
    else if (s.kind === 'plan') labels.push(en ? 'plan' : '计划');
    else if (s.kind === 'done') labels.push(en ? 'done' : '完成');
    else if (s.kind === 'error') labels.push(en ? 'error' : '错误');
    else if (s.kind === 'stopped') labels.push(en ? 'stop' : '停止');
  }
  // collapse consecutive duplicates
  const collapsed = [];
  for (const L of labels) {
    if (collapsed[collapsed.length - 1] !== L) collapsed.push(L);
  }
  const slim = collapsed.slice(-max);
  return { labels: slim, tools, text: slim.join(' → ') };
}

module.exports = {
  ROUTE_STEP_KINDS,
  createRouteState,
  appendRouteStep,
  mapActionToStepKind,
  reduceRouteFromAction,
  reduceRouteFromActions,
  reduceRouteTick,
  routeStartBoot,
  routeStartPrompt,
  routeSetPark,
  routeClearPark,
  summarizeRoute,
  routeStripLabels,
};
