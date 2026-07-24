/**
 * Theme packs — CSS token sets on body.theme-*
 * Community packs: ~/.grok-code/themes/*.json (loaded via main if needed)
 */
(function (global) {
  const THEMES = [
    { id: 'grok', nameKey: 'theme.grok', className: 'theme-grok' },
    { id: 'void', nameKey: 'theme.void', className: 'theme-void' },
    { id: 'mars', nameKey: 'theme.mars', className: 'theme-mars' },
    { id: 'ice', nameKey: 'theme.ice', className: 'theme-ice' },
    { id: 'ember', nameKey: 'theme.ember', className: 'theme-ember' },
    /** A11Y: solid black/white, high contrast borders, no glow glass */
    { id: 'hc', nameKey: 'theme.hc', className: 'theme-hc' },
    { id: 'hc-light', nameKey: 'theme.hcLight', className: 'theme-hc-light' },
  ];

  const KEY = 'grokcode-theme';
  /** Once-ever dismissal of prefers-contrast soft suggest */
  const SUGGEST_KEY = 'grokcode-theme-contrast-suggest';

  function getTheme() {
    try {
      return localStorage.getItem(KEY) || 'grok';
    } catch {
      return 'grok';
    }
  }

  function setTheme(id) {
    const theme = THEMES.find((t) => t.id === id) || THEMES[0];
    const body = document.body;
    THEMES.forEach((t) => body.classList.remove(t.className));
    body.classList.add(theme.className);
    try {
      localStorage.setItem(KEY, theme.id);
    } catch {
      /* ignore */
    }
    global.dispatchEvent(new CustomEvent('grok:theme', { detail: { theme: theme.id } }));
    return theme.id;
  }

  function list() {
    return THEMES.slice();
  }

  function isHighContrastTheme(id) {
    return id === 'hc' || id === 'hc-light';
  }

  /**
   * System prefers more contrast / forced colors (Windows HC, etc.).
   * @returns {boolean}
   */
  function prefersHighContrast() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
      return (
        window.matchMedia('(prefers-contrast: more)').matches ||
        window.matchMedia('(prefers-contrast: high)').matches ||
        window.matchMedia('(forced-colors: active)').matches
      );
    } catch {
      return false;
    }
  }

  function suggestDismissed() {
    try {
      return localStorage.getItem(SUGGEST_KEY) === '1';
    } catch {
      return false;
    }
  }

  function dismissContrastSuggest() {
    try {
      localStorage.setItem(SUGGEST_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  /**
   * Soft suggest HC theme when OS asks for contrast (never force).
   * @returns {{ ok: boolean, reason?: string, preferred?: string }}
   */
  function maybeSuggestHighContrast() {
    if (!prefersHighContrast()) return { ok: false, reason: 'no-pref' };
    const cur = getTheme();
    if (isHighContrastTheme(cur)) return { ok: false, reason: 'already-hc' };
    if (suggestDismissed()) return { ok: false, reason: 'dismissed' };
    // Prefer dark HC by default (most coding UIs dark)
    return { ok: true, preferred: 'hc' };
  }

  function applySuggestedHighContrast() {
    const id = setTheme('hc');
    dismissContrastSuggest();
    return id;
  }

  function init() {
    if (typeof document === 'undefined') return;
    setTheme(getTheme());
    // Soft suggest after UI/toast ready — never auto-switch
    const fire = () => {
      const s = maybeSuggestHighContrast();
      if (!s.ok) return;
      try {
        global.dispatchEvent(
          new CustomEvent('grok:theme-suggest-hc', { detail: s })
        );
      } catch {
        /* ignore */
      }
    };
    setTimeout(fire, 1400);
    // Re-check if user enables OS contrast while app is open
    try {
      const mq =
        window.matchMedia('(prefers-contrast: more)') ||
        window.matchMedia('(forced-colors: active)');
      mq?.addEventListener?.('change', (e) => {
        if (e.matches) fire();
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Apply a community theme pack (CSS variables object)
   * @param {{ id: string, name?: string, vars: Record<string,string> }} pack
   */
  function applyCustomPack(pack) {
    if (!pack?.vars) return;
    const root = document.documentElement;
    Object.entries(pack.vars).forEach(([k, v]) => {
      root.style.setProperty(k.startsWith('--') ? k : `--${k}`, v);
    });
    try {
      localStorage.setItem(KEY + '-custom', JSON.stringify(pack));
    } catch {
      /* ignore */
    }
  }

  global.GrokThemes = {
    list,
    getTheme,
    setTheme,
    init,
    applyCustomPack,
    THEMES,
    prefersHighContrast,
    maybeSuggestHighContrast,
    dismissContrastSuggest,
    applySuggestedHighContrast,
    isHighContrastTheme,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.GrokThemes;
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
