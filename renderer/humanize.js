/**
 * Tool humanize — turn tool name + args into a short human line.
 * Inspired by OpenWorker humanize.ts; tuned for Grok CLI / ACP tool names.
 *
 * Dual-export for unit tests + browser.
 */
(function (global) {
  function trunc(s, n) {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function baseName(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const parts = s.split(/[/\\]/);
    return parts[parts.length - 1] || s || 'file';
  }

  function pathArg(a) {
    return (
      a.path ||
      a.file_path ||
      a.target_file ||
      a.file ||
      a.filename ||
      a.filepath ||
      ''
    );
  }

  function shortArgs(args) {
    if (!args || typeof args !== 'object') return '';
    return Object.entries(args)
      .map(([k, v]) => {
        let s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s.length > 72) s = s.slice(0, 71) + '…';
        return `${k}=${s.replace(/\n/g, ' ')}`;
      })
      .join('  ');
  }

  /**
   * Normalize tool name for matching (ACP / snake / Camel / Title).
   * @param {string} name
   */
  function normName(name) {
    return String(name || '')
      .trim()
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase();
  }

  /**
   * @typedef {{ pre: string, obj?: string, post?: string }} HumanLine
   */

  /**
   * Past-tense line for completed / in-flight tools in transcript & Live.
   * @param {string} name
   * @param {object} [args]
   * @param {{ en?: boolean, tense?: 'past'|'ask' }} [opts]
   * @returns {HumanLine}
   */
  function humanizeTool(name, args, opts) {
    const en = opts?.en !== false && (opts?.en === true || opts?.locale === 'en');
    // default bilingual: detect via opts.en only; callers pass en flag
    const zh = !en;
    const a = args && typeof args === 'object' ? args : {};
    const n = normName(name);
    const path = pathArg(a);
    const file = path ? baseName(path) : '';

    // Shell
    if (/^(run_shell|run_command|run_terminal|run_terminal_command|bash|shell|powershell|cmd)$/.test(n) || /shell|terminal|bash/.test(n)) {
      const cmd = trunc(String(a.command ?? a.cmd ?? ''), 60);
      const desc =
        typeof a.description === 'string' && a.description.trim()
          ? a.description.trim()
          : '';
      if (zh) {
        return {
          pre: a.run_in_background ? '后台执行 ' : '执行 ',
          obj: cmd || '命令',
          ...(desc ? { post: ` — ${desc}` } : {}),
        };
      }
      return {
        pre: a.run_in_background ? 'Started in background: ' : 'Ran ',
        obj: cmd || 'a command',
        ...(desc ? { post: ` — ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` } : {}),
      };
    }

    // Read
    if (/^(read_file|read|view|cat|open_file|get_file)$/.test(n) || (/^read/.test(n) && !/search|replace/.test(n))) {
      if (zh) return { pre: '读取 ', obj: file || path || '文件' };
      return { pre: 'Read ', obj: file || path || 'a file' };
    }

    // Write / edit
    if (
      /^(write_file|write|create_file|search_replace|str_replace|replace_in_file|apply_patch|apply_unified_diff|edit_file|multi_edit)$/.test(
        n
      ) ||
      /write|replace|edit|patch|apply_diff|search_replace/.test(n)
    ) {
      if (/write|create/.test(n) && !/replace|edit|patch/.test(n)) {
        if (zh) return { pre: '写入 ', obj: file || path || '文件' };
        return { pre: 'Wrote ', obj: file || path || 'a file' };
      }
      if (zh) return { pre: '编辑 ', obj: file || path || '文件' };
      return { pre: 'Edited ', obj: file || path || 'files' };
    }

    // Grep / search
    if (/^(grep|rg|search|codebase_search|search_files|search_content)$/.test(n) || /grep|search/.test(n)) {
      const q = trunc(String(a.pattern ?? a.query ?? a.regex ?? a.needle ?? ''), 40);
      if (zh) return { pre: '搜索 ', obj: q ? `“${q}”` : '代码' };
      return { pre: 'Searched for ', obj: q ? `“${q}”` : 'code' };
    }

    // Glob / list
    if (/^(glob|list_dir|list_files|ls|find_files)$/.test(n) || /glob|list_dir|list_file/.test(n)) {
      const g = trunc(String(a.glob ?? a.pattern ?? a.path ?? a.target_directory ?? ''), 48);
      if (zh) return { pre: '列出 ', obj: g || '目录' };
      return { pre: 'Listed ', obj: g || 'files' };
    }

    // Web
    if (/^web_search|websearch$/.test(n) || n === 'web_search') {
      const q = trunc(String(a.query ?? a.q ?? ''), 60);
      if (zh) return { pre: '网页搜索 ', obj: q ? `“${q}”` : '' };
      return { pre: 'Searched the web — ', obj: q ? `“${q}”` : '' };
    }
    if (/web_fetch|fetch_url|open_url|browse/.test(n)) {
      let host = String(a.url ?? a.href ?? '');
      try {
        host = new URL(host).host || host;
      } catch {
        /* keep */
      }
      if (zh) return { pre: '打开网页 ', obj: trunc(host, 50) };
      return { pre: 'Fetched ', obj: trunc(host, 50) };
    }

    // Todo / plan
    if (/todo|task_update|update_todos/.test(n)) {
      if (zh) return { pre: '更新待办' };
      return { pre: 'Updated the plan' };
    }

    // Default
    const rest = trunc(shortArgs(a), 72);
    if (zh) {
      return { pre: `使用 ${name || 'tool'}`, ...(rest ? { post: ` — ${rest}` } : {}) };
    }
    return { pre: `Used ${name || 'tool'}`, ...(rest ? { post: ` — ${rest}` } : {}) };
  }

  /**
   * Approval / pending ask headline (imperative).
   * @param {string} name
   * @param {object} [args]
   * @param {{ en?: boolean }} [opts]
   * @returns {HumanLine}
   */
  function humanizeApproval(name, args, opts) {
    const en = Boolean(opts && opts.en);
    const zh = !en;
    const a = args && typeof args === 'object' ? args : {};
    const n = normName(name);
    const path = pathArg(a);
    const file = path ? baseName(path) : '';

    if (/shell|terminal|bash|run_command|run_terminal/.test(n)) {
      const desc =
        typeof a.description === 'string' && a.description.trim()
          ? a.description.trim()
          : '';
      if (zh) {
        return {
          pre: '运行命令',
          ...(desc ? { post: ` — ${desc}` } : a.command ? { obj: trunc(String(a.command), 48) } : {}),
        };
      }
      return {
        pre: 'Run a command',
        ...(desc
          ? { post: ` — ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` }
          : a.command
            ? { post: ` — ${trunc(String(a.command), 48)}` }
            : {}),
      };
    }
    if (/write|create/.test(n) && !/replace|edit|patch/.test(n)) {
      if (zh) return { pre: '写入 ', obj: file || path || '文件' };
      return { pre: 'Write ', obj: file || path || 'a file' };
    }
    if (/replace|edit|patch|search_replace/.test(n)) {
      if (zh) return { pre: '编辑 ', obj: file || path || '文件' };
      return { pre: 'Edit ', obj: file || path || 'files' };
    }
    if (zh) return { pre: `使用 ${name || 'tool'}` };
    return { pre: `Use ${name || 'tool'}` };
  }

  /** Flatten HumanLine to plain string. */
  function formatLine(line) {
    if (!line) return '';
    return `${line.pre || ''}${line.obj || ''}${line.post || ''}`;
  }

  /**
   * Permission card density: compact file writes vs full shell/external.
   * Host presentation only — does not change CLI options.
   * @param {string} name
   * @param {object} [args]
   * @returns {'compact'|'full'}
   */
  function permissionDensity(name, args) {
    const n = normName(name);
    if (
      /^(run_shell|run_command|run_terminal|run_terminal_command|bash|shell|powershell|cmd)$/.test(
        n
      ) ||
      /shell|terminal|bash|powershell/.test(n)
    ) {
      return 'full';
    }
    if (/web_search|web_fetch|browse|open_url|send_message|send_file/.test(n)) {
      return 'full';
    }
    // Routine workspace writes → compact row
    if (
      /write|replace|edit|patch|search_replace|create_file|apply_diff|str_replace/.test(n)
    ) {
      return 'compact';
    }
    // Long command-like args → full
    if (args && typeof args === 'object' && args.command) return 'full';
    return 'full';
  }

  const api = {
    trunc,
    baseName,
    shortArgs,
    normName,
    humanizeTool,
    humanizeApproval,
    formatLine,
    permissionDensity,
  };

  global.GrokHumanize = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
