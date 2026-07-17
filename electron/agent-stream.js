/**
 * Pure headless NDJSON + ACP session/update reducers.
 * No Electron / process — unit tests feed fixtures and assert IPC actions.
 */
const { pickToolInfo, pickChunkText, pickToolResultText, slimToolArgs } = require('./acp-client');

const HEADLESS_KNOWN_TYPES = Object.freeze([
  'text',
  'message',
  'assistant',
  'content',
  'response_text',
  'output_text',
  'thought',
  'reasoning',
  'thinking',
  'reasoning_text',
  'tool',
  'tool_call',
  'tool_start',
  'tool_use',
  'function_call',
  'tool_result',
  'tool_end',
  'tool_result_end',
  'function_result',
  'end',
  'result',
  'done',
  'error',
  'max_turns_reached',
  'status',
]);

function isKnownHeadlessType(type) {
  return HEADLESS_KNOWN_TYPES.includes(String(type || '').toLowerCase());
}

function pickChunk(ev) {
  if (ev == null) return '';
  if (typeof ev.data === 'string') return ev.data;
  if (typeof ev.delta === 'string') return ev.delta;
  if (typeof ev.text === 'string' && !ev.accumulated) return ev.text;
  if (typeof ev.content === 'string') return ev.content;
  if (Array.isArray(ev.content)) {
    return ev.content
      .map((c) => (typeof c === 'string' ? c : c?.text || c?.data || ''))
      .join('');
  }
  return '';
}

/**
 * @returns {{ finalText: string, thoughtText: string, toolDepth: number, sessionId: string|null, usage: object|null, stopReason: *, numTurns: number, openTools: Set<string> }}
 */
function createStreamState(seed = {}) {
  return {
    finalText: '',
    thoughtText: '',
    toolDepth: 0,
    sessionId: seed.sessionId || null,
    usage: null,
    stopReason: null,
    numTurns: 0,
    openTools: new Set(),
  };
}

/**
 * Parse one stdout line from headless streaming-json.
 * @returns {{ kind: 'event', event: object } | { kind: 'non_json', text: string } | { kind: 'empty' }}
 */
function parseNdjsonLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return { kind: 'empty' };
  try {
    const event = JSON.parse(trimmed);
    if (!event || typeof event !== 'object') {
      return { kind: 'non_json', text: trimmed };
    }
    return { kind: 'event', event };
  } catch {
    return { kind: 'non_json', text: trimmed };
  }
}

/**
 * Apply a headless NDJSON event. Returns IPC-oriented actions (no timers).
 * Action shapes:
 *   { op: 'emit', channel, payload, immediate? }
 *   { op: 'phase', phase, detail }
 *   { op: 'flush' }
 *
 * @param {ReturnType<typeof createStreamState>} state
 * @param {object} ev
 */
function reduceHeadlessEvent(state, ev) {
  const actions = [];
  if (!ev || typeof ev !== 'object') return { state, actions };

  if (ev.sessionId && typeof ev.sessionId === 'string') {
    state.sessionId = ev.sessionId;
  }

  const type = String(ev.type || '').toLowerCase();

  if (
    type === 'text' ||
    type === 'message' ||
    type === 'assistant' ||
    type === 'content' ||
    type === 'response_text' ||
    type === 'output_text'
  ) {
    const chunk = pickChunk(ev);
    if (
      typeof ev.text === 'string' &&
      ev.text.length > state.finalText.length &&
      !ev.data &&
      !ev.delta &&
      (ev.accumulated || ev.full)
    ) {
      state.finalText = ev.text;
    } else if (
      typeof ev.text === 'string' &&
      ev.text.length > state.finalText.length &&
      !ev.data &&
      !ev.delta
    ) {
      if (ev.text.startsWith(state.finalText)) state.finalText = ev.text;
      else if (chunk) state.finalText += chunk;
      else state.finalText = ev.text;
    } else if (chunk) {
      state.finalText += chunk;
    }
    actions.push({
      op: 'emit',
      channel: 'agent:text',
      payload: {
        text: state.finalText,
        delta: chunk || '',
        partial: true,
        phase: 'streaming',
      },
    });
    if (state.toolDepth <= 0) {
      actions.push({ op: 'phase', phase: 'streaming', detail: 'speaking…' });
    }
  } else if (
    type === 'thought' ||
    type === 'reasoning' ||
    type === 'thinking' ||
    type === 'reasoning_text'
  ) {
    const chunk = pickChunk(ev);
    if (chunk) state.thoughtText += chunk;
    else if (typeof ev.text === 'string' && ev.text.length > state.thoughtText.length) {
      state.thoughtText = ev.text;
    }
    actions.push({
      op: 'emit',
      channel: 'agent:thought',
      payload: {
        text: state.thoughtText,
        delta: chunk || '',
        phase: 'thinking',
      },
    });
    if (state.toolDepth <= 0) {
      actions.push({ op: 'phase', phase: 'thinking', detail: 'thinking…' });
    }
  } else if (
    type === 'tool' ||
    type === 'tool_call' ||
    type === 'tool_start' ||
    type === 'tool_use' ||
    type === 'function_call'
  ) {
    actions.push({ op: 'flush' });
    state.toolDepth += 1;
    const name = ev.name || ev.tool || ev.function?.name || 'tool';
    actions.push({
      op: 'emit',
      channel: 'agent:tool_start',
      payload: {
        id: ev.id || ev.tool_call_id || ev.call_id || `tool-${Date.now()}`,
        name,
        args: ev.args || ev.input || ev.function?.arguments || {},
      },
    });
    actions.push({ op: 'phase', phase: 'tool', detail: `${name}…` });
  } else if (
    type === 'tool_result' ||
    type === 'tool_end' ||
    type === 'tool_result_end' ||
    type === 'function_result'
  ) {
    actions.push({ op: 'flush' });
    state.toolDepth = Math.max(0, state.toolDepth - 1);
    actions.push({
      op: 'emit',
      channel: 'agent:tool_end',
      payload: {
        id: ev.id || ev.tool_call_id || ev.call_id || '',
        name: ev.name || ev.tool || 'tool',
        args: ev.args || {},
        result:
          typeof ev.result === 'string'
            ? ev.result
            : JSON.stringify(ev.result ?? ev.output ?? ''),
        ok: ev.ok !== false && ev.is_error !== true,
      },
    });
    if (state.toolDepth <= 0 && state.finalText) {
      actions.push({ op: 'phase', phase: 'streaming', detail: 'speaking…' });
    } else if (state.toolDepth <= 0) {
      actions.push({ op: 'phase', phase: 'running', detail: 'working…' });
    }
  } else if (type === 'end' || type === 'result' || type === 'done') {
    if (ev.sessionId) state.sessionId = ev.sessionId;
    if (ev.usage) state.usage = ev.usage;
    if (ev.stopReason) state.stopReason = ev.stopReason;
    if (typeof ev.num_turns === 'number') state.numTurns = ev.num_turns;
    if (typeof ev.numTurns === 'number') state.numTurns = ev.numTurns;
    if (typeof ev.text === 'string' && ev.text.length > state.finalText.length) {
      state.finalText = ev.text;
    }
    actions.push({ op: 'flush' });
    if (state.finalText) {
      actions.push({
        op: 'emit',
        channel: 'agent:text',
        payload: { text: state.finalText, delta: '', partial: false },
        immediate: true,
      });
    }
    if (state.usage) {
      actions.push({
        op: 'emit',
        channel: 'agent:usage',
        payload: {
          usage: state.usage,
          stopReason: state.stopReason,
          numTurns: state.numTurns,
          sessionId: state.sessionId,
        },
      });
    }
    actions.push({ op: 'phase', phase: 'done', detail: 'done' });
  } else if (type === 'error') {
    actions.push({ op: 'flush' });
    actions.push({
      op: 'emit',
      channel: 'agent:error',
      payload: { error: ev.message || ev.error || 'Grok CLI error' },
    });
  } else if (type === 'max_turns_reached') {
    actions.push({ op: 'phase', phase: 'max_turns', detail: 'max turns' });
  } else if (type === 'status' && ev.status) {
    actions.push({
      op: 'phase',
      phase: String(ev.status),
      detail: ev.detail || ev.message || String(ev.status),
    });
  }

  return { state, actions };
}

/**
 * Apply non-JSON plain text line (headless fallback).
 */
function reduceNonJsonLine(state, text) {
  const trimmed = String(text || '');
  if (!trimmed) return { state, actions: [] };
  state.finalText +=
    (state.finalText && !state.finalText.endsWith('\n') ? '\n' : '') + trimmed;
  return {
    state,
    actions: [
      {
        op: 'emit',
        channel: 'agent:text',
        payload: {
          text: state.finalText,
          delta: trimmed,
          partial: true,
        },
      },
      { op: 'phase', phase: 'streaming', detail: 'speaking…' },
    ],
  };
}

/**
 * Feed a multi-line NDJSON fixture; returns final state + ordered IPC emits.
 * @param {string} ndjson
 * @param {{ taskId?: string }} [opts]
 */
function reduceHeadlessNdjson(ndjson, opts = {}) {
  const taskId = opts.taskId || 't1';
  let state = createStreamState(opts);
  /** @type {{ channel: string, payload: object }[]} */
  const emits = [];
  /** @type {{ phase: string, detail: string }[]} */
  const phases = [];
  let recognized = 0;
  let unrecognized = 0;
  let nonJson = 0;

  const applyActions = (actions) => {
    for (const a of actions) {
      if (a.op === 'emit') {
        emits.push({
          channel: a.channel,
          payload: { ...a.payload, taskId },
        });
      } else if (a.op === 'phase') {
        phases.push({ phase: a.phase, detail: a.detail });
        emits.push({
          channel: 'agent:phase',
          payload: { phase: a.phase, detail: a.detail, taskId },
        });
        emits.push({
          channel: 'agent:status',
          payload: { status: a.phase, detail: a.detail, taskId },
        });
      }
      // flush is a no-op in pure mode (no timers)
    }
  };

  const lines = String(ndjson || '').split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseNdjsonLine(line);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'non_json') {
      nonJson += 1;
      const r = reduceNonJsonLine(state, parsed.text);
      state = r.state;
      applyActions(r.actions);
      continue;
    }
    const type = String(parsed.event?.type || '').toLowerCase();
    if (isKnownHeadlessType(type)) recognized += 1;
    else if (type) unrecognized += 1;
    const r = reduceHeadlessEvent(state, parsed.event);
    state = r.state;
    applyActions(r.actions);
  }

  return {
    state,
    emits,
    phases,
    stats: { recognized, unrecognized, nonJson },
  };
}

/**
 * Reduce one ACP session/update payload into actions (mirrors agent.js onUpdate).
 * @param {ReturnType<typeof createStreamState>} state
 * @param {object} update
 * @param {{ textChunks?: number, thoughtChunks?: number }} counters
 */
function reduceAcpUpdate(state, update, counters = { textChunks: 0, thoughtChunks: 0 }) {
  const actions = [];
  if (!update) return { state, actions, counters };

  const kind = String(update.sessionUpdate || update.type || '');

  if (kind === 'agent_message_chunk' || kind === 'agent_message') {
    const chunk = pickChunkText(update);
    if (chunk) state.finalText += chunk;
    counters.textChunks = (counters.textChunks || 0) + 1;
    actions.push({
      op: 'emit',
      channel: 'agent:text',
      payload: {
        text: state.finalText,
        delta: chunk || '',
        partial: true,
        phase: 'streaming',
      },
      immediate: counters.textChunks === 1,
    });
    if (state.toolDepth <= 0) {
      actions.push({ op: 'phase', phase: 'streaming', detail: 'speaking…' });
    }
  } else if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
    const chunk = pickChunkText(update);
    if (chunk) state.thoughtText += chunk;
    counters.thoughtChunks = (counters.thoughtChunks || 0) + 1;
    actions.push({
      op: 'emit',
      channel: 'agent:thought',
      payload: {
        text: state.thoughtText,
        delta: chunk || '',
        phase: 'thinking',
      },
      immediate: counters.thoughtChunks === 1,
    });
    if (state.toolDepth <= 0) {
      actions.push({ op: 'phase', phase: 'thinking', detail: 'thinking…' });
    }
  } else if (kind === 'tool_call') {
    actions.push({ op: 'flush' });
    const info = pickToolInfo(update);
    if (!state.openTools.has(info.id)) {
      state.openTools.add(info.id);
      state.toolDepth += 1;
      actions.push({
        op: 'emit',
        channel: 'agent:tool_start',
        payload: {
          id: info.id,
          name: info.name,
          args: slimToolArgs(info.args),
        },
      });
      actions.push({ op: 'phase', phase: 'tool', detail: `${info.name}…` });
    }
  } else if (kind === 'tool_call_update') {
    const info = pickToolInfo(update);
    const status = String(update.status || '').toLowerCase();
    if (
      !state.openTools.has(info.id) &&
      status !== 'completed' &&
      status !== 'failed' &&
      status !== 'cancelled'
    ) {
      state.openTools.add(info.id);
      state.toolDepth += 1;
      actions.push({
        op: 'emit',
        channel: 'agent:tool_start',
        payload: {
          id: info.id,
          name: info.name,
          args: slimToolArgs(info.args),
        },
      });
      actions.push({ op: 'phase', phase: 'tool', detail: `${info.name}…` });
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      if (state.openTools.has(info.id)) {
        state.openTools.delete(info.id);
        state.toolDepth = Math.max(0, state.toolDepth - 1);
      }
      actions.push({ op: 'flush' });
      actions.push({
        op: 'emit',
        channel: 'agent:tool_end',
        payload: {
          id: info.id,
          name: info.name,
          args: slimToolArgs(info.args),
          result: pickToolResultText(update),
          ok: status === 'completed',
        },
      });
      if (state.toolDepth <= 0 && state.finalText) {
        actions.push({ op: 'phase', phase: 'streaming', detail: 'speaking…' });
      } else if (state.toolDepth <= 0) {
        actions.push({ op: 'phase', phase: 'running', detail: 'working…' });
      }
    }
  }

  return { state, actions, counters };
}

/**
 * Apply text/thought buffer update from IPC payload (renderer contract).
 * Prefer full `text` snapshot; fall back to append `delta`.
 */
function applyStreamBuffer(prev, payload) {
  let next = prev == null ? '' : String(prev);
  if (payload && typeof payload.text === 'string') next = payload.text;
  else if (payload && payload.delta) next = next + String(payload.delta);
  return next;
}

module.exports = {
  HEADLESS_KNOWN_TYPES,
  isKnownHeadlessType,
  pickChunk,
  createStreamState,
  parseNdjsonLine,
  reduceHeadlessEvent,
  reduceNonJsonLine,
  reduceHeadlessNdjson,
  reduceAcpUpdate,
  applyStreamBuffer,
};
