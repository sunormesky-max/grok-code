/**
 * Shared IPC event channel allowlist (main → renderer).
 * Preload must only subscribe to these; contract tests lock the set.
 */
const AGENT_EVENT_CHANNELS = Object.freeze([
  'agent:status',
  'agent:phase',
  'agent:text',
  'agent:thought',
  'agent:tool_start',
  'agent:tool_end',
  'agent:tool_batch',
  'agent:usage',
  'agent:error',
  'agent:done',
  'agent:cli',
  'agent:plan',
  'agent:mode',
  'agent:model',
  'agent:commands',
  'agent:permission',
  'agent:plan_approval',
  'agent:user_question',
  'agent:ext',
]);

const RENDERER_EVENT_CHANNELS = Object.freeze([
  ...AGENT_EVENT_CHANNELS,
  'fs:changed',
  'window:maximized',
  'update:status',
]);

/** Required on every agent payload so multi-task routing works. */
const AGENT_PAYLOAD_REQUIRED = Object.freeze(['taskId']);

function isAllowedRendererChannel(channel) {
  return RENDERER_EVENT_CHANNELS.includes(channel);
}

function assertAgentPayloadShape(channel, payload) {
  if (!AGENT_EVENT_CHANNELS.includes(channel)) {
    return { ok: false, error: `unknown agent channel: ${channel}` };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload must be object' };
  }
  if (payload.taskId == null || payload.taskId === '') {
    return { ok: false, error: 'taskId required' };
  }
  if (channel === 'agent:text' || channel === 'agent:thought') {
    if (typeof payload.text !== 'string' && typeof payload.delta !== 'string') {
      return { ok: false, error: `${channel} needs text or delta` };
    }
  }
  if (channel === 'agent:tool_start') {
    if (!payload.name && !payload.id) {
      return { ok: false, error: 'tool_start needs name or id' };
    }
  }
  if (channel === 'agent:error') {
    if (payload.error == null && payload.message == null) {
      return { ok: false, error: 'error payload needs error/message' };
    }
  }
  return { ok: true };
}

module.exports = {
  AGENT_EVENT_CHANNELS,
  RENDERER_EVENT_CHANNELS,
  AGENT_PAYLOAD_REQUIRED,
  isAllowedRendererChannel,
  assertAgentPayloadShape,
};
