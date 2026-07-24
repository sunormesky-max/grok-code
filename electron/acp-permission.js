/**
 * ACP session/request_permission option picking.
 * Mirrors grok-build pager YOLO path: prefer PermissionOptionKind::AllowOnce
 * (optionId often "allow-once"), never invent IDs not in the request.
 */

/**
 * Normalize one option from wire (camelCase / snake_case).
 * @param {object} o
 */
function normalizeOption(o) {
  if (!o || typeof o !== 'object') return null;
  const optionId = String(o.optionId || o.option_id || o.id || '').trim();
  if (!optionId) return null;
  const kind = String(o.kind || o.optionKind || o.option_kind || '').toLowerCase();
  const name = String(o.name || o.title || o.label || optionId);
  return { optionId, kind, name, raw: o };
}

/**
 * @param {object} params RequestPermissionRequest params
 * @returns {ReturnType<typeof normalizeOption>[]}
 */
function extractOptions(params) {
  const raw =
    params?.options ||
    params?.permissionOptions ||
    params?.permission_options ||
    params?.request?.options ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeOption).filter(Boolean);
}

/**
 * Pick optionId for auto-approve (YOLO).
 * Priority (matches grok-build permissions.rs):
 *  1. kind === allowonce (AllowOnce)
 *  2. optionId allow-once / allow_once
 *  3. name contains "once" and allow
 *  4. kind allowalways only if preferAlways
 *  5. first option whose id/name looks like allow (not reject/deny)
 *  6. null → caller should cancel
 *
 * @param {object[]} options normalized
 * @param {{ preferAlways?: boolean }} [opts]
 */
function pickAutoApproveOptionId(options, opts = {}) {
  const list = (options || []).map((o) => (o.optionId ? o : normalizeOption(o))).filter(Boolean);
  if (!list.length) return null;

  const byKindOnce = list.find((o) => o.kind === 'allowonce' || o.kind === 'allow_once');
  if (byKindOnce) return byKindOnce.optionId;

  const byIdOnce = list.find((o) =>
    /^(allow-once|allow_once|allowonce)$/i.test(o.optionId)
  );
  if (byIdOnce) return byIdOnce.optionId;

  const byNameOnce = list.find(
    (o) => /allow/i.test(o.name) && /once/i.test(o.name) && !/always|reject|deny/i.test(o.name)
  );
  if (byNameOnce) return byNameOnce.optionId;

  if (opts.preferAlways) {
    const always = list.find(
      (o) =>
        o.kind === 'allowalways' ||
        o.kind === 'allow_always' ||
        /allow-always|allow_always/i.test(o.optionId)
    );
    if (always) return always.optionId;
  }

  const allowish = list.find(
    (o) =>
      /allow|approve|yes|ok/i.test(o.optionId + ' ' + o.name) &&
      !/reject|deny|cancel|no\b/i.test(o.optionId + ' ' + o.name)
  );
  if (allowish) return allowish.optionId;

  return null;
}

/**
 * Build ACP RequestPermissionResponse result object for JSON-RPC.
 * @param {'selected'|'cancelled'} outcome
 * @param {string} [optionId]
 */
function buildPermissionResult(outcome, optionId) {
  if (outcome === 'selected' && optionId) {
    // agent-client-protocol wire: outcome.outcome = "selected" + optionId
    return {
      outcome: {
        outcome: 'selected',
        optionId: String(optionId),
      },
    };
  }
  return {
    outcome: {
      outcome: 'cancelled',
    },
  };
}

/**
 * Full handler for session/request_permission params (auto path only).
 * When autoApprove is false, callers should **park** for host UI instead of
 * using mode:'deny' — cancel-without-UI was a footgun for careful plan exec.
 * @param {object} params
 * @param {{ autoApprove?: boolean, preferAlways?: boolean }} cfg
 */
function resolvePermissionResponse(params, cfg = {}) {
  const options = extractOptions(params);
  const autoApprove = cfg.autoApprove !== false;
  if (!autoApprove) {
    return {
      result: buildPermissionResult('cancelled'),
      options,
      selected: null,
      mode: 'needs_user', // signal: host should park, not treat as hard deny
    };
  }
  const optionId = pickAutoApproveOptionId(options, {
    preferAlways: Boolean(cfg.preferAlways),
  });
  if (!optionId) {
    return {
      result: buildPermissionResult('cancelled'),
      options,
      selected: null,
      mode: 'no-allow-option',
    };
  }
  return {
    result: buildPermissionResult('selected', optionId),
    options,
    selected: optionId,
    mode: 'auto',
  };
}

/**
 * Pull tool name/args from request_permission params (defensive wire shapes).
 * @param {object} params
 */
function extractToolFromPermissionParams(params = {}) {
  const tc =
    params.toolCall ||
    params.tool_call ||
    params.request?.toolCall ||
    params.request?.tool_call ||
    {};
  const name = String(
    tc.title || tc.name || tc.kind || params.toolName || params.tool_name || 'tool'
  );
  let args =
    tc.rawInput ||
    tc.raw_input ||
    tc.input ||
    tc.arguments ||
    tc.args ||
    params.arguments ||
    {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { raw: args };
    }
  }
  if (!args || typeof args !== 'object') args = {};
  return {
    toolCallId: String(tc.toolCallId || tc.tool_call_id || tc.id || ''),
    name,
    title: String(tc.title || name),
    args,
  };
}

module.exports = {
  normalizeOption,
  extractOptions,
  pickAutoApproveOptionId,
  buildPermissionResult,
  resolvePermissionResponse,
  extractToolFromPermissionParams,
};
