/**
 * Global search — files (Ctrl+P) + content (Ctrl+Shift+F)
 */
(function (global) {
  function t(k, fb, v) {
    return global.GrokI18n?.t?.(k, fb, v) || fb || k;
  }
  function esc(s) {
    return (global.GrokUtils?.esc || ((x) => String(x ?? '')))(s);
  }

  let mode = 'files'; // files | content
  let timer = null;
  let activeIdx = 0;
  let results = [];

  function ensure() {
    let root = document.getElementById('globalSearch');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'globalSearch';
    root.className = 'gsearch hidden';
    root.innerHTML = `
      <div class="gsearch-backdrop" data-close="1"></div>
      <div class="gsearch-card glass">
        <div class="gsearch-modes">
          <button type="button" class="gsearch-mode active" data-mode="files">${esc(t('search.mode.files', '文件'))}</button>
          <button type="button" class="gsearch-mode" data-mode="content">${esc(t('search.mode.content', '内容'))}</button>
          <span class="gsearch-hint" id="gsearchHint">Ctrl+P</span>
        </div>
        <input type="search" id="gsearchInput" class="gsearch-input" autocomplete="off" spellcheck="false" />
        <div class="gsearch-list" id="gsearchList" role="listbox"></div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.gsearch-backdrop')?.addEventListener('click', close);
    root.querySelectorAll('.gsearch-mode').forEach((btn) => {
      btn.onclick = () => {
        mode = btn.dataset.mode;
        root.querySelectorAll('.gsearch-mode').forEach((b) => b.classList.toggle('active', b === btn));
        const hint = document.getElementById('gsearchHint');
        if (hint) hint.textContent = mode === 'files' ? 'Ctrl+P' : 'Ctrl+Shift+F';
        const input = document.getElementById('gsearchInput');
        if (input) {
          input.placeholder =
            mode === 'files'
              ? t('search.ph.files', '按文件名 / 路径搜索…')
              : t('search.ph.content', '在工作区搜索文本…');
          input.focus();
          runSearch(input.value);
        }
      };
    });
    const input = root.querySelector('#gsearchInput');
    input?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => runSearch(input.value), 120);
    });
    input?.addEventListener('keydown', onKey);
    return root;
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(results.length - 1, activeIdx + 1);
      paint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  async function runSearch(q) {
    q = String(q || '').trim();
    const list = document.getElementById('gsearchList');
    const proj = global.ProjectStore?.active?.();
    if (!proj) {
      results = [];
      if (list) list.innerHTML = `<div class="gsearch-empty">${esc(t('search.noProject', '请先打开项目'))}</div>`;
      return;
    }
    if (!q) {
      results = [];
      if (list) list.innerHTML = `<div class="gsearch-empty">${esc(t('search.type', '开始输入…'))}</div>`;
      return;
    }
    if (list) list.innerHTML = `<div class="gsearch-empty">${esc(t('common.loading', '加载中…'))}</div>`;
    try {
      if (mode === 'files') {
        const res = await window.grok.searchPaths(proj.id, q, { maxHits: 60 });
        results = (res.hits || []).map((h) => ({
          kind: 'file',
          path: h.path,
          title: h.name || h.path.split(/[/\\]/).pop(),
          sub: h.path,
        }));
      } else {
        const res = await window.grok.searchContent(proj.id, q, { maxHits: 50 });
        results = (res.hits || []).map((h) => ({
          kind: 'content',
          path: h.path,
          line: h.line,
          title: `${h.path}:${h.line}`,
          sub: h.text,
        }));
      }
      activeIdx = 0;
      paint();
    } catch (err) {
      results = [];
      if (list) list.innerHTML = `<div class="gsearch-empty">${esc(err.message)}</div>`;
    }
  }

  function paint() {
    const list = document.getElementById('gsearchList');
    if (!list) return;
    if (!results.length) {
      list.innerHTML = `<div class="gsearch-empty">${esc(t('search.none', '无结果'))}</div>`;
      return;
    }
    list.innerHTML = results
      .map(
        (r, i) => `
      <button type="button" class="gsearch-item${i === activeIdx ? ' active' : ''}" data-idx="${i}">
        <div class="gs-title">${esc(r.title)}</div>
        <div class="gs-sub">${esc(r.sub || '')}</div>
      </button>`
      )
      .join('');
    list.querySelectorAll('.gsearch-item').forEach((btn) => {
      btn.onmouseenter = () => {
        activeIdx = Number(btn.dataset.idx);
        paint();
      };
      btn.onclick = () => pick(results[Number(btn.dataset.idx)]);
    });
    list.querySelector('.gsearch-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  async function pick(item) {
    if (!item?.path) return;
    close();
    if (typeof global.openFile === 'function') {
      await global.openFile(item.path, { switchToCode: true });
    } else {
      document.querySelector(`.tree-item[data-path="${CSS.escape(item.path)}"]`)?.click();
    }
    // try scroll editor to line
    if (item.line && item.line > 1) {
      const ed = document.getElementById('editor');
      if (ed) {
        const lines = ed.value.split('\n');
        let pos = 0;
        for (let i = 0; i < item.line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
        ed.focus();
        ed.setSelectionRange(pos, pos);
        // rough scroll
        const lineH = 18;
        ed.scrollTop = Math.max(0, (item.line - 5) * lineH);
      }
    }
  }

  function open(preferredMode) {
    ensure();
    if (preferredMode === 'files' || preferredMode === 'content') mode = preferredMode;
    const root = document.getElementById('globalSearch');
    root?.classList.remove('hidden');
    root?.querySelectorAll('.gsearch-mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
      // refresh labels on open
      if (b.dataset.mode === 'files') b.textContent = t('search.mode.files', '文件');
      if (b.dataset.mode === 'content') b.textContent = t('search.mode.content', '内容');
    });
    const hint = document.getElementById('gsearchHint');
    if (hint) hint.textContent = mode === 'files' ? 'Ctrl+P' : 'Ctrl+Shift+F';
    const input = document.getElementById('gsearchInput');
    if (input) {
      input.value = '';
      input.placeholder =
        mode === 'files'
          ? t('search.ph.files', '按文件名 / 路径搜索…')
          : t('search.ph.content', '在工作区搜索文本…');
      input.focus();
    }
    results = [];
    paint();
  }

  function close() {
    document.getElementById('globalSearch')?.classList.add('hidden');
  }

  function isOpen() {
    const el = document.getElementById('globalSearch');
    return Boolean(el && !el.classList.contains('hidden'));
  }

  function toggle(m) {
    if (isOpen()) close();
    else open(m);
  }

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      open('content');
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
      // don't steal browser print on some platforms if not focused - we want quick open
      e.preventDefault();
      open('files');
      return;
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  global.GrokSearch = { open, close, toggle, isOpen };
})(typeof window !== 'undefined' ? window : globalThis);
