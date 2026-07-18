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
    this.autoApprove = opts.autoApprove !== false;
    /** @type {import('child_process').ChildProcess | null} */
    this.child = null;
    this.buf = '';
    this.nextId = 0;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    this.alive = false;
    this.stderrBuf = '';
    /**
     * Only true while session/prompt is in flight.
     * session/load replays history as session/update �?must be ignored or UI
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
          const e = new Error(msg.error.message || JSON.stringify(msg.error));
          e.code = msg.error.code;
          e.data = msg.error.data;
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
        // xAI extension plane (ToolCallDeltaChunk, compact, retry, …).
        // Always deliver during prompt; also allow compact/retry outside if needed.
        if (!this.streaming) return;
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

  _handleAgentRequest(msg) {
    const method = String(msg.method || '');
    // Auto-approve tool permissions when YOLO / always-approve
    if (method === 'session/request_permission' || method.endsWith('/request_permission')) {
      const options = msg.params?.options || msg.params?.permissionOptions || [];
      let optionId =
        options.find((o) => /allow|approve|yes|always/i.test(String(o.optionId || o.id || o.name || '')))
          ?.optionId ||
        options.find((o) => /allow|approve/i.test(String(o.optionId || o.id || '')))?.id ||
        'allow-once';
      if (options[0] && !optionId) optionId = options[0].optionId || options[0].id;
      const result = this.autoApprove
        ? { outcome: { outcome: 'selected', optionId: optionId || 'allow-once' } }
        : { outcome: { outcome: 'cancelled' } };
      this._respond(msg.id, result);
      return;
    }
    // Unknown agent→client request: empty result so agent does not hang
    this._respond(msg.id, {});
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
    // grok-build ReplayBuffer (update_chunk_merge.rs) reads _meta.bufferingSettings.
    // Omit => settings None => no merge (immediate). When set, low thresholds flush each chunk.
    // https://github.com/xai-org/grok-build
    return this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'GrokCode', version: '1.10.11' },
        // Do not advertise fs/terminal �?agent executes tools itself; we only observe.
        clientCapabilities: {},
        _meta: {
          bufferingSettings: {
            maxItems: 1,
            maxBytes: 1,
            maxDurationMs: 1,
          },
        },
        // Some ACP stacks expose meta without underscore on the wire
        meta: {
          bufferingSettings: {
            maxItems: 1,
            maxBytes: 1,
            maxDurationMs: 1,
          },
        },
      },
      30_000
    );
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

function pickChunkText(update) {
  const c = update?.content;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c)) {
    return c
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x?.text) return x.text;
        if (x?.content?.text) return x.content.text;
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

module.exports = {
  AcpClient,
  pickToolInfo,
  pickChunkText,
  pickToolResultText,
  slimToolArgs,
  safeIpc,
};
