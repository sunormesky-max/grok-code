/**
 * Lightweight outline for current Code buffer (multi-language)
 */
(function (global) {
  function extractOutline(text, filePath) {
    const lines = String(text || '').split(/\r?\n/);
    const ext = (filePath || '').split('.').pop()?.toLowerCase() || '';
    const items = [];
    const push = (line, kind, name, depth = 0) => {
      if (!name || items.length > 250) return;
      items.push({ line, kind, name: String(name).slice(0, 120), depth });
    };

    let indentStack = [];

    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const n = i + 1;
      const trimmed = L.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }

      // markdown
      if (/md|mdx|markdown/.test(ext) || /^#{1,4}\s+/.test(L)) {
        const hm = L.match(/^(#{1,4})\s+(.+)/);
        if (hm) {
          push(n, 'h', hm[2].trim(), hm[1].length - 1);
          continue;
        }
      }

      // JS / TS / JSX / Vue script-like
      if (/^(js|jsx|mjs|cjs|ts|tsx|vue|svelte)$/.test(ext) || !ext) {
        if (/^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/.test(trimmed)) {
          push(n, 'fn', trimmed.match(/function\s*\*?\s*([A-Za-z0-9_$]+)/)?.[1], 0);
          continue;
        }
        if (/^(export\s+)?(abstract\s+)?class\s+([A-Za-z0-9_$]+)/.test(trimmed)) {
          push(n, 'cls', trimmed.match(/class\s+([A-Za-z0-9_$]+)/)?.[1], 0);
          continue;
        }
        if (/^(export\s+)?interface\s+([A-Za-z0-9_$]+)/.test(trimmed)) {
          push(n, 'iface', trimmed.match(/interface\s+([A-Za-z0-9_$]+)/)?.[1], 0);
          continue;
        }
        if (/^(export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/.test(trimmed)) {
          push(n, 'type', trimmed.match(/type\s+([A-Za-z0-9_$]+)/)?.[1], 0);
          continue;
        }
        if (/^(export\s+)?enum\s+([A-Za-z0-9_$]+)/.test(trimmed)) {
          push(n, 'enum', trimmed.match(/enum\s+([A-Za-z0-9_$]+)/)?.[1], 0);
          continue;
        }
        if (
          /^(export\s+)?(const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s*)?(\(|function\b)/.test(
            trimmed
          )
        ) {
          push(n, 'fn', trimmed.match(/(const|let|var)\s+([A-Za-z0-9_$]+)/)?.[2], 0);
          continue;
        }
        // methods inside class (indented)
        if (/^\s+(async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/.test(L) && !/^\s*(if|for|while|switch|catch)\b/.test(trimmed)) {
          const m = L.match(/^\s+(async\s+)?([A-Za-z0-9_$]+)\s*\(/);
          if (m && m[2] !== 'if' && m[2] !== 'for') push(n, 'meth', m[2], 1);
          continue;
        }
      }

      // Python
      if (ext === 'py') {
        const ind = L.match(/^(\s*)/)?.[1].length || 0;
        if (/^def\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'fn', trimmed.match(/^def\s+([A-Za-z0-9_]+)/)?.[1], Math.min(2, Math.floor(ind / 4)));
          continue;
        }
        if (/^class\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'cls', trimmed.match(/^class\s+([A-Za-z0-9_]+)/)?.[1], Math.min(1, Math.floor(ind / 4)));
          continue;
        }
        if (/^async\s+def\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'fn', trimmed.match(/^async\s+def\s+([A-Za-z0-9_]+)/)?.[1], Math.min(2, Math.floor(ind / 4)));
          continue;
        }
      }

      // Go
      if (ext === 'go') {
        if (/^func\s+/.test(trimmed)) {
          const m = trimmed.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)/);
          if (m) push(n, 'fn', m[1], 0);
          continue;
        }
        if (/^type\s+([A-Za-z0-9_]+)\s+struct/.test(trimmed)) {
          push(n, 'cls', trimmed.match(/^type\s+([A-Za-z0-9_]+)/)?.[1], 0);
          continue;
        }
        if (/^type\s+([A-Za-z0-9_]+)\s+interface/.test(trimmed)) {
          push(n, 'iface', trimmed.match(/^type\s+([A-Za-z0-9_]+)/)?.[1], 0);
          continue;
        }
      }

      // Rust
      if (ext === 'rs') {
        if (/^(pub\s+)?(async\s+)?fn\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'fn', trimmed.match(/fn\s+([A-Za-z0-9_]+)/)?.[1], 0);
          continue;
        }
        if (/^(pub\s+)?struct\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'cls', trimmed.match(/struct\s+([A-Za-z0-9_]+)/)?.[1], 0);
          continue;
        }
        if (/^(pub\s+)?enum\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'enum', trimmed.match(/enum\s+([A-Za-z0-9_]+)/)?.[1], 0);
          continue;
        }
        if (/^(pub\s+)?trait\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          push(n, 'iface', trimmed.match(/trait\s+([A-Za-z0-9_]+)/)?.[1], 0);
          continue;
        }
        if (/^impl\b/.test(trimmed)) {
          push(n, 'impl', trimmed.replace(/\{.*$/, '').trim().slice(0, 40), 0);
          continue;
        }
      }

      // Java / Kotlin / C#
      if (/^(java|kt|kts|cs)$/.test(ext)) {
        if (/\b(class|interface|enum|record)\s+([A-Za-z0-9_]+)/.test(trimmed)) {
          const m = trimmed.match(/\b(class|interface|enum|record)\s+([A-Za-z0-9_]+)/);
          push(n, m[1] === 'class' || m[1] === 'record' ? 'cls' : m[1] === 'enum' ? 'enum' : 'iface', m[2], 0);
          continue;
        }
        if (
          /^\s*(public|private|protected|internal|static|async|override|fun)\b.+\s+([A-Za-z0-9_]+)\s*\(/.test(
            L
          )
        ) {
          const m = L.match(/\s([A-Za-z0-9_]+)\s*\([^;]*\)\s*(\{|=>)?\s*$/);
          if (m && !/^(if|for|while|switch|catch)$/.test(m[1])) push(n, 'meth', m[1], 1);
          continue;
        }
      }

      // Ruby
      if (ext === 'rb') {
        if (/^def\s+([A-Za-z0-9_?!]+)/.test(trimmed)) {
          push(n, 'fn', trimmed.match(/^def\s+([A-Za-z0-9_?!]+)/)?.[1], 0);
          continue;
        }
        if (/^class\s+([A-Za-z0-9_:]+)/.test(trimmed)) {
          push(n, 'cls', trimmed.match(/^class\s+([A-Za-z0-9_:]+)/)?.[1], 0);
          continue;
        }
        if (/^module\s+([A-Za-z0-9_:]+)/.test(trimmed)) {
          push(n, 'mod', trimmed.match(/^module\s+([A-Za-z0-9_:]+)/)?.[1], 0);
          continue;
        }
      }

      // CSS / SCSS — selectors
      if (/^(css|scss|less)$/.test(ext)) {
        if (/^[\.\#@a-zA-Z][^{]+\{/.test(trimmed) || /^[\.\#][a-zA-Z0-9_-]+/.test(trimmed)) {
          const name = trimmed.replace(/\s*\{.*$/, '').trim();
          if (name && !name.startsWith('/*')) push(n, 'sel', name.slice(0, 60), 0);
          continue;
        }
      }

      // HTML / Vue template — tags with id
      if (/^(html|htm|vue)$/.test(ext)) {
        if (/^<\/?[a-zA-Z]/.test(trimmed) && /id=["'][^"']+["']/.test(trimmed)) {
          const id = trimmed.match(/id=["']([^"']+)["']/)?.[1];
          if (id) push(n, 'id', '#' + id, 0);
          continue;
        }
        if (/^<(section|article|main|header|nav|footer|h[1-3])\b/i.test(trimmed)) {
          push(n, 'tag', trimmed.match(/^<\/?([a-zA-Z0-9-]+)/)?.[1], 0);
        }
      }

      // JSON top-level keys
      if (ext === 'json' && /^ {2}"([^"]+)"\s*:/.test(L)) {
        push(n, 'key', L.match(/^ {2}"([^"]+)"/)?.[1], 0);
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
    // Default collapsed so Code body keeps full width/height for reading
    let collapsed = true;
    try {
      collapsed = localStorage.getItem('grokcode-outline-collapsed') !== '0';
    } catch {
      /* default collapsed */
    }
    panel.className = 'outline-panel' + (collapsed ? ' is-collapsed' : '');
    panel.innerHTML = `
      <div class="outline-head">
        <button type="button" class="outline-toggle link-btn" id="btnOutlineToggle" title="展开 / 折叠大纲" aria-expanded="${collapsed ? 'false' : 'true'}">${collapsed ? '▸' : '▾'}</button>
        <span class="outline-title">Outline</span>
        <button type="button" class="link-btn" id="btnOutlineRefresh" title="刷新大纲">↻</button>
      </div>
      <div class="outline-list" id="outlineList">
        <div class="muted pad">打开文件后显示大纲</div>
      </div>`;
    body.appendChild(panel);
    body.classList.toggle('outline-collapsed', collapsed);
    panel.querySelector('#btnOutlineRefresh')?.addEventListener('click', () => refresh());
    panel.querySelector('#btnOutlineToggle')?.addEventListener('click', () => {
      const next = !panel.classList.contains('is-collapsed');
      panel.classList.toggle('is-collapsed', next);
      body.classList.toggle('outline-collapsed', next);
      const btn = panel.querySelector('#btnOutlineToggle');
      if (btn) {
        btn.textContent = next ? '▸' : '▾';
        btn.setAttribute('aria-expanded', next ? 'false' : 'true');
      }
      try {
        localStorage.setItem('grokcode-outline-collapsed', next ? '1' : '0');
      } catch {
        /* ignore */
      }
    });
    return panel;
  }

  function lineHeight(ed) {
    if (!ed) return 18;
    const cs = getComputedStyle(ed);
    const lh = parseFloat(cs.lineHeight);
    if (Number.isFinite(lh) && lh > 0) return lh;
    const fs = parseFloat(cs.fontSize) || 13;
    return fs * 1.45;
  }

  function jumpToLine(line) {
    const ed = document.getElementById('editor');
    if (!ed || !line) return;
    const lines = ed.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus();
    ed.setSelectionRange(pos, pos);
    const lineH = lineHeight(ed);
    ed.scrollTop = Math.max(0, (line - 4) * lineH);
    requestAnimationFrame(() => highlightCurrentSymbol());
  }

  /** Sticky highlight: symbol covering current scroll/cursor position */
  function currentEditorLine(ed) {
    if (!ed) return 1;
    const lineH = lineHeight(ed);
    // Prefer caret when focused
    if (document.activeElement === ed && typeof ed.selectionStart === 'number') {
      const before = ed.value.slice(0, ed.selectionStart);
      return Math.max(1, before.split('\n').length);
    }
    // Otherwise: ~1/4 down the viewport (reads like "current" while scrolling)
    const mid = ed.scrollTop + ed.clientHeight * 0.22;
    return Math.max(1, Math.floor(mid / lineH) + 1);
  }

  function highlightCurrentSymbol() {
    const list = document.getElementById('outlineList');
    const ed = document.getElementById('editor');
    if (!list || !ed) return;
    const items = [...list.querySelectorAll('.outline-item[data-line]')];
    if (!items.length) return;
    const cur = currentEditorLine(ed);
    let active = null;
    for (const btn of items) {
      const ln = Number(btn.dataset.line) || 0;
      if (ln <= cur) active = btn;
      else break;
    }
    items.forEach((b) => {
      const on = b === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'true' : 'false');
    });
    if (active) {
      const lr = list.getBoundingClientRect();
      const br = active.getBoundingClientRect();
      if (br.top < lr.top + 4 || br.bottom > lr.bottom - 4) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
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
          `<button type="button" class="outline-item kind-${it.kind}" data-line="${it.line}" style="padding-left:${6 + (it.depth || 0) * 10}px">
            <span class="ol-kind">${it.kind}</span>
            <span class="ol-name">${escapeHtml(it.name)}</span>
            <span class="ol-line">${it.line}</span>
          </button>`
      )
      .join('');
    list.querySelectorAll('.outline-item').forEach((btn) => {
      btn.onclick = () => jumpToLine(Number(btn.dataset.line));
    });
    highlightCurrentSymbol();
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

  let stickyRaf = null;
  function scheduleSticky() {
    if (stickyRaf) return;
    stickyRaf = requestAnimationFrame(() => {
      stickyRaf = null;
      highlightCurrentSymbol();
    });
  }

  function bindSticky(ed) {
    if (!ed || ed._outlineStickyBound) return;
    ed._outlineStickyBound = true;
    ed.addEventListener('scroll', scheduleSticky, { passive: true });
    ed.addEventListener('click', scheduleSticky);
    ed.addEventListener('keyup', scheduleSticky);
    ed.addEventListener('select', scheduleSticky);
  }

  function init() {
    ensurePanel();
    const ed = document.getElementById('editor');
    ed?.addEventListener('input', schedule);
    bindSticky(ed);
    const pathEl = document.getElementById('currentPath');
    if (pathEl) {
      const obs = new MutationObserver(schedule);
      obs.observe(pathEl, { childList: true, characterData: true, subtree: true });
    }
    document.querySelector('.tab[data-tab="editor"]')?.addEventListener('click', () => setTimeout(refresh, 50));
  }

  global.GrokOutline = { extractOutline, refresh, init, highlightCurrentSymbol };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
