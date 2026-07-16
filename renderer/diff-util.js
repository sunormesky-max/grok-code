/**
 * 轻量行级 diff → unified hunks
 * 小文件用 LCS；过大则退化为 head/tail 摘要，避免卡 UI
 */
(function (global) {
  const MAX_LCS_LINES = 2500;

  function splitLines(text) {
    if (text == null) return [];
    return String(text).split(/\r?\n/);
  }

  function lcsTable(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp;
  }

  function backtrack(dp, a, b) {
    const ops = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.push({ type: 'same', text: a[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.push({ type: 'add', text: b[j - 1] });
        j--;
      } else {
        ops.push({ type: 'del', text: a[i - 1] });
        i--;
      }
    }
    ops.reverse();
    return ops;
  }

  function coarseDiff(a, b) {
    const ops = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (i >= a.length) ops.push({ type: 'add', text: b[i] });
      else if (i >= b.length) ops.push({ type: 'del', text: a[i] });
      else if (a[i] === b[i]) ops.push({ type: 'same', text: a[i] });
      else {
        ops.push({ type: 'del', text: a[i] });
        ops.push({ type: 'add', text: b[i] });
      }
    }
    return ops;
  }

  function computeLineDiff(before, after) {
    const a = splitLines(before);
    const b = splitLines(after);
    const created = !before && after != null;
    const deleted = before != null && (after == null || after === '');
    let ops;
    if (a.length + b.length > MAX_LCS_LINES) {
      ops = coarseDiff(a, b);
    } else {
      ops = backtrack(lcsTable(a, b), a, b);
    }
    let adds = 0;
    let dels = 0;
    for (const o of ops) {
      if (o.type === 'add') adds++;
      if (o.type === 'del') dels++;
    }
    return {
      ops,
      stats: { adds, dels, beforeLines: a.length, afterLines: b.length },
      created: Boolean(created && a.length === 0 && b.length > 0),
      deleted: Boolean(deleted),
    };
  }

  /**
   * Build foldable unified hunks from line ops.
   * @returns {{ html: string, hunkCount: number }}
   */
  function toUnifiedHtml(ops, { context = 3, maxRows = 800, collapsed = null } = {}) {
    // 只展示有变更的上下文窗口
    const show = new Array(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].type !== 'same') {
        for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
          show[k] = true;
        }
      }
    }

    // Pre-compute line numbers for each op index
    const lineAAt = new Array(ops.length);
    const lineBAt = new Array(ops.length);
    let lineA = 0;
    let lineB = 0;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.type === 'same') {
        lineA++;
        lineB++;
        lineAAt[i] = lineA;
        lineBAt[i] = lineB;
      } else if (o.type === 'del') {
        lineA++;
        lineAAt[i] = lineA;
        lineBAt[i] = lineB;
      } else {
        lineB++;
        lineAAt[i] = lineA;
        lineBAt[i] = lineB;
      }
    }

    // Group contiguous shown ops into hunks
    const hunks = [];
    let cur = null;
    for (let i = 0; i < ops.length; i++) {
      if (!show[i]) {
        cur = null;
        continue;
      }
      if (!cur) {
        cur = { start: i, indices: [] };
        hunks.push(cur);
      }
      cur.indices.push(i);
    }

    const collapsedSet =
      collapsed instanceof Set
        ? collapsed
        : Array.isArray(collapsed)
          ? new Set(collapsed)
          : new Set();

    let html = '';
    let rows = 0;
    let truncated = false;

    for (let hi = 0; hi < hunks.length; hi++) {
      const h = hunks[hi];
      let adds = 0;
      let dels = 0;
      let firstA = null;
      let firstB = null;
      for (const i of h.indices) {
        const o = ops[i];
        if (o.type === 'add') adds++;
        if (o.type === 'del') dels++;
        if (firstA == null && (o.type === 'same' || o.type === 'del')) firstA = lineAAt[i];
        if (firstB == null && (o.type === 'same' || o.type === 'add')) firstB = lineBAt[i];
      }
      const isCollapsed = collapsedSet.has(hi);
      const headLabel = `@@ -${firstA || 0} +${firstB || 0} @@  +${adds} −${dels}`;
      html += `<div class="diff-hunk${isCollapsed ? ' collapsed' : ''}" data-hunk="${hi}">
        <button type="button" class="diff-hunk-head" data-hunk="${hi}" aria-expanded="${isCollapsed ? 'false' : 'true'}">
          <span class="dh-chev">${isCollapsed ? '▸' : '▾'}</span>
          <span class="dh-label">${escapeHtml(headLabel)}</span>
          <span class="dh-meta"><span class="a">+${adds}</span> <span class="d">−${dels}</span></span>
        </button>
        <div class="diff-hunk-body"${isCollapsed ? ' hidden' : ''}>`;

      if (!isCollapsed) {
        for (const i of h.indices) {
          if (rows >= maxRows) {
            truncated = true;
            break;
          }
          const o = ops[i];
          const text = escapeHtml(o.text);
          if (o.type === 'same') {
            html += `<div class="diff-row same"><span class="ln">${lineAAt[i]}</span><span class="sign"> </span><span class="tx">${text}</span></div>`;
          } else if (o.type === 'del') {
            html += `<div class="diff-row del"><span class="ln">${lineAAt[i]}</span><span class="sign">-</span><span class="tx">${text}</span></div>`;
          } else {
            html += `<div class="diff-row add"><span class="ln">${lineBAt[i]}</span><span class="sign">+</span><span class="tx">${text}</span></div>`;
          }
          rows++;
        }
      }
      html += `</div></div>`;
      if (truncated) {
        html += `<div class="diff-row meta">… 其余变更已省略</div>`;
        break;
      }
    }

    if (!html) {
      html = `<div class="diff-row meta">无行级差异（可能只是空白/换行）</div>`;
    }
    return html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function extractPathFromTool(name, args = {}) {
    const n = String(name || '').toLowerCase();
    const candidates = [
      args.path,
      args.file_path,
      args.target_file,
      args.file,
      args.filename,
      args.filepath,
    ].filter(Boolean);
    if (candidates[0]) return String(candidates[0]).replace(/\\/g, '/');
    // shell 命令里粗提常见路径
    if (/run_command|run_terminal|bash|shell/.test(n) && args.command) {
      const m = String(args.command).match(/(?:^|[\s'"])((?:[\w./\\-]+\/)+[\w./\\-]+\.[\w]+)/);
      if (m) return m[1].replace(/\\/g, '/');
    }
    return null;
  }

  function isWriteTool(name) {
    const n = String(name || '').toLowerCase();
    return /write|edit|replace|create|patch|apply_diff|search_replace/.test(n);
  }

  function isReadTool(name) {
    const n = String(name || '').toLowerCase();
    return /read|cat|open|view/.test(n);
  }

  global.DiffUtil = {
    computeLineDiff,
    toUnifiedHtml,
    extractPathFromTool,
    isWriteTool,
    isReadTool,
    splitLines,
  };
})(window);
