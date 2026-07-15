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
  ];

  const KEY = 'grokcode-theme';

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

  function init() {
    setTheme(getTheme());
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

  global.GrokThemes = { list, getTheme, setTheme, init, applyCustomPack, THEMES };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
