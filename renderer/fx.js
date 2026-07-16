/**
 * Visual FX intensity — normal | high
 * body.fx-high amplifies flight-deck glow (visual-impact-2.css)
 */
(function (global) {
  const KEY = 'grokcode-fx-intensity';
  const MODES = ['normal', 'high'];

  function getFx() {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v) ? v : 'normal';
    } catch {
      return 'normal';
    }
  }

  function setFx(mode) {
    const m = MODES.includes(mode) ? mode : 'normal';
    document.body.classList.remove('fx-normal', 'fx-high');
    document.body.classList.add(m === 'high' ? 'fx-high' : 'fx-normal');
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
    global.dispatchEvent(new CustomEvent('grok:fx', { detail: { fx: m } }));
    return m;
  }

  function toggleFx() {
    return setFx(getFx() === 'high' ? 'normal' : 'high');
  }

  function init() {
    setFx(getFx());
  }

  global.GrokFx = { getFx, setFx, toggleFx, init, MODES };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
