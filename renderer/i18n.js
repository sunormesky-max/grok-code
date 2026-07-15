/**
 * Lightweight i18n — en / zh
 * Usage: t('key') · data-i18n="key" · data-i18n-placeholder="key"
 */
(function (global) {
  const STRINGS = {
    zh: {
      'app.tag': 'maximum truth-seeking · CLI',
      'btn.addProject': '添加项目',
      'btn.newWindow': '新窗口',
      'btn.settings': '设置',
      'projects.label': 'PROJECTS',
      'projects.add': '＋ 项目',
      'explorer.title': 'Explorer',
      'explorer.empty': '还没有工作区。\nGrok 需要点东西才能「grok」。',
      'explorer.pick': '选择文件夹',
      'tab.live': 'Live',
      'tab.code': 'Code',
      'tab.diff': 'Diff',
      'follow': '跟随',
      'live.idle': '待命',
      'live.hint': '丢一个任务给 Grok，这里会变成任务驾驶舱',
      'live.mission': 'Mission Control',
      'live.mission.desc': '实时显示：思考 → 读文件 → 改代码 → 跑命令。\n这是 GrokCode 相对「纯聊天框」的真正价值。',
      'live.focus': '焦点文件',
      'live.changes': '本轮变更',
      'live.context': '上下文四档',
      'live.context.refresh': '整理',
      'code.save': '保存',
      'code.diff': '查看 Diff',
      'code.ide': '↗ IDE',
      'code.ready': '就绪',
      'diff.files': '变更文件',
      'diff.restoreAll': '全部还原',
      'diff.openCode': '在 Code 打开',
      'diff.openExt': '↗ 外部编辑器',
      'diff.restore': '还原此文件',
      'diff.dismiss': '忽略',
      'diff.pick': '选择左侧文件',
      'term.label': 'Terminal',
      'chat.label': 'Grok',
      'chat.status': '待命',
      'chat.newTask': '＋ 任务',
      'chat.placeholder': '对当前任务说… 可开多个任务并行跑',
      'chat.send': 'Grok it',
      'chat.stop': '■ 停止',
      'sb.noProject': '无工作区',
      'settings.title': 'Settings',
      'settings.desc': '通用 · MCP · Skills · 插件 — 直连本机 Grok CLI',
      'stab.general': '通用',
      'stab.mcp': 'MCP',
      'stab.skills': 'Skills',
      'stab.plugins': '插件',
      'stab.catalog': '目录',
      'stab.appearance': '外观',
      'lang.label': '界面语言',
      'theme.label': '主题',
      'theme.grok': 'Grok 深空（默认）',
      'theme.void': '纯黑 Void',
      'theme.mars': '火星橙 Mars',
      'theme.ice': '冰蓝 Ice',
      'theme.ember': '余烬 Ember',
      'profile.export': '导出项目配置',
      'profile.import': '导入项目配置',
      'telemetry.label': '崩溃报告（可选）',
      'telemetry.hint': '默认关闭。开启后仅写本地 ~/.grok-code/crashes，可选手动 endpoint',
      'toast.saved': '设置已保存',
      'toast.lang': '语言已切换',
      'toast.theme': '主题已切换',
      'onb.welcome': 'Welcome aboard',
      'onb.desc': 'GrokCode 首启体检 · 约 30 秒就绪',
      'cli.detecting': '检测 CLI…',
      'cli.offline': 'CLI 未找到',
      'cli.online': '在线',
    },
    en: {
      'app.tag': 'maximum truth-seeking · CLI',
      'btn.addProject': 'Add project',
      'btn.newWindow': 'New window',
      'btn.settings': 'Settings',
      'projects.label': 'PROJECTS',
      'projects.add': '+ Project',
      'explorer.title': 'Explorer',
      'explorer.empty': 'No workspace yet.\nGrok needs something to grok.',
      'explorer.pick': 'Choose folder',
      'tab.live': 'Live',
      'tab.code': 'Code',
      'tab.diff': 'Diff',
      'follow': 'Follow',
      'live.idle': 'Idle',
      'live.hint': 'Give Grok a mission — this becomes mission control',
      'live.mission': 'Mission Control',
      'live.mission.desc': 'Think → read → edit → run, live.\nThe real value of GrokCode vs a plain chat box.',
      'live.focus': 'Focus file',
      'live.changes': 'Session changes',
      'live.context': 'Context L0–L3',
      'live.context.refresh': 'Refresh',
      'code.save': 'Save',
      'code.diff': 'View Diff',
      'code.ide': '↗ IDE',
      'code.ready': 'Ready',
      'diff.files': 'Changed files',
      'diff.restoreAll': 'Restore all',
      'diff.openCode': 'Open in Code',
      'diff.openExt': '↗ External editor',
      'diff.restore': 'Restore file',
      'diff.dismiss': 'Dismiss',
      'diff.pick': 'Select a file',
      'term.label': 'Terminal',
      'chat.label': 'Grok',
      'chat.status': 'Idle',
      'chat.newTask': '+ Task',
      'chat.placeholder': 'Talk to the active task… open more tasks to run in parallel',
      'chat.send': 'Grok it',
      'chat.stop': '■ Stop',
      'sb.noProject': 'No workspace',
      'settings.title': 'Settings',
      'settings.desc': 'General · MCP · Skills · Plugins — local Grok CLI',
      'stab.general': 'General',
      'stab.mcp': 'MCP',
      'stab.skills': 'Skills',
      'stab.plugins': 'Plugins',
      'stab.catalog': 'Catalog',
      'stab.appearance': 'Appearance',
      'lang.label': 'Language',
      'theme.label': 'Theme',
      'theme.grok': 'Grok deep space (default)',
      'theme.void': 'Void black',
      'theme.mars': 'Mars orange',
      'theme.ice': 'Ice cyan',
      'theme.ember': 'Ember',
      'profile.export': 'Export project profile',
      'profile.import': 'Import project profile',
      'telemetry.label': 'Crash reports (optional)',
      'telemetry.hint': 'Off by default. Local ~/.grok-code/crashes only; optional endpoint',
      'toast.saved': 'Settings saved',
      'toast.lang': 'Language updated',
      'toast.theme': 'Theme updated',
      'onb.welcome': 'Welcome aboard',
      'onb.desc': 'GrokCode first-run doctor · ~30 seconds',
      'cli.detecting': 'Probing CLI…',
      'cli.offline': 'CLI missing',
      'cli.online': 'Online',
    },
  };

  let locale = 'zh';
  try {
    const saved = localStorage.getItem('grokcode-locale');
    if (saved === 'en' || saved === 'zh') locale = saved;
  } catch {
    /* ignore */
  }

  function t(key, fallback) {
    const pack = STRINGS[locale] || STRINGS.zh;
    return pack[key] || STRINGS.zh[key] || fallback || key;
  }

  function setLocale(next) {
    if (next !== 'en' && next !== 'zh') return locale;
    locale = next;
    try {
      localStorage.setItem('grokcode-locale', locale);
    } catch {
      /* ignore */
    }
    applyDom();
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    global.dispatchEvent(new CustomEvent('grok:locale', { detail: { locale } }));
    return locale;
  }

  function getLocale() {
    return locale;
  }

  function applyDom(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const val = t(key);
      if (el.dataset.i18nHtml === '1') el.innerHTML = val.replace(/\n/g, '<br>');
      else el.textContent = val;
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) el.setAttribute('placeholder', t(key));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) el.setAttribute('title', t(key));
    });
  }

  global.GrokI18n = { t, setLocale, getLocale, applyDom, STRINGS };
})(typeof window !== 'undefined' ? window : globalThis);
