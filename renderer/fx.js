/**
 * Visual FX intensity + reduced-motion + cinematic idle ambient
 * - body.fx-high — amplifies glows (visual-impact-2/3)
 * - body.force-reduced-motion — kills decorative animation
 * - body.cinematic-idle — optional ambient layer (off by default)
 * - body.is-idle — set after ~12s without input (only while cinematic-idle on)
 */
(function (global) {
  const FX_KEY = 'grokcode-fx-intensity';
  const MOTION_KEY = 'grokcode-reduce-motion';
  const IDLE_KEY = 'grokcode-cinematic-idle';
  const FX_MODES = ['normal', 'high'];
  const IDLE_MS = 12000;

  let idleTimer = null;
  let idleBound = false;

  function getFx() {
    try {
      const v = localStorage.getItem(FX_KEY);
      return FX_MODES.includes(v) ? v : 'normal';
    } catch {
      return 'normal';
    }
  }

  function setFx(mode) {
    const m = FX_MODES.includes(mode) ? mode : 'normal';
    document.body.classList.remove('fx-normal', 'fx-high');
    document.body.classList.add(m === 'high' ? 'fx-high' : 'fx-normal');
    try {
      localStorage.setItem(FX_KEY, m);
    } catch {
      /* ignore */
    }
    global.dispatchEvent(new CustomEvent('grok:fx', { detail: { fx: m } }));
    return m;
  }

  function toggleFx() {
    return setFx(getFx() === 'high' ? 'normal' : 'high');
  }

  function getReduceMotion() {
    try {
      return localStorage.getItem(MOTION_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setReduceMotion(on) {
    const v = !!on;
    document.body.classList.toggle('force-reduced-motion', v);
    try {
      localStorage.setItem(MOTION_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
    global.dispatchEvent(new CustomEvent('grok:motion', { detail: { reduce: v } }));
    if (v) document.body.classList.remove('is-idle');
    return v;
  }

  function toggleReduceMotion() {
    return setReduceMotion(!getReduceMotion());
  }

  function getCinematicIdle() {
    try {
      return localStorage.getItem(IDLE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setCinematicIdle(on) {
    const v = !!on;
    document.body.classList.toggle('cinematic-idle', v);
    try {
      localStorage.setItem(IDLE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (v) {
      startIdleWatch();
      bumpActivity();
    } else {
      stopIdleWatch();
      document.body.classList.remove('is-idle');
    }
    global.dispatchEvent(new CustomEvent('grok:cinematic-idle', { detail: { on: v } }));
    return v;
  }

  function toggleCinematicIdle() {
    return setCinematicIdle(!getCinematicIdle());
  }

  function markIdle() {
    if (!getCinematicIdle() || getReduceMotion()) return;
    if (document.hidden) return;
    try {
      if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch {
      /* ignore */
    }
    document.body.classList.add('is-idle');
    global.dispatchEvent(new CustomEvent('grok:idle', { detail: { idle: true } }));
  }

  function bumpActivity() {
    if (!getCinematicIdle()) return;
    const was = document.body.classList.contains('is-idle');
    document.body.classList.remove('is-idle');
    if (was) {
      global.dispatchEvent(new CustomEvent('grok:idle', { detail: { idle: false } }));
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(markIdle, IDLE_MS);
  }

  function startIdleWatch() {
    if (idleBound) return;
    idleBound = true;
    const opts = { passive: true, capture: true };
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => {
      document.addEventListener(ev, bumpActivity, opts);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        document.body.classList.remove('is-idle');
      } else if (getCinematicIdle()) {
        bumpActivity();
      }
    });
  }

  function stopIdleWatch() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    /* listeners stay (cheap); bumpActivity no-ops when off */
  }

  function init() {
    setFx(getFx());
    setReduceMotion(getReduceMotion());
    setCinematicIdle(getCinematicIdle());
  }

  global.GrokFx = {
    getFx,
    setFx,
    toggleFx,
    getReduceMotion,
    setReduceMotion,
    toggleReduceMotion,
    getCinematicIdle,
    setCinematicIdle,
    toggleCinematicIdle,
    init,
    MODES: FX_MODES,
    IDLE_MS,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
