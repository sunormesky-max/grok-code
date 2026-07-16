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
  /** heat 0–4 from age (minutes) — hotter = more recent */
  function heatFromTs(ts) {
    if (!ts) return 0;
    const ageMin = Math.max(0, (Date.now() - Number(ts)) / 60000);
    if (ageMin < 2) return 4;
    if (ageMin < 15) return 3;
    if (ageMin < 60) return 2;
    if (ageMin < 24 * 60) return 1;
    return 0;
  }

  function blameAttrs(blame, kind) {
    if (!blame || kind === 'same') return { cls: '', attrs: '' };
    const heat =
      blame.heat != null
        ? Math.max(0, Math.min(4, Number(blame.heat) || 0))
        : heatFromTs(blame.ts);
    const title = [
      blame.taskTitle ? `Task: ${blame.taskTitle}` : '',
      blame.turnId ? `Turn: ${blame.turnId}` : '',
      blame.ts ? `At: ${new Date(blame.ts).toLocaleString()}` : '',
      blame.prompt ? `Prompt: ${String(blame.prompt).slice(0, 120)}` : '',
      blame.reason ? `Via: ${blame.reason}` : '',
      `Heat: ${heat}/4`,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      cls: ` has-blame heat-${heat}`,
      attrs: ` data-kind="${kind}" data-heat="${heat}" data-turn="${escapeHtml(blame.turnId || '')}"${
        title ? ` title="${escapeHtml(title)}"` : ''
      }`,
    };
  }

  function toUnifiedHtml(ops, { context = 3, maxRows = 800, collapsed = null, blame = null } = {}) {
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
            const b = blameAttrs(blame, 'del');
            html += `<div class="diff-row del${b.cls}"${b.attrs}><span class="ln">${lineAAt[i]}</span><span class="sign">-</span><span class="tx">${text}</span></div>`;
          } else {
            const b = blameAttrs(blame, 'add');
            html += `<div class="diff-row add${b.cls}"${b.attrs}><span class="ln">${lineBAt[i]}</span><span class="sign">+</span><span class="tx">${text}</span></div>`;
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

  /**
   * Side-by-side diff HTML from the same ops (context-windowed like unified).
   */
  function toSideBySideHtml(ops, { context = 3, maxRows = 800, blame = null } = {}) {
    const show = new Array(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].type !== 'same') {
        for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
          show[k] = true;
        }
      }
    }
    let lineA = 0;
    let lineB = 0;
    let rows = 0;
    let gap = false;
    let html =
      '<div class="diff-sbs-head"><span>Before</span><span>After</span></div><div class="diff-sbs">';
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.type === 'same') {
        lineA++;
        lineB++;
      } else if (o.type === 'del') lineA++;
      else if (o.type === 'add') lineB++;

      if (!show[i]) {
        gap = true;
        continue;
      }
      if (gap) {
        html += `<div class="diff-sbs-row meta"><div class="sbs-cell">···</div><div class="sbs-cell">···</div></div>`;
        gap = false;
      }
      if (rows >= maxRows) {
        html += `<div class="diff-sbs-row meta"><div class="sbs-cell">…</div><div class="sbs-cell">…</div></div>`;
        break;
      }
      const text = escapeHtml(o.text);
      const ba = blameAttrs(blame, o.type);
      if (o.type === 'same') {
        html += `<div class="diff-sbs-row same">
          <div class="sbs-cell"><span class="ln">${lineA}</span><span class="tx">${text}</span></div>
          <div class="sbs-cell"><span class="ln">${lineB}</span><span class="tx">${text}</span></div>
        </div>`;
      } else if (o.type === 'del') {
        html += `<div class="diff-sbs-row del${ba.cls}"${ba.attrs}>
          <div class="sbs-cell del"><span class="ln">${lineA}</span><span class="sign">-</span><span class="tx">${text}</span></div>
          <div class="sbs-cell empty"></div>
        </div>`;
      } else {
        html += `<div class="diff-sbs-row add${ba.cls}"${ba.attrs}>
          <div class="sbs-cell empty"></div>
          <div class="sbs-cell add"><span class="ln">${lineB}</span><span class="sign">+</span><span class="tx">${text}</span></div>
        </div>`;
      }
      rows++;
    }
    html += '</div>';
    if (rows === 0) {
      return `<div class="diff-row meta">无行级差异（可能只是空白/换行）</div>`;
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

  /**
   * Plain-text unified snippet for storyboard / export (size-capped).
   */
  function toUnifiedText(ops, { context = 2, maxRows = 40 } = {}) {
    const show = new Array(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].type !== 'same') {
        for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
          show[k] = true;
        }
      }
    }
    const lines = [];
    let rows = 0;
    let gap = false;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (!show[i]) {
        gap = true;
        continue;
      }
      if (gap) {
        lines.push('···');
        gap = false;
      }
      if (rows >= maxRows) {
        lines.push('… (truncated)');
        break;
      }
      if (o.type === 'same') lines.push('  ' + o.text);
      else if (o.type === 'del') lines.push('- ' + o.text);
      else lines.push('+ ' + o.text);
      rows++;
    }
    if (!lines.length) lines.push('(no line diff)');
    return lines.join('\n');
  }

  /**
   * Parse storyboard mini-diff text (toUnifiedText format) → ops + snippets.
   * Lines: "  ctx" | "- del" | "+ add" | "···" | "… (truncated)" | "(no line diff)"
   */
  function parseUnifiedText(text) {
    const ops = [];
    let truncated = false;
    let empty = false;
    const raw = String(text || '');
    if (!raw.trim()) {
      return { ops: [], truncated: false, empty: true, beforeLines: [], afterLines: [] };
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line === '(no line diff)') {
        empty = true;
        continue;
      }
      // Context gap (omit unchanged middle) — after-snippet may still be contiguous
      if (line === '···' || line === '...') {
        continue;
      }
      // Hit maxRows in toUnifiedText — reverse full-file match may be incomplete
      if (line.startsWith('…') || /^…\s*\(truncated\)/i.test(line) || /\(truncated\)\s*$/i.test(line)) {
        truncated = true;
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const t = line.startsWith('+ ') ? line.slice(2) : line.slice(1);
        ops.push({ type: 'add', text: t });
        continue;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        const t = line.startsWith('- ') ? line.slice(2) : line.slice(1);
        ops.push({ type: 'del', text: t });
        continue;
      }
      if (line.startsWith('  ')) {
        ops.push({ type: 'same', text: line.slice(2) });
        continue;
      }
      // bare context (rare) — treat as same if non-empty
      if (line.length) ops.push({ type: 'same', text: line });
    }
    const beforeLines = [];
    const afterLines = [];
    let adds = 0;
    let dels = 0;
    for (const o of ops) {
      if (o.type === 'same') {
        beforeLines.push(o.text);
        afterLines.push(o.text);
      } else if (o.type === 'del') {
        beforeLines.push(o.text);
        dels++;
      } else if (o.type === 'add') {
        afterLines.push(o.text);
        adds++;
      }
    }
    return {
      ops,
      truncated,
      empty: empty && !ops.length,
      beforeLines,
      afterLines,
      stats: { adds, dels, beforeLines: beforeLines.length, afterLines: afterLines.length },
      beforeSnippet: beforeLines.join('\n'),
      afterSnippet: afterLines.join('\n'),
    };
  }

  /**
   * Find first index where `needle` lines match a contiguous slice of `hay`.
   * Returns -1 if not found or needle empty.
   */
  function findLineSlice(hay, needle) {
    if (!needle.length) return needle.length === 0 && hay.length === 0 ? 0 : -1;
    if (needle.length > hay.length) return -1;
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
      for (let k = 0; k < needle.length; k++) {
        if (hay[i + k] !== needle[k]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /**
   * Reconstruct before (and optionally full-file before) from mini-diff.
   * @param {string} text - importDiffText / toUnifiedText output
   * @param {{ after?: string }} [opts] - full file after (e.g. disk rehydrate)
   * @returns {{
   *   ok: boolean,
   *   ops: array,
   *   stats: object,
   *   before: string,
   *   after: string,
   *   truncated: boolean,
   *   fullBefore: boolean,
   *   mode: 'snippet'|'full'|'empty'|'fail'
   * }}
   */
  function reconstructFromUnified(text, opts = {}) {
    const parsed = parseUnifiedText(text);
    if (parsed.empty || !parsed.ops.length) {
      const after = opts.after != null ? String(opts.after) : parsed.afterSnippet || '';
      return {
        ok: false,
        ops: [],
        stats: { adds: 0, dels: 0 },
        before: '',
        after,
        truncated: parsed.truncated,
        fullBefore: false,
        mode: 'empty',
      };
    }

    const snippetBefore = parsed.beforeSnippet;
    const snippetAfter = parsed.afterSnippet;

    // Full-file reverse when we have after content and a matchable after-snippet
    if (opts.after != null && String(opts.after).length >= 0 && !parsed.truncated) {
      const fullAfter = String(opts.after);
      const hay = splitLines(fullAfter);
      const needle = parsed.afterLines;
      // Pure deletions: after snippet is only context (or empty)
      if (needle.length === 0 && parsed.beforeLines.length) {
        // cannot locate without context — fall through to snippet
      } else if (needle.length === 0 && !parsed.beforeLines.length) {
        return {
          ok: true,
          ops: parsed.ops,
          stats: parsed.stats,
          before: '',
          after: fullAfter,
          truncated: false,
          fullBefore: true,
          mode: 'full',
        };
      } else {
        const at = findLineSlice(hay, needle);
        if (at >= 0) {
          const next = [
            ...hay.slice(0, at),
            ...parsed.beforeLines,
            ...hay.slice(at + needle.length),
          ];
          const fullBefore = next.join('\n');
          // Prefer full recompute for consistent ops / line numbers
          const recomputed = computeLineDiff(fullBefore, fullAfter);
          return {
            ok: true,
            ops: recomputed.ops,
            stats: recomputed.stats,
            before: fullBefore,
            after: fullAfter,
            truncated: false,
            fullBefore: true,
            mode: 'full',
          };
        }
      }
    }

    // Partial: mini-diff snippet only (still better than raw text for side-by-side)
    const after =
      opts.after != null && String(opts.after) !== ''
        ? String(opts.after)
        : snippetAfter;
    return {
      ok: true,
      ops: parsed.ops,
      stats: parsed.stats,
      before: snippetBefore,
      after: opts.after != null && String(opts.after) !== '' ? String(opts.after) : snippetAfter,
      truncated: parsed.truncated,
      fullBefore: false,
      mode: 'snippet',
      afterSnippet: snippetAfter,
      beforeSnippet: snippetBefore,
    };
  }

  const api = {
    computeLineDiff,
    toUnifiedHtml,
    toSideBySideHtml,
    toUnifiedText,
    parseUnifiedText,
    reconstructFromUnified,
    findLineSlice,
    extractPathFromTool,
    isWriteTool,
    isReadTool,
    splitLines,
    heatFromTs,
  };

  global.DiffUtil = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
