/**
 * 共享工具 — 从 app.js 抽离的无状态 helper
 * 由 app.js 挂到 window 或直接使用
 */
(function (global) {
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cssEscape(s) {
    if (global.CSS?.escape) return CSS.escape(String(s));
    return String(s).replace(/"/g, '\\"');
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* quota */
    }
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function renderMarkdown(src) {
    let s = esc(src || '');
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="lang-${esc(lang)}">${code.replace(/\n$/, '')}</code></pre>`;
    });
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" data-ext="$2">$1</a>');
    s = s.replace(/(^|\n)(?:- |\* )(.+)/g, '$1• $2');
    s = s
      .split(/\n{2,}/)
      .map((block) => {
        if (block.startsWith('<pre>')) return block;
        return `<p>${block.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
    queueMicrotask(() => {
      document.querySelectorAll('.msg .body.md a[data-ext]').forEach((a) => {
        if (a.dataset.bound) return;
        a.dataset.bound = '1';
        a.onclick = (e) => {
          e.preventDefault();
          window.grok?.openExternal?.(a.dataset.ext);
        };
      });
    });
    return s;
  }

  function toast(msg, type = '') {
    const host = document.getElementById('toasts');
    if (!host) {
      console.log(msg);
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }

  global.GrokUtils = {
    esc,
    cssEscape,
    loadJson,
    saveJson,
    formatBytes,
    renderMarkdown,
    toast,
  };
  // 兼容：settings 等模块常用 window.toast
  if (!global.toast) global.toast = toast;
})(typeof window !== 'undefined' ? window : globalThis);
