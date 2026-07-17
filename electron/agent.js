const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGrokBinary } = require('./grok-cli');
const {
  AcpClient,
  pickToolInfo,
  pickChunkText,
  pickToolResultText,
} = require('./acp-client');

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
   * Headless streaming-json is text/thought/end only (no tool progress) and is
   * kept as emergency fallback (GROKCODE_AGENT_TRANSPORT=headless).
   */
  async function run(opts) {
    const transport = String(process.env.GROKCODE_AGENT_TRANSPORT || 'acp').toLowerCase();
    if (transport === 'headless' || transport === 'streaming-json') {
      return runHeadless(opts);
    }
    try {
      return await runAcp(opts);
    } catch (err) {
      const msg = err?.message || String(err);
      // Do not silently fall back mid-run after tools already started — only cold start failures
      if (err?.code === 'ACP_FALLBACK' || /ENOENT|spawn |initialize|not writable|找不到 Grok/i.test(msg)) {
        streamDebug(`ACP unavailable → headless fallback: ${msg}`, { force: true });
        return runHeadless({ ...opts, _acpFallback: true });
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

    const emitT = (event, payload) => emit(event, { ...payload, taskId });
    emitT('agent:phase', {
      phase: 'boot',
      detail: sessionId ? 'ACP resuming…' : 'ACP booting…',
    });
    emitT('agent:status', {
      status: 'boot',
      detail: sessionId ? 'ACP resuming…' : 'ACP booting…',
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
      /** @type {Set<string>} */
      const openTools = new Set();

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

      const cleanup = () => {
        if (signal) signal.removeEventListener?.('abort', onAbort);
        const child = children.get(taskId);
        if (child && child.__acpClient) {
          children.delete(taskId);
        }
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        intentionalStops.delete(String(taskId));
        cleanup();
        try {
          client.kill();
        } catch {
          /* ignore */
        }
        resolve(result);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        intentionalStops.delete(String(taskId));
        cleanup();
        try {
          client.kill();
        } catch {
          /* ignore */
        }
        emitT('agent:error', { error: err.message || String(err) });
        reject(err);
      };

      const client = new AcpClient({
        bin: grokBin,
        args: acpArgs,
        env,
        autoApprove: alwaysApprove,
        onUpdate: (update) => {
          if (!update || settled) return;
          const kind = String(update.sessionUpdate || update.type || '');

          if (kind === 'agent_message_chunk' || kind === 'agent_message') {
            const chunk = pickChunkText(update);
            if (chunk) finalText += chunk;
            emitTextStream({
              text: finalText,
              delta: chunk || '',
              partial: true,
              phase: 'streaming',
            });
            if (toolDepth <= 0) setPhase('streaming', 'speaking…');
          } else if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
            const chunk = pickChunkText(update);
            if (chunk) thoughtText += chunk;
            emitThoughtStream({
              text: thoughtText,
              delta: chunk || '',
              phase: 'thinking',
            });
            if (toolDepth <= 0) setPhase('thinking', 'thinking…');
          } else if (kind === 'tool_call') {
            flushStreamIpc();
            const info = pickToolInfo(update);
            if (!openTools.has(info.id)) {
              openTools.add(info.id);
              toolDepth += 1;
              emitT('agent:tool_start', {
                id: info.id,
                name: info.name,
                args: info.args,
              });
              setPhase('tool', `${info.name}…`);
              streamDebug(
                `task=${taskId} acp tool_call name=${info.name} id=${info.id}`,
                { force: true }
              );
            }
          } else if (kind === 'tool_call_update') {
            const info = pickToolInfo(update);
            const status = String(update.status || '').toLowerCase();
            // Mid-flight updates (title/locations) — keep phase, don't double-start
            if (!openTools.has(info.id) && status !== 'completed' && status !== 'failed') {
              openTools.add(info.id);
              toolDepth += 1;
              emitT('agent:tool_start', {
                id: info.id,
                name: info.name,
                args: info.args,
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
                args: info.args,
                result: pickToolResultText(update),
                ok: status === 'completed',
              });
              if (toolDepth <= 0 && finalText) setPhase('streaming', 'speaking…');
              else if (toolDepth <= 0) setPhase('running', 'working…');
            }
          } else if (kind === 'user_message_chunk') {
            /* echo of our prompt — ignore */
          }
        },
        onStderr: (s) => {
          streamDebug(`task=${taskId} acp-stderr ${String(s).slice(0, 200)}`);
        },
        onExit: () => {
          children.delete(taskId);
        },
      });

      // Track as child so stop() can kill it
      client.start();
      if (client.child) {
        client.child.__acpClient = client;
        children.set(taskId, client.child);
        if (client.pid) trackedPids.add(client.pid);
      }
      // session id filled after new/load — stop() cancel uses it when present

      streamDebug(
        `=== RUN start task=${taskId} transport=acp pid=${client.pid || '?'} cwd=${cwd} resume=${sessionId || '-'} bin=${grokBin}`,
        { force: true }
      );
      streamDebug(`task=${taskId} acp-args=${acpArgs.join(' ')}`, { force: true });

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
            finish({
              text: finalText,
              stopped: true,
              sessionId: newSessionId,
              taskId,
              usage,
              thought: thoughtText || undefined,
              transport: 'acp',
            });
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
          await client.initialize();
          setPhase('boot', 'session…');

          const meta = {};
          if (rules) meta.rules = String(rules);
          // maxTurns is headless-only on CLI; pass as meta hint if supported
          if (maxTurns) meta.maxTurns = Number(maxTurns);

          let sess;
          if (sessionId) {
            try {
              sess = await client.loadSession(sessionId, cwd, meta);
            } catch (loadErr) {
              streamDebug(
                `task=${taskId} session/load failed: ${loadErr.message}; new session`,
                { force: true }
              );
              if (!_resumeRetried) {
                // one soft retry as new session
              }
              sess = await client.newSession(cwd, meta);
            }
          } else {
            sess = await client.newSession(cwd, meta);
          }

          newSessionId = sess?.sessionId || sess?.session_id || newSessionId;
          if (client.child) client.child.__acpSessionId = newSessionId;
          setPhase('running', 'prompt…');

          const result = await client.prompt(newSessionId, message);
          if (settled) return;

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
          if (usage && !usage.input_tokens && usage.inputTokens != null) {
            usage = {
              ...usage,
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
              cache_read_input_tokens: usage.cachedReadTokens,
              reasoning_tokens: usage.reasoningTokens,
            };
          }

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
            finish({
              text: finalText,
              stopped: true,
              sessionId: newSessionId,
              taskId,
              usage,
              thought: thoughtText || undefined,
              transport: 'acp',
            });
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
            `=== RUN end task=${taskId} transport=acp code=0 finalTextLen=${finalText.length} thoughtLen=${thoughtText.length}`,
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
          });
        } catch (err) {
          if (settled) return;
          if (takeIntentionalStop(taskId) || signal?.aborted) {
            flushStreamIpc();
            emitT('agent:done', {
              text: finalText,
              sessionId: newSessionId,
              stopped: true,
              thought: thoughtText || undefined,
              usage,
            });
            finish({
              text: finalText,
              stopped: true,
              sessionId: newSessionId,
              taskId,
              usage,
              thought: thoughtText || undefined,
              transport: 'acp',
            });
            return;
          }
          // Cold-start style failures → allow outer run() fallback
          const msg = err?.message || String(err);
          if (
            !finalText &&
            !thoughtText &&
            /initialize|ENOENT|spawn|not writable|timeout: initialize/i.test(msg)
          ) {
            settled = true;
            cleanup();
            try {
              client.kill();
            } catch {
              /* ignore */
            }
            const e = new Error(msg);
            e.code = 'ACP_FALLBACK';
            reject(e);
            return;
          }
          fail(err instanceof Error ? err : new Error(msg));
        }
      })();
    });
  }

  async function runHeadless({ message, sessionId = null, signal, taskId = 'default', _resumeRetried = false }) {
    const cfg = getConfig();
    const cwd = workspaceRoot;
    if (!cwd || !fs.existsSync(cwd)) {
      throw new Error('请先打开一个项目工作区');
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

      const pickChunk = (ev) => {
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
      };

      const handleEvent = (ev) => {
        if (!ev || typeof ev !== 'object') return;
        const type = String(ev.type || '').toLowerCase();

        // Session id may appear mid-stream
        if (ev.sessionId && typeof ev.sessionId === 'string') {
          newSessionId = ev.sessionId;
        }

        if (
          type === 'text' ||
          type === 'message' ||
          type === 'assistant' ||
          type === 'content' ||
          type === 'response_text' ||
          type === 'output_text'
        ) {
          const chunk = pickChunk(ev);
          // Accumulated full text from CLI
          if (
            typeof ev.text === 'string' &&
            ev.text.length > finalText.length &&
            !ev.data &&
            !ev.delta &&
            (ev.accumulated || ev.full)
          ) {
            finalText = ev.text;
          } else if (
            typeof ev.text === 'string' &&
            ev.text.length > finalText.length &&
            !ev.data &&
            !ev.delta
          ) {
            // Some builds send full text each time
            if (ev.text.startsWith(finalText)) finalText = ev.text;
            else if (chunk) finalText += chunk;
            else finalText = ev.text;
          } else if (chunk) {
            finalText += chunk;
          }
          emitTextStream({
            text: finalText,
            delta: chunk || '',
            partial: true,
            phase: 'streaming',
          });
          if (toolDepth <= 0) setPhase('streaming', 'speaking…');
        } else if (
          type === 'thought' ||
          type === 'reasoning' ||
          type === 'thinking' ||
          type === 'reasoning_text'
        ) {
          const chunk = pickChunk(ev);
          if (chunk) thoughtText += chunk;
          else if (typeof ev.text === 'string' && ev.text.length > thoughtText.length) {
            thoughtText = ev.text;
          }
          emitThoughtStream({
            text: thoughtText,
            delta: chunk || '',
            phase: 'thinking',
          });
          if (toolDepth <= 0) setPhase('thinking', 'thinking…');
        } else if (
          type === 'tool' ||
          type === 'tool_call' ||
          type === 'tool_start' ||
          type === 'tool_use' ||
          type === 'function_call'
        ) {
          // Flush stream before tool so chat order is correct
          flushStreamIpc();
          toolDepth += 1;
          const name = ev.name || ev.tool || ev.function?.name || 'tool';
          emitT('agent:tool_start', {
            id: ev.id || ev.tool_call_id || ev.call_id || `tool-${Date.now()}`,
            name,
            args: ev.args || ev.input || ev.function?.arguments || {},
          });
          setPhase('tool', `${name}…`);
        } else if (
          type === 'tool_result' ||
          type === 'tool_end' ||
          type === 'tool_result_end' ||
          type === 'function_result'
        ) {
          flushStreamIpc();
          toolDepth = Math.max(0, toolDepth - 1);
          emitT('agent:tool_end', {
            id: ev.id || ev.tool_call_id || ev.call_id || '',
            name: ev.name || ev.tool || 'tool',
            args: ev.args || {},
            result:
              typeof ev.result === 'string'
                ? ev.result
                : JSON.stringify(ev.result ?? ev.output ?? ''),
            ok: ev.ok !== false && ev.is_error !== true,
          });
          if (toolDepth <= 0 && finalText) setPhase('streaming', 'speaking…');
          else if (toolDepth <= 0) setPhase('running', 'working…');
        } else if (type === 'end' || type === 'result' || type === 'done') {
          if (ev.sessionId) newSessionId = ev.sessionId;
          if (ev.usage) usage = ev.usage;
          if (ev.stopReason) stopReason = ev.stopReason;
          if (typeof ev.num_turns === 'number') numTurns = ev.num_turns;
          if (typeof ev.numTurns === 'number') numTurns = ev.numTurns;
          if (typeof ev.text === 'string' && ev.text.length > finalText.length) {
            finalText = ev.text;
          }
          flushStreamIpc();
          if (finalText) {
            emitTextStream(
              { text: finalText, delta: '', partial: false },
              true
            );
          }
          if (usage) emitT('agent:usage', { usage, stopReason, numTurns, sessionId: newSessionId });
          setPhase('done', 'done');
        } else if (type === 'error') {
          flushStreamIpc();
          emitT('agent:error', { error: ev.message || ev.error || 'Grok CLI error' });
        } else if (type === 'max_turns_reached') {
          setPhase('max_turns', 'max turns');
        } else if (type === 'status' && ev.status) {
          setPhase(String(ev.status), ev.detail || ev.message || String(ev.status));
        }
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

      const isKnownType = (type) =>
        [
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
        ].includes(type);

      const consumeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        lineSeq += 1;
        try {
          const ev = JSON.parse(trimmed);
          const type = String(ev?.type || '').toLowerCase();
          const known = isKnownType(type);
          if (known) recognized += 1;
          else unrecognized += 1;
          streamDebug(
            `task=${taskId} line#${lineSeq} ${summarizeEvent(ev, known)}${
              !known ? ` raw=${trimmed.slice(0, 240)}` : ''
            }`
          );
          handleEvent(ev);
        } catch {
          nonJson += 1;
          streamDebug(
            `task=${taskId} line#${lineSeq} NON_JSON len=${trimmed.length} raw=${trimmed.slice(0, 200)}`
          );
          // Non-JSON fallback: treat as plain text stream
          finalText += (finalText && !finalText.endsWith('\n') ? '\n' : '') + trimmed;
          emitTextStream({ text: finalText, delta: trimmed, partial: true });
          setPhase('streaming', 'speaking…');
        }
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

  return { run, stop, isRunning, listRunning, listTrackedPids, reapTracked };
}

module.exports = { createAgent };
