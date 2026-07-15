/**
 * Command palette — Ctrl+K / Cmd+K
 */
(function (global) {
  function $(sel) {
    return document.querySelector(sel);
  }
  function t(k, fb, v) {
    return global.GrokI18n?.t?.(k, fb, v) || fb || k;
  }
  function esc(s) {
    return (global.GrokUtils?.esc || ((x) => String(x ?? '')))(s);
  }

  /** @type {Array<{id:string,title:string,hint?:string,keywords?:string,run:()=>void|Promise<void>}>} */
  let commands = [];

  function buildCommands() {
    const run = (fn) => () => {
      close();
      try {
        fn();
      } catch (e) {
        global.toast?.(e.message || String(e), 'err');
      }
    };
    commands = [];

    // Dynamic: switch project / task
    try {
      const projects = global.ProjectStore?.list?.() || [];
      for (const p of projects) {
        commands.push({
          id: `goto.project.${p.id}`,
          title: t('cmd.goto.project', '项目 · {name}', { name: p.name }),
          hint: '⌘P',
          keywords: `project ${p.name} ${p.path} 项目 切换`,
          group: 'nav',
          run: run(() => {
            if (typeof global.switchProject === 'function') global.switchProject(p.id);
            else {
              document.querySelector(`.project-tab[data-id="${p.id}"]`)?.click();
            }
          }),
        });
        for (const task of p.tasks || []) {
          commands.push({
            id: `goto.task.${p.id}.${task.id}`,
            title: t('cmd.goto.task', '任务 · {task}  · {project}', {
              task: task.title || task.id,
              project: p.name,
            }),
            keywords: `task ${task.title} ${p.name} 任务`,
            group: 'nav',
            run: run(async () => {
              if (global.ProjectStore?.activeId !== p.id) {
                if (typeof global.switchProject === 'function') await global.switchProject(p.id);
                else document.querySelector(`.project-tab[data-id="${p.id}"]`)?.click();
              }
              global.TaskStore?.setActive?.(task.id);
              if (typeof global.renderTaskTabs === 'function') global.renderTaskTabs();
              if (typeof global.syncComposerToTask === 'function') {
                const tsk = global.TaskStore?.get?.(task.id);
                if (tsk) global.syncComposerToTask(tsk);
              }
              document.getElementById('prompt')?.focus();
            }),
          });
        }
      }
    } catch {
      /* ignore */
    }

    commands.push(
      {
        id: 'project.open',
        title: t('cmd.project.open', '添加项目'),
        hint: 'Ctrl+O',
        keywords: 'open project workspace folder 项目',
        group: 'actions',
        run: run(() => document.getElementById('btnOpen')?.click()),
      },
      {
        id: 'project.window',
        title: t('cmd.project.window', '新窗口打开项目'),
        keywords: 'window 新窗口',
        run: run(() => document.getElementById('btnOpenWindow')?.click()),
      },
      {
        id: 'task.new',
        title: t('cmd.task.new', '新建任务'),
        hint: 'Ctrl+T',
        keywords: 'task new 任务',
        run: run(() => document.getElementById('btnAddTask')?.click() || document.getElementById('btnNewChat')?.click()),
      },
      {
        id: 'settings',
        title: t('cmd.settings', '打开设置'),
        hint: 'Ctrl+,',
        keywords: 'settings 设置 config',
        run: run(() => document.getElementById('btnSettings')?.click()),
      },
      {
        id: 'settings.mcp',
        title: t('cmd.settings.mcp', '设置 · MCP'),
        keywords: 'mcp server',
        run: run(() => {
          document.getElementById('btnSettings')?.click();
          setTimeout(() => document.querySelector('.stab[data-stab="mcp"]')?.click(), 50);
        }),
      },
      {
        id: 'settings.skills',
        title: t('cmd.settings.skills', '设置 · Skills'),
        keywords: 'skills 技能',
        run: run(() => {
          document.getElementById('btnSettings')?.click();
          setTimeout(() => document.querySelector('.stab[data-stab="skills"]')?.click(), 50);
        }),
      },
      {
        id: 'settings.plugins',
        title: t('cmd.settings.plugins', '设置 · 插件'),
        keywords: 'plugins 插件 marketplace',
        run: run(() => {
          document.getElementById('btnSettings')?.click();
          setTimeout(() => document.querySelector('.stab[data-stab="plugins"]')?.click(), 50);
        }),
      },
      {
        id: 'settings.catalog',
        title: t('cmd.settings.catalog', '设置 · 目录'),
        keywords: 'catalog 目录 examples',
        run: run(() => {
          document.getElementById('btnSettings')?.click();
          setTimeout(() => document.querySelector('.stab[data-stab="catalog"]')?.click(), 50);
        }),
      },
      {
        id: 'settings.appearance',
        title: t('cmd.settings.appearance', '设置 · 外观'),
        keywords: 'theme language 主题 语言',
        run: run(() => {
          document.getElementById('btnSettings')?.click();
          setTimeout(() => document.querySelector('.stab[data-stab="appearance"]')?.click(), 50);
        }),
      },
      {
        id: 'tab.live',
        title: t('cmd.tab.live', '切换到 Live'),
        keywords: 'live mission',
        run: run(() => document.querySelector('.tab[data-tab="live"]')?.click()),
      },
      {
        id: 'tab.code',
        title: t('cmd.tab.code', '切换到 Code'),
        keywords: 'code editor',
        run: run(() => document.querySelector('.tab[data-tab="editor"]')?.click()),
      },
      {
        id: 'tab.diff',
        title: t('cmd.tab.diff', '切换到 Diff'),
        keywords: 'diff changes',
        run: run(() => document.querySelector('.tab[data-tab="diff"]')?.click()),
      },
      {
        id: 'explorer.toggle',
        title: t('cmd.explorer.toggle', '折叠/展开资源管理器'),
        hint: 'Ctrl+B',
        keywords: 'explorer sidebar 侧栏',
        run: run(() => document.getElementById('btnCollapseFiles')?.click()),
      },
      {
        id: 'tree.refresh',
        title: t('cmd.tree.refresh', '刷新文件树'),
        keywords: 'refresh tree 刷新',
        run: run(() => document.getElementById('btnRefreshTree')?.click()),
      },
      {
        id: 'doctor',
        title: t('cmd.doctor', '环境体检'),
        keywords: 'doctor 体检 diagnose',
        run: run(() => {
          document.getElementById('btnSettings')?.click();
          setTimeout(() => document.getElementById('btnRunDoctor')?.click(), 80);
        }),
      },
      {
        id: 'onboarding',
        title: t('cmd.onboarding', '首启向导'),
        keywords: 'onboarding wizard 向导',
        run: run(() => global.GrokOnboarding?.show?.()),
      },
      {
        id: 'theme.cycle',
        title: t('cmd.theme.cycle', '切换下一主题'),
        keywords: 'theme 主题',
        run: run(() => {
          const list = global.GrokThemes?.list?.() || [];
          const cur = global.GrokThemes?.getTheme?.() || 'grok';
          const idx = list.findIndex((x) => x.id === cur);
          const next = list[(idx + 1) % Math.max(list.length, 1)];
          if (next) {
            global.GrokThemes.setTheme(next.id);
            global.toast?.(t('toast.theme'), 'ok');
          }
        }),
      },
      {
        id: 'lang.toggle',
        title: t('cmd.lang.toggle', '切换中/英文'),
        keywords: 'language i18n 语言',
        run: run(() => {
          const cur = global.GrokI18n?.getLocale?.() || 'zh';
          global.GrokI18n?.setLocale?.(cur === 'zh' ? 'en' : 'zh');
          global.toast?.(t('toast.lang'), 'ok');
        }),
      },
      {
        id: 'agent.stop',
        title: t('cmd.agent.stop', '停止当前任务'),
        keywords: 'stop agent 停止',
        run: run(() => document.getElementById('btnStop')?.click()),
      },
      {
        id: 'focus.prompt',
        title: t('cmd.focus.prompt', '聚焦输入框'),
        keywords: 'prompt composer 输入',
        run: run(() => document.getElementById('prompt')?.focus()),
      },
      {
        id: 'docs.catalog',
        title: t('cmd.docs.catalog', '打开在线目录站'),
        keywords: 'github pages catalog docs',
        run: run(() =>
          window.grok?.openExternal?.('https://sunormesky-max.github.io/grok-code/')
        ),
      },
      {
        id: 'docs.repo',
        title: t('cmd.docs.repo', '打开 GitHub 仓库'),
        keywords: 'github repo',
        group: 'actions',
        run: run(() =>
          window.grok?.openExternal?.('https://github.com/sunormesky-max/grok-code')
        ),
      },
      {
        id: 'help.shortcuts',
        title: t('cmd.help.shortcuts', '快捷键速查'),
        hint: 'Ctrl+/',
        keywords: 'help shortcuts keyboard 快捷键 ?',
        group: 'actions',
        run: run(() => global.GrokHelp?.open?.()),
      },
      {
        id: 'density.toggle',
        title: t('cmd.density.toggle', '切换界面密度'),
        keywords: 'density compact comfortable 密度',
        group: 'actions',
        run: run(() => {
          const cur = global.GrokDensity?.getDensity?.() || 'comfortable';
          const next = cur === 'compact' ? 'comfortable' : 'compact';
          global.GrokDensity?.setDensity?.(next);
          global.toast?.(
            t('toast.density', '密度：{mode}', { mode: next }),
            'ok'
          );
        }),
      }
    );
  }

  let activeIdx = 0;
  let filtered = [];

  function ensureDom() {
    if ($('#commandPalette')) return;
    const el = document.createElement('div');
    el.id = 'commandPalette';
    el.className = 'cmd-palette hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Command palette');
    el.innerHTML = `
      <div class="cmd-backdrop" data-close="1"></div>
      <div class="cmd-card glass">
        <input type="search" id="cmdInput" class="cmd-input" autocomplete="off" spellcheck="false"
          placeholder="Type a command…" />
        <div class="cmd-list" id="cmdList" role="listbox"></div>
        <div class="cmd-foot"><kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close · <kbd>Ctrl+K</kbd></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.cmd-backdrop')?.addEventListener('click', close);
    const input = el.querySelector('#cmdInput');
    input?.addEventListener('input', () => {
      activeIdx = 0;
      renderList();
    });
    input?.addEventListener('keydown', onInputKey);
  }

  function onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(filtered.length - 1, activeIdx + 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[activeIdx];
      if (item) item.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function score(cmd, q) {
    if (!q) return 1;
    const hay = `${cmd.title} ${cmd.keywords || ''} ${cmd.id}`.toLowerCase();
    if (hay.includes(q)) return q.length / hay.length + (cmd.title.toLowerCase().includes(q) ? 2 : 1);
    // fuzzy: all chars in order
    let j = 0;
    for (let i = 0; i < hay.length && j < q.length; i++) {
      if (hay[i] === q[j]) j++;
    }
    return j === q.length ? 0.3 : 0;
  }

  function renderList() {
    const q = ($('#cmdInput')?.value || '').trim().toLowerCase();
    filtered = commands
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    if (activeIdx >= filtered.length) activeIdx = Math.max(0, filtered.length - 1);
    const list = $('#cmdList');
    if (!list) return;
    if (!filtered.length) {
      list.innerHTML = `<div class="cmd-empty">${esc(t('cmd.empty', '无匹配命令'))}</div>`;
      return;
    }
    // group headers
    let html = '';
    let lastGroup = null;
    filtered.forEach((c, i) => {
      const g = c.group || 'actions';
      if (g !== lastGroup) {
        lastGroup = g;
        const label =
          g === 'nav'
            ? t('cmd.group.nav', '导航')
            : t('cmd.group.actions', '操作');
        html += `<div class="cmd-group">${esc(label)}</div>`;
      }
      html += `
      <button type="button" class="cmd-item${i === activeIdx ? ' active' : ''}" data-idx="${i}" role="option" aria-selected="${
        i === activeIdx
      }">
        <span class="cmd-title">${esc(c.title)}</span>
        ${c.hint ? `<span class="cmd-hint">${esc(c.hint)}</span>` : ''}
      </button>`;
    });
    list.innerHTML = html;
    list.querySelectorAll('.cmd-item').forEach((btn) => {
      btn.onmouseenter = () => {
        activeIdx = Number(btn.dataset.idx);
        renderList();
      };
      btn.onclick = () => filtered[Number(btn.dataset.idx)]?.run();
    });
    list.querySelector('.cmd-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    ensureDom();
    buildCommands();
    const root = $('#commandPalette');
    root?.classList.remove('hidden');
    activeIdx = 0;
    const input = $('#cmdInput');
    if (input) {
      input.value = '';
      input.placeholder = t('cmd.placeholder', '输入命令…');
      input.focus();
    }
    renderList();
  }

  function close() {
    $('#commandPalette')?.classList.add('hidden');
  }

  function toggle() {
    const root = $('#commandPalette');
    if (root && !root.classList.contains('hidden')) close();
    else open();
  }

  function isOpen() {
    const root = $('#commandPalette');
    return Boolean(root && !root.classList.contains('hidden'));
  }

  global.GrokCommandPalette = { open, close, toggle, isOpen, buildCommands };

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggle();
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
