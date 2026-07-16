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

  function announce(msg, { assertive = false } = {}) {
    ensureLiveRegions();
    const el = assertive ? $('#a11yLiveAssertive') : $('#a11yLiveStatus');
    if (!el) return;
    // Clear then set so repeated same text still fires
    el.textContent = '';
    requestAnimationFrame(() => {
      el.textContent = String(msg || '').slice(0, 280);
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

  function enhanceLandmarks() {
    const main = $('#app .main');
    if (main && !main.getAttribute('role')) main.setAttribute('role', 'main');
    const files = $('#filesPanel');
    if (files) {
      files.setAttribute('role', 'navigation');
      files.setAttribute('aria-label', 'Explorer');
    }
    const chat = $('#chatPanel');
    if (chat) {
      chat.setAttribute('role', 'complementary');
      chat.setAttribute('aria-label', 'Agent');
    }
    const center = document.querySelector('.center');
    if (center) {
      center.setAttribute('role', 'region');
      center.setAttribute('aria-label', 'Workspace');
    }
    const messages = $('#messagesHost');
    if (messages) {
      messages.setAttribute('role', 'log');
      messages.setAttribute('aria-relevant', 'additions');
      messages.setAttribute('aria-label', 'Conversation');
    }
    const editorTabs = $('#editorTabs');
    if (editorTabs) {
      editorTabs.setAttribute('role', 'tablist');
      editorTabs.setAttribute('aria-label', 'Live Code Diff');
    }
    document.querySelectorAll('#editorTabs .tab[data-tab]').forEach((tab) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    });
    const modeBar = $('#modeBar');
    if (modeBar) {
      modeBar.setAttribute('role', 'toolbar');
      modeBar.setAttribute('aria-label', 'Work mode');
    }
    const taskTabs = $('#taskTabs');
    if (taskTabs) {
      taskTabs.setAttribute('role', 'tablist');
      taskTabs.setAttribute('aria-label', 'Tasks');
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
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
