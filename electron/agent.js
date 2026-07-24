const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGrokBinary } = require('./grok-cli');
const { normalizeModelStateJson } = require('./grok-cli');
const { detectPatchedCli } = require('./diagnostics');
const {
  AcpClient,
  pickToolInfo,
  pickChunkText,
  pickToolResultText,
  slimToolArgs,
  safeIpc,
  resolveToolCallDelta,
  normalizeSessionModeId,
  normalizeReasoningEffort,
} = require('./acp-client');

/** Remember ACP-advertised models for host model chip */
function cacheAcpModels(payload, source) {
  try {
    const parsed = normalizeModelStateJson(payload);
    if (!parsed.ok || !parsed.models.length) return;
    global.__grokcodeModelsCache = {
      ok: true,
      defaultId: parsed.defaultId,
      models: parsed.models,
      source: source || 'acp',
      at: Date.now(),
    };
  } catch {
    /* ignore */
  }
}
const {
  isKnownHeadlessType,
  createStreamState,
  parseNdjsonLine,
  reduceHeadlessEvent,
  reduceNonJsonLine,
} = require('./agent-stream');

/**
 * Map opaque CLI/ACP errors to actionable Chinese (or EN) copy for the UI.
 * Upstream often wraps 403 as "Internal error" — never surface that bare string.
 */
function humanizeAgentError(raw) {
  const msg = String(raw?.message || raw || '').trim();
  const blob = msg.toLowerCase();
  if (
    /coming soon|don't have access|do not have access|not have access/i.test(msg) ||
    (/403/.test(msg) && /forbidden|access|grok build/i.test(msg))
  ) {
    return (
      '当前账号无权使用 Grok Build API（403）。\n' +
      '官方提示：Grok Build is coming soon / You don\'t have access now。\n' +
      '处理：在终端执行 grok login 重新登录，确认账号已开通 Grok Build；' +
      '或在设置中填写可用的 XAI_API_KEY。\n' +
      '这不是 GrokCode 崩溃。'
    );
  }
  if (
    /authorizationrequired|auth\(authorization|re-authentication|session expired|not authenticated|login required/i.test(
      blob
    )
  ) {
    return (
      'Grok CLI 需要重新登录（AuthorizationRequired）。\n' +
      '请在终端运行：grok login\n' +
      '完成后重启 GrokCode 再试。'
    );
  }
  if (/401|unauthorized/i.test(msg) && /api|auth|token|key/i.test(msg)) {
    return 'API 鉴权失败（401）。请检查 XAI_API_KEY 或重新 grok login。';
  }
  if (/429|rate.?limit|too many requests/i.test(msg)) {
    return '请求过于频繁（429）。请稍后再试或降低并发任务。';
  }
  if (/enoent|not found|spawn .* failed/i.test(msg) && /grok/i.test(msg)) {
    return `找不到 Grok CLI：${msg}\n请在设置中指定 grok 路径，或确认已安装。`;
  }
  // Strip giant JSON dumps after Internal error
  if (/^internal error/i.test(msg)) {
    const inner = msg.replace(/^internal error[:\s]*/i, '').slice(0, 400);
    if (/403|coming soon|access/i.test(inner)) {
      return humanizeAgentError(inner);
    }
    return `Grok 代理内部错误：${inner || msg}`.slice(0, 500);
  }
  return msg.slice(0, 800);
}

/**
 * Stream diagnostic log (async, batched — never block IPC hot path).
 * File: %TEMP%\grokcode-stream.log
 * Env GROKCODE_STREAM_DEBUG=0 disables; =full logs every NDJSON line.
 */
const STREAM_DEBUG =
  process.env.GROKCODE_STREAM_DEBUG !== '0' && process.env.GROKCODE_STREAM_DEBUG !== 'false';
const STREAM_DEBUG_FULL = process.env.GROKCODE_STREAM_DEBUG === 'full';
const STREAM_DEBUG_PATH = path.join(os.tmpdir(), 'grokcode-stream.log');
const STREAM_DEBUG_MAX = 8_000_000; // ~8MB rotate truncate
/** @type {string[]} */
const streamDebugBuf = [];
let streamDebugTimer = null;
let streamDebugBytes = 0;
let streamDebugSeq = 0;

function streamDebug(line, opts = {}) {
  if (!STREAM_DEBUG) return;
  streamDebugSeq += 1;
  const force = Boolean(opts.force);
  // Sample by default so diagnosis stays cheap; full mode keeps every line.
  if (
    !force &&
    !STREAM_DEBUG_FULL &&
    streamDebugSeq > 40 &&
    streamDebugSeq % 20 !== 0 &&
    !/RUN |NON_JSON|stderr|type=(tool|end|error|result|done)/i.test(line)
  ) {
    return;
  }
  try {
    streamDebugBuf.push(`[${new Date().toISOString()}] ${line}\n`);
    if (streamDebugBuf.length > 400) streamDebugBuf.splice(0, streamDebugBuf.length - 200);
    if (streamDebugTimer) return;
    streamDebugTimer = setTimeout(() => {
      streamDebugTimer = null;
      const batch = streamDebugBuf.splice(0, streamDebugBuf.length).join('');
      if (!batch) return;
      const write = () => {
        fs.appendFile(STREAM_DEBUG_PATH, batch, 'utf8', () => {});
        streamDebugBytes += batch.length;
      };
      if (streamDebugBytes > STREAM_DEBUG_MAX) {
        streamDebugBytes = 0;
        fs.writeFile(STREAM_DEBUG_PATH, `[${new Date().toISOString()}] --- log rotated ---\n`, 'utf8', () =>
          write()
        );
      } else {
        write();
      }
    }, 40);
  } catch {
    /* ignore disk errors */
  }
}

/**
 * GrokCode multi-task agent
 * 每个 taskId 可并行跑一个 grok CLI 进程，互不抢占。
 */
function createAgent({ getConfig, workspaceRoot, emit }) {
  /** @type {Map<string, import('child_process').ChildProcess>} */
  const children = new Map();
  /**
   * Warm ACP sessions kept after a turn so the next prompt skips
   * initialize+session/new (~1s+ cold start). Keyed by taskId.
   * @type {Map<string, { client: import('./acp-client').AcpClient, sessionId: string, cwd: string, key: string }>}
   */
  const acpPool = new Map();
  /**
   * taskIds we intentionally stopped (user stop / replace / external cleanup).
   * Without this, Windows taskkill surfaces exit 4294967295 and UI shows a fake hard error.
   * @type {Set<string>}
   */
  const intentionalStops = new Set();
  /**
   * PIDs we spawned (survives map delete after kill) — reaped on stop / quit.
   * @type {Set<number>}
   */
  const trackedPids = new Set();

  function acpArgsKey(bin, args, cwd) {
    return `${bin}\0${(args || []).join('\0')}\0${cwd}`;
  }

  function disposeAcpPool(taskId, { kill = true } = {}) {
    if (taskId) {
      const slot = acpPool.get(String(taskId));
      if (!slot) return;
      acpPool.delete(String(taskId));
      if (kill) {
        try {
          slot.client.kill();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    for (const id of [...acpPool.keys()]) disposeAcpPool(id, { kill });
  }

  /**
   * Drop warm ACP sessions so next run re-initialize/authenticate with new
   * settings (model, path, transport, YOLO, rules, …). Running turns keep their child.
   * @returns {{ cleared: number }}
   */
  function invalidateWarmSessions() {
    const n = acpPool.size;
    if (n) {
      streamDebug(`acp warm pool invalidate count=${n}`, { force: true });
    }
    disposeAcpPool(null, { kill: true });
    return { cleared: n };
  }

  function killPidTree(pid) {
    if (!pid || pid <= 0) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
        setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* ignore */
          }
        }, 1200);
      }
    } catch {
      /* ignore */
    }
  }

  function killProc(child) {
    if (!child) return;
    const pid = child.pid;
    if (pid) trackedPids.add(pid);
    try {
      if (process.platform === 'win32' && pid) {
        killPidTree(pid);
      } else if (!child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            if (!child.killed) child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 1200);
      }
    } catch {
      /* ignore */
    }
    // Second pass: tree may respawn helpers briefly after first taskkill
    if (pid) {
      setTimeout(() => killPidTree(pid), 400);
      setTimeout(() => {
        killPidTree(pid);
        trackedPids.delete(pid);
      }, 1600);
    }
  }

  /** Force-kill every PID we ever spawned that may still be alive */
  function reapTracked() {
    for (const pid of [...trackedPids]) {
      killPidTree(pid);
      trackedPids.delete(pid);
    }
  }

  function stop(taskId) {
    if (taskId) {
      intentionalStops.add(String(taskId));
      const child = children.get(taskId);
      if (child) {
        try {
          child.__acpClient?.cancel?.(child.__acpSessionId)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
        if (child.__acpClient) {
          try {
            child.__acpClient.kill();
          } catch {
            /* ignore */
          }
        } else {
          killProc(child);
        }
        children.delete(taskId);
      }
      // Always drop warm pool on explicit stop so next run is clean
      disposeAcpPool(taskId, { kill: true });
      return;
    }
    for (const [id, child] of children) {
      intentionalStops.add(String(id));
      if (child?.__acpClient) {
        try {
          child.__acpClient.kill();
        } catch {
          /* ignore */
        }
      } else {
        killProc(child);
      }
      children.delete(id);
    }
    disposeAcpPool(null, { kill: true });
    // Catch orphans not currently mapped (race after crash mid-spawn)
    reapTracked();
  }

  function isRunning(taskId) {
    return children.has(taskId);
  }

  function listRunning() {
    return [...children.keys()];
  }

  function listTrackedPids() {
    return [...trackedPids];
  }

  function takeIntentionalStop(taskId) {
    const key = String(taskId);
    if (!intentionalStops.has(key)) return false;
    intentionalStops.delete(key);
    return true;
  }

  /**
   * Primary path: ACP (`grok agent stdio`) — streams thought + text + tool_call.
   * Headless streaming-json is text/thought/end only (no tool progress).
   *
   * Some accounts can use `grok -p` / headless but get 403 on agent stdio
   * (cli-chat-proxy.grok.com/v1/responses "Grok Build is coming soon"). In that
   * case we fall back to headless so the desktop shell still works for chat.
   * Override: GROKCODE_AGENT_TRANSPORT=headless|acp|streaming-json
   * Disable fallback: GROKCODE_ACP_NO_FALLBACK=1
   */
  async function run(opts) {
    const cfg0 = getConfig();
    const transport = String(
      process.env.GROKCODE_AGENT_TRANSPORT || cfg0.agentTransport || 'auto'
    ).toLowerCase();
    // headless | streaming-json: force -p style path (matches open-source grok -p)
    if (transport === 'headless' || transport === 'streaming-json') {
      return runHeadless(opts);
    }
    // acp: never fall back unless env allows (default acp still falls back on 403 via auto)
    const forceAcpOnly = transport === 'acp';
    try {
      return await runAcp(opts);
    } catch (err) {
      const msg = err?.message || String(err);
      const dataMsg =
        err?.data && typeof err.data === 'object'
          ? String(err.data.message || '')
          : typeof err?.data === 'string'
            ? err.data
            : '';
      const blob = `${msg}\n${dataMsg}`;
      const noFallback =
        forceAcpOnly ||
        process.env.GROKCODE_ACP_NO_FALLBACK === '1' ||
        process.env.GROKCODE_ACP_NO_FALLBACK === 'true' ||
        opts?._noHeadlessFallback;
      // Cold start / transport failures
      const coldFail =
        err?.code === 'ACP_FALLBACK' ||
        /ENOENT|spawn |initialize|not writable|找不到 Grok/i.test(msg);
      // Account can run -p but agent stdio prompt is gated (403 coming soon)
      const buildGate403 =
        /coming soon|don't have access|do not have access/i.test(blob) ||
        ((/403/.test(blob) || err?.httpStatus === 403) &&
          /forbidden|access|grok build|cli-chat-proxy|responses/i.test(blob)) ||
        (/internal error/i.test(blob) && /403|coming soon|access/i.test(blob));
      if (!noFallback && (coldFail || buildGate403)) {
        streamDebug(
          `ACP → headless fallback (${buildGate403 ? 'build-gate-403' : 'cold'}): ${msg.slice(0, 200)}`,
          { force: true }
        );
        try {
          const reason = buildGate403
            ? 'ACP agent 路径 403（Build 代理未开放），改用 headless（与 grok -p 同路）…'
            : 'ACP 不可用，改用 headless…';
          opts?.emit?.('agent:phase', {
            taskId: opts.taskId || 'default',
            phase: 'boot',
            detail: reason,
          });
          // emit via createAgent emit is not on opts — use stream only; headless will set phase
        } catch {
          /* ignore */
        }
        // Fresh headless session — ACP session id is not valid for -p path
        return runHeadless({
          ...opts,
          sessionId: null,
          _acpFallback: true,
          _fallbackReason: buildGate403 ? 'acp_build_403' : 'acp_cold',
        });
      }
      throw err;
    }
  }

  async function runAcp({
    message,
    sessionId = null,
    signal,
    taskId = 'default',
    _resumeRetried = false,
    prepMs = 0,
  }) {
    const cfg = getConfig();
    const cwd = workspaceRoot;
    if (!cwd || !fs.existsSync(cwd)) {
      throw new Error('请先打开一个项目工作区');
    }

    if (children.has(taskId)) {
      stop(taskId);
    }
    intentionalStops.delete(String(taskId));

    const grokBin = resolveGrokBinary(cfg.grokPath);
    if (!grokBin) {
      const e = new Error(
        '找不到 Grok CLI。请安装 Grok Build，或在设置中填写 grok 可执行文件路径。\n' +
          '默认查找：%USERPROFILE%\\.grok\\bin\\grok.exe 或 PATH 中的 grok'
      );
      e.code = 'ACP_FALLBACK';
      throw e;
    }

    const alwaysApprove =
      cfg._alwaysApproveOverride !== undefined
        ? cfg._alwaysApproveOverride
        : cfg.alwaysApprove !== false;
    const rules = cfg._rulesOverride !== undefined ? cfg._rulesOverride : cfg.rules;
    const maxTurns =
      cfg._maxTurnsOverride !== undefined ? cfg._maxTurnsOverride : cfg.maxTurns;

    const acpArgs = ['agent'];
    if (alwaysApprove) acpArgs.push('--always-approve');
    acpArgs.push('--no-leader');
    if (cfg.model) acpArgs.push('-m', String(cfg.model));
    if (cfg.reasoningEffort || cfg.effort) {
      acpArgs.push('--reasoning-effort', String(cfg.reasoningEffort || cfg.effort));
    }
    acpArgs.push('stdio');

    const emitT = (event, payload) => {
      try {
        emit(event, safeIpc({ ...payload, taskId }));
      } catch (err) {
        streamDebug(`task=${taskId} emit fail ${event}: ${err.message}`, { force: true });
      }
    };
    const t0 = Date.now();
    const mark = (label) => {
      const ms = Date.now() - t0;
      streamDebug(
        `task=${taskId} timing ${label} +${ms}ms prep=${prepMs || 0}ms`,
        { force: true }
      );
      return ms;
    };
    emitT('agent:phase', {
      phase: 'boot',
      detail: sessionId ? 'spawn ACP（resume）…' : 'spawn ACP…',
    });
    emitT('agent:status', {
      status: 'boot',
      detail: sessionId ? 'spawn ACP（resume）…' : 'spawn ACP…',
    });
    emitT('agent:cli', {
      binary: grokBin,
      args: acpArgs,
      transport: 'acp',
    });

    const env = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      GROK_DISABLE_AUTOUPDATER: '1',
    };
    if (cfg.apiKey) env.XAI_API_KEY = cfg.apiKey;

    return new Promise((resolve, reject) => {
      let finalText = '';
      let thoughtText = '';
      let newSessionId = sessionId || null;
      let settled = false;
      let lastPhase = '';
      let lastStatusKey = '';
      let toolDepth = 0;
      let usage = null;
      let stopReason = null;
      let numTurns = 0;
      let textChunks = 0;
      let thoughtChunks = 0;
      let firstTokenAt = 0;
      /** @type {Set<string>} */
      const openTools = new Set();
      /** Shared state for resolveToolCallDelta (index→id, arg fragments). */
      let toolDeltaState = {
        indexToId: new Map(),
        names: new Map(),
        argAccum: new Map(),
        lastName: 'tool',
      };
      const noteFirstToken = (kind) => {
        if (firstTokenAt) return;
        firstTokenAt = Date.now();
        const sinceSpawn = firstTokenAt - t0;
        streamDebug(
          `task=${taskId} FIRST_TOKEN kind=${kind} sinceSpawn=${sinceSpawn}ms prep=${prepMs || 0}ms totalSilent=${sinceSpawn + (prepMs || 0)}ms`,
          { force: true }
        );
        setPhase(
          kind === 'tool' ? 'tool' : kind === 'thought' ? 'thinking' : 'streaming',
          `首包 ${sinceSpawn}ms`
        );
      };

      const STREAM_IPC_MS = 16;
      let pendingTextPayload = null;
      let pendingThoughtPayload = null;
      let textIpcTimer = null;
      let thoughtIpcTimer = null;

      const setPhase = (phase, detail) => {
        if (phase === lastPhase && detail === lastStatusKey) return;
        lastPhase = phase;
        lastStatusKey = detail || phase;
        emitT('agent:phase', { phase, detail: detail || phase });
        emitT('agent:status', { status: phase, detail: detail || phase });
      };

      const emitTextStream = (payload, immediate = false) => {
        pendingTextPayload = payload;
        if (immediate) {
          if (textIpcTimer) {
            clearTimeout(textIpcTimer);
            textIpcTimer = null;
          }
          emitT('agent:text', pendingTextPayload);
          pendingTextPayload = null;
          return;
        }
        if (textIpcTimer) return;
        textIpcTimer = setTimeout(() => {
          textIpcTimer = null;
          if (pendingTextPayload) {
            emitT('agent:text', pendingTextPayload);
            pendingTextPayload = null;
          }
        }, STREAM_IPC_MS);
      };

      const emitThoughtStream = (payload, immediate = false) => {
        pendingThoughtPayload = payload;
        if (immediate) {
          if (thoughtIpcTimer) {
            clearTimeout(thoughtIpcTimer);
            thoughtIpcTimer = null;
          }
          emitT('agent:thought', pendingThoughtPayload);
          pendingThoughtPayload = null;
          return;
        }
        if (thoughtIpcTimer) return;
        thoughtIpcTimer = setTimeout(() => {
          thoughtIpcTimer = null;
          if (pendingThoughtPayload) {
            emitT('agent:thought', pendingThoughtPayload);
            pendingThoughtPayload = null;
          }
        }, STREAM_IPC_MS);
      };

      const flushStreamIpc = () => {
        if (textIpcTimer) {
          clearTimeout(textIpcTimer);
          textIpcTimer = null;
        }
        if (thoughtIpcTimer) {
          clearTimeout(thoughtIpcTimer);
          thoughtIpcTimer = null;
        }
        if (pendingTextPayload) {
          emitT('agent:text', pendingTextPayload);
          pendingTextPayload = null;
        }
        if (pendingThoughtPayload) {
          emitT('agent:thought', pendingThoughtPayload);
          pendingThoughtPayload = null;
        }
      };

      const plainUsage = (u) => {
        if (!u || typeof u !== 'object') return null;
        return safeIpc(u);
      };

      let waitTickTimer = null;
      let promptSentAt = 0;
      /** Last time we saw any agent activity (token/tool). Used for inter-stage silence clock. */
      let lastActivityAt = 0;
      /** Agent wall clock from session/update _meta.turnStartMs (ms epoch). */
      let agentTurnStartMs = 0;
      /** Live totalTokens from each session/update _meta (estimated mid-turn). */
      let liveTotalTokens = 0;
      let lastLiveUsageEmitAt = 0;
      let lastLiveUsageTokens = -1;

      const clearWaitTick = () => {
        if (waitTickTimer) {
          clearInterval(waitTickTimer);
          waitTickTimer = null;
        }
      };

      const bumpActivity = () => {
        lastActivityAt = Date.now();
      };

      /**
       * Read totalTokens / turnStartMs from ACP notification params meta.
       * Upstream (updates.rs) attaches: totalTokens, agentTimestampMs, turnStartMs, streamStartMs.
       */
      const ingestUpdateMeta = (params, update) => {
        const meta =
          (params && (params._meta || params.meta)) ||
          (update && (update._meta || update.meta)) ||
          null;
        if (!meta || typeof meta !== 'object') return;
        const tt = meta.totalTokens ?? meta.total_tokens;
        if (typeof tt === 'number' && Number.isFinite(tt) && tt >= 0) {
          liveTotalTokens = tt;
          // Throttle IPC: every 400ms or when tokens jump ≥64
          const now = Date.now();
          const jumped = Math.abs(tt - lastLiveUsageTokens) >= 64;
          if (jumped || now - lastLiveUsageEmitAt >= 400) {
            lastLiveUsageEmitAt = now;
            lastLiveUsageTokens = tt;
            const liveUsage = plainUsage({
              total_tokens: tt,
              totalTokens: tt,
              live: true,
            });
            if (liveUsage) {
              usage = { ...(usage || {}), ...liveUsage };
              emitT('agent:usage', { usage: liveUsage, live: true });
            }
          }
        }
        const tsm = meta.turnStartMs ?? meta.turn_start_ms;
        if (typeof tsm === 'number' && tsm > 0 && !agentTurnStartMs) {
          agentTurnStartMs = tsm;
        }
      };

      const tokenBrief = () =>
        liveTotalTokens > 0 ? ` · ~${liveTotalTokens} tok` : '';

      /**
       * Anti-black-box clock for the WHOLE prompt (not just pre-first-token).
       * Upstream is silent between model spans and tool batches for seconds–minutes.
       */
      const startActivityClock = () => {
        clearWaitTick();
        promptSentAt = Date.now();
        lastActivityAt = promptSentAt;
        waitTickTimer = setInterval(() => {
          if (settled) {
            clearWaitTick();
            return;
          }
          const silentSec = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
          const totalSec = Math.max(0, Math.floor((Date.now() - promptSentAt) / 1000));
          const tok = tokenBrief();
          if (!firstTokenAt) {
            setPhase('running', `等待模型首包… ${silentSec}s${tok}`);
          } else if (toolDepth > 0) {
            setPhase(
              'tool',
              `工具执行中 ×${toolDepth} · 已静默 ${silentSec}s · 总 ${totalSec}s${tok}`
            );
          } else if (silentSec >= 1) {
            // Between stages: model planning next tools / next text (no session/update)
            setPhase(
              'running',
              `等待模型继续… ${silentSec}s（CLI 段间静默）· 总 ${totalSec}s${tok}`
            );
          }
        }, 500);
      };

      const cleanup = () => {
        clearWaitTick();
        if (signal) signal.removeEventListener?.('abort', onAbort);
        const child = children.get(taskId);
        if (child && child.__acpClient) {
          children.delete(taskId);
        }
      };

      /** Park warm ACP for next turn (skip cold initialize). Kill only on stop/fail. */
      const parkClient = (c, sid) => {
        if (!c?.alive || !sid) return;
        try {
          c.onUpdate = () => {};
          c.onNotification = () => {};
        } catch {
          /* ignore */
        }
        acpPool.set(String(taskId), {
          client: c,
          sessionId: sid,
          cwd,
          key: argsKey,
        });
      };

      const finish = (result, { keepWarm = true } = {}) => {
        if (settled) return;
        settled = true;
        intentionalStops.delete(String(taskId));
        cleanup();
        if (keepWarm && client?.alive && newSessionId && !result?.stopped) {
          parkClient(client, newSessionId);
        } else {
          try {
            client?.kill?.();
          } catch {
            /* ignore */
          }
          disposeAcpPool(taskId, { kill: false });
        }
        resolve(result);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        intentionalStops.delete(String(taskId));
        cleanup();
        try {
          client?.kill?.();
        } catch {
          /* ignore */
        }
        disposeAcpPool(taskId, { kill: false });
        const friendly = humanizeAgentError(err);
        const e = err instanceof Error ? err : new Error(friendly);
        e.message = friendly;
        emitT('agent:error', { error: friendly });
        setPhase('error', friendly.split('\n')[0].slice(0, 120));
        streamDebug(`task=${taskId} FAIL ${friendly.replace(/\n/g, ' | ')}`, {
          force: true,
        });
        reject(e);
      };

      const argsKey = acpArgsKey(grokBin, acpArgs, cwd);
      let client = null;
      let reused = false;
      let warmSessionId = null;
      const pooled = acpPool.get(String(taskId));
      if (
        pooled &&
        pooled.client?.alive &&
        pooled.key === argsKey &&
        pooled.cwd === cwd
      ) {
        client = pooled.client;
        reused = true;
        warmSessionId = pooled.sessionId || null;
        acpPool.delete(String(taskId)); // checked out for this run
        if (!sessionId && warmSessionId) {
          // Continue warm session when renderer still has no id yet
          newSessionId = warmSessionId;
        }
        streamDebug(
          `task=${taskId} acp REUSE pid=${client.pid || '?'} session=${warmSessionId || '-'}`,
          { force: true }
        );
      } else {
        if (pooled) disposeAcpPool(taskId, { kill: true });
        client = new AcpClient({
          bin: grokBin,
          args: acpArgs,
          env,
          autoApprove: alwaysApprove,
        });
      }

      const bindHandlers = () => {
        client.onUpdate = (update, params) => {
          // AcpClient already gates on .streaming (active prompt only)
          if (!update || settled) return;
          // Live totalTokens / turnStartMs ride on params._meta (not inside update)
          ingestUpdateMeta(params, update);
          // Normalize camelCase / PascalCase / snake_case (ACP is usually snake_case)
          const kind = String(update.sessionUpdate || update.session_update || update.type || '')
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .toLowerCase()
            .replace(/-/g, '_');

          if (kind === 'agent_message_chunk' || kind === 'agent_message') {
            const chunk = pickChunkText(update);
            if (chunk) finalText += chunk;
            textChunks += 1;
            bumpActivity();
            if (textChunks === 1) {
              noteFirstToken('text');
              streamDebug(
                `task=${taskId} acp first text chunk len=${chunk.length} total=${finalText.length}`,
                { force: true }
              );
              emitTextStream(
                {
                  text: finalText,
                  delta: chunk || '',
                  partial: true,
                  phase: 'streaming',
                },
                true
              );
            } else {
              emitTextStream({
                text: finalText,
                delta: chunk || '',
                partial: true,
                phase: 'streaming',
              });
            }
            if (toolDepth <= 0) setPhase('streaming', 'speaking…');
          } else if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
            const chunk = pickChunkText(update);
            if (chunk) thoughtText += chunk;
            thoughtChunks += 1;
            bumpActivity();
            if (thoughtChunks === 1) {
              noteFirstToken('thought');
              streamDebug(
                `task=${taskId} acp first thought chunk len=${chunk.length}`,
                { force: true }
              );
              emitThoughtStream(
                {
                  text: thoughtText,
                  delta: chunk || '',
                  phase: 'thinking',
                },
                true
              );
            } else {
              emitThoughtStream({
                text: thoughtText,
                delta: chunk || '',
                phase: 'thinking',
              });
            }
            if (toolDepth <= 0) setPhase('thinking', 'thinking…');
          } else if (kind === 'tool_call') {
            flushStreamIpc();
            bumpActivity();
            const info = pickToolInfo(update);
            if (!openTools.has(info.id)) {
              openTools.add(info.id);
              toolDepth += 1;
              if (textChunks === 0 && thoughtChunks === 0) noteFirstToken('tool');
              emitT('agent:tool_start', {
                id: info.id,
                name: info.name,
                args: slimToolArgs(info.args),
                startedAt: Date.now(),
              });
              setPhase('tool', `${info.name}…`);
              streamDebug(
                `task=${taskId} acp tool_call name=${info.name} id=${info.id} depth=${toolDepth}`,
                { force: true }
              );
            }
          } else if (kind === 'tool_call_update') {
            bumpActivity();
            const info = pickToolInfo(update);
            const status = String(update.status || '').toLowerCase();
            // in_progress / pending / running: keep tool card alive
            if (
              status === 'in_progress' ||
              status === 'pending' ||
              status === 'running'
            ) {
              if (!openTools.has(info.id)) {
                openTools.add(info.id);
                toolDepth += 1;
                if (textChunks === 0 && thoughtChunks === 0) noteFirstToken('tool');
                emitT('agent:tool_start', {
                  id: info.id,
                  name: info.name,
                  args: slimToolArgs(info.args),
                  startedAt: Date.now(),
                  status,
                });
              } else {
                const partial =
                  pickToolResultText(update) ||
                  pickChunkText(update.content || update.output || update) ||
                  '';
                emitT('agent:tool_start', {
                  id: info.id,
                  name: info.name,
                  args: slimToolArgs(info.args),
                  status,
                  progress: true,
                  result: partial ? String(partial).slice(0, 4000) : undefined,
                });
              }
              setPhase(
                'tool',
                status === 'in_progress'
                  ? `${info.name} · 执行中…`
                  : `${info.name}…`
              );
            } else if (
              !openTools.has(info.id) &&
              status !== 'completed' &&
              status !== 'failed' &&
              status !== 'cancelled'
            ) {
              openTools.add(info.id);
              toolDepth += 1;
              emitT('agent:tool_start', {
                id: info.id,
                name: info.name,
                args: slimToolArgs(info.args),
                startedAt: Date.now(),
              });
              setPhase('tool', `${info.name}…`);
            }
            if (status === 'completed' || status === 'failed' || status === 'cancelled') {
              if (openTools.has(info.id)) {
                openTools.delete(info.id);
                toolDepth = Math.max(0, toolDepth - 1);
              }
              flushStreamIpc();
              emitT('agent:tool_end', {
                id: info.id,
                name: info.name,
                args: slimToolArgs(info.args),
                result: pickToolResultText(update),
                ok: status === 'completed',
                endedAt: Date.now(),
              });
              // Do not clear activity clock — next stage may be silent for minutes
              if (toolDepth <= 0 && finalText) setPhase('streaming', 'speaking…');
              else if (toolDepth <= 0) setPhase('running', '等待模型继续…');
            }
          } else if (kind === 'user_message_chunk') {
            bumpActivity();
          } else if (kind === 'plan') {
            bumpActivity();
            const entries = Array.isArray(update.entries)
              ? update.entries
              : Array.isArray(update.plan)
                ? update.plan
                : [];
            const lines = entries
              .map((e) => {
                if (typeof e === 'string') return e;
                return e?.content || e?.title || e?.text || JSON.stringify(e);
              })
              .filter(Boolean)
              .slice(0, 40);
            emitT('agent:plan', {
              entries: lines,
              rawCount: entries.length,
            });
            if (lines[0]) setPhase('running', `计划: ${String(lines[0]).slice(0, 80)}`);
          } else if (kind === 'current_mode_update' || kind === 'currentmodeupdate') {
            bumpActivity();
            const modeId =
              update.currentModeId ||
              update.current_mode_id ||
              update.modeId ||
              update.mode ||
              '';
            emitT('agent:mode', { modeId: String(modeId) });
            if (modeId) setPhase('running', `模式: ${modeId}`);
          } else if (
            kind === 'available_commands_update' ||
            kind === 'availablecommandsupdate'
          ) {
            bumpActivity();
            const cmds = Array.isArray(update.availableCommands)
              ? update.availableCommands
              : Array.isArray(update.available_commands)
                ? update.available_commands
                : Array.isArray(update.commands)
                  ? update.commands
                  : [];
            const names = cmds
              .map((c) => c?.name || c?.command || c?.id || (typeof c === 'string' ? c : ''))
              .filter(Boolean)
              .slice(0, 80);
            emitT('agent:commands', {
              commands: names,
              count: names.length,
              toolsMeta: update._meta || update.meta || null,
            });
          }
        };
        /**
         * xAI extension plane (see docs/ACP-SOURCE-AUDIT.md).
         * ToolCallDeltaChunk and lifecycle events ride `x.ai/session_notification`,
         * NOT standard `session/update` — dropping them causes black-box tools/compact.
         */
        client.onNotification = (method, params) => {
          if (settled) return;
          const m = String(method || '');
          if (m !== 'x.ai/session_notification' && m !== '_x.ai/session_notification') {
            // Other x.ai/* noise (mcp init, announcements) — sample log only
            if (/x\.ai\//i.test(m)) {
              streamDebug(`task=${taskId} acp-ext ${m}`, { force: false });
            }
            return;
          }
          // xAI plane may also carry totalTokens on notification meta
          ingestUpdateMeta(params, params?.update);
          const update = params?.update || params?.sessionUpdate || params;
          if (!update || typeof update !== 'object') return;
          const kind = String(
            update.sessionUpdate || update.session_update || update.type || ''
          )
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .toLowerCase();

          bumpActivity();

          if (kind === 'tool_call_delta_chunk' || kind === 'toolcalldeltachunk') {
            // Wire: first frame has id+name; later frames only tool_index+arguments_delta
            const resolved = resolveToolCallDelta(update, toolDeltaState);
            toolDeltaState = resolved.state;
            const { id, name, idx, argFrag, hintArgs } = resolved;
            let deltaArgs = slimToolArgs(
              update.rawInput || update.delta || update.args || update.partialArgs || {}
            );
            if (hintArgs && Object.keys(hintArgs).length) {
              deltaArgs = { ...deltaArgs, ...hintArgs };
            }

            if (id && !openTools.has(id)) {
              openTools.add(id);
              toolDepth += 1;
              if (textChunks === 0 && thoughtChunks === 0) noteFirstToken('tool');
              emitT('agent:tool_start', {
                id,
                name: String(name),
                args: deltaArgs,
                startedAt: Date.now(),
                status: 'in_progress',
                fromDelta: true,
              });
            } else if (id) {
              emitT('agent:tool_start', {
                id,
                name: String(name),
                args: deltaArgs,
                status: 'in_progress',
                progress: true,
                fromDelta: true,
              });
            }
            setPhase('tool', `${name}${id ? '' : ' (args)'}…`);
            streamDebug(
              `task=${taskId} xai tool_delta id=${id || '-'} idx=${idx ?? '-'} name=${name} frag=${argFrag ? argFrag.length : 0}`,
              { force: true }
            );
            return;
          }

          if (kind === 'model_changed' || kind === 'modelchanged') {
            const modelId =
              update.model_id ||
              update.modelId ||
              update.model ||
              '';
            const effort =
              update.reasoning_effort ||
              update.reasoningEffort ||
              null;
            if (modelId) {
              emitT('agent:model', {
                modelId: String(modelId),
                reasoningEffort: effort,
                source: 'model_changed',
              });
              setPhase('running', `模型 · ${modelId}`);
            }
            return;
          }

          if (kind === 'pending_interaction') {
            // Auto-approve YOLO: still surface that a tool is about to run
            const tid =
              update.tool_call_id || update.toolCallId || update.id || '';
            const pk = update.kind || update.interactionKind || '';
            const nm =
              (tid && toolDeltaState.names.get(String(tid))) ||
              toolDeltaState.lastName ||
              'tool';
            setPhase('tool', `批准 ${nm}${pk ? ` · ${pk}` : ''}…`);
            streamDebug(
              `task=${taskId} xai pending_interaction id=${tid} kind=${pk}`,
              { force: true }
            );
            return;
          }

          if (kind === 'interaction_resolved') {
            const tid =
              update.tool_call_id || update.toolCallId || update.id || '';
            const nm =
              (tid && toolDeltaState.names.get(String(tid))) ||
              toolDeltaState.lastName ||
              'tool';
            setPhase('tool', `执行 ${nm}…`);
            return;
          }

          if (kind === 'retry_state' || kind.startsWith('retry')) {
            const detail =
              update.message ||
              update.error ||
              update.reason ||
              (update.status && String(update.status)) ||
              'retrying…';
            setPhase('retry', String(detail).slice(0, 160));
            return;
          }

          if (
            kind === 'auto_compact_started' ||
            kind === 'memory_flush_started' ||
            kind === 'auto_recovery_started'
          ) {
            setPhase(
              'running',
              kind.includes('compact')
                ? '上下文压缩中…'
                : kind.includes('recovery')
                  ? '自动恢复中…'
                  : 'Memory flush…'
            );
            return;
          }

          if (
            kind === 'auto_compact_completed' ||
            kind === 'auto_compact_failed' ||
            kind === 'auto_compact_cancelled' ||
            kind === 'memory_flush_completed' ||
            kind === 'auto_recovery_exhausted'
          ) {
            setPhase(
              kind.includes('fail') || kind.includes('exhaust') ? 'error' : 'running',
              kind.includes('fail') || kind.includes('exhaust')
                ? String(update.error || 'compact/recovery failed').slice(0, 120)
                : '压缩/恢复完成，继续…'
            );
            return;
          }

          if (kind === 'goal_updated') {
            const title = update.title || update.goalTitle || 'goal';
            const progress =
              typeof update.progress === 'number' ? ` ${update.progress}%` : '';
            setPhase('running', `目标${progress}: ${String(title).slice(0, 80)}`);
            return;
          }

          if (kind === 'turn_completed') {
            // Usage often on result; still mark activity
            if (update.usage) {
              emitT('agent:usage', { usage: plainUsage(update.usage) });
            }
            return;
          }

          if (
            kind === 'subagent_spawned' ||
            kind === 'subagent_progress' ||
            kind === 'subagent_finished'
          ) {
            setPhase(
              'running',
              kind === 'subagent_spawned'
                ? `子代理启动…`
                : kind === 'subagent_finished'
                  ? '子代理完成'
                  : '子代理运行中…'
            );
            return;
          }

          if (kind === 'task_completed') {
            setPhase('running', '后台任务完成');
            return;
          }

          if (kind === 'hook_annotation') {
            const msg = update.message || '';
            if (msg) setPhase('tool', String(msg).slice(0, 120));
            return;
          }

          // Unknown xAI update — forward as agent:ext for Live + log
          emitT('agent:ext', {
            kind: kind || 'unknown',
            preview: JSON.stringify(update).slice(0, 240),
          });
          streamDebug(
            `task=${taskId} xai unhandled sessionUpdate=${kind || '(empty)'} keys=${Object.keys(update).slice(0, 8).join(',')}`,
            { force: true }
          );
        };

        client.onPermission = (info) => {
          streamDebug(
            `task=${taskId} permission pending=${info?.pending ? 1 : 0} mode=${info?.mode} req=${info?.requestId} tool=${info?.toolName || ''}`,
            { force: true }
          );
          emitT('agent:permission', {
            requestId: info.requestId,
            pending: Boolean(info.pending),
            mode: info.mode,
            selected: info.selected,
            method: info.method || 'session/request_permission',
            optionCount: (info.options || []).length,
            options: (info.options || []).map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind,
            })),
            toolName: info.toolName || '',
            toolTitle: info.toolTitle || '',
            toolArgs: info.toolArgs || {},
            toolCallId: info.toolCallId || '',
          });
          if (info?.pending) {
            setPhase('running', '等待工具授权…');
          }
        };
        // Upstream x.ai/exit_plan_mode — park until UI approve/revise/quit
        client.onPlanApproval = (info) => {
          streamDebug(
            `task=${taskId} plan_approval pending=${info?.pending ? 1 : 0} mode=${info?.mode} req=${info?.requestId}`,
            { force: true }
          );
          if (info?.planContent) {
            emitT('agent:plan', {
              entries: String(info.planContent)
                .split(/\n/)
                .map((l) => l.trim())
                .filter(Boolean)
                .slice(0, 40),
              rawCount: String(info.planContent).split(/\n/).length,
              source: 'exit_plan_mode',
            });
          }
          emitT('agent:plan_approval', {
            requestId: info.requestId,
            toolCallId: info.toolCallId || '',
            planContent: String(info.planContent || '').slice(0, 50_000),
            sessionId: info.sessionId || newSessionId || '',
            pending: Boolean(info.pending),
            mode: info.mode || 'interactive',
            selected: info.selected || null,
          });
          if (info?.pending) {
            setPhase('running', '等待计划审批…');
          }
        };
        // Upstream x.ai/ask_user_question — park until UI answers
        client.onUserQuestion = (info) => {
          streamDebug(
            `task=${taskId} user_question pending=${info?.pending ? 1 : 0} mode=${info?.mode} n=${(info?.questions || []).length} req=${info?.requestId}`,
            { force: true }
          );
          emitT('agent:user_question', {
            requestId: info.requestId,
            toolCallId: info.toolCallId || '',
            sessionId: info.sessionId || newSessionId || '',
            mode: info.mode || 'default',
            questions: Array.isArray(info.questions) ? info.questions : [],
            pending: Boolean(info.pending),
            selected: info.selected || null,
          });
          if (info?.pending) {
            setPhase('running', '等待用户回答…');
          }
        };
        client.onAgentRequest = (info) => {
          // Unknown reverse request (fs/terminal/etc.) — empty {} already sent
          streamDebug(
            `task=${taskId} acp reverse-req unhandled method=${info?.method || '?'}`,
            { force: true }
          );
          emitT('agent:ext', {
            kind: 'reverse_request',
            preview: String(info?.method || 'unknown').slice(0, 120),
          });
        };
        client.onStderr = (s) => {
          const line = String(s || '');
          streamDebug(`task=${taskId} acp-stderr ${line.slice(0, 240)}`, {
            force: /ERROR|403|Forbidden|Authorization|Internal error|coming soon/i.test(
              line
            ),
          });
          // Surface access errors immediately in phase (don't wait for reject)
          if (
            /403|coming soon|don't have access|AuthorizationRequired|Internal error/i.test(
              line
            )
          ) {
            setPhase('error', humanizeAgentError(line).split('\n')[0].slice(0, 120));
          }
        };
        client.onExit = () => {
          children.delete(taskId);
          acpPool.delete(String(taskId));
        };
      };
      bindHandlers();

      // Track as child so stop() can kill it
      if (!client.child) client.start();
      if (client.child) {
        client.child.__acpClient = client;
        children.set(taskId, client.child);
        if (client.pid) trackedPids.add(client.pid);
      }

      mark(reused ? 'reused' : 'spawned');
      streamDebug(
        `=== RUN start task=${taskId} transport=acp reused=${reused ? 1 : 0} pid=${client.pid || '?'} cwd=${cwd} resume=${sessionId || '-'} bin=${grokBin} prepMs=${prepMs || 0} patchedCli=${detectPatchedCli(grokBin, getConfig()).patched ? 1 : 0}`,
        { force: true }
      );
      streamDebug(`task=${taskId} acp-args=${acpArgs.join(' ')}`, { force: true });
      setPhase('boot', reused ? 'ACP 热会话…' : 'ACP initialize…');

      const onAbort = () => {
        intentionalStops.add(String(taskId));
        const sid = newSessionId;
        client
          .cancel(sid)
          .catch(() => {})
          .finally(() => {
            flushStreamIpc();
            if (finalText) {
              emitTextStream({ text: finalText, delta: '', partial: false }, true);
            }
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
            });
            setPhase('stopped', '已停止');
            finish(
              {
                text: finalText,
                stopped: true,
                sessionId: newSessionId,
                taskId,
                usage,
                thought: thoughtText || undefined,
                transport: 'acp',
              },
              { keepWarm: false }
            );
          });
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      (async () => {
        try {
          const meta = {};
          if (rules) meta.rules = String(rules);
          if (maxTurns) meta.maxTurns = Number(maxTurns);

          if (!reused || !client._acpInitialized) {
            setPhase('boot', 'ACP initialize…');
            const initRes = await client.initialize();
            client._acpInitialized = true;
            mark('initialized');
            // ACP initialize meta.modelState — available models for host chip
            try {
              const ms =
                initRes?._meta?.modelState ||
                initRes?.meta?.modelState ||
                initRes?._meta?.model_state ||
                initRes?.meta?.model_state;
              if (ms) {
                cacheAcpModels(ms, 'acp-initialize');
                emitT('agent:models', {
                  ...normalizeModelStateJson(ms),
                  source: 'initialize',
                });
              }
            } catch {
              /* ignore */
            }
            // Load session token into agent sampling (matches grok TUI after initialize)
            try {
              setPhase('boot', 'ACP authenticate…');
              const defaultAuth =
                initRes?._meta?.defaultAuthMethodId ||
                initRes?.meta?.defaultAuthMethodId ||
                initRes?.authMethods?.[0]?.id ||
                'cached_token';
              const authId =
                typeof defaultAuth === 'string'
                  ? defaultAuth
                  : defaultAuth?.id || 'cached_token';
              await client.authenticate(authId);
              mark('authenticated');
              streamDebug(`task=${taskId} acp authenticate method=${authId}`, {
                force: true,
              });
            } catch (authErr) {
              // Still try prompt — some builds auto-load disk auth on initialize
              streamDebug(
                `task=${taskId} acp authenticate skip/fail: ${authErr?.message || authErr}`,
                { force: true }
              );
              mark('authenticate_skip');
            }
          } else {
            mark('initialized_skip');
          }

          // Session: reuse warm id when possible (skip load/new + history replay)
          const wantSession = sessionId || newSessionId || warmSessionId || null;
          if (reused && wantSession && (!warmSessionId || wantSession === warmSessionId)) {
            newSessionId = wantSession;
            mark('session_reuse');
            setPhase('running', '热会话 prompt…');
          } else {
            setPhase('boot', wantSession ? 'session/load…' : 'session/new…');
            let sess;
            if (wantSession) {
              try {
                sess = await client.loadSession(wantSession, cwd, meta);
                mark('session_loaded');
              } catch (loadErr) {
                streamDebug(
                  `task=${taskId} session/load failed: ${loadErr.message}; new session`,
                  { force: true }
                );
                setPhase('boot', 'session/new（load 失败）…');
                sess = await client.newSession(cwd, meta);
                mark('session_new_after_load_fail');
              }
            } else {
              sess = await client.newSession(cwd, meta);
              mark('session_new');
            }
            newSessionId = sess?.sessionId || sess?.session_id || newSessionId;
            // NewSessionResponse.models — live catalog for host model chip
            try {
              const modelsPayload =
                sess?.models ||
                sess?._meta?.models ||
                sess?.meta?.models ||
                sess?._meta?.modelState ||
                sess?.meta?.modelState;
              if (modelsPayload) {
                cacheAcpModels(modelsPayload, 'acp-session');
                emitT('agent:models', {
                  ...normalizeModelStateJson(modelsPayload),
                  source: 'session',
                });
              }
            } catch {
              /* ignore */
            }
          }

          if (client.child) client.child.__acpSessionId = newSessionId;
          setPhase('running', '已发送 prompt，等待首包…');
          mark('prompt_send');
          streamDebug(
            `task=${taskId} acp bufferingSettings=tight maxItems=1 (initialize meta)`,
            { force: true }
          );
          // Keep ticking until prompt completes — covers first-token silence AND
          // multi-minute inter-stage gaps (tools / model planning).
          startActivityClock();

          const result = await client.prompt(newSessionId, message);
          if (settled) return;
          clearWaitTick();
          mark('prompt_done');

          // Close any tools that never got completed updates
          for (const id of openTools) {
            emitT('agent:tool_end', {
              id,
              name: 'tool',
              args: {},
              result: '',
              ok: true,
            });
          }
          openTools.clear();
          toolDepth = 0;

          flushStreamIpc();

          stopReason = result?.stopReason || result?.stop_reason || null;
          if (result?._meta?.usage) usage = result._meta.usage;
          else if (result?.usage) usage = result.usage;
          if (result?._meta?.sessionId) newSessionId = result._meta.sessionId;
          if (typeof result?._meta?.num_turns === 'number') numTurns = result._meta.num_turns;
          else if (typeof usage?.modelCalls === 'number') numTurns = usage.modelCalls;

          // Normalize usage keys for UI (headless snake_case + ACP camelCase)
          if (usage && typeof usage === 'object') {
            if (!usage.input_tokens && usage.inputTokens != null) {
              usage = {
                ...usage,
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                total_tokens: usage.totalTokens,
                cache_read_input_tokens:
                  usage.cachedReadTokens ?? usage.cache_read_input_tokens,
                reasoning_tokens: usage.reasoningTokens,
                modelCalls: usage.modelCalls,
              };
            }
            // Surface incomplete / partial cost flags for formatUsageBrief
            if (usage.usageIsIncomplete != null && usage.usage_is_incomplete == null) {
              usage.usage_is_incomplete = usage.usageIsIncomplete;
            }
            if (usage.costIsPartial != null && usage.cost_is_partial == null) {
              usage.cost_is_partial = usage.costIsPartial;
            }
          }
          usage = plainUsage(usage);

          if (finalText) {
            emitTextStream({ text: finalText, delta: '', partial: false }, true);
          }
          if (usage) {
            emitT('agent:usage', {
              usage,
              stopReason,
              numTurns,
              sessionId: newSessionId,
            });
          }

          const intentional = takeIntentionalStop(taskId) || Boolean(signal?.aborted);
          if (intentional) {
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
            });
            setPhase('stopped', '已停止');
            finish(
              {
                text: finalText,
                stopped: true,
                sessionId: newSessionId,
                taskId,
                usage,
                thought: thoughtText || undefined,
                transport: 'acp',
              },
              { keepWarm: false }
            );
            return;
          }

          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            thought: thoughtText || undefined,
            usage,
            stopReason,
            numTurns,
          });
          setPhase('done', 'done');
          streamDebug(
            `=== RUN end task=${taskId} transport=acp reused=${reused ? 1 : 0} code=0 finalTextLen=${finalText.length} thoughtLen=${thoughtText.length} textChunks=${textChunks} thoughtChunks=${thoughtChunks} firstTokenMs=${firstTokenAt ? firstTokenAt - t0 : -1} totalMs=${Date.now() - t0} prepMs=${prepMs || 0}`,
            { force: true }
          );
          finish({
            text: finalText,
            stopped: false,
            sessionId: newSessionId,
            thought: thoughtText || undefined,
            taskId,
            usage,
            stopReason,
            numTurns,
            transport: 'acp',
            acpReused: reused,
          });
        } catch (err) {
          if (settled) return;
          clearWaitTick();
          if (takeIntentionalStop(taskId) || signal?.aborted) {
            flushStreamIpc();
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
            });
            finish(
              {
                text: finalText,
                stopped: true,
                sessionId: newSessionId,
                taskId,
                usage,
                thought: thoughtText || undefined,
                transport: 'acp',
              },
              { keepWarm: false }
            );
            return;
          }
          // Cold-start / Build-gate 403 → outer run() may headless-fallback
          const msg = err?.message || String(err);
          const dataMsg =
            err?.data && typeof err.data === 'object'
              ? String(err.data.message || '')
              : '';
          const blob = `${msg}\n${dataMsg}`;
          const noOutputYet = !finalText && !thoughtText && openTools.size === 0;
          const buildGate =
            /coming soon|don't have access|403|cli-chat-proxy/i.test(blob) ||
            err?.httpStatus === 403;
          if (
            noOutputYet &&
            (/initialize|ENOENT|spawn|not writable|timeout: initialize/i.test(msg) ||
              buildGate)
          ) {
            settled = true;
            cleanup();
            try {
              client.kill();
            } catch {
              /* ignore */
            }
            const e = new Error(humanizeAgentError(err));
            e.code = 'ACP_FALLBACK';
            e.httpStatus = err?.httpStatus;
            e.data = err?.data;
            // Keep raw blob for outer fallback detector
            e.message = blob.slice(0, 800) || e.message;
            reject(e);
            return;
          }
          // Prefer stderr-rich messages; humanize 403/auth before UI
          fail(err instanceof Error ? err : new Error(humanizeAgentError(msg)));
        }
      })();
    });
  }

  async function runHeadless({
    message,
    sessionId = null,
    signal,
    taskId = 'default',
    _resumeRetried = false,
    _acpFallback = false,
    _fallbackReason = '',
  }) {
    const cfg = getConfig();
    const cwd = workspaceRoot;
    if (!cwd || !fs.existsSync(cwd)) {
      throw new Error('请先打开一个项目工作区');
    }
    if (_acpFallback) {
      streamDebug(
        `=== RUN headless fallback task=${taskId} reason=${_fallbackReason || 'acp'}`,
        { force: true }
      );
    }

    // 同一 task 不允许并发叠跑；新请求先停旧的（标记 intentional，避免 4294967295 假错误）
    if (children.has(taskId)) {
      stop(taskId);
    }
    // New run supersedes any stale intentional-stop flag for this taskId
    intentionalStops.delete(String(taskId));

    const grokBin = resolveGrokBinary(cfg.grokPath);
    if (!grokBin) {
      throw new Error(
        '找不到 Grok CLI。请安装 Grok Build，或在设置中填写 grok 可执行文件路径。\n' +
          '默认查找：%USERPROFILE%\\.grok\\bin\\grok.exe 或 PATH 中的 grok'
      );
    }

    const promptFile = path.join(
      os.tmpdir(),
      `grok-code-prompt-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    fs.writeFileSync(promptFile, message, 'utf8');

    const args = [
      '--prompt-file',
      promptFile,
      '--cwd',
      cwd,
      '--output-format',
      'streaming-json',
      '--no-auto-update',
    ];

    // allow per-run overrides (modes)
    const alwaysApprove =
      cfg._alwaysApproveOverride !== undefined
        ? cfg._alwaysApproveOverride
        : cfg.alwaysApprove !== false;
    const rules = cfg._rulesOverride !== undefined ? cfg._rulesOverride : cfg.rules;
    const maxTurns =
      cfg._maxTurnsOverride !== undefined ? cfg._maxTurnsOverride : cfg.maxTurns;

    if (alwaysApprove) args.push('--always-approve');
    if (cfg.model) args.push('-m', cfg.model);
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    if (rules) args.push('--rules', rules);
    if (sessionId) args.push('--resume', sessionId);

    const emitT = (event, payload) => emit(event, { ...payload, taskId });

    emitT('agent:phase', {
      phase: 'boot',
      detail: sessionId ? 'resuming…' : 'booting CLI…',
    });
    emitT('agent:status', {
      status: 'boot',
      detail: sessionId ? 'resuming…' : 'booting CLI…',
    });
    emitT('agent:cli', {
      binary: grokBin,
      args: args.map((a, i) => (args[i - 1] === '--prompt-file' ? '<prompt-file>' : a)),
    });

    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
    if (cfg.apiKey) env.XAI_API_KEY = cfg.apiKey;

    const isResumeError = (msg) =>
      sessionId &&
      !_resumeRetried &&
      /resume|session|not found|invalid|unknown session|expired|no such/i.test(String(msg || ''));

    /** Windows reports killed process as 4294967295 (uint32 of -1) */
    const normalizeExitCode = (code) => {
      if (code === 4294967295 || code === -1) return -1;
      return code;
    };
    const isForcedKillExit = (code) => {
      const c = normalizeExitCode(code);
      // -1 / 0xFFFFFFFF: TerminateProcess; 0xC000013A: Ctrl+C / console close
      return c === -1 || c === 3221225786;
    };
    const formatExitError = (code, stderrHint) => {
      const c = normalizeExitCode(code);
      if (isForcedKillExit(code)) {
        return (
          'Grok CLI 进程被中断（退出码 -1 / 4294967295）。' +
          '常见原因：点了停止、外部结束进程、或上次挂死被清理。' +
          '请点「新会话 / Fresh」或「重试（跳过 resume）」后再发。' +
          (stderrHint ? `\n${stderrHint}` : '')
        );
      }
      return `Grok CLI 退出码 ${c}${stderrHint ? `\n${stderrHint}` : ''}`;
    };

    return new Promise((resolve, reject) => {
      let finalText = '';
      let thoughtText = '';
      let newSessionId = sessionId || null;
      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let lastPhase = '';
      let lastStatusKey = '';
      let toolDepth = 0;
      let usage = null;
      let stopReason = null;
      let numTurns = 0;

      const cleanup = () => {
        try {
          fs.unlinkSync(promptFile);
        } catch {
          /* ignore */
        }
        children.delete(taskId);
        if (signal) signal.removeEventListener?.('abort', onAbort);
      };

      /** Phase machine for UI: boot → thinking → tool → streaming → done */
      const setPhase = (phase, detail) => {
        if (phase === lastPhase && detail === lastStatusKey) return;
        lastPhase = phase;
        lastStatusKey = detail || phase;
        emitT('agent:phase', { phase, detail: detail || phase });
        emitT('agent:status', { status: phase, detail: detail || phase });
      };

      /**
       * Coalesce text/thought IPC to ~60fps.
       * Sending full finalText on every CLI token floods Electron IPC; the
       * renderer then processes a backlog in one turn and paints one huge dump.
       */
      const STREAM_IPC_MS = 16;
      let pendingTextPayload = null;
      let pendingThoughtPayload = null;
      let textIpcTimer = null;
      let thoughtIpcTimer = null;

      const emitTextStream = (payload, immediate = false) => {
        pendingTextPayload = payload;
        if (immediate) {
          if (textIpcTimer) {
            clearTimeout(textIpcTimer);
            textIpcTimer = null;
          }
          emitT('agent:text', pendingTextPayload);
          pendingTextPayload = null;
          return;
        }
        if (textIpcTimer) return;
        textIpcTimer = setTimeout(() => {
          textIpcTimer = null;
          if (pendingTextPayload) {
            emitT('agent:text', pendingTextPayload);
            pendingTextPayload = null;
          }
        }, STREAM_IPC_MS);
      };

      const emitThoughtStream = (payload, immediate = false) => {
        pendingThoughtPayload = payload;
        if (immediate) {
          if (thoughtIpcTimer) {
            clearTimeout(thoughtIpcTimer);
            thoughtIpcTimer = null;
          }
          emitT('agent:thought', pendingThoughtPayload);
          pendingThoughtPayload = null;
          return;
        }
        if (thoughtIpcTimer) return;
        thoughtIpcTimer = setTimeout(() => {
          thoughtIpcTimer = null;
          if (pendingThoughtPayload) {
            emitT('agent:thought', pendingThoughtPayload);
            pendingThoughtPayload = null;
          }
        }, STREAM_IPC_MS);
      };

      const flushStreamIpc = () => {
        if (textIpcTimer) {
          clearTimeout(textIpcTimer);
          textIpcTimer = null;
        }
        if (thoughtIpcTimer) {
          clearTimeout(thoughtIpcTimer);
          thoughtIpcTimer = null;
        }
        if (pendingTextPayload) {
          emitT('agent:text', pendingTextPayload);
          pendingTextPayload = null;
        }
        if (pendingThoughtPayload) {
          emitT('agent:thought', pendingThoughtPayload);
          pendingThoughtPayload = null;
        }
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        intentionalStops.delete(String(taskId));
        cleanup();
        resolve(result);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        intentionalStops.delete(String(taskId));
        cleanup();
        const msg = err.message || String(err);
        if (isResumeError(msg)) {
          setPhase('retry', '会话失效，无 resume 重试…');
          run({
            message,
            sessionId: null,
            signal,
            taskId,
            _resumeRetried: true,
          })
            .then((r) =>
              resolve({
                ...r,
                resumedFallback: true,
                previousError: msg,
              })
            )
            .catch(reject);
          return;
        }
        emitT('agent:error', { error: msg });
        reject(err);
      };

      const onAbort = () => {
        // User stop: resolve cleanly with partial text (not an error path)
        stop(taskId);
        flushStreamIpc();
        if (finalText) {
          emitTextStream({ text: finalText, delta: '', partial: false }, true);
        }
        emitT('agent:done', {
          text: finalText,
          sessionId: newSessionId,
          stopped: true,
          thought: thoughtText || undefined,
          usage,
        });
        setPhase('stopped', '已停止');
        finish({
          text: finalText,
          stopped: true,
          sessionId: newSessionId,
          taskId,
          usage,
          thought: thoughtText || undefined,
        });
      };

      if (signal) {
        if (signal.aborted) {
          try {
            fs.unlinkSync(promptFile);
          } catch {
            /* ignore */
          }
          finish({ text: '', stopped: true, sessionId, taskId });
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      let child;
      try {
        child = spawn(grokBin, args, {
          cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        fail(new Error(`无法启动 Grok CLI：${err.message}`));
        return;
      }

      children.set(taskId, child);
      if (child.pid) trackedPids.add(child.pid);
      streamDebug(
        `=== RUN start task=${taskId} pid=${child.pid || '?'} cwd=${cwd} resume=${sessionId || '-'} bin=${grokBin}`
      );
      streamDebug(
        `task=${taskId} args=${args
          .map((a, i) => (args[i - 1] === '--prompt-file' ? '<prompt>' : a))
          .join(' ')} log=${STREAM_DEBUG_PATH}`
      );
      try {
        child.stdout.setEncoding('utf8');
      } catch {
        /* ignore */
      }

      /** Pure reducer state (agent-stream.js) — mirrors finalText/thoughtText locals. */
      const streamState = createStreamState({ sessionId: newSessionId });

      const applyStreamActions = (actions) => {
        for (const a of actions) {
          if (a.op === 'flush') {
            flushStreamIpc();
          } else if (a.op === 'phase') {
            setPhase(a.phase, a.detail);
          } else if (a.op === 'emit') {
            if (a.channel === 'agent:text') {
              emitTextStream(a.payload, Boolean(a.immediate));
            } else if (a.channel === 'agent:thought') {
              emitThoughtStream(a.payload, Boolean(a.immediate));
            } else {
              emitT(a.channel, a.payload);
            }
          }
        }
        finalText = streamState.finalText;
        thoughtText = streamState.thoughtText;
        toolDepth = streamState.toolDepth;
        if (streamState.sessionId) newSessionId = streamState.sessionId;
        if (streamState.usage) usage = streamState.usage;
        if (streamState.stopReason != null) stopReason = streamState.stopReason;
        if (streamState.numTurns) numTurns = streamState.numTurns;
      };

      const handleEvent = (ev) => {
        const { actions } = reduceHeadlessEvent(streamState, ev);
        applyStreamActions(actions);
      };

      let lineSeq = 0;
      let chunkSeq = 0;
      let recognized = 0;
      let unrecognized = 0;
      let nonJson = 0;

      const summarizeEvent = (ev, recognizedFlag) => {
        const type = String(ev?.type || '').toLowerCase() || '(no-type)';
        const keys = ev && typeof ev === 'object' ? Object.keys(ev).slice(0, 16).join(',') : '';
        let sample = '';
        try {
          const raw =
            typeof ev?.delta === 'string'
              ? ev.delta
              : typeof ev?.data === 'string'
                ? ev.data
                : typeof ev?.text === 'string'
                  ? ev.text
                  : typeof ev?.content === 'string'
                    ? ev.content
                    : '';
          if (raw) sample = raw.replace(/\s+/g, ' ').slice(0, 80);
        } catch {
          /* ignore */
        }
        return `type=${type} known=${recognizedFlag ? 1 : 0} keys=[${keys}] sample="${sample}" finalTextLen=${finalText.length} thoughtLen=${thoughtText.length} toolDepth=${toolDepth}`;
      };

      const consumeLine = (line) => {
        const parsed = parseNdjsonLine(line);
        if (parsed.kind === 'empty') return;
        lineSeq += 1;
        if (parsed.kind === 'non_json') {
          nonJson += 1;
          streamDebug(
            `task=${taskId} line#${lineSeq} NON_JSON len=${parsed.text.length} raw=${parsed.text.slice(0, 200)}`
          );
          const { actions } = reduceNonJsonLine(streamState, parsed.text);
          applyStreamActions(actions);
          return;
        }
        const type = String(parsed.event?.type || '').toLowerCase();
        const known = isKnownHeadlessType(type);
        if (known) recognized += 1;
        else unrecognized += 1;
        streamDebug(
          `task=${taskId} line#${lineSeq} ${summarizeEvent(parsed.event, known)}${
            !known ? ` raw=${JSON.stringify(parsed.event).slice(0, 240)}` : ''
          }`
        );
        handleEvent(parsed.event);
      };

      streamDebug(
        `task=${taskId} listening stdout/stderr log=${STREAM_DEBUG_PATH}`
      );

      child.stdout.on('data', (chunk) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        chunkSeq += 1;
        stdoutBuf += s;
        const hasNl = /\r?\n/.test(s);
        streamDebug(
          `task=${taskId} stdout#${chunkSeq} bytes=${s.length} hasNl=${hasNl ? 1 : 0} buf=${stdoutBuf.length}`
        );
        let idx;
        while ((idx = stdoutBuf.search(/\r?\n/)) >= 0) {
          const nl = stdoutBuf[idx] === '\r' && stdoutBuf[idx + 1] === '\n' ? 2 : 1;
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + nl);
          consumeLine(line);
        }
      });

      child.stderr.on('data', (buf) => {
        const s = buf.toString('utf8');
        stderrBuf += s;
        if (stderrBuf.length > 40_000) stderrBuf = stderrBuf.slice(-40_000);
        // Log first stderr slices (TUI leak detection)
        streamDebug(
          `task=${taskId} stderr bytes=${s.length} head=${s.replace(/\s+/g, ' ').slice(0, 160)}`
        );
      });

      child.on('error', (err) => {
        fail(new Error(`Grok CLI 进程错误：${err.message}`));
      });

      child.on('close', (code) => {
        streamDebug(
          `=== RUN end task=${taskId} code=${code} lines=${lineSeq} chunks=${chunkSeq} known=${recognized} unknown=${unrecognized} nonJson=${nonJson} finalTextLen=${finalText.length} thoughtLen=${thoughtText.length} pendingBuf=${stdoutBuf.length}`
        );
        if (stdoutBuf.trim()) {
          streamDebug(
            `task=${taskId} flush-pending-buf len=${stdoutBuf.length} head=${stdoutBuf.slice(0, 200).replace(/\s+/g, ' ')}`
          );
          consumeLine(stdoutBuf);
        }
        stdoutBuf = '';
        if (settled) return;

        // Always drop map entry for this pid/task when process exits
        if (children.get(taskId) === child) {
          children.delete(taskId);
        }

        const intentional = takeIntentionalStop(taskId) || Boolean(signal?.aborted);
        if (intentional) {
          flushStreamIpc();
          if (finalText) {
            emitTextStream({ text: finalText, delta: '', partial: false }, true);
          }
          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            stopped: true,
            thought: thoughtText || undefined,
            usage,
          });
          setPhase('stopped', '已停止');
          finish({
            text: finalText,
            stopped: true,
            sessionId: newSessionId,
            taskId,
            usage,
            thought: thoughtText || undefined,
          });
          return;
        }

        const exitCode = normalizeExitCode(code);

        if (code !== 0 && code !== null) {
          const errLine = stderrBuf
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-5)
            .join('\n');
          let errMsg = formatExitError(code, errLine);
          try {
            const maybe = JSON.parse(
              (stderrBuf || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
            );
            if (maybe.message) errMsg = maybe.message;
          } catch {
            /* keep formatExitError */
          }

          // Forced kill / crash with no text: drop broken resume and retry once
          // (covers external taskkill AND stale --resume after interrupt)
          if (
            !finalText &&
            !_resumeRetried &&
            (isForcedKillExit(code) || (sessionId && isResumeError(errMsg)))
          ) {
            setPhase('retry', 'CLI 中断或会话异常，无 resume 重试…');
            run({
              message,
              sessionId: null,
              signal,
              taskId,
              _resumeRetried: true,
            })
              .then((r) =>
                resolve({
                  ...r,
                  resumedFallback: true,
                  previousError: errMsg,
                })
              )
              .catch(reject);
            return;
          }

          if (!finalText) {
            if (!isResumeError(errMsg)) {
              emitT('agent:error', { error: errMsg });
            }
            fail(new Error(errMsg));
            return;
          }
          // Partial output after unexpected kill: treat as interrupted stop (keep text)
          if (isForcedKillExit(code)) {
            flushStreamIpc();
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              warning: errMsg,
              usage,
              thought: thoughtText || undefined,
            });
            finish({
              text: finalText,
              stopped: true,
              sessionId: newSessionId,
              code: exitCode,
              warning: errMsg,
              taskId,
              usage,
              thought: thoughtText || undefined,
            });
            return;
          }
          flushStreamIpc();
          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            code: exitCode,
            warning: errMsg,
            usage,
            stopReason,
            numTurns,
            thought: thoughtText || undefined,
          });
          finish({
            text: finalText,
            stopped: false,
            sessionId: newSessionId,
            code: exitCode,
            warning: errMsg,
            taskId,
            usage,
            stopReason,
            numTurns,
          });
          return;
        }

        flushStreamIpc();
        if (finalText) {
          emitTextStream({ text: finalText, delta: '', partial: false }, true);
        }
        emitT('agent:done', {
          text: finalText,
          sessionId: newSessionId,
          thought: thoughtText || undefined,
          usage,
          stopReason,
          numTurns,
        });
        finish({
          text: finalText,
          stopped: false,
          sessionId: newSessionId,
          thought: thoughtText || undefined,
          taskId,
          usage,
          stopReason,
          numTurns,
        });
      });
    });
  }

  /**
   * Resolve ACP client + sessionId for a task (running turn or warm pool).
   */
  function resolveAcpSession(taskId) {
    const tid = String(taskId);
    const child = children.get(tid);
    if (child?.__acpClient) {
      return {
        client: child.__acpClient,
        sessionId: child.__acpSessionId || null,
        source: 'running',
      };
    }
    const pooled = acpPool.get(tid);
    if (pooled?.client) {
      return {
        client: pooled.client,
        sessionId: pooled.sessionId || null,
        source: 'pool',
      };
    }
    return { client: null, sessionId: null, source: null };
  }

  /**
   * ACP session/set_mode — host mirrors CLI Shift+Tab plan/default/ask.
   * @param {string} taskId
   * @param {string} modeId default | plan | ask
   * @param {string} [sessionId] override if known from renderer
   */
  async function setSessionMode(taskId, modeId, sessionId) {
    const mid = normalizeSessionModeId(modeId);
    const { client, sessionId: sid0, source } = resolveAcpSession(taskId);
    const sid = String(sessionId || sid0 || '').trim();
    if (!client || typeof client.setMode !== 'function') {
      return {
        ok: false,
        error:
          'no active ACP session — run a prompt first (warm pool) or use CLI /plan',
        modeId: mid,
      };
    }
    if (!sid) {
      return { ok: false, error: 'sessionId unknown', modeId: mid };
    }
    try {
      await client.setMode(sid, mid);
      streamDebug(
        `task=${taskId} session/set_mode mode=${mid} sid=${sid} via=${source}`,
        { force: true }
      );
      // Optimistic host mirror; agent also emits current_mode_update
      try {
        emit(
          'agent:mode',
          safeIpc({
            taskId: String(taskId),
            modeId: mid,
            source: 'set_mode',
          })
        );
      } catch {
        /* ignore */
      }
      return { ok: true, modeId: mid, sessionId: sid };
    } catch (err) {
      const msg = err?.message || String(err);
      streamDebug(`task=${taskId} session/set_mode FAIL ${msg}`, { force: true });
      return { ok: false, error: msg, modeId: mid };
    }
  }

  /**
   * ACP session/set_model — live switch on warm/running session.
   * Empty modelId is rejected (use config only for "CLI default" next spawn).
   * @param {string} taskId
   * @param {string} modelId
   * @param {{ sessionId?: string, reasoningEffort?: string }} [opts]
   */
  async function setSessionModel(taskId, modelId, opts = {}) {
    const mid = String(modelId || '').trim();
    const effort = normalizeReasoningEffort(
      opts.reasoningEffort != null ? opts.reasoningEffort : ''
    );
    if (!mid) {
      return {
        ok: false,
        error: 'modelId required (empty = next-run config only, not set_model)',
        modelId: '',
        reasoningEffort: effort,
      };
    }
    const { client, sessionId: sid0, source } = resolveAcpSession(taskId);
    const sid = String(opts.sessionId || sid0 || '').trim();
    if (!client || typeof client.setModel !== 'function') {
      return {
        ok: false,
        error: 'no active ACP session — model saved for next run only',
        modelId: mid,
        reasoningEffort: effort,
        deferred: true,
      };
    }
    if (!sid) {
      return {
        ok: false,
        error: 'sessionId unknown — model saved for next run only',
        modelId: mid,
        reasoningEffort: effort,
        deferred: true,
      };
    }
    try {
      const resp = await client.setModel(sid, mid, {
        reasoningEffort: effort || undefined,
      });
      streamDebug(
        `task=${taskId} session/set_model model=${mid} effort=${effort || '-'} sid=${sid} via=${source}`,
        { force: true }
      );
      const meta = resp?._meta || resp?.meta || {};
      try {
        emit(
          'agent:model',
          safeIpc({
            taskId: String(taskId),
            modelId: mid,
            reasoningEffort:
              effort ||
              meta.reasoning_effort ||
              meta.reasoningEffort ||
              null,
            source: 'set_model',
            meta: meta.model || meta || null,
          })
        );
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        modelId: mid,
        reasoningEffort: effort || null,
        sessionId: sid,
        response: resp || null,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      // Surface incompatible-agent hint from upstream data when present
      const data = err?.data || err?.raw?.error?.data;
      let extra = '';
      try {
        const blob = typeof data === 'string' ? data : JSON.stringify(data || '');
        if (/incompatible|start_new_session|agent.?type/i.test(blob)) {
          extra =
            ' · 当前会话 harness 与目标模型不兼容，请新开任务后再切模型';
        }
        if (/reasoning|effort|not support/i.test(blob + msg)) {
          extra +=
            ' · 该模型可能不支持 reasoning effort，已保留设置供下次 spawn';
        }
      } catch {
        /* ignore */
      }
      streamDebug(`task=${taskId} session/set_model FAIL ${msg}`, { force: true });
      return {
        ok: false,
        error: msg + extra,
        modelId: mid,
        reasoningEffort: effort,
      };
    }
  }

  /**
   * Host answered x.ai/exit_plan_mode (approve | abandoned | cancelled + feedback).
   * Optional execTier: 'yolo' | 'ask' flips live client.autoApprove for remaining tools
   * (settings alwaysApprove is not rewritten — flight-only).
   */
  function replyPlanApproval(taskId, requestId, body = {}) {
    const child = children.get(String(taskId));
    const client = child?.__acpClient;
    // Also try warm pool (rare: approval after turn parked)
    const pooled = !client ? acpPool.get(String(taskId))?.client : null;
    const c = client || pooled;
    if (!c || typeof c.resolveInteractive !== 'function') {
      return { ok: false, error: 'no active ACP client for task' };
    }
    const tier = String(body.execTier || body.exec_tier || '').toLowerCase();
    if (tier === 'yolo' || tier === 'auto') {
      c.autoApprove = true;
    } else if (tier === 'ask' || tier === 'careful' || tier === 'interactive') {
      c.autoApprove = false;
    }
    const outcome = String(body.outcome || 'cancelled');
    const result = { outcome };
    if (body.feedback != null && String(body.feedback).trim()) {
      result.feedback = String(body.feedback).trim();
    }
    const r = c.resolveInteractive(requestId, result);
    streamDebug(
      `task=${taskId} plan_approval reply req=${requestId} outcome=${outcome} tier=${tier || '-'} autoApprove=${c.autoApprove ? 1 : 0} ok=${r.ok ? 1 : 0}`,
      { force: true }
    );
    return { ...r, autoApprove: Boolean(c.autoApprove), execTier: tier || null };
  }

  /**
   * Host answered parked session/request_permission (CLI optionId only).
   * @param {string} taskId
   * @param {string|number} requestId
   * @param {{ optionId?: string, selected?: string, cancelled?: boolean }} body
   */
  function replyPermission(taskId, requestId, body = {}) {
    const child = children.get(String(taskId));
    const client = child?.__acpClient;
    const pooled = !client ? acpPool.get(String(taskId))?.client : null;
    const c = client || pooled;
    if (!c || typeof c.resolveInteractive !== 'function') {
      return { ok: false, error: 'no active ACP client for task' };
    }
    const r = c.resolveInteractive(requestId, body || { cancelled: true });
    streamDebug(
      `task=${taskId} permission reply req=${requestId} outcome=${r.outcome || '?'} sel=${r.selected || '-'} ok=${r.ok ? 1 : 0}`,
      { force: true }
    );
    return r;
  }

  /**
   * Host answered x.ai/ask_user_question (AskUserQuestionExtResponse body).
   * @param {string} taskId
   * @param {string|number} requestId
   * @param {{ outcome: string, answers?: object, annotations?: object, partial_answers?: object }} result
   */
  function replyUserQuestion(taskId, requestId, result = {}) {
    const child = children.get(String(taskId));
    const client = child?.__acpClient;
    const pooled = !client ? acpPool.get(String(taskId))?.client : null;
    const c = client || pooled;
    if (!c || typeof c.resolveInteractive !== 'function') {
      return { ok: false, error: 'no active ACP client for task' };
    }
    const body =
      result && typeof result === 'object' ? { ...result } : { outcome: 'cancelled' };
    if (!body.outcome) body.outcome = 'cancelled';
    const r = c.resolveInteractive(requestId, body);
    streamDebug(
      `task=${taskId} user_question reply req=${requestId} outcome=${body.outcome} ok=${r.ok ? 1 : 0}`,
      { force: true }
    );
    return r;
  }

  return {
    run,
    stop,
    isRunning,
    listRunning,
    listTrackedPids,
    reapTracked,
    replyPlanApproval,
    replyUserQuestion,
    replyPermission,
    setSessionMode,
    setSessionModel,
    invalidateWarmSessions,
  };
}

module.exports = { createAgent, humanizeAgentError };
