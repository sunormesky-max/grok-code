/**
 * Pure multi-task stream fairness scheduler (no DOM).
 * Mirrors StreamFair tick ordering: active first, then longest-waiting.
 *
 * Browser: window.GrokStreamScheduler
 * Node tests: module.exports
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) root.GrokStreamScheduler = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = Object.freeze({
    ACTIVE_MS: 0,
    BG_MS: 100,
    MAX_PAINT_PER_TICK: 4,
  });

  /**
   * @typedef {{ id: string, streamDirty?: boolean, thoughtDirty?: boolean, lastStream?: number, lastThought?: number, running?: boolean }} QueueEntry
   */

  /**
   * Sort entries: active task first, then oldest lastStream/lastThought among dirty.
   * @param {QueueEntry[]} entries
   * @param {string|null} activeId
   */
  function sortFair(entries, activeId) {
    return [...entries].sort((a, b) => {
      const aA = a.id === activeId ? 0 : 1;
      const bA = b.id === activeId ? 0 : 1;
      if (aA !== bA) return aA - bA;
      const aWait = Math.min(
        a.streamDirty ? (a.lastStream ?? 0) : Infinity,
        a.thoughtDirty ? (a.lastThought ?? 0) : Infinity
      );
      const bWait = Math.min(
        b.streamDirty ? (b.lastStream ?? 0) : Infinity,
        b.thoughtDirty ? (b.lastThought ?? 0) : Infinity
      );
      return aWait - bWait;
    });
  }

  /**
   * Decide which dirty entries paint this tick.
   * @param {QueueEntry[]} entries
   * @param {{ activeId?: string|null, now?: number, ACTIVE_MS?: number, BG_MS?: number, MAX_PAINT_PER_TICK?: number }} opts
   * @returns {{ paint: { id: string, kind: 'stream'|'thought' }[], needMore: boolean, drop: string[] }}
   */
  function planTick(entries, opts = {}) {
    const activeId = opts.activeId || null;
    const now = opts.now != null ? opts.now : 0;
    const ACTIVE_MS = opts.ACTIVE_MS != null ? opts.ACTIVE_MS : DEFAULTS.ACTIVE_MS;
    const BG_MS = opts.BG_MS != null ? opts.BG_MS : DEFAULTS.BG_MS;
    const MAX = opts.MAX_PAINT_PER_TICK != null ? opts.MAX_PAINT_PER_TICK : DEFAULTS.MAX_PAINT_PER_TICK;

    const ordered = sortFair(entries, activeId);
    const paint = [];
    const drop = [];
    let painted = 0;
    let needMore = false;

    for (const e of ordered) {
      if (!e.streamDirty && !e.thoughtDirty) {
        if (!e.running) drop.push(e.id);
        continue;
      }
      if (!e.running && !e.streamDirty && !e.thoughtDirty) {
        drop.push(e.id);
        continue;
      }
      const active = e.id === activeId;
      const minMs = active ? ACTIVE_MS : BG_MS;

      if (e.streamDirty) {
        const last = e.lastStream ?? 0;
        if (now - last < minMs) {
          needMore = true;
        } else if (painted < MAX || active) {
          paint.push({ id: e.id, kind: 'stream' });
          painted += 1;
        } else {
          needMore = true;
        }
      }

      if (e.thoughtDirty) {
        const last = e.lastThought ?? 0;
        if (now - last < minMs) {
          needMore = true;
        } else if (painted < MAX + (active ? 1 : 0) || active) {
          paint.push({ id: e.id, kind: 'thought' });
          painted += 1;
        } else {
          needMore = true;
        }
      }
    }

    return { paint, needMore, drop };
  }

  /**
   * Simulate N ticks with synthetic time — for multi-task fairness tests.
   * @param {QueueEntry[]} initial
   * @param {{ activeId: string, steps: number, stepMs?: number, ACTIVE_MS?: number, BG_MS?: number }} opts
   */
  function simulateFairness(initial, opts) {
    const stepMs = opts.stepMs != null ? opts.stepMs : 16;
    let entries = initial.map((e) => ({ ...e }));
    const history = [];
    let now = 0;
    for (let i = 0; i < opts.steps; i += 1) {
      now += stepMs;
      const plan = planTick(entries, {
        activeId: opts.activeId,
        now,
        ACTIVE_MS: opts.ACTIVE_MS,
        BG_MS: opts.BG_MS,
        MAX_PAINT_PER_TICK: opts.MAX_PAINT_PER_TICK,
      });
      history.push({ now, paint: plan.paint.map((p) => p.id + ':' + p.kind) });
      // Apply paints: clear dirty + update last*
      const painted = new Set(plan.paint.map((p) => p.id + ':' + p.kind));
      entries = entries
        .filter((e) => !plan.drop.includes(e.id))
        .map((e) => {
          const next = { ...e };
          if (painted.has(e.id + ':stream')) {
            next.streamDirty = false;
            next.lastStream = now;
          }
          if (painted.has(e.id + ':thought')) {
            next.thoughtDirty = false;
            next.lastThought = now;
          }
          return next;
        });
    }
    return { history, entries };
  }

  return {
    DEFAULTS,
    sortFair,
    planTick,
    simulateFairness,
  };
});
