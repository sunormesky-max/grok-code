/**
 * Stream gate — quiet / answer for mid-turn narration (fail-open).
 *
 * Inspired by OpenWorker streamGate, but we deliberately refuse their
 * aggressive `hold` (blank bubble) path: that hides live text and feels like
 * a black box. Short pre-tool text stays a one-line quiet preview; anything
 * substantial promotes to full answer. Host presentation only — CLI owns tools.
 *
 * Pure helpers — no DOM. Dual-export for unit tests (Node) + browser.
 */
(function (global) {
  /** Promote full bubble sooner than OpenWorker (fail-open). */
  const STREAM_PROMOTE_WORDS = 24;
  /** Chinese / dense text: promote by character count. */
  const STREAM_PROMOTE_CHARS = 48;

  /**
   * @param {string} s
   * @returns {number} rough "word units" (whitespace words + CJK halves)
   */
  function streamUnits(s) {
    const t = String(s || '').trim();
    if (!t) return 0;
    const words = t.split(/\s+/).filter(Boolean).length;
    const cjk = (t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    if (cjk >= 8) return Math.max(words, Math.ceil(cjk / 2));
    return words;
  }

  /**
   * @param {{ running?: boolean, toolCount?: number, phase?: string, hasToolThisTurn?: boolean }} ctx
   */
  function midTurn(ctx) {
    if (!ctx || !ctx.running) return false;
    if (Number(ctx.toolCount) > 0) return true;
    if (ctx.hasToolThisTurn) return true;
    const phase = String(ctx.phase || '');
    return phase === 'tool' || phase === 'writing';
  }

  /**
   * @param {string} streaming
   * @param {{ running?: boolean, toolCount?: number, phase?: string, hasToolThisTurn?: boolean }} ctx
   * @returns {'none'|'quiet'|'answer'}
   *
   * Note: `hold` is intentionally not used (kept only as alias → quiet for
   * older callers). Blank hold was an OpenWorker-style footgun.
   */
  function streamMode(streaming, ctx) {
    const text = String(streaming || '');
    if (!text.trim()) return 'none';
    const running = Boolean(ctx && ctx.running);
    const units = streamUnits(text);
    const chars = text.trim().length;
    if (
      units >= STREAM_PROMOTE_WORDS ||
      chars >= STREAM_PROMOTE_CHARS ||
      !running
    ) {
      return 'answer';
    }
    // Short while running — always show a quiet line (never blank hold)
    return 'quiet';
  }

  /**
   * What to put in the assistant bubble while streaming.
   * none → empty; quiet → one-line preview; answer → full.
   * hold → treated as quiet (compat, not blank).
   * @param {string} streaming
   * @param {'none'|'hold'|'quiet'|'answer'} mode
   * @param {{ en?: boolean }} [opts]
   */
  function displayForMode(streaming, mode, opts) {
    const text = String(streaming || '');
    if (mode === 'none') return '';
    // Compat: never blank out live tokens (refuse OpenWorker-style hold)
    if (mode === 'hold' || mode === 'quiet') {
      const one = text.replace(/\s+/g, ' ').trim();
      const slice = one.length > 140 ? one.slice(0, 137) + '…' : one;
      const en = Boolean(opts && opts.en);
      if (!slice) return '';
      return en ? `Working… ${slice}` : `进行中… ${slice}`;
    }
    return text;
  }

  /**
   * Build ctx from a GrokCode task object.
   * @param {object|null|undefined} task
   */
  function ctxFromTask(task) {
    if (!task) return { running: false, toolCount: 0, phase: '' };
    return {
      running: Boolean(task.running),
      toolCount: Number(task.toolCount) || 0,
      phase: String(task.phase || ''),
      hasToolThisTurn: Boolean(task._hasToolThisTurn),
    };
  }

  /**
   * @param {object|null|undefined} task
   * @returns {'none'|'quiet'|'answer'}
   */
  function modeForTask(task) {
    return streamMode(task?.streamBuf || '', ctxFromTask(task));
  }

  const api = {
    STREAM_PROMOTE_WORDS,
    STREAM_PROMOTE_CHARS,
    streamUnits,
    midTurn,
    streamMode,
    displayForMode,
    ctxFromTask,
    modeForTask,
  };

  global.GrokStreamGate = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
