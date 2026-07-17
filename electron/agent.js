const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGrokBinary } = require('./grok-cli');

/**
 * Temporary stream diagnostic log (diagnose black-box / event shapes).
 * File: %TEMP%\grokcode-stream.log  — remove after investigation.
 * Env GROKCODE_STREAM_DEBUG=0 disables.
 */
const STREAM_DEBUG =
  process.env.GROKCODE_STREAM_DEBUG !== '0' && process.env.GROKCODE_STREAM_DEBUG !== 'false';
const STREAM_DEBUG_PATH = path.join(os.tmpdir(), 'grokcode-stream.log');
const STREAM_DEBUG_MAX = 8_000_000; // ~8MB rotate truncate

function streamDebug(line) {
  if (!STREAM_DEBUG) return;
  try {
    const ts = new Date().toISOString();
    const row = `[${ts}] ${line}\n`;
    if (fs.existsSync(STREAM_DEBUG_PATH)) {
      const st = fs.statSync(STREAM_DEBUG_PATH);
      if (st.size > STREAM_DEBUG_MAX) {
        fs.writeFileSync(STREAM_DEBUG_PATH, `[${ts}] --- log rotated ---\n`);
      }
    }
    fs.appendFileSync(STREAM_DEBUG_PATH, row, 'utf8');
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
        killProc(child);
        children.delete(taskId);
      }
      return;
    }
    for (const [id, child] of children) {
      intentionalStops.add(String(id));
      killProc(child);
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

  async function run({ message, sessionId = null, signal, taskId = 'default', _resumeRetried = false }) {
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
        if (finalText) {
          emitT('agent:text', { text: finalText, delta: '', partial: false });
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
          emitT('agent:text', {
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
          emitT('agent:thought', {
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
            emitT('agent:text', { text: finalText, delta: '', partial: false });
          }
          if (usage) emitT('agent:usage', { usage, stopReason, numTurns, sessionId: newSessionId });
          setPhase('done', 'done');
        } else if (type === 'error') {
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
          emitT('agent:text', { text: finalText, delta: trimmed, partial: true });
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
          if (finalText) {
            emitT('agent:text', { text: finalText, delta: '', partial: false });
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

        if (finalText) {
          emitT('agent:text', { text: finalText, delta: '', partial: false });
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
