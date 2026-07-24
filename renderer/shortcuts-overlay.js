/**
 * Keyboard shortcuts cheatsheet — ? or Ctrl+/
 */
(function (global) {
  function t(k, fb) {
    return global.GrokI18n?.t?.(k, fb) || fb || k;
  }

  // CLI-native host: no Craft/Plan/Ask/Goal inject — modes via session/set_mode & slash
  const ROWS = () => [
    { keys: ['Ctrl', 'K'], desc: t('help.cmd', '命令面板') },
    { keys: ['Ctrl', 'Shift', 'I'], desc: t('help.inbox', 'Inbox · 跨任务计划/提问') },
    { keys: ['Ctrl', 'O'], desc: t('help.open', '添加项目') },
    { keys: ['Ctrl', 'T'], desc: t('help.task', '新建任务') },
    { keys: ['Enter'], desc: t('help.send', '发送当前任务') },
    { keys: ['Shift', 'Enter'], desc: t('help.send.newline', '输入框换行') },
    { keys: ['Ctrl', 'Enter'], desc: t('help.send.ctrl', '发送（兼容）') },
    { keys: ['/'], desc: t('help.slash', '斜杠 · /plan /agent /ask /effort /cli …') },
    { keys: ['@'], desc: t('help.at', 'Composer 提及文件路径') },
    {
      keys: ['sbMode'],
      desc: t('help.cli.mode', '状态栏 CLI 模式 · 点击循环 default→plan→ask'),
    },
    {
      keys: ['model'],
      desc: t('help.cli.model', '模型芯片 · 列表 / 热切换 session/set_model'),
    },
    {
      keys: ['effort'],
      desc: t('help.cli.effort', '推理强度芯片 · ↑↓ 菜单 · /effort'),
    },
    { keys: ['Esc'], desc: t('help.esc', '关闭浮层 / 设置 / 模型菜单') },
    { keys: ['↑', '↓'], desc: t('help.nav', '命令面板 · 模型菜单导航') },
    { keys: ['Ctrl', 'F'], desc: t('help.chat.search', '搜索本任务消息') },
    { keys: ['Ctrl', 'P'], desc: t('help.files', '搜索文件') },
    { keys: ['Ctrl', 'Shift', 'F'], desc: t('help.content', '搜索内容') },
    { keys: ['j', 'k'], desc: t('help.diff.nav', 'Diff 下一/上一文件（↑↓ 亦可）') },
    { keys: ['n', 'p'], desc: t('help.diff.hunk', 'Diff 下一/上一 hunk') },
    { keys: ['[', ']'], desc: t('help.diff.scrub', 'Diff 上一 / 下一 turn') },
    { keys: ['Space'], desc: t('help.diff.play', 'Diff 播放 / 暂停 turn 时间轴') },
    { keys: ['L'], desc: t('help.diff.loop', 'Diff 循环播放开关') },
    { keys: ['a'], desc: t('help.diff.review', 'Diff 标记已审阅') },
    { keys: ['s'], desc: t('help.diff.sbs', 'Diff 切换并排视图') },
    { keys: ['Ctrl', 'S'], desc: t('help.save', '保存当前文件') },
    { keys: ['Ctrl', 'B'], desc: t('help.explorer', '折叠/展开资源管理器') },
    { keys: ['Ctrl', ','], desc: t('help.settings', '打开设置') },
    { keys: ['Ctrl', '/'], desc: t('help.this', '快捷键速查') },
    { keys: ['?'], desc: t('help.this.q', '快捷键速查（非输入框）') },
  ];

  function ensure() {
    let root = document.getElementById('shortcutsOverlay');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'shortcutsOverlay';
    root.className = 'help-overlay hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'helpTitle');
    root.innerHTML = `
      <div class="help-backdrop" data-close="1"></div>
      <div class="help-card glass" data-a11y-autofocus>
        <div class="help-head">
          <div>
            <div class="help-kicker">xAI · FLIGHT CONTROLS · CLI HOST</div>
            <h2 id="helpTitle" data-i18n="help.title">${t('help.title', '键盘快捷键')}</h2>
          </div>
          <button type="button" class="icon-btn" id="helpClose" aria-label="close">✕</button>
        </div>
        <div class="help-grid" id="helpGrid"></div>
        <div class="help-foot">
          <span data-i18n="help.foot">${t('help.foot', '按 ? 或 Ctrl+/ 再次关闭 · 也可从命令面板打开 · CLI 模式由 Grok CLI 拥有')}</span>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.help-backdrop')?.addEventListener('click', close);
    root.querySelector('#helpClose')?.addEventListener('click', close);
    return root;
  }

  function render() {
    const grid = document.getElementById('helpGrid');
    if (!grid) return;
    grid.innerHTML = ROWS()
      .map(
        (r) => `
      <div class="help-row">
        <div class="help-keys">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('<span class="help-plus">+</span>')}</div>
        <div class="help-desc">${r.desc}</div>
      </div>`
      )
      .join('');
    const h2 = document.querySelector('#shortcutsOverlay h2');
    if (h2) h2.textContent = t('help.title', '键盘快捷键');
    const foot = document.querySelector('#shortcutsOverlay .help-foot span');
    if (foot) foot.textContent = t('help.foot', '按 ? 或 Ctrl+/ 再次关闭 · 也可从命令面板打开');
  }

  function open() {
    ensure();
    render();
    const root = document.getElementById('shortcutsOverlay');
    root?.classList.remove('hidden');
    const card = root?.querySelector('.help-card');
    try {
      global.GrokA11y?.trapFocus?.(card || root);
    } catch {
      /* optional */
    }
  }

  function close() {
    document.getElementById('shortcutsOverlay')?.classList.add('hidden');
    try {
      global.GrokA11y?.releaseTrap?.();
    } catch {
      /* optional */
    }
  }

  function toggle() {
    const el = ensure();
    if (el.classList.contains('hidden')) open();
    else close();
  }

  function isOpen() {
    const el = document.getElementById('shortcutsOverlay');
    return Boolean(el && !el.classList.contains('hidden'));
  }

  window.addEventListener('keydown', (e) => {
    // Ctrl+/ or ?
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target?.isContentEditable) return;
      e.preventDefault();
      toggle();
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  global.GrokHelp = { open, close, toggle, isOpen };
})(typeof window !== 'undefined' ? window : globalThis);
