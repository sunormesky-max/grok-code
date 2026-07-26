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
  mergeToolMeta,
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
  createStreamIpcCoalesce,
} = require('./agent-stream');

/**
 * Auth / re-login signals from CLI agent worker (not the same as “Build closed”).
 */
function isAuthRequiredBlob(blob) {
  return /authorizationrequired|auth\(authorization|re-authentication|session expired|not authenticated|login required/i.test(
    String(blob || '')
  );
}

/**
 * ACP agent stdio / cli-chat-proxy 403. Server body may still say “coming soon”
 * even when the same account can use headless / TUI / this Build product.
 */
function isAcpStdio403Blob(blob, err) {
  const b = String(blob || '');
  return (
    /coming soon|don't have access|do not have access|not have access/i.test(b) ||
    ((/403/.test(b) || err?.httpStatus === 403) &&
      /forbidden|access|grok build|cli-chat-proxy|responses/i.test(b)) ||
    (/internal error/i.test(b) && /403|coming soon|access/i.test(b))
  );
}

/**
 * Map opaque CLI/ACP errors to actionable Chinese (or EN) copy for the UI.
 * Upstream often wraps 403 as "Internal error" — never surface that bare string.
 * Never claim “Build 未开通” solely from agent-stdio 403: headless may still work.
 */
function humanizeAgentError(raw) {
  const msg = String(raw?.message || raw || '').trim();
  const blob = msg.toLowerCase();
  const authReq = isAuthRequiredBlob(blob);
  const stdio403 = isAcpStdio403Blob(msg, raw);

  // Combined: common in stream logs — Auth(AuthorizationRequired) then 403 body
  if (authReq && stdio403) {
    return (
      '【Build 主路径失败】grok agent stdio 鉴权/代理错误（AuthorizationRequired + 403）。\n' +
      '正常态应是 agent stdio（完整工具流）。若已允许 -p 降级，将自动改用 grok -p 继续（黑盒工具、无 tool 卡片）。\n' +
      '处理：终端 grok login；设置→探测 ACP；设置里可开关「允许 -p 降级」。'
    );
  }
  if (authReq) {
    return (
      '【Build 主路径失败】Grok CLI 需要重新登录（AuthorizationRequired）。\n' +
      '请在终端运行：grok login 后点「重试 ACP」。\n' +
      '若已允许 -p 降级，可先用 -p 应急。'
    );
  }
  if (stdio403) {
    return (
      '【Build 主路径失败】grok agent stdio 返回 403（文案可能仍写 coming soon）。\n' +
      '同一 CLI 的 grok -p 往往仍可用（工具黑盒、无 tool 事件）。\n' +
      '默认会降级到 -p 并显示黄条；关闭「允许 -p 降级」则只报错不干活。\n' +
      '处理：grok login · 探测 ACP · 或接受 -p 应急。'
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
    if (/403|coming soon|access|authorization/i.test(inner)) {
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
function createAgent({ getConfig, workspaceRoot, emit, reportStreamTelemetry } = {}) {
  /** @type {Map<string, import('child_process').ChildProcess>} */
  const children = new Map();
  /**
   * Interactive parks (permission / plan / ask) — activity clock must not
   * look like CLI silence while the host is waiting on the user.
   * @type {Map<string, { kind: string, label: string, since: number, toolName?: string }>}
   */
  const interactiveParks = new Map();
  /**
   * Warm ACP sessions kept after a turn so the next prompt skips
   * initialize+session/new (~1s+ cold start). Keyed by taskId.
   * @type {Map<string, { client: import('./acp-client').AcpClient, sessionId: string, cwd: string, key: string }>}
   */
  const acpPool = new Map();
  /**
   * After ACP agent-stdio 403/auth fails, skip ACP for a while on auto transport
   * so every send does not burn ~2s cold ACP only to fall back again.
   * Cleared when user forces agentTransport=acp, clearStickyHeadless(), or stickyMs.
   * @type {number} Date.now() until which auto prefers headless
   */
  let stickyHeadlessUntil = 0;
  /** @type {string} acp_stdio_403 | acp_auth | acp_cold | '' */
  let stickyHeadlessReason = '';
  /** When preferHeadlessOnAcpFail: sticky stays until user clears (no auto expiry retry). */
  let stickyPinned = false;

  function stickyMsFromConfig() {
    try {
      const cfg = typeof getConfig === 'function' ? getConfig() || {} : {};
      const envMin = Number(process.env.GROKCODE_STICKY_HEADLESS_MIN);
      const n = Number.isFinite(envMin) && envMin > 0 ? envMin : Number(cfg.stickyHeadlessMinutes);
      if (Number.isFinite(n) && n >= 1 && n <= 120) return Math.round(n) * 60 * 1000;
    } catch {
      /* ignore */
    }
    return 30 * 60 * 1000;
  }

  function preferHeadlessPinned() {
    try {
      const cfg = typeof getConfig === 'function' ? getConfig() || {} : {};
      return Boolean(cfg.preferHeadlessOnAcpFail);
    } catch {
      return false;
    }
  }

  function stickyReasonLabel(reason) {
    const r = String(reason || '');
    if (r === 'acp_stdio_403' || r === 'acp_build_403') {
      return 'ACP agent 路径 403（服务端文案可能仍写 coming soon；≠ Build 未开通）';
    }
    if (r === 'acp_auth') {
      return 'ACP AuthorizationRequired（需 grok login / 会话令牌）';
    }
    if (r === 'acp_cold') return 'ACP 冷启动失败';
    if (r === 'acp_sticky') return '沿用上次 ACP 失败（sticky headless）';
    if (r === 'acp_sticky_expired_retry') return 'sticky 已到期，正在重试 ACP';
    return r || 'ACP 不可用';
  }

  function getTransportState() {
    const now = Date.now();
    const sticky = stickyHeadlessUntil > now || (stickyPinned && Boolean(stickyHeadlessReason));
    const minsCfg = Math.round(stickyMsFromConfig() / 60000);
    return {
      stickyHeadless: sticky,
      stickyUntil: sticky && !stickyPinned ? stickyHeadlessUntil : stickyPinned ? 0 : 0,
      stickyRemainingMs:
        sticky && !stickyPinned ? Math.max(0, stickyHeadlessUntil - now) : stickyPinned ? -1 : 0,
      stickyReason: sticky ? stickyHeadlessReason : '',
      stickyReasonLabel: sticky ? stickyReasonLabel(stickyHeadlessReason) : '',
      stickyMinutes: sticky
        ? stickyPinned
          ? minsCfg
          : Math.max(1, Math.ceil((stickyHeadlessUntil - now) / 60000))
        : 0,
      stickyPinned: Boolean(stickyPinned && sticky),
      stickyConfiguredMinutes: minsCfg,
      preferHeadlessOnAcpFail: preferHeadlessPinned(),
      noToolStream: sticky,
      degrade: sticky,
    };
  }

  function emitTransportState(extra = {}) {
    try {
      if (typeof emit === 'function') {
        emit('agent:transport', {
          taskId: 'global',
          ...getTransportState(),
          ...extra,
        });
      }
    } catch {
      /* ignore */
    }
  }

  function clearStickyHeadless(opts = {}) {
    const had =
      stickyHeadlessUntil > Date.now() || stickyHeadlessReason || stickyPinned;
    stickyHeadlessUntil = 0;
    stickyHeadlessReason = '';
    stickyPinned = false;
    streamDebug(`sticky headless cleared by=${opts.by || 'user'}`, { force: true });
    emitTransportState({ cleared: true, by: opts.by || 'user' });
    return { ok: true, cleared: Boolean(had) };
  }

  function armStickyHeadless(reason) {
    stickyHeadlessReason = String(reason || 'acp_stdio_403');
    const pin = preferHeadlessPinned();
    stickyPinned = pin;
    const ms = stickyMsFromConfig();
    stickyHeadlessUntil = pin ? Date.now() + 365 * 24 * 60 * 60 * 1000 : Date.now() + ms;
    streamDebug(
      `sticky headless armed reason=${stickyHeadlessReason} pinned=${pin ? 1 : 0} until=${new Date(stickyHeadlessUntil).toISOString()} ms=${ms}`,
      { force: true }
    );
    emitTransportState({ armed: true, stickyPinned: pin });
  }
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
      // Drop interactive park so next turn's activity clock never shows stale
      // “等待授权/计划审批” after user stop mid-permission.
      interactiveParks.delete(String(taskId));
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
    interactiveParks.clear();
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
   * Primary path: ACP (`grok agent stdio`) — Grok Build frontend contract.
   * Full tool stream + Live/Code/Diff. This is the only “normal” mode.
   *
   * `grok -p` streaming-json is an explicit escape hatch (allowHeadlessFallback),
   * NOT product-normal: tools may run black-box but no tool_call events.
   *
   * Override: GROKCODE_AGENT_TRANSPORT=headless|acp|streaming-json
   * Force no -p: GROKCODE_ACP_NO_FALLBACK=1 (default product stance when
   * allowHeadlessFallback is false).
   */
  function allowHeadlessFallbackNow(cfg) {
    if (
      process.env.GROKCODE_ACP_NO_FALLBACK === '1' ||
      process.env.GROKCODE_ACP_NO_FALLBACK === 'true'
    ) {
      return false;
    }
    if (
      process.env.GROKCODE_ALLOW_HEADLESS_FALLBACK === '1' ||
      process.env.GROKCODE_ALLOW_HEADLESS_FALLBACK === 'true'
    ) {
      return true;
    }
    // Default true: stay usable when agent stdio is 403 but -p works (loud banner).
    // Explicit false → hard-fail only.
    return cfg?.allowHeadlessFallback !== false;
  }

  async function run(opts) {
    const cfg0 = getConfig();
    const transport = String(
      process.env.GROKCODE_AGENT_TRANSPORT || cfg0.agentTransport || 'auto'
    ).toLowerCase();
    const allowHl = allowHeadlessFallbackNow(cfg0);
    // headless | streaming-json: force -p style path (explicit user choice)
    if (transport === 'headless' || transport === 'streaming-json') {
      return runHeadless(opts);
    }
    // auto + sticky: only skip to -p when user opted into degraded fallback
    if (
      transport === 'auto' &&
      stickyHeadlessReason &&
      stickyHeadlessUntil > 0 &&
      stickyHeadlessUntil <= Date.now() &&
      !stickyPinned &&
      !opts?._forceAcp
    ) {
      streamDebug(
        `sticky expired — auto-retry ACP (was ${stickyHeadlessReason})`,
        { force: true }
      );
      stickyHeadlessUntil = 0;
      const prev = stickyHeadlessReason;
      stickyHeadlessReason = '';
      try {
        opts?.emit?.('agent:phase', {
          taskId: opts.taskId || 'default',
          phase: 'boot',
          detail: `sticky 已到期，重试 ACP（上次 ${prev}）…`,
        });
      } catch {
        /* ignore */
      }
      emitTransportState({ expiredRetry: true, previousReason: prev });
    }
    if (
      allowHl &&
      transport === 'auto' &&
      (stickyHeadlessUntil > Date.now() || stickyPinned) &&
      stickyHeadlessReason &&
      !opts?._forceAcp &&
      process.env.GROKCODE_FORCE_ACP !== '1'
    ) {
      streamDebug(
        `sticky headless (opt-in fallback; pinned=${stickyPinned ? 1 : 0})`,
        { force: true }
      );
      try {
        opts?.emit?.('agent:phase', {
          taskId: opts.taskId || 'default',
          phase: 'boot',
          detail: '已选择 -p 降级（非 Build 主路径）…',
        });
      } catch {
        /* ignore */
      }
      return runHeadless({
        ...opts,
        sessionId: null,
        _acpFallback: true,
        _fallbackReason: 'acp_sticky',
      });
    }
    // transport=acp or auto without sticky/opt-in → ACP only
    const forceAcpOnly = transport === 'acp' || !allowHl;
    try {
      const result = await runAcp(opts);
      if (stickyHeadlessUntil || stickyHeadlessReason) {
        clearStickyHeadless({ by: 'acp_ok' });
      }
      return result;
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
        opts?._noHeadlessFallback ||
        !allowHl;
      const coldFail =
        err?.code === 'ACP_FALLBACK' ||
        /ENOENT|spawn |initialize|not writable|找不到 Grok/i.test(msg);
      const acpStdio403 = isAcpStdio403Blob(blob, err);
      const authRequired = isAuthRequiredBlob(blob);
      const fallbackReason = acpStdio403
        ? 'acp_stdio_403'
        : authRequired
          ? 'acp_auth'
          : coldFail
            ? 'acp_cold'
            : 'acp_error';

      // Always record last ACP failure for UI / Doctor (even when not falling back)
      if (acpStdio403 || authRequired) {
        armStickyHeadless(fallbackReason);
      }

      streamDebug(
        [
          `=== STREAM_SUMMARY task=${opts.taskId || 'default'}`,
          `transport=acp`,
          `stopReason=${noFallback ? 'ACP_PATH_FAILED' : 'ACP_FALLBACK'}`,
          `fallback=${fallbackReason}`,
          `allowHeadlessFallback=${allowHl ? 1 : 0}`,
          `note=${noFallback ? 'no_silent_degrade' : 'retry_headless'}`,
          `firstTokenMs=-1`,
          `err=${String(msg).slice(0, 120).replace(/\s+/g, ' ')}`,
        ].join(' '),
        { force: true }
      );

      if (!noFallback && (coldFail || acpStdio403 || authRequired)) {
        streamDebug(
          `ACP → headless fallback OPT-IN (${fallbackReason}): ${msg.slice(0, 200)}`,
          { force: true }
        );
        try {
          opts?.emit?.('agent:phase', {
            taskId: opts.taskId || 'default',
            phase: 'boot',
            detail:
              'ACP 失败 · 用户已允许 -p 降级（无工具 UI，非 Build 主路径）…',
          });
        } catch {
          /* ignore */
        }
        return runHeadless({
          ...opts,
          sessionId: null,
          _acpFallback: true,
          _fallbackReason: fallbackReason,
        });
      }

      // Product-normal: hard fail — do not pretend we are still a Build flight deck
      const friendly = humanizeAgentError(err);
      const e = new Error(friendly);
      e.code = 'ACP_PATH_FAILED';
      e.fallbackReason = fallbackReason;
      e.allowHeadlessFallback = false;
      e.cause = err;
      try {
        if (typeof emit === 'function') {
          emit('agent:error', {
            taskId: opts.taskId || 'default',
            error: friendly,
            code: 'ACP_PATH_FAILED',
            fallbackReason,
            buildPathFailed: true,
          });
          emit('agent:phase', {
            taskId: opts.taskId || 'default',
            phase: 'error',
            detail: 'Build 主路径失败（agent stdio）',
          });
          emitTransportState({
            taskId: opts.taskId || 'default',
            buildPathFailed: true,
            fallbackReason,
          });
        }
      } catch {
        /* ignore */
      }
      throw e;
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
      /** Stream health counters (STREAM-PLAN Phase 0) */
      let toolStarts = 0;
      let toolEnds = 0;
      let toolInProgressFrames = 0;
      let maxSilentSec = 0;
      /** Last tool name for inter-stage silence UI (Phase 3.1 host). */
      let lastToolName = '';
      /** @type {Map<string, { name: string, args: object }>} id → start meta (path survives empty end frames) */
      const openTools = new Map();
      const noteOpenTool = (info) => {
        const id = String(info?.id || '');
        if (!id) return false;
        const was = openTools.has(id);
        openTools.set(id, mergeToolMeta(openTools.get(id), info));
        return !was;
      };
      const takeOpenTool = (id) => {
        const key = String(id || '');
        const meta = openTools.get(key) || null;
        if (openTools.has(key)) openTools.delete(key);
        return meta;
      };
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
      const buildStreamSummary = (extra = {}) => {
        const totalMs = Date.now() - t0;
        const firstMs = firstTokenAt ? firstTokenAt - t0 : -1;
        return {
          transport: 'acp',
          firstTokenMs: firstMs,
          totalMs,
          textChunks,
          thoughtChunks,
          toolStarts,
          toolEnds,
          toolInProgress: toolInProgressFrames,
          maxSilentSec,
          finalTextLen: finalText.length,
          thoughtLen: thoughtText.length,
          openTools: openTools.size,
          emptyToolsOnly: finalText.length === 0 && toolStarts > 0 ? 1 : 0,
          ...extra,
        };
      };
      const logStreamSummary = (extra = {}) => {
        const sum = buildStreamSummary(extra);
        const parts = [
          `=== STREAM_SUMMARY task=${taskId}`,
          `transport=${sum.transport}`,
          `firstTokenMs=${sum.firstTokenMs}`,
          `totalMs=${sum.totalMs}`,
          `textChunks=${sum.textChunks}`,
          `thoughtChunks=${sum.thoughtChunks}`,
          `toolStarts=${sum.toolStarts}`,
          `toolEnds=${sum.toolEnds}`,
          `toolInProgress=${sum.toolInProgress}`,
          `maxSilentSec=${sum.maxSilentSec}`,
          `finalTextLen=${sum.finalTextLen}`,
          `thoughtLen=${sum.thoughtLen}`,
          `openTools=${sum.openTools}`,
        ];
        for (const [k, v] of Object.entries(extra)) {
          if (v != null && v !== '') parts.push(`${k}=${v}`);
        }
        streamDebug(parts.join(' '), { force: true });
        // Phase 5.3 — opt-in allowlisted counters only (no prompts/paths/keys)
        try {
          if (typeof reportStreamTelemetry === 'function') {
            const cfgNow = getConfig() || {};
            if (cfgNow.telemetryEnabled) {
              reportStreamTelemetry({
                transport: 'acp',
                firstTokenMs: sum.firstTokenMs,
                toolStarts,
                toolEnds,
                maxSilentSec,
                emptyToolsOnly: sum.emptyToolsOnly,
                stopReason: extra.stopReason || 'unknown',
                totalMs: sum.totalMs,
                textChunks,
                thoughtChunks,
                code: extra.code,
              });
            }
          }
        } catch {
          /* never break agent on telemetry */
        }
        return sum;
      };

      /**
       * Coalesce text/thought IPC to ~60fps with **enqueue-order** flush
       * (single timer — thought-before-text windows no longer invert on flush).
       */
      const STREAM_IPC_MS = 16;
      const streamIpc = createStreamIpcCoalesce(
        (channel, payload) => emitT(channel, payload),
        { intervalMs: STREAM_IPC_MS }
      );
      const emitTextStream = (payload, immediate = false) =>
        streamIpc.emitText(payload, immediate);
      const emitThoughtStream = (payload, immediate = false) =>
        streamIpc.emitThought(payload, immediate);
      const flushStreamIpc = () => streamIpc.flush();

      const setPhase = (phase, detail) => {
        if (phase === lastPhase && detail === lastStatusKey) return;
        lastPhase = phase;
        lastStatusKey = detail || phase;
        emitT('agent:phase', { phase, detail: detail || phase });
        emitT('agent:status', { status: phase, detail: detail || phase });
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
        if (lastActivityAt > 0 && promptSentAt > 0) {
          const gap = Math.floor((Date.now() - lastActivityAt) / 1000);
          if (gap > maxSilentSec) maxSilentSec = gap;
        }
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

      /** @type {'none'|'boot'|'prompt'} */
      let clockMode = 'none';
      let bootStartedAt = 0;

      /**
       * Anti-black-box clock:
       * - boot: cold initialize/auth/load elapsed (before prompt)
       * - prompt: first-token + inter-stage silence + interactive park honesty
       */
      const startActivityClock = (mode = 'prompt') => {
        clearWaitTick();
        clockMode = mode === 'boot' ? 'boot' : 'prompt';
        if (clockMode === 'boot') {
          bootStartedAt = Date.now();
          if (!promptSentAt) promptSentAt = bootStartedAt;
        } else {
          promptSentAt = Date.now();
          lastActivityAt = promptSentAt;
        }
        waitTickTimer = setInterval(() => {
          if (settled) {
            clearWaitTick();
            return;
          }

          // Interactive park: host waiting on user — not CLI silence
          const park = interactiveParks.get(String(taskId));
          if (park && clockMode === 'prompt') {
            const parkSec = Math.max(0, Math.floor((Date.now() - park.since) / 1000));
            const who = park.toolName ? ` · ${park.toolName}` : '';
            setPhase('running', `${park.label}${who} ${parkSec}s`);
            // Freeze activity baseline so maxSilentSec does not count user think time
            lastActivityAt = Date.now();
            return;
          }

          if (clockMode === 'boot') {
            const sec = Math.max(0, Math.floor((Date.now() - bootStartedAt) / 1000));
            const base = String(lastStatusKey || 'ACP 启动中…').replace(/\s+\d+s\s*$/, '');
            setPhase('boot', `${base || 'ACP 启动中…'} ${sec}s`);
            return;
          }

          const silentSec = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
          if (silentSec > maxSilentSec) maxSilentSec = silentSec;
          const totalSec = Math.max(0, Math.floor((Date.now() - promptSentAt) / 1000));
          const tok = tokenBrief();
          if (!firstTokenAt) {
            const eff = String(cfg.reasoningEffort || '').trim() || 'default';
            setPhase(
              'running',
              `CLI 静默 ${silentSec}s · 模型多半在服务端推理（effort=${eff}）· 尚未推送 chunk${tok}`
            );
          } else if (toolDepth > 0) {
            const who = lastToolName ? ` · ${lastToolName}` : '';
            setPhase(
              'tool',
              `工具执行中 ×${toolDepth}${who} · 已静默 ${silentSec}s · 总 ${totalSec}s${tok}`
            );
          } else if (silentSec >= 1) {
            // Between stages: model planning next tools / next text (no session/update)
            const last = lastToolName ? `上次 ${lastToolName} · ` : '';
            setPhase(
              'running',
              `等待模型继续… ${silentSec}s（${last}CLI 段间静默）· 总 ${totalSec}s${tok}`
            );
          }
        }, 500);
      };

      const setInteractivePark = (kind, label, toolName = '') => {
        interactiveParks.set(String(taskId), {
          kind: String(kind || 'park'),
          label: String(label || '等待用户…'),
          since: Date.now(),
          toolName: String(toolName || ''),
        });
      };
      const clearInteractivePark = () => {
        if (interactiveParks.has(String(taskId))) {
          interactiveParks.delete(String(taskId));
          bumpActivity();
        }
      };

      const cleanup = () => {
        clearWaitTick();
        // Teardown must clear parks — fail/stop/ACP_FALLBACK mid-permission
        // otherwise leaves a stale entry that poisons the next prompt clock.
        interactiveParks.delete(String(taskId));
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
        // Stop accepting updates, then flush coalesced text so the last
        // ~16ms of stream is not lost under agent:error.
        try {
          flushStreamIpc();
          if (finalText) {
            emitTextStream({ text: finalText, delta: '', partial: false }, true);
          }
        } catch {
          /* ignore flush races during teardown */
        }
        logStreamSummary({
          stopReason: 'error',
          prepMs: prepMs || 0,
          code: 1,
        });
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
            if (info.name) lastToolName = String(info.name);
            // noteOpenTool always merges path args (repeat tool_call frames)
            if (noteOpenTool(info)) {
              toolDepth += 1;
              toolStarts += 1;
              if (textChunks === 0 && thoughtChunks === 0) noteFirstToken('tool');
              const meta = openTools.get(info.id);
              emitT('agent:tool_start', {
                id: info.id,
                name: meta?.name || info.name,
                args: meta?.args || slimToolArgs(info.args),
                startedAt: Date.now(),
              });
              setPhase('tool', `${meta?.name || info.name}…`);
              streamDebug(
                `task=${taskId} acp tool_call name=${meta?.name || info.name} id=${info.id} depth=${toolDepth}`,
                { force: true }
              );
            }
          } else if (kind === 'tool_call_update') {
            bumpActivity();
            const info = pickToolInfo(update);
            if (info.name) lastToolName = String(info.name);
            const status = String(update.status || '').toLowerCase();
            // in_progress / pending / running: keep tool card alive
            if (
              status === 'in_progress' ||
              status === 'pending' ||
              status === 'running'
            ) {
              // Parity with tool_call / ToolCallDelta: flush text before tool paint
              flushStreamIpc();
              if (status === 'in_progress') toolInProgressFrames += 1;
              const isNew = noteOpenTool(info);
              if (isNew) {
                toolDepth += 1;
                toolStarts += 1;
                if (textChunks === 0 && thoughtChunks === 0) noteFirstToken('tool');
                const meta = openTools.get(info.id);
                emitT('agent:tool_start', {
                  id: info.id,
                  name: meta?.name || info.name,
                  args: meta?.args || slimToolArgs(info.args),
                  startedAt: Date.now(),
                  status,
                });
              } else {
                const meta = openTools.get(info.id);
                const partial =
                  pickToolResultText(update) ||
                  pickChunkText(update.content || update.output || update) ||
                  '';
                emitT('agent:tool_start', {
                  id: info.id,
                  name: meta?.name || info.name,
                  args: meta?.args || slimToolArgs(info.args),
                  status,
                  progress: true,
                  result: partial ? String(partial).slice(0, 4000) : undefined,
                });
              }
              const metaName = openTools.get(info.id)?.name || info.name;
              setPhase(
                'tool',
                status === 'in_progress'
                  ? `${metaName} · 执行中…`
                  : `${metaName}…`
              );
            } else if (
              !openTools.has(info.id) &&
              status !== 'completed' &&
              status !== 'failed' &&
              status !== 'cancelled'
            ) {
              noteOpenTool(info);
              toolDepth += 1;
              toolStarts += 1;
              const meta = openTools.get(info.id);
              emitT('agent:tool_start', {
                id: info.id,
                name: meta?.name || info.name,
                args: meta?.args || slimToolArgs(info.args),
                startedAt: Date.now(),
              });
              setPhase('tool', `${meta?.name || info.name}…`);
            }
            if (status === 'completed' || status === 'failed' || status === 'cancelled') {
              const prev = takeOpenTool(info.id);
              if (prev) {
                toolDepth = Math.max(0, toolDepth - 1);
              }
              toolEnds += 1;
              flushStreamIpc();
              const endMeta = mergeToolMeta(prev, info);
              emitT('agent:tool_end', {
                id: info.id,
                name: endMeta.name,
                args: endMeta.args,
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
            // Flush pending text/thought first so tool cards never overtake last stream paint.
            flushStreamIpc();
            const resolved = resolveToolCallDelta(update, toolDeltaState);
            toolDeltaState = resolved.state;
            const { id, name, idx, argFrag, hintArgs } = resolved;
            let deltaArgs = slimToolArgs(
              update.rawInput ||
                update.raw_input ||
                update.delta ||
                update.args ||
                update.partialArgs ||
                {}
            );
            if (hintArgs && Object.keys(hintArgs).length) {
              deltaArgs = { ...deltaArgs, ...hintArgs };
            }

            if (name) lastToolName = String(name);
            // Phase 2.1: surface arguments_delta / body fragment as mid-flight progress
            const partialBody =
              (argFrag && String(argFrag).slice(0, 2000)) ||
              pickChunkText(update.content || update.output || update) ||
              '';
            if (id) {
              const isNewDelta = noteOpenTool({ id, name: String(name), args: deltaArgs });
              const meta = openTools.get(id);
              if (isNewDelta) {
                toolDepth += 1;
                toolStarts += 1;
                if (textChunks === 0 && thoughtChunks === 0) noteFirstToken('tool');
                emitT('agent:tool_start', {
                  id,
                  name: meta?.name || String(name),
                  args: meta?.args || deltaArgs,
                  startedAt: Date.now(),
                  status: 'in_progress',
                  fromDelta: true,
                  result: partialBody || undefined,
                });
              } else {
                emitT('agent:tool_start', {
                  id,
                  name: meta?.name || String(name),
                  args: meta?.args || deltaArgs,
                  status: 'in_progress',
                  progress: true,
                  fromDelta: true,
                  result: partialBody || undefined,
                });
              }
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
            // 流式执行路线：durable step (not phase-only)
            emitT('agent:route', {
              kind: 'retry',
              detail: String(detail).slice(0, 160),
              title: 'retry',
            });
            return;
          }

          if (
            kind === 'auto_compact_started' ||
            kind === 'memory_flush_started' ||
            kind === 'auto_recovery_started'
          ) {
            const detail = kind.includes('compact')
              ? '上下文压缩中…'
              : kind.includes('recovery')
                ? '自动恢复中…'
                : 'Memory flush…';
            setPhase('running', detail);
            emitT('agent:route', {
              kind: 'compact',
              detail,
              title: kind,
              meta: { status: 'running', rawKind: kind },
            });
            return;
          }

          if (
            kind === 'auto_compact_completed' ||
            kind === 'auto_compact_failed' ||
            kind === 'auto_compact_cancelled' ||
            kind === 'memory_flush_completed' ||
            kind === 'auto_recovery_exhausted'
          ) {
            const fail = kind.includes('fail') || kind.includes('exhaust');
            const detail = fail
              ? String(update.error || 'compact/recovery failed').slice(0, 120)
              : '压缩/恢复完成，继续…';
            setPhase(fail ? 'error' : 'running', detail);
            emitT('agent:route', {
              kind: 'compact',
              detail,
              title: kind,
              meta: { status: fail ? 'fail' : 'ok', rawKind: kind },
            });
            return;
          }

          if (kind === 'goal_updated') {
            const title = update.title || update.goalTitle || 'goal';
            const progress =
              typeof update.progress === 'number' ? ` ${update.progress}%` : '';
            const detail = `目标${progress}: ${String(title).slice(0, 80)}`;
            setPhase('running', detail);
            emitT('agent:route', {
              kind: 'goal',
              detail,
              title: String(title).slice(0, 80),
              meta: {
                progress: typeof update.progress === 'number' ? update.progress : undefined,
              },
            });
            return;
          }

          if (kind === 'turn_completed') {
            // Usage often on result; still mark activity
            if (update.usage) {
              emitT('agent:usage', { usage: plainUsage(update.usage) });
            }
            emitT('agent:route', {
              kind: 'signal',
              detail: 'turn_completed',
              title: 'turn',
              meta: { rawKind: 'turn_completed' },
            });
            return;
          }

          if (
            kind === 'subagent_spawned' ||
            kind === 'subagent_progress' ||
            kind === 'subagent_finished'
          ) {
            const detail =
              kind === 'subagent_spawned'
                ? '子代理启动…'
                : kind === 'subagent_finished'
                  ? '子代理完成'
                  : '子代理运行中…';
            setPhase('running', detail);
            emitT('agent:route', {
              kind: 'subagent',
              detail,
              title: kind,
              meta: {
                status:
                  kind === 'subagent_finished'
                    ? 'ok'
                    : kind === 'subagent_spawned'
                      ? 'running'
                      : 'running',
                rawKind: kind,
              },
            });
            return;
          }

          if (kind === 'task_completed') {
            setPhase('running', '后台任务完成');
            emitT('agent:route', {
              kind: 'signal',
              detail: '后台任务完成',
              title: 'task_completed',
            });
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
            setInteractivePark(
              'permission',
              '等待工具授权…',
              info.toolName || info.toolTitle || ''
            );
            setPhase('running', '等待工具授权…');
          } else {
            clearInteractivePark();
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
            setInteractivePark('plan', '等待计划审批…');
            setPhase('running', '等待计划审批…');
          } else {
            clearInteractivePark();
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
            setInteractivePark('ask', '等待用户回答…');
            setPhase('running', '等待用户回答…');
          } else {
            clearInteractivePark();
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
      // Boot elapsed clock (Phase breakthrough) — replaced by prompt clock later
      startActivityClock('boot');

      const onAbort = () => {
        intentionalStops.add(String(taskId));
        const sid = newSessionId;
        client
          .cancel(sid)
          .catch(() => {})
          .finally(() => {
            // Main prompt path may already have settled via intentional stop
            if (settled) return;
            flushStreamIpc();
            if (finalText) {
              emitTextStream({ text: finalText, delta: '', partial: false }, true);
            }
            // Parity with headless onAbort + normal ACP stop paths
            const streamSummary = logStreamSummary({
              stopReason: 'user_stop_abort',
              prepMs: prepMs || 0,
              code: 0,
            });
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
              streamSummary,
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
                streamSummary,
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
          startActivityClock('prompt');

          const result = await client.prompt(newSessionId, message);
          if (settled) return;
          clearWaitTick();
          mark('prompt_done');

          // Close any tools that never got completed updates (keep start path/name)
          for (const [id, meta] of openTools) {
            emitT('agent:tool_end', {
              id,
              name: meta?.name || 'tool',
              args: meta?.args || {},
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
            const streamSummary = logStreamSummary({
              reused: reused ? 1 : 0,
              stopReason: 'user_stop',
              prepMs: prepMs || 0,
              code: 0,
            });
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
              streamSummary,
            });
            setPhase('stopped', '已停止');
            finish(
              {
                streamSummary,
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

          const streamSummary = logStreamSummary({
            reused: reused ? 1 : 0,
            stopReason: stopReason || 'end',
            prepMs: prepMs || 0,
            code: 0,
          });
          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            thought: thoughtText || undefined,
            usage,
            stopReason,
            numTurns,
            streamSummary,
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
            streamSummary,
            numTurns,
            transport: 'acp',
            acpReused: reused,
          });
        } catch (err) {
          if (settled) return;
          clearWaitTick();
          if (takeIntentionalStop(taskId) || signal?.aborted) {
            flushStreamIpc();
            const streamSummary = logStreamSummary({
              stopReason: 'user_stop_err_path',
              prepMs: prepMs || 0,
            });
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
              streamSummary,
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
                streamSummary,
              },
              { keepWarm: false }
            );
            return;
          }
          // Cold-start / ACP stdio 403 / auth → outer run() may headless-fallback
          const msg = err?.message || String(err);
          const dataMsg =
            err?.data && typeof err.data === 'object'
              ? String(err.data.message || '')
              : '';
          const blob = `${msg}\n${dataMsg}`;
          const noOutputYet = !finalText && !thoughtText && openTools.size === 0;
          const acpPathFail =
            isAcpStdio403Blob(blob, err) ||
            isAuthRequiredBlob(blob) ||
            /coming soon|don't have access|403|cli-chat-proxy/i.test(blob) ||
            err?.httpStatus === 403;
          if (
            noOutputYet &&
            (/initialize|ENOENT|spawn|not writable|timeout: initialize/i.test(msg) ||
              acpPathFail)
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

    // Phase 4.2: honest banner — headless has no tool stream (host paint only)
    const transportMode = String(
      process.env.GROKCODE_AGENT_TRANSPORT || cfg.agentTransport || 'auto'
    ).toLowerCase();
    if (_acpFallback || transportMode === 'headless') {
      const reason = _fallbackReason || (transportMode === 'headless' ? 'headless' : 'acp');
      // acp_build_403 kept as legacy alias of acp_stdio_403
      const fromAcpPath =
        reason === 'acp_stdio_403' ||
        reason === 'acp_build_403' ||
        reason === 'acp_auth' ||
        reason === 'acp_sticky' ||
        reason === 'acp_cold';
      const headlessDetail = fromAcpPath
        ? `已降级 headless · 文本可流 · 工具/Diff 写流不可用 · ${stickyReasonLabel(reason)}`
        : 'headless 传输 · 文本可流 · 无工具卡片';
      const st = getTransportState();
      emit('agent:phase', {
        taskId,
        phase: 'running',
        detail: headlessDetail,
        transport: 'headless',
        noToolStream: true,
        fallbackReason: reason,
        degrade: true,
        stickyHeadless: st.stickyHeadless,
        stickyReason: st.stickyReason || reason,
        stickyReasonLabel: stickyReasonLabel(st.stickyReason || reason),
        stickyMinutes: st.stickyMinutes,
      });
      emit('agent:status', {
        taskId,
        status: 'running',
        detail: headlessDetail,
        noToolStream: true,
        transport: 'headless',
        degrade: true,
        fallbackReason: reason,
      });
      emitTransportState({ taskId, activeRun: true, fallbackReason: reason });
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
      const t0Headless = Date.now();
      let firstTokenAtHl = 0;
      let textChunksHl = 0;
      let thoughtChunksHl = 0;
      let toolStartsHl = 0;
      let toolEndsHl = 0;
      let toolInProgressHl = 0;
      /** Updated by headless activity clock (parity with ACP). */
      let maxSilentSecHl = 0;
      let lastActivityAtHl = t0Headless;
      let waitTickTimerHl = null;
      /** Assigned before stdout handlers; may be null if spawn fails early. */
      let streamState = null;

      const noteFirstTokenHl = () => {
        if (!firstTokenAtHl) {
          firstTokenAtHl = Date.now();
          lastActivityAtHl = firstTokenAtHl;
        } else {
          lastActivityAtHl = Date.now();
        }
      };

      const clearWaitTickHl = () => {
        if (waitTickTimerHl) {
          clearInterval(waitTickTimerHl);
          waitTickTimerHl = null;
        }
      };

      /** Anti-black-box: 等待模型首包 / 段间静默 — headless was missing this (91s blank). */
      const startActivityClockHl = () => {
        clearWaitTickHl();
        lastActivityAtHl = Date.now();
        waitTickTimerHl = setInterval(() => {
          if (settled) {
            clearWaitTickHl();
            return;
          }
          const silentSec = Math.max(
            0,
            Math.floor((Date.now() - lastActivityAtHl) / 1000)
          );
          if (silentSec > maxSilentSecHl) maxSilentSecHl = silentSec;
          const totalSec = Math.max(0, Math.floor((Date.now() - t0Headless) / 1000));
          if (!firstTokenAtHl) {
            // Honest: often 60–90s of ZERO stdout under xhigh before thought/text burst
            const eff = String(cfg.reasoningEffort || '').trim() || 'default';
            setPhase(
              'running',
              `CLI 静默 ${silentSec}s · 模型多半在服务端推理（effort=${eff}）· 尚未推送 NDJSON · headless · 总 ${totalSec}s`
            );
          } else if (toolDepth > 0) {
            setPhase(
              'tool',
              `工具执行中 ×${toolDepth} · 已静默 ${silentSec}s · 总 ${totalSec}s`
            );
          } else if (silentSec >= 2) {
            setPhase(
              'running',
              `CLI 段间静默 ${silentSec}s · 等待下一 chunk · headless · 总 ${totalSec}s`
            );
          }
        }, 500);
      };

      /** ACP-shaped summary object for agent:done + mission bar (transport=headless). */
      const buildHeadlessStreamSummary = (extra = {}) => {
        const totalMs = Date.now() - t0Headless;
        const firstMs = firstTokenAtHl ? firstTokenAtHl - t0Headless : -1;
        return {
          transport: 'headless',
          firstTokenMs: firstMs,
          totalMs,
          textChunks: textChunksHl,
          thoughtChunks: thoughtChunksHl,
          toolStarts: toolStartsHl,
          toolEnds: toolEndsHl,
          toolInProgress: toolInProgressHl,
          maxSilentSec: maxSilentSecHl,
          finalTextLen: finalText.length,
          thoughtLen: thoughtText.length,
          openTools: streamState?.openTools?.size || 0,
          emptyToolsOnly: finalText.length === 0 && toolStartsHl > 0 ? 1 : 0,
          ...extra,
        };
      };

      const logHeadlessStreamSummary = (extra = {}) => {
        const sum = buildHeadlessStreamSummary(extra);
        const parts = [
          `=== STREAM_SUMMARY task=${taskId}`,
          `transport=${sum.transport}`,
          `firstTokenMs=${sum.firstTokenMs}`,
          `totalMs=${sum.totalMs}`,
          `textChunks=${sum.textChunks}`,
          `thoughtChunks=${sum.thoughtChunks}`,
          `toolStarts=${sum.toolStarts}`,
          `toolEnds=${sum.toolEnds}`,
          `toolInProgress=${sum.toolInProgress}`,
          `maxSilentSec=${sum.maxSilentSec}`,
          `finalTextLen=${sum.finalTextLen}`,
          `thoughtLen=${sum.thoughtLen}`,
          `openTools=${sum.openTools}`,
        ];
        for (const [k, v] of Object.entries(extra)) {
          if (v != null && v !== '') parts.push(`${k}=${v}`);
        }
        streamDebug(parts.join(' '), { force: true });
        try {
          if (typeof reportStreamTelemetry === 'function') {
            const cfgNow = getConfig() || {};
            if (cfgNow.telemetryEnabled) {
              reportStreamTelemetry({
                transport: 'headless',
                firstTokenMs: sum.firstTokenMs,
                toolStarts: toolStartsHl,
                toolEnds: toolEndsHl,
                maxSilentSec: maxSilentSecHl,
                emptyToolsOnly: sum.emptyToolsOnly,
                stopReason: extra.stopReason || 'unknown',
                totalMs: sum.totalMs,
                textChunks: textChunksHl,
                thoughtChunks: thoughtChunksHl,
                code: extra.code,
              });
            }
          }
        } catch {
          /* ignore */
        }
        return sum;
      };

      const cleanup = () => {
        clearWaitTickHl();
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
       * Headless stream path: ALWAYS immediate IPC (no 16ms last-write-wins).
       * CLI often dumps many NDJSON lines in one pipe read; coalesce collapsed
       * that into a single "wait then full dump" paint. Tools still flush via emitT.
       */
      const streamIpcHl = createStreamIpcCoalesce(
        (channel, payload) => emitT(channel, payload),
        { intervalMs: 0 }
      );
      const emitTextStream = (payload, _immediate = true) =>
        streamIpcHl.emitText(payload, true);
      const emitThoughtStream = (payload, _immediate = true) =>
        streamIpcHl.emitThought(payload, true);
      const flushStreamIpc = () => streamIpcHl.flush();

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
        try {
          flushStreamIpc();
          if (finalText) {
            emitTextStream({ text: finalText, delta: '', partial: false }, true);
          }
        } catch {
          /* ignore */
        }
        try {
          logHeadlessStreamSummary({ stopReason: 'error', code: 1 });
        } catch {
          /* ignore */
        }
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
        const streamSummary = logHeadlessStreamSummary({
          stopReason: 'user_stop',
          code: 0,
        });
        emitT('agent:done', {
          text: finalText,
          sessionId: newSessionId,
          stopped: true,
          thought: thoughtText || undefined,
          usage,
          streamSummary,
        });
        setPhase('stopped', '已停止');
        finish({
          text: finalText,
          stopped: true,
          sessionId: newSessionId,
          taskId,
          usage,
          thought: thoughtText || undefined,
          streamSummary,
          transport: 'headless',
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
      streamDebug(`task=${taskId} listening stdout/stderr log=${STREAM_DEBUG_PATH}`, {
        force: true,
      });
      {
        const eff = String(cfg.reasoningEffort || '').trim() || 'default';
        setPhase(
          'running',
          _acpFallback
            ? `headless 已启动 · CLI 尚未推送 NDJSON（effort=${eff}，xhigh 常见 60–90s 静默后爆发）…`
            : `CLI 已启动 · 等待首包 NDJSON（effort=${eff}）…`
        );
      }
      startActivityClockHl();
      try {
        child.stdout.setEncoding('utf8');
      } catch {
        /* ignore */
      }

      /** Pure reducer state (agent-stream.js) — mirrors finalText/thoughtText locals. */
      streamState = createStreamState({ sessionId: newSessionId });

      /** @returns {boolean} true if this action emitted text/thought (need event-loop yield) */
      const applyStreamActions = (actions) => {
        let needYield = false;
        for (const a of actions) {
          if (a.op === 'flush') {
            flushStreamIpc();
          } else if (a.op === 'phase') {
            setPhase(a.phase, a.detail);
          } else if (a.op === 'emit') {
            if (a.channel === 'agent:text') {
              textChunksHl += 1;
              noteFirstTokenHl();
              emitTextStream(a.payload, true);
              needYield = true;
            } else if (a.channel === 'agent:thought') {
              thoughtChunksHl += 1;
              noteFirstTokenHl();
              emitThoughtStream(a.payload, true);
              needYield = true;
            } else {
              if (a.channel === 'agent:tool_start') {
                if (a.payload?.progress) {
                  toolInProgressHl += 1;
                } else {
                  toolStartsHl += 1;
                  noteFirstTokenHl();
                }
              }
              if (a.channel === 'agent:tool_end') toolEndsHl += 1;
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
        return needYield;
      };

      const handleEvent = (ev) => {
        const { actions } = reduceHeadlessEvent(streamState, ev);
        return applyStreamActions(actions);
      };

      let lineSeq = 0;
      let chunkSeq = 0;
      let recognized = 0;
      let unrecognized = 0;
      let nonJson = 0;
      /** Async line queue — yield so renderer can paint between NDJSON lines */
      const lineQueue = [];
      let lineDrainRunning = false;

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
        if (parsed.kind === 'empty') return false;
        lineSeq += 1;
        if (parsed.kind === 'non_json') {
          nonJson += 1;
          streamDebug(
            `task=${taskId} line#${lineSeq} NON_JSON len=${parsed.text.length} raw=${parsed.text.slice(0, 200)}`
          );
          const { actions } = reduceNonJsonLine(streamState, parsed.text);
          return applyStreamActions(actions);
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
        return handleEvent(parsed.event);
      };

      const yieldLoop = () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        });

      const drainLineQueue = async () => {
        if (lineDrainRunning) return;
        lineDrainRunning = true;
        try {
          while (lineQueue.length && !settled) {
            const line = lineQueue.shift();
            const needYield = consumeLine(line);
            // Let Electron deliver agent:text/thought and renderer paint
            if (needYield) await yieldLoop();
            // Even non-stream lines: yield every 8 so close-handler isn't starved
            else if (lineSeq % 8 === 0) await yieldLoop();
          }
        } finally {
          lineDrainRunning = false;
          if (lineQueue.length && !settled) {
            setImmediate(() => {
              drainLineQueue().catch(() => {});
            });
          }
        }
      };

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
          lineQueue.push(line);
        }
        drainLineQueue().catch((err) => {
          streamDebug(`task=${taskId} line-drain err=${err?.message || err}`, {
            force: true,
          });
        });
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
        // Wait until async line drain finishes so last tokens paint before done
        const finishClose = async () => {
          // Push any trailing unterminated buffer
          if (stdoutBuf.trim()) {
            streamDebug(
              `task=${taskId} flush-pending-buf len=${stdoutBuf.length} head=${stdoutBuf.slice(0, 200).replace(/\s+/g, ' ')}`
            );
            lineQueue.push(stdoutBuf);
            stdoutBuf = '';
          }
          // Drain remaining lines (bounded wait)
          const tDrain0 = Date.now();
          while ((lineQueue.length || lineDrainRunning) && Date.now() - tDrain0 < 15_000) {
            if (lineQueue.length && !lineDrainRunning) {
              await drainLineQueue();
            } else {
              await yieldLoop();
            }
          }
          streamDebug(
            `=== RUN end task=${taskId} code=${code} lines=${lineSeq} chunks=${chunkSeq} known=${recognized} unknown=${unrecognized} nonJson=${nonJson} finalTextLen=${finalText.length} thoughtLen=${thoughtText.length} pendingBuf=${stdoutBuf.length}`,
            { force: true }
          );
          if (settled) return;
          onHeadlessClose(code);
        };
        finishClose().catch((err) => {
          streamDebug(`task=${taskId} close-drain err=${err?.message || err}`, {
            force: true,
          });
          if (!settled) onHeadlessClose(code);
        });
      });

      const onHeadlessClose = (code) => {
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
          const streamSummary = logHeadlessStreamSummary({
            stopReason: 'user_stop',
            code: 0,
          });
          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            stopped: true,
            thought: thoughtText || undefined,
            usage,
            streamSummary,
          });
          setPhase('stopped', '已停止');
          finish({
            text: finalText,
            stopped: true,
            sessionId: newSessionId,
            taskId,
            usage,
            thought: thoughtText || undefined,
            streamSummary,
            transport: 'headless',
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
            const streamSummary = logHeadlessStreamSummary({
              stopReason: 'forced_kill',
              code: exitCode,
            });
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              warning: errMsg,
              usage,
              thought: thoughtText || undefined,
              streamSummary,
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
              streamSummary,
              transport: 'headless',
            });
            return;
          }
          flushStreamIpc();
          {
            const streamSummary = logHeadlessStreamSummary({
              stopReason: stopReason || 'exit_nonzero',
              code: exitCode,
            });
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              code: exitCode,
              warning: errMsg,
              usage,
              stopReason,
              numTurns,
              thought: thoughtText || undefined,
              streamSummary,
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
              streamSummary,
              transport: 'headless',
            });
          }
          return;
        }

        flushStreamIpc();
        if (finalText) {
          emitTextStream({ text: finalText, delta: '', partial: false }, true);
        }
        {
          const streamSummary = logHeadlessStreamSummary({
            stopReason: stopReason || 'end',
            code: 0,
          });
          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            thought: thoughtText || undefined,
            usage,
            stopReason,
            numTurns,
            streamSummary,
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
            streamSummary,
            transport: 'headless',
          });
        }
      };
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
    interactiveParks.delete(String(taskId));
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
    interactiveParks.delete(String(taskId));
    const r = c.resolveInteractive(requestId, body || { cancelled: true });
    streamDebug(
      `task=${taskId} permission reply req=${requestId} outcome=${r.outcome || '?'} sel=${r.selected || '-'} remembered=${r.remembered ? 1 : 0} ok=${r.ok ? 1 : 0}`,
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
    interactiveParks.delete(String(taskId));
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
    getTransportState,
    clearStickyHeadless,
    armStickyHeadless,
  };
}

function getStreamDebugPath() {
  return STREAM_DEBUG_PATH;
}

module.exports = {
  createAgent,
  humanizeAgentError,
  isAuthRequiredBlob,
  isAcpStdio403Blob,
  getStreamDebugPath,
  STREAM_DEBUG_PATH,
};
