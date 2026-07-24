/**
 * Stream gate — hold / quiet / answer for mid-turn narration.
 * Inspired by OpenWorker streamGate (§33): short pre-tool narration stays
 * off the main bubble; mid-tool chatter is a quiet line; full answers promote.
 *
 * Pure helpers — no DOM. Dual-export for unit tests (Node) + browser.
 */
(function (global) {
  /** ~1–2s of English stream; CJK uses char threshold below. */
  const STREAM_PROMOTE_WORDS = 40;
  /** Chinese / dense text: promote sooner by character count. */
  const STREAM_PROMOTE_CHARS = 80;

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
   * @returns {'none'|'hold'|'quiet'|'answer'}
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
    return midTurn(ctx || {}) ? 'quiet' : 'hold';
  }

  /**
   * What to put in the assistant bubble while streaming.
   * hold → empty (spinner/role only); quiet → one-line preview; answer → full.
   * @param {string} streaming
   * @param {'none'|'hold'|'quiet'|'answer'} mode
   * @param {{ en?: boolean }} [opts]
   */
  function displayForMode(streaming, mode, opts) {
    const text = String(streaming || '');
    if (mode === 'none' || mode === 'hold') return '';
    if (mode === 'quiet') {
      const one = text.replace(/\s+/g, ' ').trim();
      const slice = one.length > 120 ? one.slice(0, 117) + '…' : one;
      const en = Boolean(opts && opts.en);
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
   * @returns {'none'|'hold'|'quiet'|'answer'}
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
