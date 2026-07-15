/**
 * UI density — comfortable | compact
 */
(function (global) {
  const KEY = 'grokcode-density';
  const MODES = ['comfortable', 'compact'];

  function getDensity() {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v) ? v : 'comfortable';
    } catch {
      return 'comfortable';
    }
  }

  function setDensity(mode) {
    const m = MODES.includes(mode) ? mode : 'comfortable';
    document.body.classList.remove('density-comfortable', 'density-compact');
    document.body.classList.add(`density-${m}`);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
    global.dispatchEvent(new CustomEvent('grok:density', { detail: { density: m } }));
    return m;
  }

  function init() {
    setDensity(getDensity());
  }

  global.GrokDensity = { getDensity, setDensity, init, MODES };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
