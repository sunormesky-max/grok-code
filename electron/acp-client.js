/**
 * Minimal ACP (Agent Client Protocol) client over `grok agent stdio`.
 *
 * Headless `--output-format streaming-json` only emits text/thought/end and
 * never tool progress. Desktop UI must use ACP for tool_call streaming.
 *
 * Spec shape used by Grok Build 0.2.x (verified against local probe):
 *   initialize �?session/new|session/load �?session/prompt
 *   session/update: agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update
 */
const { spawn } = require('child_process');
const {
  resolvePermissionResponse,
  extractOptions,
  buildPermissionResult,
  extractToolFromPermissionParams,
  normToolKey,
  matchStandingGrant,
  shouldRememberGrant,
} = require('./acp-permission');

class AcpClient {
  /**
   * @param {{
   *   bin: string,
   *   args?: string[],
   *   env?: NodeJS.ProcessEnv,
   *   onUpdate?: (update: object, params: object) => void,
   *   onNotification?: (method: string, params: object) => void,
   *   onStderr?: (s: string) => void,
   *   onExit?: (code: number|null) => void,
   *   autoApprove?: boolean,
   * }} opts
   */
  constructor(opts) {
    this.bin = opts.bin;
    this.args = opts.args || ['agent', '--always-approve', '--no-leader', 'stdio'];
    this.env = opts.env || process.env;
    this.onUpdate = opts.onUpdate || (() => {});
    this.onNotification = opts.onNotification || (() => {});
    this.onStderr = opts.onStderr || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.onPermission = opts.onPermission || null;
    this.onPlanApproval = opts.onPlanApproval || null;
    this.onUserQuestion = opts.onUserQuestion || null;
    this.onAgentRequest = opts.onAgentRequest || null;
    this.autoApprove = opts.autoApprove !== false;
    /**
     * Session/flight standing grants: toolKey → optionId that was offered by CLI
     * and chosen (or allow-always). Cleared with client lifecycle — not a second SM.
     * @type {Map<string, string>}
     */
    this.standingGrants = new Map();
    /**
     * When true (default), exit_plan_mode waits for host UI (approve/revise/quit).
     * Set false or GROKCODE_AUTO_APPROVE_PLAN=1 to auto-approve like pure YOLO.
     */
    this.planInteractive =
      opts.planInteractive !== undefined
        ? Boolean(opts.planInteractive)
        : process.env.GROKCODE_AUTO_APPROVE_PLAN !== '1';
    /**
     * When true (default), ask_user_question parks for host UI.
     * GROKCODE_AUTO_CANCEL_ASK_USER=1 → immediate cancelled (legacy non-hang).
     */
    this.userQuestionInteractive =
      opts.userQuestionInteractive !== undefined
        ? Boolean(opts.userQuestionInteractive)
        : process.env.GROKCODE_AUTO_CANCEL_ASK_USER !== '1';
    /** @type {import('child_process').ChildProcess | null} */
    this.child = null;
    this.buf = '';
    this.nextId = 0;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** Open interactive reverse-requests (plan approval etc.) awaiting host reply */
    this.pendingInteractive = new Map();
    this.alive = false;
    this.stderrBuf = '';
    /**
     * Only true while session/prompt is in flight.
     * session/load replays history as session/update — must be ignored or UI
     * floods with old tools and looks blank / frozen during the real turn.
     */
    this.streaming = false;
  }

  start() {
    if (this.child) return;
    const child = spawn(this.bin, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      windowsHide: true,
    });
    this.child = child;
    this.alive = true;
    try {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
    } catch {
      /* ignore */
    }
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrBuf += s;
      if (this.stderrBuf.length > 40_000) this.stderrBuf = this.stderrBuf.slice(-40_000);
      this.onStderr(s);
    });
    child.on('error', (err) => {
      this.alive = false;
      this._rejectAll(err);
      this.onExit(null);
    });
    child.on('close', (code) => {
      this.alive = false;
      this._rejectAll(new Error(`ACP process exited (${code})`));
      this.onExit(code);
    });
  }

  _rejectAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _onStdout(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // JSON-RPC response
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          // Prefer data.message — grok wraps 403 as "Internal error" + data.http_status
          const data = msg.error.data;
          const detail =
            typeof data === 'string'
              ? data
              : data && typeof data === 'object'
                ? data.message || data.error || JSON.stringify(data)
                : '';
          const head = msg.error.message || 'ACP error';
          const e = new Error(detail && detail !== head ? `${head}: ${detail}` : head);
          e.code = msg.error.code;
          e.data = msg.error.data;
          e.httpStatus =
            data && typeof data === 'object'
              ? data.http_status || data.httpStatus || data.status
              : undefined;
          p.reject(e);
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC request from agent (permission etc.)
    if (msg.method && msg.id != null && msg.result === undefined) {
      this._handleAgentRequest(msg);
      return;
    }

    // Notification
    if (msg.method) {
      const params = msg.params || {};
      if (msg.method === 'session/update') {
        // Drop history replay & idle notifications outside an active prompt
        if (!this.streaming) return;
        const update = params.update || params;
        try {
          this.onUpdate(update, params);
        } catch {
          /* UI handler errors must not kill transport */
        }
      } else if (
        msg.method === 'x.ai/session_notification' ||
        msg.method === '_x.ai/session_notification'
      ) {
        // xAI extension plane (ToolCallDeltaChunk, compact, retry, ModelChanged…).
        // Tool deltas only matter mid-prompt; ModelChanged may arrive between turns
        // after session/set_model — allow that (and compact/retry) outside streaming.
        if (!this.streaming) {
          const u = params?.update || params?.sessionUpdate || params || {};
          const k = String(
            u.sessionUpdate || u.session_update || u.type || ''
          )
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .toLowerCase();
          if (
            k !== 'model_changed' &&
            k !== 'modelchanged' &&
            !/compact|retry|mode/i.test(k)
          ) {
            return;
          }
        }
        try {
          this.onNotification(msg.method, params);
        } catch {
          /* ignore */
        }
      } else {
        try {
          this.onNotification(msg.method, params);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Unwrap gateway-style `_x.ai/foo` → { method, params }.
   * Leader may wrap as method=`_x.ai/exit_plan_mode` with params.method + params.params.
   */
  _unwrapAgentMethod(msg) {
    let method = String(msg.method || '');
    let params = msg.params || {};
    if (method.startsWith('_') && params && typeof params === 'object' && params.method) {
      method = String(params.method);
      params = params.params || params;
    }
    return { method, params };
  }

  _handleAgentRequest(msg) {
    const { method, params } = this._unwrapAgentMethod(msg);
    const reqId = msg.id;

    // Tool permissions: YOLO auto-pick CLI options, else park for host UI
    // (never invent optionIds; never blank-cancel when user asked for careful mode)
    if (method === 'session/request_permission' || method.endsWith('/request_permission')) {
      // exit_plan_mode is NOT request_permission — handled below as x.ai/exit_plan_mode
      if (this.autoApprove) {
        const resolved = resolvePermissionResponse(params || {}, {
          autoApprove: true,
          preferAlways: false, // match grok-build: YOLO uses AllowOnce, not AllowAlways
        });
        try {
          if (typeof this.onPermission === 'function') {
            this.onPermission({
              method,
              params,
              selected: resolved.selected,
              mode: resolved.mode,
              options: resolved.options,
              pending: false,
              requestId: reqId,
            });
          }
        } catch {
          /* ignore */
        }
        this._respond(reqId, resolved.result);
        return;
      }

      const options = extractOptions(params || {});
      const tool = extractToolFromPermissionParams(params || {});
      // Standing grant: only if optionId is still in this request's CLI list
      const grantKey = normToolKey(tool.name);
      const grantId = this.standingGrants.get(grantKey);
      const matched = matchStandingGrant(options, grantId);
      if (matched) {
        const result = buildPermissionResult('selected', matched);
        try {
          if (typeof this.onPermission === 'function') {
            this.onPermission({
              method,
              params,
              requestId: reqId,
              pending: false,
              mode: 'standing',
              selected: matched,
              options,
              toolName: tool.name,
              toolTitle: tool.title,
              toolArgs: tool.args,
              toolCallId: tool.toolCallId,
            });
          }
        } catch {
          /* ignore */
        }
        this._respond(reqId, result);
        return;
      }

      this.pendingInteractive.set(String(reqId), {
        kind: 'permission',
        method,
        requestId: reqId,
        toolCallId: tool.toolCallId || '',
        toolName: tool.name,
        options,
        at: Date.now(),
      });
      try {
        if (typeof this.onPermission === 'function') {
          this.onPermission({
            method,
            params,
            requestId: reqId,
            pending: true,
            mode: 'interactive',
            selected: null,
            options,
            toolName: tool.name,
            toolTitle: tool.title,
            toolArgs: tool.args,
            toolCallId: tool.toolCallId,
          });
        }
      } catch {
        /* ignore */
      }
      return;
    }

    // Plan approval reverse-request (upstream: x.ai/exit_plan_mode)
    // Response shape (ExitPlanModeExtResponse): { outcome, feedback? }
    // outcomes: approved | abandoned | cancelled
    if (
      method === 'x.ai/exit_plan_mode' ||
      method === '_x.ai/exit_plan_mode' ||
      /exit_plan_mode/i.test(method)
    ) {
      const toolCallId =
        params.toolCallId ||
        params.tool_call_id ||
        params.toolCall?.toolCallId ||
        params.tool_call?.tool_call_id ||
        '';
      const planContent =
        params.planContent ||
        params.plan_content ||
        params.plan ||
        params.content ||
        '';
      const sessionId = params.sessionId || params.session_id || '';

      const autoPlan =
        this.autoApprove &&
        (!this.planInteractive || process.env.GROKCODE_AUTO_APPROVE_PLAN === '1');

      if (autoPlan) {
        this._respond(reqId, { outcome: 'approved' });
        try {
          if (typeof this.onPlanApproval === 'function') {
            this.onPlanApproval({
              requestId: reqId,
              method,
              toolCallId: String(toolCallId),
              planContent: String(planContent || ''),
              sessionId: String(sessionId),
              mode: 'auto',
              pending: false,
              selected: 'approved',
            });
          }
        } catch {
          /* ignore */
        }
        return;
      }

      // Park reverse-request until host UI answers (first answer wins)
      this.pendingInteractive.set(String(reqId), {
        kind: 'plan_approval',
        method,
        requestId: reqId,
        toolCallId: String(toolCallId),
        at: Date.now(),
      });
      try {
        if (typeof this.onPlanApproval === 'function') {
          this.onPlanApproval({
            requestId: reqId,
            method,
            toolCallId: String(toolCallId),
            planContent: String(planContent || ''),
            sessionId: String(sessionId),
            mode: 'interactive',
            pending: true,
          });
        }
      } catch {
        /* ignore */
      }
      return;
    }

    // ask_user_question reverse-request (upstream: x.ai/ask_user_question)
    // Response: AskUserQuestionExtResponse tagged on "outcome"
    //   accepted | chat_about_this | skip_interview | cancelled
    if (
      method === 'x.ai/ask_user_question' ||
      method === '_x.ai/ask_user_question' ||
      /ask_user_question/i.test(method)
    ) {
      this._handleAskUserQuestion(reqId, method, params);
      return;
    }

    // Unknown agent→client request: empty result so agent does not hang
    try {
      if (typeof this.onAgentRequest === 'function') {
        this.onAgentRequest({ method, params: params || {}, id: reqId });
      }
    } catch {
      /* ignore */
    }
    this._respond(reqId, {});
  }

  /**
   * Park x.ai/ask_user_question until host UI answers.
   * Wire shape (camelCase): sessionId, toolCallId, questions[], mode default|plan
   */
  _handleAskUserQuestion(reqId, method, params) {
    const p = params && typeof params === 'object' ? params : {};
    const toolCallId =
      p.toolCallId || p.tool_call_id || p.toolCall?.toolCallId || '';
    const sessionId = p.sessionId || p.session_id || '';
    const modeRaw = String(p.mode || 'default').toLowerCase();
    const mode = modeRaw === 'plan' ? 'plan' : 'default';
    const questions = normalizeAskUserQuestions(p.questions || p.Questions || []);

    // Replacing an active questionnaire cancels the previous (pager parity)
    for (const [oldKey, pending] of [...this.pendingInteractive.entries()]) {
      if (pending.kind === 'ask_user_question') {
        this.pendingInteractive.delete(oldKey);
        // Preserve original JSON-RPC id type (number vs string)
        const oldReqId = pending.requestId != null ? pending.requestId : oldKey;
        this._respond(oldReqId, { outcome: 'cancelled' });
      }
    }

    // Auto-cancel only when host explicitly disables interactive questions
    const autoCancel =
      this.userQuestionInteractive === false ||
      process.env.GROKCODE_AUTO_CANCEL_ASK_USER === '1';

    if (autoCancel) {
      this._respond(reqId, { outcome: 'cancelled' });
      try {
        if (typeof this.onUserQuestion === 'function') {
          this.onUserQuestion({
            requestId: reqId,
            method,
            toolCallId: String(toolCallId),
            sessionId: String(sessionId),
            mode,
            questions,
            pending: false,
            selected: 'cancelled',
          });
        }
      } catch {
        /* ignore */
      }
      return;
    }

    this.pendingInteractive.set(String(reqId), {
      kind: 'ask_user_question',
      method,
      requestId: reqId,
      toolCallId: String(toolCallId),
      at: Date.now(),
    });
    try {
      if (typeof this.onUserQuestion === 'function') {
        this.onUserQuestion({
          requestId: reqId,
          method,
          toolCallId: String(toolCallId),
          sessionId: String(sessionId),
          mode,
          questions,
          pending: true,
        });
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Host answered a parked interactive reverse-req
   * (plan approval / ask_user / permission).
   * @param {string|number} requestId
   * @param {object} body Full JSON-RPC result or host-friendly permission body
   */
  resolveInteractive(requestId, body) {
    const key = String(requestId);
    if (!this.pendingInteractive.has(key)) {
      return { ok: false, error: 'no pending request' };
    }
    const pending = this.pendingInteractive.get(key);
    this.pendingInteractive.delete(key);

    // session/request_permission — ACP wire shape is nested outcome
    if (pending?.kind === 'permission') {
      let result;
      let selectedId = null;
      if (
        body &&
        typeof body === 'object' &&
        body.outcome &&
        typeof body.outcome === 'object' &&
        body.outcome.outcome
      ) {
        result = { outcome: body.outcome };
        selectedId = body.outcome.optionId || null;
      } else if (body?.optionId || body?.selected) {
        selectedId = String(body.optionId || body.selected);
        // Only accept optionIds that were offered (or still match grant list)
        const offered = pending.options || [];
        if (offered.length && !matchStandingGrant(offered, selectedId)) {
          // Unknown id — refuse invent; cancel
          result = buildPermissionResult('cancelled');
          selectedId = null;
        } else {
          result = buildPermissionResult('selected', selectedId);
        }
      } else if (body?.cancelled || body?.outcome === 'cancelled') {
        result = buildPermissionResult('cancelled');
      } else {
        result = buildPermissionResult('cancelled');
      }

      // Remember grant for this flight if asked / allow-always
      if (
        selectedId &&
        result.outcome?.outcome === 'selected' &&
        shouldRememberGrant(
          { ...body, optionId: selectedId },
          pending.options || []
        )
      ) {
        const key = normToolKey(pending.toolName || body?.toolName || '');
        if (key) this.standingGrants.set(key, selectedId);
      }

      this._respond(requestId, result);
      return {
        ok: true,
        kind: 'permission',
        outcome: result.outcome?.outcome || 'cancelled',
        selected: result.outcome?.optionId || null,
        remembered: Boolean(
          selectedId &&
            this.standingGrants.get(normToolKey(pending.toolName || '')) === selectedId
        ),
      };
    }

    const result =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...body }
        : { outcome: 'cancelled' };
    if (!result.outcome) result.outcome = 'cancelled';
    // Plan-approval feedback convenience (legacy shape)
    if (
      pending?.kind === 'plan_approval' &&
      body?.feedback != null &&
      String(body.feedback).trim() &&
      result.feedback == null
    ) {
      result.feedback = String(body.feedback).trim();
    }
    this._respond(requestId, result);
    return { ok: true, kind: pending?.kind || null, outcome: result.outcome };
  }

  _respond(id, result) {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  request(method, params = {}, timeoutMs = 120_000) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error('ACP stdin not writable'));
    }
    const id = ++this.nextId;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async initialize() {
    this.start();
    // See buildInitializeParams() for clientType / bufferingSettings contract.
    return this.request('initialize', buildInitializeParams(), 30_000);
  }

  /**
   * ACP authenticate (required so sampling uses ~/.grok/auth.json session token).
   * initialize advertises authMethods + defaultAuthMethodId (usually cached_token).
   * @param {string|object} methodId
   */
  async authenticate(methodId = 'cached_token') {
    const id =
      typeof methodId === 'string'
        ? methodId
        : methodId?.id || methodId?.methodId || 'cached_token';
    // Wire: AuthenticateRequest.methodId is AuthMethodId (string in 0.2.x)
    return this.request('authenticate', { methodId: id }, 60_000);
  }

  async newSession(cwd, meta = {}) {
    const params = { cwd, mcpServers: [] };
    if (meta && Object.keys(meta).length) params._meta = meta;
    return this.request('session/new', params, 60_000);
  }

  async loadSession(sessionId, cwd, meta = {}) {
    const params = { sessionId, cwd, mcpServers: [] };
    if (meta && Object.keys(meta).length) params._meta = meta;
    return this.request('session/load', params, 60_000);
  }

  async prompt(sessionId, text, timeoutMs = 0) {
    // 0 = no extra timeout beyond very long agent runs (2h)
    const ms = timeoutMs > 0 ? timeoutMs : 2 * 60 * 60 * 1000;
    this.streaming = true;
    try {
      return await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: String(text || '') }],
        },
        ms
      );
    } finally {
      this.streaming = false;
    }
  }

  async cancel(sessionId) {
    if (!sessionId || !this.alive) return;
    try {
      await this.request('session/cancel', { sessionId }, 5_000);
    } catch {
      /* process may already be dying */
    }
  }

  /**
   * ACP session/set_mode — open-source SessionMode wire ids: default | plan | ask.
   * Affects next turn start mode (and plan tracker when mode=plan).
   * @param {string} sessionId
   * @param {string} modeId
   */
  async setMode(sessionId, modeId) {
    const sid = String(sessionId || '').trim();
    const mid = normalizeSessionModeId(modeId);
    if (!sid) throw new Error('sessionId required for session/set_mode');
    // Wire: SetSessionModeRequest { sessionId, modeId }
    return this.request(
      'session/set_mode',
      { sessionId: sid, modeId: mid },
      30_000
    );
  }

  /**
   * ACP session/set_model — live model switch on warm/running session.
   * Wire: SetSessionModelRequest { sessionId, modelId, meta? }
   * Optional meta.reasoning_effort / meta.reasoningEffort.
   * @param {string} sessionId
   * @param {string} modelId
   * @param {{ reasoningEffort?: string, meta?: object }} [opts]
   */
  async setModel(sessionId, modelId, opts = {}) {
    const sid = String(sessionId || '').trim();
    const mid = String(modelId || '').trim();
    if (!sid) throw new Error('sessionId required for session/set_model');
    if (!mid) throw new Error('modelId required for session/set_model');
    const params = { sessionId: sid, modelId: mid };
    const meta = { ...(opts.meta && typeof opts.meta === 'object' ? opts.meta : {}) };
    const effort = opts.reasoningEffort || opts.reasoning_effort || meta.reasoningEffort;
    if (effort != null && String(effort).trim()) {
      meta.reasoning_effort = String(effort).trim();
      meta.reasoningEffort = String(effort).trim();
    }
    if (Object.keys(meta).length) params.meta = meta;
    return this.request('session/set_model', params, 60_000);
  }

  kill() {
    const child = this.child;
    this.child = null;
    this.alive = false;
    this._rejectAll(new Error('ACP killed'));
    if (!child) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else if (!child.killed) {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }

  get pid() {
    return this.child?.pid || null;
  }
}

/**
 * Extract tool name/args from ACP tool_call / tool_call_update payload.
 */
function pickToolInfo(update) {
  const meta = update?._meta?.['x.ai/tool'] || {};
  const name =
    meta.name ||
    update?.title ||
    update?.kind ||
    update?.name ||
    'tool';
  const args =
    update?.rawInput ||
    update?.input ||
    update?.arguments ||
    (update?.locations?.[0]?.path ? { path: update.locations[0].path } : {}) ||
    {};
  const id = update?.toolCallId || update?.id || `tool-${Date.now()}`;
  return { id, name: String(name), args: typeof args === 'object' && args ? args : {} };
}

/**
 * Extract text from ACP content blocks (string | {text} | multimodal array).
 * Skips image/binary blocks; joins text parts only.
 */
function pickChunkText(update) {
  if (!update || typeof update !== 'object') return '';
  // Some agents put text at top-level
  if (typeof update.text === 'string' && update.content == null) return update.text;
  const c = update.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c)) {
    return c
      .map((x) => {
        if (typeof x === 'string') return x;
        if (!x || typeof x !== 'object') return '';
        const t = String(x.type || x.kind || '').toLowerCase();
        // Multimodal: only surface text-ish blocks
        if (t === 'image' || t === 'audio' || t === 'resource' || t === 'blob') return '';
        if (typeof x.text === 'string') return x.text;
        if (x?.content?.text) return x.content.text;
        if (typeof x.data === 'string' && (t === 'text' || !t)) return x.data;
        return '';
      })
      .join('');
  }
  return '';
}

function pickToolResultText(update) {
  if (typeof update?.rawOutput === 'string') return update.rawOutput;
  if (update?.rawOutput && typeof update.rawOutput === 'object') {
    try {
      return JSON.stringify(update.rawOutput).slice(0, 8000);
    } catch {
      /* fall through */
    }
  }
  const fromContent = pickChunkText(update);
  if (fromContent) return fromContent;
  if (Array.isArray(update?.content)) {
    return update.content
      .map((block) => {
        if (block?.content?.text) return block.content.text;
        if (block?.text) return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);
  }
  return '';
}

/** Slim tool args for IPC (avoid huge file bodies / non-cloneable values). */
function slimToolArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  const keys = [
    'path',
    'file_path',
    'target_file',
    'command',
    'query',
    'pattern',
    'glob',
    'old_string',
    'new_string',
    'content',
    'description',
  ];
  for (const k of keys) {
    if (args[k] == null) continue;
    let v = args[k];
    if (typeof v === 'string' && v.length > 240) v = `${v.slice(0, 240)}…`;
    out[k] = v;
  }
  if (!Object.keys(out).length) {
    try {
      const s = JSON.stringify(args);
      return { preview: s.length > 300 ? `${s.slice(0, 300)}…` : s };
    } catch {
      return {};
    }
  }
  return out;
}

/** Structured-clone-safe plain object for Electron IPC. */
function safeIpc(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return { taskId: obj?.taskId, _ipcError: 'unserializable' };
  }
}

/**
 * Resolve ToolCallDeltaChunk id/name/args across first + subsequent frames.
 * Subsequent frames omit tool_call_id/name and only send tool_index + arguments_delta.
 * @param {object} update
 * @param {{ indexToId: Map<number,string>, names: Map<string,string>, argAccum: Map<string,string>, lastName: string }} state
 */
function resolveToolCallDelta(update, state) {
  const st = state || {
    indexToId: new Map(),
    names: new Map(),
    argAccum: new Map(),
    lastName: 'tool',
  };
  const rawId =
    update?.toolCallId || update?.tool_call_id || update?.id || update?.callId || '';
  const idxRaw = update?.tool_index ?? update?.toolIndex;
  const idx =
    typeof idxRaw === 'number'
      ? idxRaw
      : idxRaw != null && idxRaw !== ''
        ? Number(idxRaw)
        : null;
  let id = rawId ? String(rawId) : '';
  if (id && idx != null && Number.isFinite(idx)) st.indexToId.set(idx, id);
  else if (!id && idx != null && Number.isFinite(idx) && st.indexToId.has(idx)) {
    id = st.indexToId.get(idx);
  }
  let name = update?.title || update?.name || update?.toolName || update?.tool_name || '';
  if (name) {
    st.lastName = String(name);
    if (id) st.names.set(id, st.lastName);
  } else if (id && st.names.has(id)) name = st.names.get(id);
  else name = st.lastName || 'tool';

  const argFrag =
    typeof update?.arguments_delta === 'string'
      ? update.arguments_delta
      : typeof update?.argumentsDelta === 'string'
        ? update.argumentsDelta
        : '';
  if (id && argFrag) st.argAccum.set(id, (st.argAccum.get(id) || '') + argFrag);

  let hintArgs = {};
  if (id && st.argAccum.has(id)) {
    const frag = st.argAccum.get(id);
    const pathM = frag.match(
      /"(?:path|file_path|target_file|command)"\s*:\s*"((?:\\.|[^"\\]){1,120})/
    );
    if (pathM) {
      const key = frag.includes('"command"') ? 'command' : 'path';
      hintArgs = { [key]: pathM[1].replace(/\\"/g, '"') };
    } else {
      hintArgs = { preview: frag.length > 120 ? `${frag.slice(0, 120)}…` : frag };
    }
  }
  return { id, name: String(name), idx, argFrag, hintArgs, state: st };
}

/**
 * Canonical CLI SessionMode ids (xai-grok-tools SessionMode).
 * Unknown → default (upstream from_id behavior).
 */
function normalizeSessionModeId(modeId) {
  const raw = String(modeId || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (raw === 'plan' || raw === 'planning') return 'plan';
  if (raw === 'ask' || raw === 'ask_mode' || raw === 'readonly') return 'ask';
  if (
    raw === 'default' ||
    raw === 'agent' ||
    raw === 'normal' ||
    raw === 'craft' ||
    raw === ''
  ) {
    return 'default';
  }
  // Unknown custom agent names still pass through (upstream falls back to Default
  // for unknown plan/ask bits but may resolve agent definitions by name).
  return raw || 'default';
}

/** Ordered cycle matching pager Shift+Tab (session modes only; YOLO is separate). */
const SESSION_MODE_CYCLE = Object.freeze(['default', 'plan', 'ask']);

/**
 * Canonical reasoning effort tokens (CLI /effort, set_model meta).
 * Default menu: low | medium | high | xhigh. Empty = unset (CLI default).
 * `none` / `minimal` accepted only when explicitly set (some models advertise them).
 */
const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

function normalizeReasoningEffort(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!s) return '';
  if (s === 'x_high' || s === 'extra_high' || s === 'max') return 'xhigh';
  if (s === 'med') return 'medium';
  if (s === 'hi') return 'high';
  if (s === 'lo') return 'low';
  if (
    REASONING_EFFORT_LEVELS.includes(s) ||
    s === 'none' ||
    s === 'minimal'
  ) {
    return s;
  }
  // Unknown: pass through for model-specific remaps (e.g. "deep" → upstream)
  return s;
}

/**
 * Normalize ask_user_question payload (camelCase + snake_case).
 * Upstream Question: { question, options[{label,description,preview?}], multiSelect? }
 */
function normalizeAskUserQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q, qi) => {
      if (!q || typeof q !== 'object') return null;
      const question = String(q.question || q.prompt || q.text || '').trim();
      if (!question) return null;
      const opts = Array.isArray(q.options) ? q.options : [];
      const options = opts
        .map((o, oi) => {
          if (o == null) return null;
          if (typeof o === 'string') {
            return {
              label: o,
              description: '',
              preview: null,
              id: `q${qi}-o${oi}`,
            };
          }
          const label = String(o.label || o.name || o.text || '').trim();
          if (!label) return null;
          return {
            label,
            description: String(o.description || o.desc || '').trim(),
            preview:
              o.preview != null && String(o.preview).trim()
                ? String(o.preview).slice(0, 4000)
                : null,
            id: o.id != null ? String(o.id) : `q${qi}-o${oi}`,
          };
        })
        .filter(Boolean)
        .slice(0, 24);
      const multi =
        q.multiSelect === true ||
        q.multi_select === true ||
        q.multiSelect === 'true' ||
        q.multi_select === 'true';
      return {
        question,
        options,
        multiSelect: Boolean(multi),
        id: q.id != null ? String(q.id) : `q${qi}`,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * Build ACP initialize params (pure — unit-tested).
 * Client identity must land in meta/_meta, not only clientInfo.name.
 * Upstream: mvp_agent/acp_agent.rs reads meta.clientType then meta.clientIdentifier.
 */
function buildInitializeParams(versionOverride) {
  let clientVersion = versionOverride;
  if (!clientVersion) {
    try {
      clientVersion = require('../package.json').version || '0.0.0';
    } catch {
      clientVersion = '0.0.0';
    }
  }
  // grok-build ClientType::Desktop serde rename is "grok_desktop";
  // clientIdentifier fallback string is hyphenated "grok-desktop".
  const identityMeta = {
    clientType: 'grok_desktop',
    clientIdentifier: 'grok-desktop',
    clientSource: 'grok-desktop',
    clientVersion,
    bufferingSettings: {
      maxItems: 1,
      maxBytes: 1,
      maxDurationMs: 1,
    },
  };
  return {
    protocolVersion: 1,
    clientInfo: { name: 'GrokCode', title: 'GrokCode', version: clientVersion },
    clientCapabilities: {},
    _meta: { ...identityMeta },
    meta: { ...identityMeta },
  };
}

module.exports = {
  AcpClient,
  pickToolInfo,
  pickChunkText,
  pickToolResultText,
  slimToolArgs,
  safeIpc,
  buildInitializeParams,
  resolveToolCallDelta,
  normalizeAskUserQuestions,
  normalizeSessionModeId,
  SESSION_MODE_CYCLE,
  normalizeReasoningEffort,
  REASONING_EFFORT_LEVELS,
};
