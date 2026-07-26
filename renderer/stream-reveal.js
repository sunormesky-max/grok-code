/**
 * Progressive reveal for stream text when host receives large jumps
 * (CLI burst / coalesce dump). Content is real — only paint timing is smoothed.
 * Pure helpers; dual-export for unit tests + browser.
 */
(function (global) {
  /**
   * How many characters to reveal this frame.
   * @param {number} remaining
   * @returns {number}
   */
  function stepForRemaining(remaining) {
    const r = Math.max(0, Number(remaining) || 0);
    if (r <= 0) return 0;
    if (r > 800) return 48;
    if (r > 400) return 28;
    if (r > 160) return 16;
    if (r > 60) return 10;
    if (r > 20) return 6;
    return Math.min(r, 3);
  }

  /**
   * Should we animate a jump from painted → target?
   * Small steps paint immediately; large jumps drip.
   * @param {number} paintedLen
   * @param {number} targetLen
   * @param {{ jumpMin?: number }} [opts]
   */
  function shouldReveal(paintedLen, targetLen, opts) {
    const jumpMin = opts && opts.jumpMin != null ? opts.jumpMin : 48;
    const p = Math.max(0, Number(paintedLen) || 0);
    const t = Math.max(0, Number(targetLen) || 0);
    return t - p >= jumpMin;
  }

  /**
   * Advance painted text toward target (prefix-safe).
   * @param {string} painted
   * @param {string} target
   * @returns {string}
   */
  function advanceReveal(painted, target) {
    const tgt = String(target || '');
    const prev = String(painted || '');
    if (!tgt) return '';
    // Target rewound or diverged — snap
    if (prev && !tgt.startsWith(prev) && !prev.startsWith(tgt)) {
      return tgt;
    }
    if (tgt.length <= prev.length) return tgt;
    const step = stepForRemaining(tgt.length - prev.length);
    return tgt.slice(0, prev.length + step);
  }

  /**
   * Per-task reveal controller (mutates task fields).
   * task._revealPainted, task._revealRaf, task.streamBuf (truth), task.thoughtBuf
   *
   * @param {object} task
   * @param {'text'|'thought'} kind
   * @param {string} fullTarget  full buffer (truth)
   * @param {(shown: string, streaming: boolean, task: object) => void} paint
   * @param {{ jumpMin?: number }} [opts]
   */
  const scheduleFrame =
    typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 16);
  const cancelFrame =
    typeof cancelAnimationFrame === 'function'
      ? (id) => cancelAnimationFrame(id)
      : (id) => clearTimeout(id);

  function revealTo(task, kind, fullTarget, paint, opts) {
    if (!task || typeof paint !== 'function') return;
    const target = String(fullTarget || '');
    const key = kind === 'thought' ? '_revealThought' : '_revealText';
    const rafKey = kind === 'thought' ? '_revealThoughtRaf' : '_revealTextRaf';

    // Truth always on task buffers (caller sets streamBuf/thoughtBuf)
    let painted = String(task[key] || '');
    // Tiny growth: paint immediately (real stream chunks)
    if (!shouldReveal(painted.length, target.length, opts)) {
      if (task[rafKey]) {
        cancelFrame(task[rafKey]);
        task[rafKey] = 0;
      }
      task[key] = target;
      paint(target, true, task);
      return;
    }
    // Large jump with no painted yet: start from '' and animate (burst dump)
    if (!painted) {
      painted = '';
      task[key] = '';
    }

    // Large jump: animate from current painted toward target
    if (!target.startsWith(painted) && painted.length > 0) {
      // Diverged — restart from common prefix or snap start
      let i = 0;
      const lim = Math.min(painted.length, target.length);
      while (i < lim && painted[i] === target[i]) i += 1;
      painted = target.slice(0, i);
      task[key] = painted;
    }

    const tick = () => {
      task[rafKey] = 0;
      const tgt = kind === 'thought' ? String(task.thoughtBuf || '') : String(task.streamBuf || '');
      let shown = String(task[key] || '');
      if (!tgt) {
        task[key] = '';
        paint('', true, task);
        return;
      }
      if (shown === tgt) {
        paint(shown, true, task);
        return;
      }
      shown = advanceReveal(shown, tgt);
      task[key] = shown;
      paint(shown, true, task);
      if (shown !== tgt) {
        task[rafKey] = scheduleFrame(tick);
      }
    };

    if (!task[rafKey]) {
      task[rafKey] = scheduleFrame(tick);
    }
  }

  /**
   * Snap reveal to full (on done / stop).
   * @param {object} task
   * @param {'text'|'thought'|'both'} [which]
   */
  function snapReveal(task, which = 'both') {
    if (!task) return;
    if (which === 'text' || which === 'both') {
      if (task._revealTextRaf) {
        cancelFrame(task._revealTextRaf);
        task._revealTextRaf = 0;
      }
      task._revealText = String(task.streamBuf || '');
    }
    if (which === 'thought' || which === 'both') {
      if (task._revealThoughtRaf) {
        cancelFrame(task._revealThoughtRaf);
        task._revealThoughtRaf = 0;
      }
      task._revealThought = String(task.thoughtBuf || '');
    }
  }

  const api = {
    stepForRemaining,
    shouldReveal,
    advanceReveal,
    revealTo,
    snapReveal,
  };

  global.GrokStreamReveal = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
