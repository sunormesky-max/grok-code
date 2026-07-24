/**
 * Accessibility helpers — focus trap, live announcements, modal focus restore
 */
(function (global) {
  let lastFocus = null;
  let trapCleanup = null;

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function ensureLiveRegions() {
    if (!$('#a11yLiveStatus')) {
      const el = document.createElement('div');
      el.id = 'a11yLiveStatus';
      el.className = 'sr-only';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      document.body.appendChild(el);
    }
    if (!$('#a11yLiveAssertive')) {
      const el = document.createElement('div');
      el.id = 'a11yLiveAssertive';
      el.className = 'sr-only';
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-live', 'assertive');
      el.setAttribute('aria-atomic', 'true');
      document.body.appendChild(el);
    }
    const toasts = $('#toasts');
    if (toasts && !toasts.getAttribute('aria-live')) {
      toasts.setAttribute('aria-live', 'polite');
      toasts.setAttribute('aria-relevant', 'additions');
    }
  }

  let lastPolite = '';
  let lastPoliteAt = 0;

  function announce(msg, { assertive = false, force = false } = {}) {
    ensureLiveRegions();
    const text = String(msg || '').trim().slice(0, 280);
    if (!text) return;
    // Throttle polite spam (phase clocks) unless force
    if (!assertive && !force) {
      const now = Date.now();
      if (text === lastPolite && now - lastPoliteAt < 1800) return;
      lastPolite = text;
      lastPoliteAt = now;
    }
    const el = assertive ? $('#a11yLiveAssertive') : $('#a11yLiveStatus');
    if (!el) return;
    // Clear then set so repeated same text still fires
    el.textContent = '';
    requestAnimationFrame(() => {
      el.textContent = text;
    });
  }

  function getFocusable(container) {
    if (!container) return [];
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...container.querySelectorAll(sel)].filter((el) => {
      if (el.closest('[hidden], .hidden')) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    });
  }

  function trapFocus(container) {
    releaseTrap();
    if (!container) return;
    lastFocus = document.activeElement;
    document.body.classList.add('a11y-modal-open');

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const list = getFocusable(container);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !container.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !container.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    trapCleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('a11y-modal-open');
      trapCleanup = null;
    };

    // Initial focus
    const prefer =
      container.querySelector('[data-a11y-autofocus], input:not([type="hidden"]), button.primary, button') ||
      getFocusable(container)[0];
    prefer?.focus?.();
  }

  function releaseTrap() {
    if (trapCleanup) trapCleanup();
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try {
        lastFocus.focus();
      } catch {
        /* ignore */
      }
    }
    lastFocus = null;
  }

  function enLocale() {
    return (
      document.documentElement.lang === 'en' ||
      global.GrokI18n?.getLocale?.() === 'en'
    );
  }

  function enhanceLandmarks() {
    const en = enLocale();
    const main = $('#app .main');
    if (main && !main.getAttribute('role')) main.setAttribute('role', 'main');
    const files = $('#filesPanel');
    if (files) {
      files.setAttribute('role', 'navigation');
      files.setAttribute('aria-label', en ? 'Explorer' : '文件树');
    }
    const chat = $('#chatPanel');
    if (chat) {
      chat.setAttribute('role', 'complementary');
      chat.setAttribute('aria-label', en ? 'Agent chat' : 'Agent 对话');
    }
    const center = document.querySelector('.center');
    if (center) {
      center.setAttribute('role', 'region');
      center.setAttribute('aria-label', en ? 'Workspace' : '工作区');
    }
    const messages = $('#messagesHost');
    if (messages) {
      messages.setAttribute('role', 'log');
      messages.setAttribute('aria-relevant', 'additions');
      messages.setAttribute('aria-live', 'polite');
      messages.setAttribute('aria-label', en ? 'Conversation' : '对话流');
    }
    const editorTabs = $('#editorTabs');
    if (editorTabs) {
      editorTabs.setAttribute('role', 'tablist');
      editorTabs.setAttribute('aria-label', en ? 'Live Code Diff' : 'Live · Code · Diff');
    }
    document.querySelectorAll('#editorTabs .tab[data-tab]').forEach((tab) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    });
    const modeBar = $('#modeBar');
    if (modeBar) {
      modeBar.setAttribute('role', 'toolbar');
      modeBar.setAttribute('aria-label', en ? 'CLI work mode' : 'CLI 工作模式');
    }
    const taskTabs = $('#taskTabs');
    if (taskTabs) {
      taskTabs.setAttribute('role', 'tablist');
      taskTabs.setAttribute('aria-label', en ? 'Tasks' : '任务');
    }
    const prompt = $('#prompt');
    if (prompt && !prompt.getAttribute('aria-label')) {
      prompt.setAttribute('aria-label', en ? 'Message to Grok' : '发给 Grok 的消息');
    }
    // Status bar chips often used as buttons
    const sbMode = $('#sbMode');
    if (sbMode) {
      sbMode.setAttribute('role', 'button');
      if (!sbMode.getAttribute('aria-label')) {
        sbMode.setAttribute(
          'aria-label',
          en ? 'CLI session mode — click to cycle' : 'CLI 会话模式 — 点击切换'
        );
      }
    }
  }

  /**
   * Arrow / Home / End roving focus inside a role=menu popup.
   * Call after menu is populated and shown.
   * @param {HTMLElement} menuEl
   * @param {{ focusFirst?: boolean }} [opts]
   */
  function bindMenuKeyboard(menuEl, opts = {}) {
    if (!menuEl || menuEl.dataset.a11yMenuBound === '1') {
      // Rebind key handler each open — remove old if any
      if (menuEl?._a11yMenuKey) {
        menuEl.removeEventListener('keydown', menuEl._a11yMenuKey);
      }
    }
    const items = () =>
      [...menuEl.querySelectorAll('button.model-menu-item, [role="menuitem"]')].filter(
        (el) => !el.disabled && el.offsetParent !== null
      );
    const onKey = (e) => {
      const list = items();
      if (!list.length) return;
      const idx = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = list[(idx < 0 ? 0 : idx + 1) % list.length];
        next?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = list[(idx <= 0 ? list.length : idx) - 1];
        prev?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        list[list.length - 1]?.focus();
      }
    };
    menuEl._a11yMenuKey = onKey;
    menuEl.addEventListener('keydown', onKey);
    menuEl.dataset.a11yMenuBound = '1';
    if (opts.focusFirst !== false) {
      const list = items();
      const active = list.find((b) => b.classList.contains('active')) || list[0];
      try {
        active?.focus?.();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Mark interactive overlay (plan approval / user question) and announce.
   * @param {HTMLElement} el
   * @param {string} label
   * @param {{ assertive?: boolean, focus?: boolean }} [opts]
   */
  function presentInteractive(el, label, opts = {}) {
    if (!el) return;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', String(label || 'Interaction'));
    el.setAttribute('tabindex', '-1');
    announce(label, { assertive: opts.assertive !== false, force: true });
    if (opts.focus !== false) {
      const btn =
        el.querySelector('button.primary, button[data-act="approve"], button[data-act="accept"], button') ||
        getFocusable(el)[0];
      try {
        btn?.focus?.();
      } catch {
        /* ignore */
      }
    }
  }

  function syncTabSelection() {
    document.querySelectorAll('#editorTabs .tab[data-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    });
  }

  function bindSkipLink() {
    const skip = document.querySelector('.skip-link');
    if (!skip) return;
    // Prefer composer / prompt over #app shell
    skip.setAttribute('href', '#prompt');
    skip.addEventListener('click', (e) => {
      const target = $('#prompt') || $('#app');
      if (!target) return;
      e.preventDefault();
      if (!target.hasAttribute('tabindex') && target.id === 'prompt') {
        /* textarea is focusable */
      } else if (target.id === 'app') {
        target.setAttribute('tabindex', '-1');
      }
      target.focus?.();
    });
  }

  function init() {
    ensureLiveRegions();
    enhanceLandmarks();
    bindSkipLink();
  }

  global.GrokA11y = {
    init,
    announce,
    trapFocus,
    releaseTrap,
    ensureLiveRegions,
    enhanceLandmarks,
    syncTabSelection,
    getFocusable,
    presentInteractive,
    bindMenuKeyboard,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
