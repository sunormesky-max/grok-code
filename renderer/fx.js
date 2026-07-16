/**
 * Visual FX intensity + reduced-motion preference
 * - body.fx-high — amplifies glows (visual-impact-2/3)
 * - body.force-reduced-motion — kills decorative animation
 */
(function (global) {
  const FX_KEY = 'grokcode-fx-intensity';
  const MOTION_KEY = 'grokcode-reduce-motion';
  const FX_MODES = ['normal', 'high'];

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
    return v;
  }

  function toggleReduceMotion() {
    return setReduceMotion(!getReduceMotion());
  }

  function init() {
    setFx(getFx());
    setReduceMotion(getReduceMotion());
  }

  global.GrokFx = {
    getFx,
    setFx,
    toggleFx,
    getReduceMotion,
    setReduceMotion,
    toggleReduceMotion,
    init,
    MODES: FX_MODES,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
