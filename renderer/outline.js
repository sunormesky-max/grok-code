/**
 * Lightweight outline for current Code buffer (headings / functions / classes)
 */
(function (global) {
  function $(sel) {
    return document.querySelector(sel);
  }

  function extractOutline(text, filePath) {
    const lines = String(text || '').split(/\r?\n/);
    const ext = (filePath || '').split('.').pop()?.toLowerCase() || '';
    const items = [];
    const push = (line, kind, name) => {
      if (!name || items.length > 200) return;
      items.push({ line, kind, name: name.slice(0, 120) });
    };

    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const n = i + 1;
      // markdown headings
      if (/^#{1,4}\s+/.test(L)) {
        push(n, 'h', L.replace(/^#+\s+/, '').trim());
        continue;
      }
      // js/ts functions / classes
      if (/^(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)/.test(L)) {
        push(n, 'fn', L.match(/function\s+([A-Za-z0-9_$]+)/)?.[1]);
        continue;
      }
      if (/^(export\s+)?class\s+([A-Za-z0-9_$]+)/.test(L)) {
        push(n, 'cls', L.match(/class\s+([A-Za-z0-9_$]+)/)?.[1]);
        continue;
      }
      if (/^(export\s+)?(const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s*)?\(/.test(L)) {
        push(n, 'fn', L.match(/(const|let|var)\s+([A-Za-z0-9_$]+)/)?.[2]);
        continue;
      }
      // python
      if (ext === 'py') {
        if (/^def\s+([A-Za-z0-9_]+)/.test(L)) {
          push(n, 'fn', L.match(/^def\s+([A-Za-z0-9_]+)/)?.[1]);
          continue;
        }
        if (/^class\s+([A-Za-z0-9_]+)/.test(L)) {
          push(n, 'cls', L.match(/^class\s+([A-Za-z0-9_]+)/)?.[1]);
          continue;
        }
      }
      // go
      if (ext === 'go' && /^func\s+/.test(L)) {
        const m = L.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)/);
        if (m) push(n, 'fn', m[1]);
      }
    }
    return items;
  }

  function ensurePanel() {
    let panel = document.getElementById('outlinePanel');
    if (panel) return panel;
    const body = document.querySelector('#codePane .editor-body');
    if (!body) return null;
    body.classList.add('has-outline');
    panel = document.createElement('aside');
    panel.id = 'outlinePanel';
    panel.className = 'outline-panel';
    panel.innerHTML = `
      <div class="outline-head">
        <span>Outline</span>
        <button type="button" class="link-btn" id="btnOutlineRefresh">↻</button>
      </div>
      <div class="outline-list" id="outlineList">
        <div class="muted pad">打开文件后显示大纲</div>
      </div>`;
    body.appendChild(panel);
    panel.querySelector('#btnOutlineRefresh')?.addEventListener('click', () => refresh());
    return panel;
  }

  function jumpToLine(line) {
    const ed = document.getElementById('editor');
    if (!ed || !line) return;
    const lines = ed.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus();
    ed.setSelectionRange(pos, pos);
    const lineH = 18;
    ed.scrollTop = Math.max(0, (line - 4) * lineH);
  }

  function refresh() {
    ensurePanel();
    const list = document.getElementById('outlineList');
    const ed = document.getElementById('editor');
    if (!list || !ed) return;
    const path =
      global.ProjectStore?.active?.()?.currentFile ||
      document.getElementById('currentPath')?.title ||
      '';
    const items = extractOutline(ed.value, path);
    if (!items.length) {
      list.innerHTML = '<div class="muted pad">无符号</div>';
      return;
    }
    list.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="outline-item kind-${it.kind}" data-line="${it.line}">
            <span class="ol-kind">${it.kind}</span>
            <span class="ol-name">${escapeHtml(it.name)}</span>
            <span class="ol-line">${it.line}</span>
          </button>`
      )
      .join('');
    list.querySelectorAll('.outline-item').forEach((btn) => {
      btn.onclick = () => jumpToLine(Number(btn.dataset.line));
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  }

  function init() {
    ensurePanel();
    const ed = document.getElementById('editor');
    ed?.addEventListener('input', schedule);
    // refresh when file opens
    const obs = new MutationObserver(schedule);
    const pathEl = document.getElementById('currentPath');
    if (pathEl) obs.observe(pathEl, { childList: true, characterData: true, subtree: true });
    document.querySelector('.tab[data-tab="editor"]')?.addEventListener('click', () => setTimeout(refresh, 50));
  }

  global.GrokOutline = { extractOutline, refresh, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
