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
        id: 'live.side.toggle',
        title: t('cmd.live.side', '折叠/展开 Live 详情侧栏'),
        keywords: 'live side detail focus context 详情 侧栏',
        group: 'actions',
        run: run(() => global.toggleLiveSide?.()),
      },
      {
        id: 'term.toggle',
        title: t('cmd.term.toggle', '折叠/展开终端'),
        keywords: 'terminal shell 终端 折叠',
        group: 'actions',
        run: run(() => document.getElementById('btnToggleTerm')?.click()),
      },
      {
        id: 'layout.agent',
        title: t('cmd.layout.agent', '布局 · Work（默认）'),
        keywords: 'layout work agent chat primary 布局 对话 工作',
        group: 'actions',
        run: run(() => global.applyLayoutMode?.('agent', { toast: true })),
      },
      {
        id: 'layout.review',
        title: t('cmd.layout.review', '布局 · Review 审阅'),
        keywords: 'layout review explorer 审阅 布局',
        group: 'actions',
        run: run(() => global.applyLayoutMode?.('review', { toast: true })),
      },
      {
        id: 'layout.pilot',
        title: t('cmd.layout.pilot', '布局 · Pilot（高级）'),
        keywords: 'layout pilot center ultrawide 居中 超宽 高级',
        group: 'actions',
        run: run(() => global.applyLayoutMode?.('pilot', { toast: true })),
      },
      {
        id: 'layout.full',
        title: t('cmd.layout.full', '布局 · Full（高级）'),
        keywords: 'layout full ide 全面板 高级',
        group: 'actions',
        run: run(() => global.applyLayoutMode?.('full', { toast: true })),
      },
      {
        id: 'diff.review.bridge',
        title: t('cmd.diff.review.bridge', '打开 Diff 审阅台'),
        keywords: 'diff review bridge 审阅 变更',
        group: 'actions',
        run: run(() => global.openReviewBridge?.()),
      },
      {
        id: 'diff.storyboard.import',
        title: t('cmd.diff.storyboard.import', '导入 Storyboard 到胶片条'),
        keywords: 'diff storyboard import filmstrip offline 导入 回灌',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.importStoryboardToFilmstrip?.();
        }),
      },
      {
        id: 'diff.storyboard.clear',
        title: t('cmd.diff.storyboard.clear', '退出 Storyboard 回灌'),
        keywords: 'diff storyboard clear exit 退出 回灌',
        group: 'actions',
        run: run(() => global.clearStoryboardOverlay?.()),
      },
      {
        id: 'diff.storyboard.rehydrate',
        title: t('cmd.diff.storyboard.rehydrate', 'Storyboard 从磁盘 rehydrate'),
        keywords: 'diff storyboard rehydrate disk 磁盘 恢复',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.rehydrateStoryboardFromDisk?.({ silent: false });
        }),
      },
      {
        id: 'layout.auto.pilot',
        title: t('cmd.layout.auto.pilot', '切换超宽自动 Pilot'),
        keywords: 'layout auto pilot ultrawide 自动 超宽',
        group: 'actions',
        run: run(() => {
          const on = !(global.getAutoPilotEnabled?.() ?? true);
          global.setAutoPilotEnabled?.(on);
          global.toast?.(
            on ? 'Auto-Pilot on' : 'Auto-Pilot off',
            'ok'
          );
        }),
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
      },
      {
        id: 'fx.toggle',
        title: t('cmd.fx.toggle', '切换视觉强度 FX'),
        keywords: 'fx visual intensity high glow 光晕 强度',
        group: 'actions',
        run: run(() => {
          const next = global.GrokFx?.toggleFx?.() || 'normal';
          global.toast?.(t('toast.fx', '视觉强度：{mode}', { mode: next }), 'ok');
        }),
      },
      {
        id: 'motion.toggle',
        title: t('cmd.motion.toggle', '切换强制减少动效'),
        keywords: 'motion reduce accessibility a11y 动效 无障碍',
        group: 'actions',
        run: run(() => {
          const on = global.GrokFx?.toggleReduceMotion?.();
          global.toast?.(
            t('toast.motion', '减少动效：{mode}', { mode: on ? 'on' : 'off' }),
            'ok'
          );
        }),
      },
      {
        id: 'idle.toggle',
        title: t('cmd.idle.toggle', '切换电影级待机氛围'),
        keywords: 'cinematic idle ambient nebula 待机 氛围 电影 星云',
        group: 'actions',
        run: run(() => {
          const on = global.GrokFx?.toggleCinematicIdle?.();
          global.toast?.(
            t('toast.idle', '电影级待机：{mode}', { mode: on ? 'on' : 'off' }),
            'ok'
          );
        }),
      },
      {
        id: 'search.files',
        title: t('cmd.search.files', '搜索文件'),
        hint: 'Ctrl+P',
        keywords: 'search files quick open 文件 搜索',
        group: 'actions',
        run: run(() => global.GrokSearch?.open?.('files')),
      },
      {
        id: 'search.content',
        title: t('cmd.search.content', '搜索内容'),
        hint: 'Ctrl+Shift+F',
        keywords: 'search content grep 内容 搜索',
        group: 'actions',
        run: run(() => global.GrokSearch?.open?.('content')),
      },
      {
        id: 'split.toggle',
        title: t('cmd.split.toggle', 'Code | Diff 并排'),
        keywords: 'split side by side 并排',
        group: 'actions',
        run: run(() => global.GrokSplit?.toggle?.()),
      },
      {
        id: 'mode.craft',
        title: t('cmd.mode.craft', '模式 · Craft 飞行'),
        keywords: 'mode craft 动手 flight 飞行',
        group: 'actions',
        run: run(() => global.setWorkMode?.('craft', { toast: true })),
      },
      {
        id: 'mode.plan',
        title: t('cmd.mode.plan', '模式 · Plan'),
        keywords: 'mode plan 方案',
        group: 'actions',
        run: run(() => global.setWorkMode?.('plan', { toast: true })),
      },
      {
        id: 'mode.goal',
        title: t('cmd.mode.goal', '模式 · Goal 目标'),
        keywords: 'mode goal 目标 milestone 里程碑',
        group: 'actions',
        run: run(() => global.setWorkMode?.('goal', { toast: true })),
      },
      {
        id: 'mode.ask',
        title: t('cmd.mode.ask', '模式 · Ask'),
        keywords: 'mode ask 只读',
        group: 'actions',
        run: run(() => global.setWorkMode?.('ask', { toast: true })),
      },
      {
        id: 'mode.cycle',
        title: t('cmd.mode.cycle', '切换工作模式'),
        keywords: 'mode cycle 切换 模式 craft plan goal ask',
        group: 'actions',
        run: run(() => global.cycleWorkMode?.()),
      },
      {
        id: 'session.share',
        title: t('cmd.session.share', '导出会话分享卡'),
        keywords: 'export session share markdown 导出 会话 分享',
        group: 'actions',
        run: run(() => global.openSessionShareCard?.()),
      },
      {
        id: 'task.rename',
        title: t('cmd.task.rename', '重命名当前任务'),
        keywords: 'rename task 重命名 任务',
        group: 'actions',
        run: run(() => {
          const id = global.TaskStore?.activeId;
          if (id) global.beginTaskRename?.(id);
        }),
      },
      {
        id: 'live.filter.write',
        title: t('cmd.live.filter.write', 'Live 过滤 · 写入'),
        keywords: 'live filter write 写入',
        group: 'actions',
        run: run(() => global.setLiveFilter?.('write')),
      },
      {
        id: 'live.filter.all',
        title: t('cmd.live.filter.all', 'Live 过滤 · 全部'),
        keywords: 'live filter all 全部',
        group: 'actions',
        run: run(() => global.setLiveFilter?.('all')),
      },
      {
        id: 'model.cycle',
        title: t('cmd.model.cycle', '切换模型预设'),
        keywords: 'model cycle 模型 grok',
        group: 'actions',
        run: run(async () => {
          const presets = ['', 'grok-build', 'grok-4.5', 'grok-4'];
          const cur = global.getComposerModel?.() ?? '';
          const i = presets.indexOf(cur);
          const next = presets[(i + 1) % presets.length];
          await global.setModelPreset?.(next);
        }),
      },
      {
        id: 'chat.search',
        title: t('cmd.chat.search', '搜索本任务消息'),
        hint: 'Ctrl+F',
        keywords: 'search chat messages 消息 搜索',
        group: 'actions',
        run: run(() => global.openChatSearch?.()),
      },
      {
        id: 'diff.next',
        title: t('cmd.diff.next', 'Diff 下一个文件'),
        keywords: 'diff next j',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.navigateDiffFile?.(1);
        }),
      },
      {
        id: 'diff.review',
        title: t('cmd.diff.review', 'Diff 标记已审阅'),
        keywords: 'diff review accept 审阅',
        group: 'actions',
        run: run(() => global.markDiffReviewed?.(undefined, true)),
      },
      {
        id: 'diff.sbs',
        title: t('cmd.diff.sbs', 'Diff 并排 / Unified 切换'),
        keywords: 'diff side by side split 并排',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.toggleDiffViewMode?.();
        }),
      },
      {
        id: 'task.pin',
        title: t('cmd.task.pin', '固定/取消固定当前任务'),
        keywords: 'pin task 固定',
        group: 'actions',
        run: run(() => {
          const id = global.TaskStore?.activeId;
          if (id) {
            global.TaskStore.togglePin(id);
            global.renderTaskTabs?.();
          }
        }),
      },
      {
        id: 'rules.edit',
        title: t('cmd.rules.edit', '快速编辑 --rules'),
        keywords: 'rules 规则',
        group: 'actions',
        run: run(() => global.openRulesQuickEdit?.()),
      },
      {
        id: 'templates.open',
        title: t('cmd.templates', '会话模板包'),
        keywords: 'template starter 模板 会话',
        group: 'actions',
        run: run(() => global.openTemplatesMenu?.()),
      },
      {
        id: 'templates.import',
        title: t('cmd.templates.import', '导入模板 JSON 包'),
        keywords: 'template import pack 导入',
        group: 'actions',
        run: run(() => global.importTemplatesPack?.()),
      },
      {
        id: 'templates.export',
        title: t('cmd.templates.export', '导出模板 JSON 包'),
        keywords: 'template export pack 导出',
        group: 'actions',
        run: run(() => global.exportTemplatesPack?.()),
      },
      {
        id: 'templates.project.open',
        title: t('cmd.templates.project', '打开项目 templates.json'),
        keywords: 'project templates.json .grok',
        group: 'actions',
        run: run(() => global.openProjectTemplatesInCode?.()),
      },
      {
        id: 'diff.play',
        title: t('cmd.diff.play', 'Diff 播放 / 暂停 turn'),
        keywords: 'diff play scrub 播放',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.toggleScrubPlay?.();
        }),
      },
      {
        id: 'diff.loop',
        title: t('cmd.diff.loop', 'Diff 循环播放开关'),
        keywords: 'diff loop scrub 循环',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.toggleScrubLoop?.();
        }),
      },
      {
        id: 'diff.storyboard',
        title: t('cmd.diff.storyboard', '导出 Diff storyboard Markdown'),
        keywords: 'diff export storyboard filmstrip markdown',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.exportFilmstripStoryboard?.({ format: 'md' });
        }),
      },
      {
        id: 'diff.storyboard.html',
        title: t('cmd.diff.storyboard.html', '导出 Diff HTML 审阅包'),
        keywords: 'diff export storyboard html review pack 审阅',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.exportFilmstripHtml?.();
        }),
      },
      {
        id: 'diff.storyboard.png',
        title: t('cmd.diff.storyboard.png', '导出 Diff storyboard PNG'),
        keywords: 'diff export storyboard png',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.exportFilmstripPng?.();
        }),
      },
      {
        id: 'diff.review.folder',
        title: t('cmd.diff.review.folder', '导出 Diff 审阅文件夹'),
        keywords: 'diff export review folder handoff 审阅 文件夹',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.exportReviewFolder?.();
        }),
      },
      {
        id: 'diff.storyboard.compare',
        title: t('cmd.diff.storyboard.compare', '对比两个 Storyboard 包'),
        keywords: 'diff storyboard compare packs ab review html json 对比 审阅包',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.compareStoryboardPacks?.();
        }),
      },
      {
        id: 'diff.storyboard.encrypt',
        title: t('cmd.diff.storyboard.encrypt', '导出加密 Storyboard JSON'),
        keywords: 'diff storyboard encrypt aes passphrase 加密 口令',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.exportStoryboardEncrypted?.();
        }),
      },
      {
        id: 'diff.storyboard.budget.cycle',
        title: t('cmd.diff.storyboard.budget', '循环导出包体积预算'),
        keywords: 'diff storyboard budget compress full balanced compact 预算 压缩',
        group: 'actions',
        run: run(() => {
          const order = ['full', 'balanced', 'compact'];
          const cur = global.getStoryboardBudgetMode?.() || 'balanced';
          const next = order[(order.indexOf(cur) + 1) % order.length];
          global.setStoryboardBudgetMode?.(next);
          global.renderDiffPane?.();
          global.toast?.(
            t('toast.budget', '导出预算：{mode}', { mode: next }),
            'ok'
          );
        }),
      },
      {
        id: 'diff.restoreTurn',
        title: t('cmd.diff.restoreTurn', 'Diff 整轮还原'),
        keywords: 'diff restore turn 整轮 还原 checkpoint',
        group: 'actions',
        run: run(() => {
          global.switchTab?.('diff');
          global.restoreWholeTurn?.();
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
    const card = root?.querySelector('.cmd-card');
    const input = $('#cmdInput');
    if (input) {
      input.value = '';
      input.placeholder = t('cmd.placeholder', '输入命令…');
      input.setAttribute('aria-controls', 'cmdList');
      input.setAttribute('aria-autocomplete', 'list');
    }
    renderList();
    // Focus trap after list is ready
    global.GrokA11y?.trapFocus?.(card || root);
    input?.focus();
  }

  function close() {
    $('#commandPalette')?.classList.add('hidden');
    global.GrokA11y?.releaseTrap?.();
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
