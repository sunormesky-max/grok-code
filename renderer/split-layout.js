/**
 * Code | Diff side-by-side layout toggle
 */
(function (global) {
  const KEY = 'grokcode-split-layout';
  const WIDTH_KEY = 'grokcode-split-width';

  function isSplit() {
    return document.body.classList.contains('layout-split');
  }

  function getSavedWidth() {
    try {
      const n = Number(localStorage.getItem(WIDTH_KEY));
      return n > 160 && n < 2000 ? n : null;
    } catch {
      return null;
    }
  }

  function saveWidth(px) {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(px)));
    } catch {
      /* ignore */
    }
  }

  function setSplit(on) {
    document.body.classList.toggle('layout-split', Boolean(on));
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    const btn = document.getElementById('btnSplitLayout');
    if (btn) {
      btn.classList.toggle('active', Boolean(on));
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    applyViewClass();
    if (on) {
      // leave Live if currently there — prefer showing code+diff
      const tab = document.querySelector('.tab.active')?.dataset?.tab;
      if (tab === 'live') {
        document.querySelector('.tab[data-tab="editor"]')?.click();
      }
      ensureSplitHost();
      if (typeof global.renderDiffPane === 'function') global.renderDiffPane();
    } else {
      unwrapSplitHost();
      const name = document.querySelector('.tab.active')?.dataset?.tab || 'live';
      if (typeof global.switchTab === 'function') global.switchTab(name);
    }
    global.dispatchEvent(new CustomEvent('grok:split', { detail: { split: Boolean(on) } }));
  }

  function applyViewClass() {
    const tab = document.querySelector('.tab.active')?.dataset?.tab;
    const codediff = isSplit() && tab !== 'live';
    document.body.classList.toggle('view-codediff', codediff);
  }

  function ensureSplitHost() {
    const wrap = document.querySelector('.editor-wrap');
    const code = document.getElementById('codePane');
    const diff = document.getElementById('diffPane');
    if (!wrap || !code || !diff) return;
    let host = document.getElementById('splitHost');
    if (host) return;
    host = document.createElement('div');
    host.id = 'splitHost';
    host.className = 'split-host';
    const divider = document.createElement('div');
    divider.className = 'split-divider';
    divider.id = 'splitDivider';
    // insert after panel-head
    const head = wrap.querySelector('.panel-head');
    const ref = head ? head.nextSibling : wrap.firstChild;
    wrap.insertBefore(host, ref);
    host.appendChild(code);
    host.appendChild(divider);
    host.appendChild(diff);
    code.classList.remove('hidden');
    diff.classList.remove('hidden');
    const w = getSavedWidth();
    if (w) code.style.flex = `0 0 ${w}px`;
    bindDivider(divider, host, code);
  }

  function unwrapSplitHost() {
    const host = document.getElementById('splitHost');
    const wrap = document.querySelector('.editor-wrap');
    if (!host || !wrap) return;
    const code = document.getElementById('codePane');
    const diff = document.getElementById('diffPane');
    const head = wrap.querySelector('.panel-head');
    if (code) wrap.insertBefore(code, head ? head.nextSibling : null);
    if (diff) wrap.insertBefore(diff, code ? code.nextSibling : null);
    host.remove();
  }

  function bindDivider(divider, host, codePane) {
    let startX = 0;
    let startW = 0;
    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      divider.classList.add('active');
      startX = e.clientX;
      startW = codePane.getBoundingClientRect().width;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const total = host.getBoundingClientRect().width;
        let w = Math.min(total - 200, Math.max(180, startW + dx));
        codePane.style.flex = `0 0 ${w}px`;
        codePane._splitW = w;
      };
      const onUp = () => {
        divider.classList.remove('active');
        if (codePane._splitW) saveWidth(codePane._splitW);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function toggle() {
    setSplit(!isSplit());
  }

  function init() {
    let on = false;
    try {
      on = localStorage.getItem(KEY) === '1';
    } catch {
      /* ignore */
    }
    if (on) setSplit(true);
    document.getElementById('btnSplitLayout')?.addEventListener('click', () => toggle());
    // keep view class in sync when tabs change
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => setTimeout(applyViewClass, 0));
    });
  }

  global.GrokSplit = { isSplit, setSplit, toggle, applyViewClass, init, ensureSplitHost };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
