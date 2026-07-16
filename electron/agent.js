const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveGrokBinary } = require('./grok-cli');

/**
 * GrokCode multi-task agent
 * 每个 taskId 可并行跑一个 grok CLI 进程，互不抢占。
 */
function createAgent({ getConfig, workspaceRoot, emit }) {
  /** @type {Map<string, import('child_process').ChildProcess>} */
  const children = new Map();

  function killProc(child) {
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }

  function stop(taskId) {
    if (taskId) {
      const child = children.get(taskId);
      if (child) {
        killProc(child);
        children.delete(taskId);
      }
      return;
    }
    for (const [id, child] of children) {
      killProc(child);
      children.delete(id);
    }
  }

  function isRunning(taskId) {
    return children.has(taskId);
  }

  function listRunning() {
    return [...children.keys()];
  }

  async function run({ message, sessionId = null, signal, taskId = 'default', _resumeRetried = false }) {
    const cfg = getConfig();
    const cwd = workspaceRoot;
    if (!cwd || !fs.existsSync(cwd)) {
      throw new Error('请先打开一个项目工作区');
    }

    // 同一 task 不允许并发叠跑；新请求先停旧的
    if (children.has(taskId)) {
      stop(taskId);
    }

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
        cleanup();
        resolve(result);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
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

      const consumeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          handleEvent(JSON.parse(trimmed));
        } catch {
          // Non-JSON fallback: treat as plain text stream
          finalText += (finalText && !finalText.endsWith('\n') ? '\n' : '') + trimmed;
          emitT('agent:text', { text: finalText, delta: trimmed, partial: true });
          setPhase('streaming', 'speaking…');
        }
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.search(/\r?\n/)) >= 0) {
          const nl = stdoutBuf[idx] === '\r' && stdoutBuf[idx + 1] === '\n' ? 2 : 1;
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + nl);
          consumeLine(line);
        }
      });

      child.stderr.on('data', (buf) => {
        stderrBuf += buf.toString('utf8');
        if (stderrBuf.length > 40_000) stderrBuf = stderrBuf.slice(-40_000);
      });

      child.on('error', (err) => {
        fail(new Error(`Grok CLI 进程错误：${err.message}`));
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) consumeLine(stdoutBuf);
        stdoutBuf = '';
        if (settled) return;

        if (signal?.aborted) {
          finish({ text: finalText, stopped: true, sessionId: newSessionId, taskId, usage });
          return;
        }

        if (code !== 0 && code !== null) {
          let errMsg = `Grok CLI 退出码 ${code}`;
          const errLine = stderrBuf
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-5)
            .join('\n');
          try {
            const maybe = JSON.parse(
              (stderrBuf || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
            );
            if (maybe.message) errMsg = maybe.message;
            else if (errLine) errMsg = `${errMsg}\n${errLine}`;
          } catch {
            if (errLine) errMsg = `${errMsg}\n${errLine}`;
          }

          if (!finalText) {
            if (!isResumeError(errMsg)) {
              emitT('agent:error', { error: errMsg });
            }
            fail(new Error(errMsg));
            return;
          }
          emitT('agent:done', {
            text: finalText,
            sessionId: newSessionId,
            code,
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
            code,
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

  return { run, stop, isRunning, listRunning };
}

module.exports = { createAgent };
