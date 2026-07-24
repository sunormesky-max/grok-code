/* GrokCode 渲染进程 — 主 UI 编排
 * 模块拆分：utils / onboarding / settings-extra / external-editor-ui / projects / tasks / diff-util
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const U = window.GrokUtils || {};
const esc = U.esc || ((s) => String(s ?? ''));
const cssEscape = U.cssEscape || ((s) => String(s));
const loadJson = U.loadJson || ((_, fb) => fb);
const saveJson = U.saveJson || (() => {});
const formatBytes = U.formatBytes || ((n) => n + ' B');
const renderMarkdown = U.renderMarkdown || ((s) => esc(s));
const t = (key, fallback, vars) =>
  (window.GrokI18n && window.GrokI18n.t(key, fallback, vars)) || fallback || key;

const LAYOUT_KEY = 'grokcode-layout-v1';
const TERM_HIST_KEY = 'grokcode-term-hist';
const MODE_KEY = 'grokcode-work-mode';
const LIVE_FILTER_KEY = 'grokcode-live-filter';
const MODEL_KEY = 'grokcode-model-chip';

/** 尽早打平台 class，避免标题栏布局闪一下 */
(function applyPlatformClass() {
  try {
    const p = window.grok?.platform || '';
    const isWin = p === 'win32' || /Win/i.test(navigator.platform || '');
    const isMac = p === 'darwin' || /Mac/i.test(navigator.platform || '');
    document.body.classList.toggle('plat-win', isWin);
    document.body.classList.toggle('plat-mac', isMac);
    document.body.classList.toggle('plat-linux', !isWin && !isMac);
  } catch {
    /* ignore */
  }
})();

/** Common model presets — empty string = CLI default (fallback if grok models fails) */
const MODEL_PRESETS = [
  { id: '', label: 'CLI 默认' },
  { id: 'grok-build', label: 'grok-build' },
  { id: 'grok-4.5', label: 'grok-4.5' },
  { id: 'grok-4', label: 'grok-4' },
];

/** Live catalog from `grok models` / ACP modelState (merged into chip menu) */
let _liveModels = { models: [], defaultId: '', at: 0, source: '' };

function mergeModelMenuItems() {
  const items = [{ id: '', label: localeIsEn() ? 'CLI default' : 'CLI 默认' }];
  const seen = new Set(['']);
  const live = Array.isArray(_liveModels.models) ? _liveModels.models : [];
  for (const m of live) {
    const id = String(m.id || m.name || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const star = m.isDefault || id === _liveModels.defaultId ? ' ★' : '';
    items.push({ id, label: `${id}${star}` });
  }
  // Keep static presets that aren't already listed
  for (const p of MODEL_PRESETS) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    items.push({ id: p.id, label: p.label });
  }
  return items;
}

async function refreshLiveModels(opts = {}) {
  if (!window.grok?.listModels) return _liveModels;
  // Cache 2 min unless force
  if (
    !opts.force &&
    _liveModels.models?.length &&
    Date.now() - (_liveModels.at || 0) < 120_000
  ) {
    return _liveModels;
  }
  try {
    const r = await window.grok.listModels();
    if (r?.ok && Array.isArray(r.models) && r.models.length) {
      _liveModels = {
        models: r.models,
        defaultId: r.defaultId || '',
        at: Date.now(),
        source: r.source || (r.fromCache ? 'cache' : 'cli'),
      };
    }
  } catch {
    /* keep previous */
  }
  return _liveModels;
}

/** CLI /effort levels (session/set_model meta.reasoning_effort) */
const EFFORT_PRESETS = [
  { id: '', label: 'effort · default' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
];
const EFFORT_KEY = 'grokcode-reasoning-effort';

const state = {
  // CLI owns session mode (/plan, Shift+Tab, YOLO) — host no longer invents craft/plan/ask/goal
  workMode: 'cli',
  /** low|medium|high|xhigh|'' — set_model meta + --reasoning-effort */
  reasoningEffort: loadJson(EFFORT_KEY, '') || '',
  workspace: null,
  treeData: [],
  currentFile: null,
  dirty: false,
  lastDiffs: [],
  unsubs: [],
  termHistory: loadJson(TERM_HIST_KEY, []),
  termHistIdx: -1,
  filesCollapsed: true,
  termCollapsed: true,
  /** Live 右侧详情（焦点/变更/上下文）默认折叠，界面更干净 */
  liveSideCollapsed: loadJson('grokcode-live-side-collapsed', true) !== false,
  /** agent | pilot | review | full — Codex/ZCode 式布局预设 */
  layoutMode: loadJson('grokcode-layout-mode', 'agent') || 'agent',
  /** 超宽自动 Pilot（≥1600）— 默认关，避免布局乱跳 */
  autoPilot: loadJson('grokcode-auto-pilot', false) === true,
  autoPilotApplied: false,
  /** 离线 storyboard 胶片条回灌（JSON/HTML/AES） */
  storyboardOverlay: null,
  filter: '',
  /** Live / Diff（工作区级共享） */
  activeTab: 'live',
  followAgent: true,
  activity: [],
  /** all | write | tool | error | signal */
  liveFilter: loadJson(LIVE_FILTER_KEY, 'all') || 'all',
  /** path -> change entry */
  changes: new Map(),
  contentCache: new Map(),
  selectedDiffPath: null,
  fsDebounce: new Map(),
  focusPath: null,
  _restoring: false,
  /** model id string; empty = CLI default */
  model: '',
  /** collapsed diff hunk indices for current file view */
  diffHunkCollapsed: new Set(),
  /** multi-select paths in Diff list */
  diffSelected: new Set(),
  /** unified | split */
  diffViewMode: loadJson('grokcode-diff-view', 'unified') || 'unified',
  /** composer paste attachments (session-only) */
  attachments: [],
  /** play chime when background task finishes */
  notifySound: loadJson('grokcode-notify-sound', true) !== false,
  /** show blame heat legend in Diff — default off (saves chrome height) */
  diffHeatLegend: loadJson('grokcode-diff-heat-legend', false) === true,
  /** Diff advanced chrome: filmstrip / exports / notes (default collapsed) */
  diffChromeOpen: loadJson('grokcode-diff-chrome-open', false) === true,
  /** Checkpoint bar expanded (default collapsed to one row) */
  diffCpOpen: loadJson('grokcode-diff-cp-open', false) === true,
  /** global turn scrubber key (turnId or ts-*) or null */
  diffScrubTurn: null,
  /** auto-play scrub through turns */
  diffScrubPlaying: false,
  diffScrubPlayTimer: null,
  /** base interval ms at 1x */
  diffScrubPlayMs: 1400,
  /** playback speed multiplier 0.5 | 1 | 1.5 | 2 */
  diffScrubPlaySpeed: loadJson('grokcode-diff-scrub-speed', 1) || 1,
  /** loop playback when scrubbing turns */
  diffScrubLoop: loadJson('grokcode-diff-scrub-loop', false) === true,
};

/** 当前激活任务 */
function T() {
  return window.TaskStore.active();
}

/** 当前任务消息面板 */
function messagesEl() {
  return T()?.pane || document.querySelector('.messages');
}

/** 是否有任意任务在跑 */
function anyRunning() {
  return window.TaskStore.countRunningAll
    ? window.TaskStore.countRunningAll() > 0
    : window.TaskStore.countRunning() > 0;
}

/** 当前项目 */
function P() {
  return window.ProjectStore.active();
}

function requireProject() {
  const p = P();
  if (!p) throw new Error('请先打开项目');
  return p;
}

function pid() {
  return requireProject().id;
}

function changesMap() {
  return requireProject().changes;
}

function contentCacheMap() {
  return requireProject().contentCache;
}


// ── Init ────────────────────────────────────────────────
async function init() {
  // 平台 class：Windows 用系统 titleBarOverlay，隐藏自定义 ─□✕
  const plat = window.grok?.platform || (navigator.platform || '').toLowerCase();
  const isWin = plat === 'win32' || /win/i.test(String(plat));
  const isMac = plat === 'darwin' || /mac/i.test(String(plat));
  document.body.classList.toggle('plat-win', isWin);
  document.body.classList.toggle('plat-mac', isMac);
  document.body.classList.toggle('plat-linux', !isWin && !isMac);
  document.body.dataset.platform = isWin ? 'win32' : isMac ? 'darwin' : 'linux';

  restoreLayout();
  bindUi();
  bindWorkModeUi(); // early — must not wait on project restore (chips become dead)
  bindResizers();
  bindShortcuts();
  bindAgentEvents();
  bindWindowControls();
  await refreshConfigUi();

  // 同步主进程已打开的项目列表
  try {
    const list = await window.grok.projectList();
    for (const info of list || []) {
      window.ProjectStore.add(info);
    }
  } catch (e) {
    console.warn(e);
  }

  if (window.ProjectStore.count() > 0) {
    const p = P();
    setWorkspaceLabel(p.path);
    ensureAtLeastOneTask();
    await loadTree();
  } else {
    setWorkspaceLabel(null);
  }

  // 从磁盘恢复各项目的对话 / 四档上下文
  await restoreAllProjectsFromDisk();

  renderProjectTabs();
  switchTab('live');
  syncFilesRail();
  updateEditorChrome();
  updateLiveStats();
  renderTaskTabs();
  refreshTaskQueueHint();
  renderContextTiers(T());
  bindPersistHooks();

  // 暴露给命令面板
  window.switchProject = switchProject;
  window.renderTaskTabs = renderTaskTabs;

  syncAutoPilotUi();
  maybeAutoPilot({ toast: false });
  // sync mode from config if present (local chips already bound)
  try {
    const cfg = await window.grok.getConfig();
    if (cfg.workMode) setWorkMode(cfg.workMode, { persistRemote: false });
    if (cfg.model != null && cfg.model !== '') {
      state.model = String(cfg.model);
      saveJson(MODEL_KEY, state.model);
      applyModelChip();
    }
    if (cfg.reasoningEffort != null) {
      state.reasoningEffort = String(cfg.reasoningEffort || '');
      saveJson(EFFORT_KEY, state.reasoningEffort);
      applyEffortChip();
    }
  } catch {
    /* ignore */
  }

  // i18n + theme first paint
  try {
    window.GrokI18n?.applyDom?.();
    window.GrokThemes?.init?.();
  } catch (e) {
    console.warn('i18n/theme', e);
  }

  // renderer error → optional telemetry
  window.addEventListener('error', (ev) => {
    window.grok?.telemetryReport?.({
      message: ev.message || 'renderer error',
      kind: 'window.error',
      extra: { filename: ev.filename, lineno: ev.lineno },
    });
  });

  // 首启向导（boot 结束后再弹，避免叠层）
  const showOnb = () => {
    try {
      window.GrokOnboarding?.maybeShow?.();
    } catch (e) {
      console.warn('onboarding', e);
    }
  };
  if (document.body.classList.contains('booted') || !document.getElementById('bootScreen')) {
    setTimeout(showOnb, 200);
  } else {
    window.addEventListener('grok:booted', () => setTimeout(showOnb, 150), { once: true });
  }

  // 项目从向导打开时刷新 UI
  window.addEventListener('grok:project-opened', async (e) => {
    const info = e.detail;
    if (!info) return;
    window.ProjectStore.add(info);
    window.ProjectStore.setActive(info.id);
    setWorkspaceLabel(info.path);
    ensureAtLeastOneTask();
    await loadTree();
    renderProjectTabs();
    renderTaskTabs();
  });
}

// ── 持久化 + 四档上下文 ─────────────────────────────────
let persistTimer = null;
let lastPersistAt = 0;

function schedulePersist(immediate = false) {
  clearTimeout(persistTimer);
  if (immediate) {
    persistAllProjects().catch((e) => console.warn('persist', e));
    return;
  }
  persistTimer = setTimeout(() => {
    persistAllProjects().catch((e) => console.warn('persist', e));
  }, 800);
}

function bindPersistHooks() {
  window.addEventListener('beforeunload', () => {
    // 尽力同步落盘（Electron 下 beforeunload 时间有限）
    try {
      snapshotActiveEditor();
      // 同步 XHR 不可用；用 sendBeacon 也不行 — 依赖 debounced save + 关键路径已 save
      persistAllProjects();
    } catch {
      /* ignore */
    }
  });
  $('#btnRefreshContext')?.addEventListener('click', async () => {
    const task = T();
    if (!task) return;
    await refreshTaskContext(task);
    renderContextTiers(task);
    toast(t('live.context.done', '上下文已重新整理'), 'ok');
    schedulePersist(true);
  });
  // 周期性自动保存
  setInterval(() => schedulePersist(false), 20000);
}

function buildProjectSnapshot(proj) {
  if (!proj) return null;
  const tasks = (proj.tasks || []).map((t) => ({
    id: t.id,
    title: t.title,
    sessionId: t.sessionId,
    messages: (t.messages || []).slice(-200),
    context: t.context || null,
    contextTiers: t.contextTiers || null,
    toolCount: t.toolCount || 0,
    createdAt: t.createdAt,
    pinned: Boolean(t.pinned),
    goal: t.goal
      ? {
          title: String(t.goal.title || '').slice(0, 200),
          status: t.goal.status || 'active',
          progress: typeof t.goal.progress === 'number' ? t.goal.progress : 0,
          next: t.goal.next ? String(t.goal.next).slice(0, 160) : '',
          updatedAt: t.goal.updatedAt || Date.now(),
        }
      : null,
  }));
  return {
    path: proj.path,
    name: proj.name,
    activeTaskId: proj.activeTaskId,
    currentFile: proj.currentFile,
    tasks,
  };
}

async function persistAllProjects() {
  const list = window.ProjectStore.list();
  for (const proj of list) {
    // 若当前项目，同步 editor 缓冲
    if (P()?.id === proj.id) snapshotActiveEditor();
    const snap = buildProjectSnapshot(proj);
    if (!snap) continue;
    await window.grok.persistSave(snap);
  }
  lastPersistAt = Date.now();
  showPersistChip();
}

function showPersistChip() {
  let el = document.getElementById('persistChip');
  if (!el) {
    const bar = $('#projectBar');
    if (!bar) return;
    el = document.createElement('span');
    el.id = 'persistChip';
    el.className = 'persist-chip';
    bar.appendChild(el);
  }
  el.textContent = '● 已继承保存';
  el.title = `已保存到本地 · ${new Date(lastPersistAt).toLocaleTimeString()}`;
}

function pathKey(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function restoreAllProjectsFromDisk() {
  // Always merge ~/.grok-code/sessions index — do not require empty ProjectStore.
  // (Bug: only restored snaps when list was empty; one "recent" project blocked the rest.)
  let merged = 0;
  try {
    const snaps = await window.grok.persistList();
    const openKeys = new Set(
      window.ProjectStore.list().map((p) => pathKey(p.path))
    );
    for (const s of snaps || []) {
      if (!s?.path || openKeys.has(pathKey(s.path))) continue;
      try {
        const info = await window.grok.projectOpenPath(s.path);
        if (info) {
          window.ProjectStore.add(info);
          openKeys.add(pathKey(info.path || s.path));
          merged += 1;
        }
      } catch (e) {
        console.warn('restore open', s.path, e);
      }
    }
  } catch (e) {
    console.warn('persistList', e);
  }

  // Hydrate tasks/messages for every open project from disk snapshots
  for (const proj of window.ProjectStore.list()) {
    await restoreProjectFromDisk(proj);
  }

  if (window.ProjectStore.count() > 0) {
    const p = P();
    if (p) {
      setWorkspaceLabel(p.path);
      window.TaskStore?.onProjectSwitch?.();
      try {
        await loadTree();
      } catch {
        /* ignore */
      }
    }
    if (merged > 0) {
      toast(
        t('projects.restored', `已恢复 ${window.ProjectStore.count()} 个项目的上下文`, {
          n: window.ProjectStore.count(),
        }),
        'ok'
      );
    }
  }
}

async function restoreProjectFromDisk(proj) {
  if (!proj?.path) return;
  const snap = await window.grok.persistLoad(proj.path);
  if (!snap || !Array.isArray(snap.tasks) || !snap.tasks.length) {
    // 无快照则确保至少一任务
    if (!(proj.tasks || []).length) {
      window.ProjectStore.setActive(proj.id);
      ensureAtLeastOneTask();
    }
    return;
  }

  // 清掉默认空任务 panes（若有）
  document.querySelectorAll(`#messagesHost .messages[data-project-id="${proj.id}"]`).forEach((el) => el.remove());
  proj.tasks = [];
  proj.taskSeq = 0;
  proj.activeTaskId = null;

  window.ProjectStore.setActive(proj.id);
  for (const td of snap.tasks) {
    const t = window.TaskStore.create({
      id: td.id,
      title: td.title || '任务',
      sessionId: td.sessionId || null,
      messages: td.messages || [],
      context: td.context || null,
      contextTiers: td.contextTiers || null,
      pinned: Boolean(td.pinned),
      createdAt: td.createdAt,
    });
    t.toolCount = td.toolCount || 0;
    t.createdAt = td.createdAt || t.createdAt;
    t.pinned = Boolean(td.pinned);
    if (td.goal?.title) {
      t.goal = {
        title: String(td.goal.title).slice(0, 200),
        status: td.goal.status || 'active',
        progress: typeof td.goal.progress === 'number' ? td.goal.progress : 0,
        next: td.goal.next ? String(td.goal.next).slice(0, 160) : '',
        updatedAt: td.goal.updatedAt || Date.now(),
      };
    }
    // 重绘消息
    rebuildTaskMessages(t);
  }
  const activeId = snap.activeTaskId && proj.tasks.find((t) => t.id === snap.activeTaskId)
    ? snap.activeTaskId
    : proj.tasks[0]?.id;
  if (activeId) window.TaskStore.setActive(activeId);
  if (snap.currentFile) proj.currentFile = snap.currentFile;
  renderTaskTabs();
  renderContextTiers(T());
  renderGoalTrack(T());
}

function rebuildTaskMessages(task) {
  if (!task?.pane) return;
  const msgs = task.messages || [];
  if (!msgs.length) {
    task.pane.innerHTML = '';
    showWelcome(task.pane);
    return;
  }
  // 长对话：虚拟化（只渲染尾部 + 加载更早）
  if (window.GrokChatVirtual && msgs.length > window.GrokChatVirtual.TAIL) {
    window.GrokChatVirtual.rebuildVirtual(task.pane, msgs, {
      showWelcome: () => showWelcome(task.pane),
      renderOne: (m) =>
        window.GrokChatVirtual.makeMessageEl(m, { renderMarkdown, esc }),
    });
    scrollMessages(true, task);
    return;
  }
  task.pane.innerHTML = '';
  for (const m of msgs) {
    // persist:false 避免重复写入 messages
    appendMessage(m.role, m.content, { markdown: m.role === 'assistant', persist: false }, task);
  }
}

async function refreshTaskContext(task) {
  if (!task || !P()) return null;
  try {
    const changedFiles = [...changesMap().keys()];
    const lastTurn = Array.isArray(task.turns) && task.turns.length
      ? task.turns[task.turns.length - 1]
      : null;
    const ctx = await window.grok.compressContext({
      messages: task.messages || [],
      prevContext: task.context || {},
      projectName: P().name,
      taskTitle: task.title || '',
      workMode: task.turnMode || state.workMode || '',
      turns: task.turns || [],
      changedFiles,
      lastStopped: Boolean(lastTurn?.stopped),
    });
    task.context = ctx;
    task.contextTiers = ctx.tiers;
    return ctx;
  } catch (e) {
    console.warn('compress', e);
    return null;
  }
}

function renderContextTiers(task) {
  const host = $('#contextTiers');
  if (!host) return;
  task = task || T();
  if (!task?.context && !task?.contextTiers) {
    host.innerHTML = `<div class="muted">对话开始后实时压缩 L0–L3<br>关闭重开会自动继承</div>`;
    return;
  }
  const c = task.context || {};
  const modeHint =
    c.mode === 'llm'
      ? '<div class="muted" style="margin-bottom:6px;font-size:11px">模式：LLM 摘要</div>'
      : c.llm && c.llm.used === false && c.llm.reason
        ? `<div class="muted" style="margin-bottom:6px;font-size:11px">模式：启发式（LLM 未用：${esc(String(c.llm.reason).slice(0, 40))}）</div>`
        : '';
  const tiers = task.contextTiers || c.tiers || [
    { id: 'L0', name: '即时原文', chars: 0 },
    { id: 'L1', name: '近端摘要', chars: (c.l1 || '').length },
    { id: 'L2', name: '会话脉络', chars: (c.l2 || '').length },
    { id: 'L3', name: '项目记忆', chars: (c.l3 || '').length },
  ];
  const bodyOf = (id) => {
    if (id === 'L0') {
      return (c.l0 || [])
        .map((m) => `${m.role}: ${String(m.content || '').slice(0, 280)}`)
        .join('\n\n') || '（空）';
    }
    if (id === 'L1') return c.l1 || '（空）';
    if (id === 'L2') return c.l2 || '（空）';
    if (id === 'L3') return c.l3 || '（空）';
    return '';
  };
  host.innerHTML =
    modeHint +
    tiers
      .map((t) => {
        const chars = t.chars ?? bodyOf(t.id).length;
        return `<div class="tier-card" data-tier="${t.id}">
        <div><span class="tier-id">${t.id}</span><span class="tier-name">${esc(t.name || t.id)}</span></div>
        <div class="tier-meta">${chars} chars${t.count != null ? ` · ${t.count} msgs` : ''} · ${esc(t.desc || '')}</div>
        <div class="tier-body"></div>
      </div>`;
      })
      .join('');
  host.querySelectorAll('.tier-card').forEach((card) => {
    card.onclick = () => {
      const open = card.classList.toggle('open');
      const body = card.querySelector('.tier-body');
      if (open) body.textContent = bodyOf(card.dataset.tier);
    };
  });
}

// ── 多项目 UI ───────────────────────────────────────────
function renderProjectTabs() {
  const host = $('#projectTabs');
  if (!host) return;
  const list = window.ProjectStore.list();
  const activeId = window.ProjectStore.activeId;
  if (!list.length) {
    host.innerHTML = `<div class="muted" style="font-size:12px;padding:4px 8px">${esc(
      t('projects.none')
    )}</div>`;
    return;
  }
  host.innerHTML = list
    .map((p) => {
      const act = p.id === activeId ? ' active' : '';
      const running = (p.tasks || []).some((t) => t.running);
      const run = running ? ' running' : '';
      return `<div class="project-tab${act}${run}" data-id="${p.id}" title="${esc(p.path)}">
        <span class="p-dot"></span>
        <span class="p-name">${esc(p.name)}</span>
        <button type="button" class="p-x" data-close="${p.id}" title="关闭项目">×</button>
      </div>`;
    })
    .join('');

  host.querySelectorAll('.project-tab').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.p-x')) return;
      switchProject(el.dataset.id);
    };
  });
  host.querySelectorAll('.p-x').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      closeProject(btn.dataset.close);
    };
  });
}

async function switchProject(id) {
  // 供命令面板等模块调用
  window.switchProject = switchProject;
  // 保存当前项目的 Live / Code / Diff 视图状态
  snapshotActiveProjectView();

  const p = window.ProjectStore.setActive(id);
  if (!p) return;
  setWorkspaceLabel(p.path);
  window.TaskStore.hideOtherProjects();
  window.TaskStore.onProjectSwitch();
  if (!window.TaskStore.list().length) {
    ensureAtLeastOneTask();
  } else {
    renderTaskTabs();
    const t = T();
    if (t) syncComposerToTask(t);
  }

  // 恢复该项目的 Live / Code / Diff（三面板跟项目走）
  await restoreProjectView(p);
  // restore Diff scrub selection for this project
  restoreScrubSelection();
  if (state.activeTab === 'diff') renderDiffPane();

  await loadTree();
  renderProjectTabs();
  schedulePersist(true);
  toast(t('projects.switched', `切换到项目：${p.name}`, { name: p.name }));
}

/** 切换项目前：把当前 UI 状态写回旧项目对象 */
function snapshotActiveProjectView() {
  const p = P();
  if (!p) return;
  p.activeTab = state.activeTab || p.activeTab || 'live';
  const ed = $('#editor');
  if (ed && p.currentFile) {
    p.editorContent = ed.value;
    p.dirty = state.dirty || p.dirty;
  }
  // activity 已在 pushLiveEvent 时写入 p.activity
  p.livePhase = $('#livePhase')?.textContent || p.livePhase;
  p.liveDetail = $('#liveDetail')?.textContent || p.liveDetail;
}

function snapshotActiveEditor() {
  snapshotActiveProjectView();
}

/** 切换项目后：整页 Live/Code/Diff 跟新项目对齐 */
async function restoreProjectView(p) {
  if (!p) return;

  // 1) 恢复 Live 时间线 + 变更 + 焦点 + 相位
  rebuildLiveTimeline(p);
  renderLiveChanges();
  if (p.focusPath) {
    setLiveFocus(p.focusPath, p.focusSnippet || '', { persist: false });
  } else {
    const el = $('#liveFocus');
    if (el) el.innerHTML = '<div class="muted">Agent 读/写文件时出现在这里</div>';
  }
  if ($('#livePhase')) $('#livePhase').textContent = p.livePhase || '待命';
  if ($('#liveDetail')) $('#liveDetail').textContent = p.liveDetail || '';

  // 2) 恢复 Code：优先从磁盘重读，保证是该项目文件
  await restoreProjectEditor(p);

  // 3) 恢复 Diff 选中与内容
  renderDiffPane();

  // 4) 切到该项目上次停留的页签
  const tab = p.activeTab || 'live';
  switchTab(tab, { skipProjectWrite: true });

  renderContextTiers(T());
  updateEditorChrome();
  updateLiveStats();

  // 状态芯片：反映当前项目任务是否在跑
  const t = T();
  if (t?.running) {
    setAgentStatus('grokking…', true);
    setRunningUi(true);
  } else {
    setAgentStatus('待命', false);
    setRunningUi(false);
  }
}

async function restoreProjectEditor(p) {
  const ed = $('#editor');
  if (!ed) return;
  if (p.currentFile) {
    try {
      const data = await window.grok.readFile(p.id, p.currentFile);
      if (!data.error) {
        // 若有未保存缓冲且 dirty，优先缓冲；否则用磁盘
        if (p.dirty && p.editorContent != null && p.editorContent !== '') {
          ed.value = p.editorContent;
        } else {
          ed.value = data.content;
          p.editorContent = data.content;
          p.dirty = false;
          if (!p.contentCache.has(p.currentFile)) {
            p.contentCache.set(p.currentFile, data.content);
          }
        }
        $('#currentPath').textContent = p.currentFile;
      } else {
        ed.value = p.editorContent || '';
        $('#currentPath').textContent = p.currentFile + ' (缺失)';
      }
    } catch {
      ed.value = p.editorContent || '';
      $('#currentPath').textContent = p.currentFile || '—';
    }
  } else {
    ed.value = '';
    $('#currentPath').textContent = '—';
    p.dirty = false;
  }
  syncGutter();
}

function filterLiveEvents(events, filter) {
  const f = filter || state.liveFilter || 'all';
  if (!f || f === 'all') return events || [];
  return (events || []).filter((ev) => {
    const k = ev.kind || 'status';
    if (f === 'write') return k === 'write';
    if (f === 'tool') return k === 'tool';
    if (f === 'error') return k === 'error';
    if (f === 'signal') return k === 'status' || k === 'done' || k === 'error';
    return true;
  });
}

function setLiveFilter(filter, opts = {}) {
  const allowed = ['all', 'write', 'tool', 'error', 'signal'];
  const f = allowed.includes(filter) ? filter : 'all';
  state.liveFilter = f;
  saveJson(LIVE_FILTER_KEY, f);
  document.querySelectorAll('.live-filter-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === f);
  });
  if (opts.rebuild !== false) rebuildLiveTimeline(P());
}

function bindLiveFilterUi() {
  let bar = document.getElementById('liveFilterBar');
  if (!bar) {
    const status = document.getElementById('liveStatusBar');
    if (!status) return;
    bar = document.createElement('div');
    bar.id = 'liveFilterBar';
    bar.className = 'live-filter-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Live filter');
    const chips = [
      ['all', '全部'],
      ['write', '写入'],
      ['tool', '工具'],
      ['error', '错误'],
      ['signal', '信号'],
    ];
    bar.innerHTML = chips
      .map(
        ([id, label]) =>
          `<button type="button" class="live-filter-chip${state.liveFilter === id ? ' active' : ''}" data-filter="${id}">${label}</button>`
      )
      .join('');
    status.insertAdjacentElement('afterend', bar);
  }
  bar.querySelectorAll('.live-filter-chip').forEach((btn) => {
    btn.onclick = () => setLiveFilter(btn.dataset.filter);
  });
  setLiveFilter(state.liveFilter, { rebuild: false });
}

function rebuildLiveTimeline(proj) {
  const box = $('#liveTimeline');
  if (!box) return;
  const raw = proj?.activity || [];
  const events = filterLiveEvents(raw, state.liveFilter);
  if (!raw.length) {
    box._virt = null;
    box.innerHTML = `<div class="live-empty" id="liveEmpty">
      <div class="grok-sigil" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>Mission Control</h3>
      <p>项目 <strong>${esc(proj?.name || '')}</strong> 的实时动态会出现在这里。</p>
    </div>`;
    return;
  }
  if (!events.length) {
    box._virt = null;
    box.innerHTML = `<div class="live-empty" id="liveEmpty">
      <h3>无匹配事件</h3>
      <p>当前过滤：<strong>${esc(state.liveFilter)}</strong> · 切换上方芯片查看全部</p>
    </div>`;
    return;
  }
  if (window.GrokLiveVirtual?.renderVirtualTimeline) {
    window.GrokLiveVirtual.renderVirtualTimeline(box, events, { esc, forceBottom: true });
  } else {
    box.innerHTML = '';
    for (const ev of events.slice(-120)) {
      const row = document.createElement('div');
      const ts = ev.ts ? new Date(ev.ts) : new Date();
      const t = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(
        ts.getSeconds()
      ).padStart(2, '0')}`;
      row.className = `live-event ${ev.kind || 'status'}`;
      row.innerHTML = `
      <div class="t">${t}</div>
      <div class="dot"></div>
      <div class="card">
        <div class="kind">${esc(ev.kind || 'status')}</div>
        <div class="title">${esc(ev.title || '')}</div>
        ${ev.sub ? `<div class="sub">${esc(ev.sub)}</div>` : ''}
      </div>`;
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
  }
  // Re-attach sticky stream/thought mirrors wiped by rebuild (virtual or plain)
  const task = T();
  if (task?.running && (task.streamBuf || task.thoughtBuf)) {
    paintLiveStreamMirrors(task);
  }
}

async function openProjectFlow({ newWindow = false } = {}) {
  try {
    const info = newWindow
      ? await window.grok.projectOpenInNewWindow()
      : await window.grok.projectOpen();
    if (!info) return;
    if (newWindow) {
      toast(`已在新窗口打开：${info.name}`, 'ok');
      // 本窗口也挂载，方便统一列表
      window.ProjectStore.add(info);
      renderProjectTabs();
      return;
    }
    snapshotActiveEditor();
    window.ProjectStore.add(info);
    setWorkspaceLabel(info.path);
    const proj = window.ProjectStore.list().find((x) => x.id === info.id || x.path === info.path);
    if (proj) {
      await restoreProjectFromDisk(proj);
      if (!(proj.tasks || []).length) ensureAtLeastOneTask();
    } else {
      ensureAtLeastOneTask();
    }
    await loadTree();
    renderProjectTabs();
    renderTaskTabs();
    renderContextTiers(T());
    updateEditorChrome();
    schedulePersist(true);
    toast(`已挂载项目：${info.name}（上下文可跨次启动继承）`, 'ok');
  } catch (err) {
    toast(err.message || '打开失败', 'err');
  }
}

async function closeProject(id) {
  const p = window.ProjectStore.get(id);
  if (!p) return;
  const running = (p.tasks || []).some((t) => t.running);
  if (running) {
    const ok = confirm(`项目「${p.name}」仍有任务在运行，关闭将停止该项目所有 Agent？`);
    if (!ok) return;
  }
  try {
    await window.grok.stopAgent({ projectId: id });
  } catch {
    /* ignore */
  }
  // 移除消息 panes
  document.querySelectorAll(`#messagesHost .messages[data-project-id="${id}"]`).forEach((el) => el.remove());
  await window.grok.projectClose(id);
  window.ProjectStore.remove(id);
  if (window.ProjectStore.count() === 0) {
    setWorkspaceLabel(null);
    $('#fileTree').innerHTML = `<div class="empty-hint"><div class="empty-ico grok-eye">◉</div><p>打开项目后即可浏览文件</p><button class="btn small primary" id="btnOpenEmpty2">选择文件夹</button></div>`;
    $('#btnOpenEmpty2')?.addEventListener('click', () => openProjectFlow());
    $('#messagesHost').innerHTML = '';
    renderTaskTabs();
  } else {
    const cur = P();
    if (cur) await switchProject(cur.id);
  }
  renderProjectTabs();
  toast('项目已关闭');
}

// ── 多任务 UI ───────────────────────────────────────────
function ensureAtLeastOneTask() {
  if (!P()) return;
  if (!window.TaskStore.list().length) {
    const t = window.TaskStore.create({ title: '任务 1' });
    window.TaskStore.setActive(t.id);
    showWelcome(t.pane);
  } else if (!window.TaskStore.active()) {
    window.TaskStore.setActive(window.TaskStore.list()[0].id);
  }
  window.TaskStore.onProjectSwitch();
}

function taskPhaseLabel(t) {
  if (!t?.running) return '';
  const p = t.phase || 'running';
  const map = {
    boot: '启动',
    running: '运行',
    thinking: '思考',
    tool: '工具',
    streaming: '输出',
    retry: '重试',
    max_turns: '轮次上限',
  };
  return map[p] || p;
}

function renderTaskTabs() {
  const host = $('#taskTabs');
  if (!host) return;
  const list = window.TaskStore.list();
  const activeId = window.TaskStore.activeId;
  host.innerHTML = list
    .map((t) => {
      const act = t.id === activeId ? ' active' : '';
      const run = t.running ? ' running' : '';
      const pin = t.pinned ? ' pinned' : '';
      const phase = t.running && t.phase ? ` phase-${esc(t.phase)}` : '';
      const phaseTip = t.running
        ? ` · ${taskPhaseLabel(t)}${t.phaseDetail ? `: ${t.phaseDetail}` : ''}`
        : '';
      return `<div class="task-tab${act}${run}${pin}${phase}" data-id="${t.id}" draggable="true" title="${esc(t.title)}${esc(phaseTip)} · 双击重命名 · 拖拽排序">
        <button type="button" class="task-pin" data-pin="${t.id}" title="${t.pinned ? '取消固定' : '固定'}">${t.pinned ? '📌' : '📍'}</button>
        <span class="task-dot"></span>
        <span class="task-name" data-rename="${t.id}">${esc(t.title)}</span>
        ${t.running ? `<span class="task-phase">${esc(taskPhaseLabel(t))}</span>` : ''}
        <button type="button" class="task-x" data-close="${t.id}" title="关闭任务">×</button>
      </div>`;
    })
    .join('');

  host.querySelectorAll('.task-tab').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.task-x') || e.target.closest('.task-pin') || e.target.closest('input.task-rename')) return;
      switchTask(el.dataset.id);
    };
    el.ondblclick = (e) => {
      if (e.target.closest('.task-x') || e.target.closest('.task-pin')) return;
      e.preventDefault();
      e.stopPropagation();
      beginTaskRename(el.dataset.id);
    };
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/task-id', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromId = e.dataTransfer.getData('text/task-id');
      const toId = el.dataset.id;
      if (!fromId || fromId === toId) return;
      const p = P();
      if (!p?.tasks) return;
      const toIdx = p.tasks.findIndex((t) => t.id === toId);
      if (toIdx < 0) return;
      window.TaskStore.move(fromId, toIdx);
      renderTaskTabs();
      schedulePersist(true);
    });
  });
  host.querySelectorAll('.task-x').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      closeTask(btn.dataset.close);
    };
  });
  host.querySelectorAll('.task-pin').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      window.TaskStore.togglePin(btn.dataset.pin);
      renderTaskTabs();
      schedulePersist(true);
      toast(
        window.TaskStore.get(btn.dataset.pin)?.pinned
          ? localeIsEn()
            ? 'Pinned'
            : '已固定'
          : localeIsEn()
            ? 'Unpinned'
            : '已取消固定',
        'ok'
      );
    };
  });
  refreshTaskQueueHint();
}

/** Double-click task tab → inline rename */
function beginTaskRename(taskId) {
  const task = window.TaskStore.get(taskId);
  const host = $('#taskTabs');
  if (!task || !host) return;
  const tab = host.querySelector(`.task-tab[data-id="${cssEscape(taskId)}"]`);
  const nameEl = tab?.querySelector('.task-name');
  if (!tab || !nameEl || nameEl.querySelector('input')) return;
  switchTask(taskId);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-rename';
  input.value = task.title || '';
  input.setAttribute('aria-label', '重命名任务');
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (ok) => {
    if (done) return;
    done = true;
    if (ok) {
      const next = input.value.trim().slice(0, 48);
      if (next && next !== task.title) {
        task.title = next;
        schedulePersist(true);
        toast(localeIsEn() ? `Renamed: ${next}` : `已重命名：${next}`, 'ok');
      }
    }
    renderTaskTabs();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commit(false);
    }
    e.stopPropagation();
  };
  input.onblur = () => commit(true);
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
}

function refreshTaskQueueHint() {
  const n = window.TaskStore.list().length;
  const r = window.TaskStore.countRunning();
  const rAll = window.TaskStore.countRunningAll
    ? window.TaskStore.countRunningAll()
    : r;
  const pc = window.ProjectStore.count();
  const el = $('#taskQueueHint');
  if (el) {
    if (rAll > 1) {
      el.textContent = localeIsEn()
        ? `${rAll} running · fair stream`
        : `${rAll} 并行 · 公平流`;
      el.classList.add('multi-run');
      el.title = localeIsEn()
        ? 'Active task paints first; background streams throttled'
        : '前台任务优先刷新；后台流降频，避免互相抢帧';
    } else {
      el.classList.remove('multi-run');
      el.title = '';
      el.textContent =
        pc > 1
          ? `${pc} projects · ${n} tasks`
          : r > 0
            ? `${n} tasks · ${r} running`
            : `${n} tasks · multi`;
    }
  }
}

function switchTask(id) {
  // save draft of previous task before switch
  savePromptDraft();
  const t = window.TaskStore.setActive(id);
  if (!t) return;
  renderTaskTabs();
  syncComposerToTask(t);
  loadPromptDraft(t);
  renderContextTiers(t);
  renderGoalTrack(t);
  // Fairness: immediately catch up stream paint for focused task
  if (t.running) StreamFair.flushTask(t);
  // 状态条反映当前任务
  if (t.running) {
    const phase = taskPhaseLabel(t) || 'grokking…';
    setAgentStatus(t.phaseDetail || phase, true);
    setLivePhase(t.phaseDetail || phase, t.title);
    $('#elapsedTimer')?.classList.remove('hidden');
  } else {
    setAgentStatus('待命', false);
    $('#elapsedTimer')?.classList.add('hidden');
  }
  setRunningUi(t.running);
  refreshTaskQueueHint();
  schedulePersist();
}

function addTask(title) {
  if (!P()) {
    toast('请先添加项目', 'err');
    openProjectFlow();
    return null;
  }
  const t = window.TaskStore.create({ title: title || undefined });
  window.TaskStore.setActive(t.id);
  showWelcome(t.pane);
  renderTaskTabs();
  syncComposerToTask(t);
  renderContextTiers(t);
  setAgentStatus('待命', false);
  setRunningUi(false);
  schedulePersist(true);
  toast(`新任务：${t.title}`, 'ok');
  $('#prompt')?.focus();
  return t;
}

async function closeTask(id) {
  const t = window.TaskStore.get(id);
  if (!t) return;
  if (window.TaskStore.list().length <= 1) {
    toast('至少保留一个任务', 'err');
    return;
  }
  if (t.running) {
    const ok = confirm(`任务「${t.title}」仍在运行，关闭将停止它？`);
    if (!ok) return;
    await window.grok.stopAgent({ projectId: pid(), taskId: t.id });
    t.running = false;
  }
  await window.grok.clearSession({ projectId: pid(), taskId: t.id });
  window.GrokInbox?.removeMatching?.({ taskId: t.id });
  window.TaskStore.remove(id);
  const cur = T();
  if (cur) {
    switchTask(cur.id);
  }
  renderTaskTabs();
  toast('任务已关闭');
}

function syncComposerToTask(t) {
  // 停止按钮随当前任务
  setRunningUi(Boolean(t?.running));
  applySendLabel();
}

// ── 窗口控制 ────────────────────────────────────────────
// Windows：系统 titleBarOverlay 负责 ─□✕（不绑自定义按钮）
// 其它平台：绑定 #winControls 自定义按钮
function bindWindowControls() {
  const isWin = document.body.classList.contains('plat-win');

  const runWin = async (action) => {
    const api = window.grok;
    if (!api) {
      toast('窗口 API 不可用', 'err');
      return;
    }
    try {
      if (action === 'min') await api.windowMinimize();
      else if (action === 'max') {
        const max = await api.windowMaximize();
        syncMaxBtn(max);
      } else if (action === 'close') await api.windowClose();
    } catch (err) {
      console.error('[win]', action, err);
      toast((err && err.message) || '窗口操作失败', 'err');
    }
  };

  if (!isWin) {
    const forceNoDrag = (el) => {
      if (!el) return;
      el.style.setProperty('-webkit-app-region', 'no-drag');
      el.style.setProperty('app-region', 'no-drag');
    };
    document.querySelectorAll('#winControls, #winControls .win-btn, .top-actions').forEach(forceNoDrag);

    const bindWinBtn = (id, action) => {
      const el = document.getElementById(id);
      if (!el) return;
      forceNoDrag(el);
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        runWin(action);
      });
    };
    bindWinBtn('btnWinMin', 'min');
    bindWinBtn('btnWinMax', 'max');
    bindWinBtn('btnWinClose', 'close');
  }

  // 双击拖拽区最大化（系统按钮区域除外）
  document.querySelectorAll('.titlebar-drag').forEach((zone) => {
    zone.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, a, .pill, .win-controls, .top-actions')) return;
      runWin('max');
    });
  });

  window.grok?.on?.('window:maximized', (d) => syncMaxBtn(d?.maximized));
  window.grok?.windowIsMaximized?.().then(syncMaxBtn).catch(() => {});
}

function syncMaxBtn(maximized) {
  const btn = $('#btnWinMax');
  if (!btn) return;
  btn.textContent = maximized ? '❐' : '□';
  btn.title = maximized ? '还原' : '最大化';
  btn.classList.toggle('is-max', Boolean(maximized));
}

function restoreLayout() {
  const L = loadJson(LAYOUT_KEY, null);
  if (!L) {
    // 首次 / Agent 默认：文件树 + 终端 + Live 侧栏全收起，对话主舞台
    state.termCollapsed = true;
    state.liveSideCollapsed = true;
    state.filesCollapsed = true;
    applyLayoutMode(state.layoutMode || 'agent', { persist: false, toast: false });
    applyChromeCollapse();
    return;
  }
  if (L.filesW) document.documentElement.style.setProperty('--files-w', L.filesW + 'px');
  if (L.chatW) document.documentElement.style.setProperty('--chat-w', L.chatW + 'px');
  if (L.termH) document.documentElement.style.setProperty('--term-h', L.termH + 'px');
  if (typeof L.filesCollapsed === 'boolean') state.filesCollapsed = L.filesCollapsed;
  else state.filesCollapsed = true;
  if (typeof L.termCollapsed === 'boolean') state.termCollapsed = L.termCollapsed;
  else state.termCollapsed = true;
  if (typeof L.liveSideCollapsed === 'boolean') state.liveSideCollapsed = L.liveSideCollapsed;
  if (L.layoutMode) state.layoutMode = L.layoutMode;
  applyLayoutMode(state.layoutMode || 'agent', { persist: false, toast: false, skipCollapse: true });
  applyChromeCollapse();
  maybeAutoPilot({ toast: false });
}

const AUTO_PILOT_KEY = 'grokcode-auto-pilot';
const AUTO_PILOT_MIN_W = 1600;
const AUTO_PILOT_HYST_W = 1500;

function getAutoPilotEnabled() {
  return state.autoPilot !== false;
}

function setAutoPilotEnabled(on) {
  state.autoPilot = !!on;
  saveJson(AUTO_PILOT_KEY, state.autoPilot);
  syncAutoPilotUi();
  if (state.autoPilot) maybeAutoPilot({ toast: true, force: true });
}

function syncAutoPilotUi() {
  const btn = document.getElementById('btnAutoPilot');
  if (!btn) return;
  btn.classList.toggle('active', getAutoPilotEnabled());
  btn.setAttribute('aria-pressed', getAutoPilotEnabled() ? 'true' : 'false');
  btn.title = getAutoPilotEnabled()
    ? (localeIsEn() ? 'Auto-Pilot on (≥1600px) — click to disable' : '超宽自动 Pilot 已开（≥1600）· 点击关闭')
    : (localeIsEn() ? 'Auto-Pilot off — click to enable' : '超宽自动 Pilot 已关 · 点击开启');
  syncLayoutPresetUi();
}

/** Highlight Work/Review vs advanced (Pilot/Full) in simplified preset strip */
function syncLayoutPresetUi() {
  const m = state.layoutMode || 'agent';
  document.querySelectorAll('#layoutPresets [data-layout]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === m);
  });
  const moreBtn = document.getElementById('btnLayoutMore');
  const advanced = m === 'pilot' || m === 'full';
  if (moreBtn) {
    moreBtn.classList.toggle('has-advanced', advanced);
    moreBtn.classList.toggle('active', advanced);
    moreBtn.title = advanced
      ? localeIsEn()
        ? `More layouts · current: ${m}`
        : `更多布局 · 当前 ${m === 'pilot' ? 'Pilot' : 'Full'}`
      : localeIsEn()
        ? 'More layouts · Pilot / Full / Auto'
        : '更多布局 · Pilot / Full / Auto';
  }
  document.querySelectorAll('#layoutMoreMenu [data-layout]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === m);
  });
}

function setLayoutMoreOpen(open) {
  const menu = document.getElementById('layoutMoreMenu');
  const btn = document.getElementById('btnLayoutMore');
  if (!menu || !btn) return;
  menu.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function syncCenterTabChrome(name) {
  const tab = name || state.activeTab || 'live';
  document.body.classList.remove('center-tab-live', 'center-tab-editor', 'center-tab-diff');
  const cls =
    tab === 'editor' ? 'center-tab-editor' : tab === 'diff' ? 'center-tab-diff' : 'center-tab-live';
  document.body.classList.add(cls);
  document.body.dataset.centerTab = tab === 'editor' ? 'editor' : tab;
}

/**
 * Ultra-wide (≥1600) → Pilot; shrink below ~1500 → Agent
 * Does not override Review / Full.
 */
function maybeAutoPilot(opts = {}) {
  if (!getAutoPilotEnabled() && !opts.force) return;
  if (!getAutoPilotEnabled()) return;
  const w = window.innerWidth || 0;
  const mode = state.layoutMode || 'agent';
  if (mode === 'review' || mode === 'full') return;

  if (w >= AUTO_PILOT_MIN_W && mode === 'agent') {
    applyLayoutMode('pilot', {
      toast: opts.toast,
      persist: true,
      skipCollapse: opts.skipCollapse !== false,
      fromAuto: true,
    });
    state.autoPilotApplied = true;
  } else if (w < AUTO_PILOT_HYST_W && mode === 'pilot' && (state.autoPilotApplied || opts.force)) {
    applyLayoutMode('agent', {
      toast: opts.toast,
      persist: true,
      skipCollapse: true,
      fromAuto: true,
    });
    state.autoPilotApplied = false;
  }
}
window.maybeAutoPilot = maybeAutoPilot;
window.setAutoPilotEnabled = setAutoPilotEnabled;
window.getAutoPilotEnabled = getAutoPilotEnabled;

/**
 * Agent-first layout presets (Codex / ZCode command-center inspired)
 * - agent: chat right (primary)
 * - pilot: chat center (ultra-wide)
 * - review: explorer + Diff-friendly
 * - full: classic multi-pane
 */
function applyLayoutMode(mode, opts = {}) {
  const m = ['agent', 'pilot', 'review', 'full'].includes(mode) ? mode : 'agent';
  state.layoutMode = m;
  if (!opts.fromAuto) {
    // manual pick: remember if pilot was intentional
    state.autoPilotApplied = m === 'pilot';
  }
  document.body.classList.add('layout-v15');
  document.body.classList.remove(
    'layout-mode-agent',
    'layout-mode-pilot',
    'layout-mode-review',
    'layout-mode-full'
  );
  document.body.classList.add(`layout-mode-${m}`);

  syncLayoutPresetUi();
  syncAutoPilotUi();

  if (!opts.skipCollapse) {
    if (m === 'agent' || m === 'pilot') {
      state.filesCollapsed = true;
      state.termCollapsed = true;
      state.liveSideCollapsed = true;
      document.documentElement.style.setProperty('--chat-w', m === 'pilot' ? '520px' : '480px');
      document.documentElement.style.setProperty('--files-w', '220px');
    } else if (m === 'review') {
      state.filesCollapsed = false;
      state.termCollapsed = true;
      state.liveSideCollapsed = false;
      document.documentElement.style.setProperty('--chat-w', '380px');
      document.documentElement.style.setProperty('--files-w', '250px');
    } else if (m === 'full') {
      state.filesCollapsed = false;
      state.termCollapsed = false;
      state.liveSideCollapsed = false;
      document.documentElement.style.setProperty('--chat-w', '400px');
      document.documentElement.style.setProperty('--files-w', '260px');
      document.documentElement.style.setProperty('--term-h', '160px');
    }
    applyChromeCollapse();
  }

  saveJson('grokcode-layout-mode', m);
  if (opts.persist !== false) persistLayout();
  if (opts.toast) {
    const en = localeIsEn();
    const labels = {
      agent: en ? 'Work · chat + Live' : 'Work · 对话 + Live',
      pilot: en ? 'Pilot · chat center' : 'Pilot · 对话居中',
      review: en ? 'Review · Diff desk' : 'Review · 审阅台',
      full: en ? 'Full · all panes' : 'Full · 全面板',
    };
    toast(labels[m] || m, 'ok');
  }
}
window.applyLayoutMode = applyLayoutMode;

/** Open Diff review bridge — layout Review + Diff tab (+ optional path) */
function openReviewBridge(path) {
  const n = changesMap().size;
  if (!n && !path) {
    toast(localeIsEn() ? 'No changes to review' : '暂无变更可审阅', 'err');
    return;
  }
  if (state.layoutMode === 'agent' || state.layoutMode === 'pilot') {
    applyLayoutMode('review', { toast: false, persist: true });
  }
  if (path && P()) {
    requireProject().selectedDiffPath = path;
  } else if (P() && !P().selectedDiffPath) {
    const first = changesMap().keys().next().value;
    if (first) requireProject().selectedDiffPath = first;
  }
  switchTab('diff');
  updateReviewBridgeUi();
  toast(
    localeIsEn()
      ? `Review · ${n || 1} file(s)`
      : `审阅台 · ${n || 1} 个文件`,
    'ok'
  );
}
window.openReviewBridge = openReviewBridge;

/** Diff → Agent: inject @path into composer and focus chat */
function discussDiffInAgent(path) {
  const p = path || (P() && P().selectedDiffPath);
  if (!p) {
    toast(localeIsEn() ? 'Pick a file in Diff' : '请先在 Diff 选中文件', 'err');
    return;
  }
  const el = document.getElementById('prompt');
  if (!el) return;
  const mention = `@${p}`;
  const cur = el.value || '';
  if (!cur.includes(mention)) {
    el.value = cur.trim() ? `${cur.trim()}\n\n${mention} ` : `${mention} `;
  } else {
    el.focus();
  }
  autoResizePrompt();
  updateCharCount();
  schedulePromptDraftSave();
  el.focus();
  // place caret at end
  try {
    el.selectionStart = el.selectionEnd = el.value.length;
  } catch {
    /* ignore */
  }
  toast(localeIsEn() ? `Discuss ${p}` : `讨论 ${p}`, 'ok');
}
window.discussDiffInAgent = discussDiffInAgent;

function updateReviewBridgeUi() {
  const n = changesMap().size;
  const chip = document.getElementById('btnReviewBridge');
  const label = document.getElementById('reviewBridgeLabel');
  const badge = document.getElementById('diffTabBadge');
  if (chip) {
    chip.classList.toggle('hidden', n <= 0);
    if (label) {
      label.textContent = localeIsEn()
        ? `${n} change${n === 1 ? '' : 's'}`
        : `${n} 变更`;
    }
  }
  if (badge) {
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n <= 0);
  }
}
window.updateReviewBridgeUi = updateReviewBridgeUi;

function applyChromeCollapse() {
  $('#filesPanel')?.classList.toggle('collapsed', state.filesCollapsed);
  const term = $('.terminal-wrap') || $('#terminalWrap');
  term?.classList.toggle('collapsed', state.termCollapsed);
  const termSub = term?.querySelector('.panel-sub');
  if (termSub) termSub.textContent = state.termCollapsed ? '点击 ↕ 展开' : 'workspace shell';
  $('#liveSide')?.classList.toggle('collapsed', state.liveSideCollapsed);
  $('#liveLayout')?.classList.toggle('side-collapsed', state.liveSideCollapsed);
  const sideBtn = $('#btnToggleLiveSide');
  if (sideBtn) {
    sideBtn.setAttribute('aria-expanded', state.liveSideCollapsed ? 'false' : 'true');
    sideBtn.textContent = state.liveSideCollapsed ? '详情 ▹' : '详情 ▿';
  }
  syncFilesRail();
}

function persistLayout() {
  const cs = getComputedStyle(document.documentElement);
  saveJson(LAYOUT_KEY, {
    filesW: parseInt(cs.getPropertyValue('--files-w'), 10),
    chatW: parseInt(cs.getPropertyValue('--chat-w'), 10),
    termH: parseInt(cs.getPropertyValue('--term-h'), 10),
    filesCollapsed: state.filesCollapsed,
    termCollapsed: state.termCollapsed,
    liveSideCollapsed: state.liveSideCollapsed,
    layoutMode: state.layoutMode || 'agent',
  });
  saveJson('grokcode-live-side-collapsed', state.liveSideCollapsed);
  saveJson('grokcode-layout-mode', state.layoutMode || 'agent');
}

// ── Session templates (starters pack) ───────────────────
const USER_TEMPLATES_KEY = 'grokcode-session-templates';
const FAV_TEMPLATES_KEY = 'grokcode-template-favorites';
const SCRUB_KEY = 'grokcode-diff-scrub-v1';
let _bundledTemplates = null;

function getFavoriteIds() {
  const arr = loadJson(FAV_TEMPLATES_KEY, []) || [];
  return new Set(Array.isArray(arr) ? arr : []);
}

function setFavoriteIds(set) {
  saveJson(FAV_TEMPLATES_KEY, [...set].slice(0, 80));
}

function isTemplateFavorite(id) {
  return getFavoriteIds().has(id);
}

function toggleTemplateFavorite(id) {
  if (!id) return false;
  const set = getFavoriteIds();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  setFavoriteIds(set);
  return set.has(id);
}

async function loadProjectTemplates() {
  if (!P()?.path) return [];
  try {
    const r = await window.grok.projectTemplatesGet({
      projectPath: P().path,
      projectId: pid(),
    });
    return (r?.templates || []).map((t) => ({ ...t, source: 'project' }));
  } catch {
    return [];
  }
}

async function loadSessionTemplates() {
  if (!_bundledTemplates) {
    try {
      const res = await fetch('session-templates.json');
      _bundledTemplates = await res.json();
    } catch {
      _bundledTemplates = [];
    }
  }
  const custom = loadJson(USER_TEMPLATES_KEY, []) || [];
  const bundled = Array.isArray(_bundledTemplates) ? _bundledTemplates : [];
  const project = await loadProjectTemplates();
  // priority: bundled < project < user
  const map = new Map();
  for (const t of bundled) map.set(t.id, { ...t, source: 'bundled' });
  for (const t of project) if (t?.id) map.set(t.id, { ...t, source: 'project' });
  for (const t of custom) if (t?.id) map.set(t.id, { ...t, source: 'user' });
  const fav = getFavoriteIds();
  const list = [...map.values()].map((t) => ({ ...t, favorite: fav.has(t.id) }));
  // favorites first, then user, project, bundled
  const sourceRank = { user: 3, project: 2, bundled: 1 };
  list.sort((a, b) => {
    const af = a.favorite ? 1 : 0;
    const bf = b.favorite ? 1 : 0;
    if (af !== bf) return bf - af;
    const ar = sourceRank[a.source] || 0;
    const br = sourceRank[b.source] || 0;
    if (ar !== br) return br - ar;
    return String(a.labelZh || a.id).localeCompare(String(b.labelZh || b.id));
  });
  return list;
}

async function saveTemplateToProject(t) {
  if (!P()?.path || !t) {
    toast(localeIsEn() ? 'Open a project first' : '请先打开项目', 'err');
    return;
  }
  const en = localeIsEn();
  try {
    const cur = await window.grok.projectTemplatesGet({
      projectPath: P().path,
      projectId: pid(),
    });
    const list = Array.isArray(cur?.templates) ? cur.templates.slice() : [];
    const entry = {
      id: t.id,
      labelZh: t.labelZh || t.labelEn || t.id,
      labelEn: t.labelEn || t.labelZh || t.id,
      promptZh: t.promptZh || t.prompt || '',
      promptEn: t.promptEn || t.prompt || '',
      tags: normalizeTags(t.tags),
    };
    const i = list.findIndex((x) => x.id === entry.id);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    await window.grok.projectTemplatesSet({
      projectPath: P().path,
      projectId: pid(),
      templates: list,
    });
    toast(en ? `Saved to .grok/templates.json` : `已写入 .grok/templates.json`, 'ok');
  } catch (e) {
    toast(e.message || 'save failed', 'err');
  }
}

/** Ensure `.grok/templates.json` exists and open in Code */
async function openProjectTemplatesInCode() {
  if (!P()?.path) {
    toast(localeIsEn() ? 'Open a project first' : '请先打开项目', 'err');
    return;
  }
  const en = localeIsEn();
  try {
    const rel = '.grok/templates.json';
    const exists = await window.grok.exists(pid(), rel);
    if (!exists) {
      await window.grok.projectTemplatesSet({
        projectPath: P().path,
        projectId: pid(),
        templates: [],
      });
    }
    await openFile(rel, { switchToCode: true });
    switchTab('editor');
    toast(en ? 'Opened .grok/templates.json' : '已打开 .grok/templates.json', 'ok');
  } catch (e) {
    toast(e.message || 'open failed', 'err');
  }
}
window.openProjectTemplatesInCode = openProjectTemplatesInCode;

function templatePrompt(t, en) {
  if (!t) return '';
  if (en) return t.promptEn || t.prompt || t.promptZh || '';
  return t.promptZh || t.prompt || t.promptEn || '';
}

function applySessionTemplate(t, opts = {}) {
  if (!t) return;
  const en = localeIsEn();
  if (state.workMode !== 'cli') setWorkMode('cli');
  const promptText = templatePrompt(t, en);
  const el = document.getElementById('prompt');
  if (el) {
    el.value = promptText;
    autoResizePrompt();
    updateCharCount();
    el.focus();
  }
  schedulePromptDraftSave();
  if (opts.send) {
    // fire after UI settles
    setTimeout(() => {
      sendPrompt().catch((e) => toast(e.message || String(e), 'err'));
    }, 30);
  }
}

function getUserTemplates() {
  return loadJson(USER_TEMPLATES_KEY, []) || [];
}

function setUserTemplates(list) {
  saveJson(USER_TEMPLATES_KEY, (list || []).slice(-80));
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 12);
  if (typeof tags === 'string') {
    return tags
      .split(/[,，\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function mergeImportedTemplates(incoming, { replace = false } = {}) {
  const custom = replace ? [] : getUserTemplates();
  const map = new Map(custom.map((t) => [t.id, t]));
  let n = 0;
  for (const t of incoming || []) {
    if (!t?.id) continue;
    map.set(t.id, {
      id: t.id,
      labelZh: t.labelZh || t.labelEn || t.id,
      labelEn: t.labelEn || t.labelZh || t.id,
      promptZh: t.promptZh || t.prompt || t.promptEn || '',
      promptEn: t.promptEn || t.prompt || t.promptZh || '',
      tags: normalizeTags(t.tags),
    });
    n += 1;
  }
  setUserTemplates([...map.values()]);
  return n;
}

function templateSearchHay(t, en) {
  const tags = normalizeTags(t.tags).join(' ');
  return `${t.id} ${t.labelZh || ''} ${t.labelEn || ''} ${tags} ${templatePrompt(t, en)}`.toLowerCase();
}

async function exportTemplatesPack() {
  const user = getUserTemplates();
  const bundled = (await loadSessionTemplates()).filter((t) => t.source === 'bundled');
  const pack = {
    format: 'grokcode-templates-v1',
    exportedAt: new Date().toISOString(),
    templates: [...user, ...bundled.map(({ source, ...rest }) => rest)],
  };
  try {
    const r = await window.grok.templateExportPack({ json: JSON.stringify(pack, null, 2) });
    if (r?.canceled) return;
    if (r?.ok) toast((localeIsEn() ? 'Exported: ' : '已导出：') + (r.file || ''), 'ok');
    else toast(r?.error || 'export failed', 'err');
  } catch (e) {
    toast(e.message || 'export failed', 'err');
  }
}

async function importTemplatesPack() {
  try {
    const r = await window.grok.templateImportPack();
    if (r?.canceled) return;
    if (!r?.ok) {
      toast(r?.error || 'import failed', 'err');
      return;
    }
    const n = mergeImportedTemplates(r.templates, { replace: false });
    toast(localeIsEn() ? `Imported ${n} templates` : `已导入 ${n} 个模板`, 'ok');
  } catch (e) {
    toast(e.message || 'import failed', 'err');
  }
}

async function pushTemplatesSync() {
  const templates = getUserTemplates();
  try {
    let dir = await window.grok.templateGetSyncDir();
    if (!dir) {
      const pick = await window.grok.templatePickSyncDir();
      if (!pick?.ok) return;
      dir = pick.dir;
    }
    const r = await window.grok.templateSyncPush({ templates, dir });
    if (r?.ok) toast((localeIsEn() ? 'Synced → ' : '已推送到 ') + (r.file || dir), 'ok');
    else toast(r?.error || 'sync failed', 'err');
  } catch (e) {
    toast(e.message || 'sync failed', 'err');
  }
}

async function pullTemplatesSync() {
  try {
    let dir = await window.grok.templateGetSyncDir();
    if (!dir) {
      const pick = await window.grok.templatePickSyncDir();
      if (!pick?.ok) return;
      dir = pick.dir;
    }
    const r = await window.grok.templateSyncPull({ dir });
    if (!r?.ok) {
      toast(r?.error || 'pull failed', 'err');
      return;
    }
    const n = mergeImportedTemplates(r.templates, { replace: false });
    toast(localeIsEn() ? `Pulled ${n} templates` : `已拉取 ${n} 个模板`, 'ok');
  } catch (e) {
    toast(e.message || 'pull failed', 'err');
  }
}

function renderTemplateListItems(list, en, query, { favOnly = false } = {}) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  let filtered = list;
  if (favOnly) filtered = filtered.filter((t) => t.favorite || isTemplateFavorite(t.id));
  if (q) {
    filtered = filtered.filter(
      (t) => templateSearchHay(t, en).includes(q) || normalizeTags(t.tags).some((tag) => tag.includes(q))
    );
  }
  if (!filtered.length) {
    return `<div class="slash-desc" style="padding:10px">${en ? 'No matches' : '无匹配模板'}</div>`;
  }
  return filtered
    .map((t) => {
      const tags = normalizeTags(t.tags);
      const fav = t.favorite || isTemplateFavorite(t.id);
      return `<div class="slash-item tpl-row" data-id="${esc(t.id)}">
        <button type="button" class="tpl-fav${fav ? ' on' : ''}" data-fav="${esc(t.id)}" title="${
          fav ? (en ? 'Unpin' : '取消固定') : en ? 'Pin favorite' : '固定收藏'
        }">${fav ? '★' : '☆'}</button>
        <button type="button" class="tpl-main" data-apply="${esc(t.id)}">
          <span class="slash-label">${esc(en ? t.labelEn || t.id : t.labelZh || t.id)}${
            t.source === 'user' ? ' · user' : t.source === 'project' ? ' · proj' : ''
          }${fav ? ' · ★' : ''}</span>
          ${
            tags.length
              ? `<span class="tpl-tags">${tags.map((tag) => `<em class="tpl-tag">${esc(tag)}</em>`).join('')}</span>`
              : ''
          }
          <span class="slash-desc">${esc(templatePrompt(t, en).slice(0, 90))}</span>
        </button>
      </div>`;
    })
    .join('');
}

async function openTemplatesMenu() {
  const list = await loadSessionTemplates();
  const en = localeIsEn();
  let syncDir = '';
  try {
    syncDir = (await window.grok.templateGetSyncDir()) || '';
  } catch {
    /* ignore */
  }
  let menu = document.getElementById('templatesMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'templatesMenu';
    menu.className = 'slash-menu templates-menu';
    document.body.appendChild(menu);
  }
  const allTags = [
    ...new Set(list.flatMap((t) => normalizeTags(t.tags))),
  ].sort();
  menu.innerHTML = `
    <div class="slash-head">${en ? 'Session templates' : '会话模板'}</div>
    <div class="tpl-search-row">
      <input type="search" id="tplSearch" class="tpl-search" placeholder="${en ? 'Search name / tag / prompt…' : '搜索 名称 / 标签 / 内容…'}" autocomplete="off" />
      <button type="button" class="tpl-fav-filter" id="tplFavFilter" title="${en ? 'Favorites only' : '仅收藏'}">★</button>
    </div>
    ${
      allTags.length
        ? `<div class="tpl-tag-bar">${allTags
            .map((tag) => `<button type="button" class="tpl-tag-btn" data-tag="${esc(tag)}">#${esc(tag)}</button>`)
            .join('')}</div>`
        : ''
    }
    <div id="tplListHost">${renderTemplateListItems(list, en, '')}</div>
    <div class="slash-head">${en ? 'Pack / sync' : '包 / 同步'}</div>
    <button type="button" class="slash-item" data-act="custom"><span class="slash-label">${en ? '+ Save current as template' : '+ 将当前输入存为模板'}</span></button>
    <button type="button" class="slash-item" data-act="to-project" ${P() ? '' : 'disabled'}><span class="slash-label">${en ? '+ Save current → project .grok/templates.json' : '+ 当前输入 → 项目 templates.json'}</span></button>
    <button type="button" class="slash-item" data-act="open-project" ${P() ? '' : 'disabled'}><span class="slash-label">${en ? 'Open .grok/templates.json in Code' : '在 Code 打开 templates.json'}</span></button>
    <button type="button" class="slash-item" data-act="export"><span class="slash-label">${en ? 'Export JSON pack' : '导出 JSON 包'}</span></button>
    <button type="button" class="slash-item" data-act="import"><span class="slash-label">${en ? 'Import JSON pack' : '导入 JSON 包'}</span></button>
    <button type="button" class="slash-item" data-act="export-enc"><span class="slash-label">${en ? 'Export encrypted pack…' : '导出加密包…'}</span><span class="slash-desc">${en ? 'AES-GCM + passphrase' : 'AES-GCM 口令加密'}</span></button>
    <button type="button" class="slash-item" data-act="import-enc"><span class="slash-label">${en ? 'Import encrypted pack…' : '导入加密包…'}</span></button>
    <button type="button" class="slash-item" data-act="sync-dir"><span class="slash-label">${en ? 'Set sync folder…' : '设置同步目录…'}</span><span class="slash-desc">${esc(syncDir || (en ? 'OneDrive / Dropbox / local' : '网盘或本地文件夹'))}</span></button>
    <button type="button" class="slash-item" data-act="sync-push"><span class="slash-label">${en ? 'Push to sync folder' : '推送到同步目录'}</span></button>
    <button type="button" class="slash-item" data-act="sync-pull"><span class="slash-label">${en ? 'Pull from sync folder' : '从同步目录拉取'}</span></button>`;
  const ta = document.getElementById('prompt');
  const rect = ta?.getBoundingClientRect() || { left: 40, top: window.innerHeight - 120, width: 360 };
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  menu.style.width = `${Math.min(460, Math.max(340, rect.width || 360))}px`;
  menu.classList.remove('hidden');

  const host = menu.querySelector('#tplListHost');
  const search = menu.querySelector('#tplSearch');
  const favFilterBtn = menu.querySelector('#tplFavFilter');
  let favOnly = false;
  const bindListClicks = () => {
    host.querySelectorAll('[data-apply]').forEach((btn) => {
      btn.onclick = () => {
        const t = list.find((x) => x.id === btn.dataset.apply);
        menu.classList.add('hidden');
        applySessionTemplate(t);
      };
    });
    host.querySelectorAll('[data-fav]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.dataset.fav;
        const on = toggleTemplateFavorite(id);
        const item = list.find((x) => x.id === id);
        if (item) item.favorite = on;
        // re-sort favorites first
        list.sort((a, b) => {
          const af = a.favorite || isTemplateFavorite(a.id) ? 1 : 0;
          const bf = b.favorite || isTemplateFavorite(b.id) ? 1 : 0;
          if (af !== bf) return bf - af;
          return 0;
        });
        refreshList(search?.value || '');
        toast(on ? (en ? 'Pinned' : '已固定') : en ? 'Unpinned' : '已取消固定', 'ok');
      };
    });
  };
  const refreshList = (q) => {
    host.innerHTML = renderTemplateListItems(list, en, q, { favOnly });
    bindListClicks();
    favFilterBtn?.classList.toggle('on', favOnly);
  };
  bindListClicks();
  search?.addEventListener('input', () => refreshList(search.value));
  search?.addEventListener('keydown', (e) => e.stopPropagation());
  favFilterBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    favOnly = !favOnly;
    refreshList(search?.value || '');
  });
  menu.querySelectorAll('.tpl-tag-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (search) {
        search.value = btn.dataset.tag || '';
        refreshList(search.value);
        search.focus();
      }
    };
  });

  const acts = {
    custom: () => saveCurrentAsTemplate(),
    'to-project': () => {
      const text = document.getElementById('prompt')?.value?.trim();
      if (!text) {
        toast(en ? 'Composer is empty' : '输入框为空', 'err');
        return;
      }
      const label = prompt(en ? 'Project template name' : '项目模板名称', text.slice(0, 16));
      if (!label) return;
      const id =
        'proj-' +
        String(label)
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
          .slice(0, 32);
      return saveTemplateToProject({
        id,
        labelZh: label,
        labelEn: label,
        promptZh: text,
        promptEn: text,
        tags: [],
      });
    },
    'open-project': () => openProjectTemplatesInCode(),
    export: () => exportTemplatesPack(),
    import: () => importTemplatesPack(),
    'export-enc': () => exportTemplatesEncrypted(),
    'import-enc': () => importTemplatesEncrypted(),
    'sync-dir': async () => {
      const r = await window.grok.templatePickSyncDir();
      if (r?.ok) toast((en ? 'Sync dir: ' : '同步目录：') + r.dir, 'ok');
    },
    'sync-push': () => pushTemplatesSync(),
    'sync-pull': () => pullTemplatesSync(),
  };
  menu.querySelectorAll('.slash-item[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.classList.add('hidden');
      const fn = acts[btn.dataset.act];
      if (fn) Promise.resolve(fn()).catch((e) => toast(e.message || String(e), 'err'));
    });
  });
  const onDoc = (e) => {
    if (!menu.contains(e.target)) {
      menu.classList.add('hidden');
      document.removeEventListener('click', onDoc);
    }
  };
  setTimeout(() => document.addEventListener('click', onDoc), 0);
  search?.focus();
}

function saveCurrentAsTemplate() {
  const text = document.getElementById('prompt')?.value?.trim();
  if (!text) {
    toast(localeIsEn() ? 'Composer is empty' : '输入框为空', 'err');
    return;
  }
  const en = localeIsEn();
  const label = prompt(en ? 'Template name' : '模板名称', text.slice(0, 16));
  if (!label) return;
  const tagsRaw = prompt(en ? 'Tags (comma-separated, optional)' : '标签（逗号分隔，可选）', '');
  const id =
    'user-' +
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .slice(0, 32) +
    '-' +
    Date.now().toString(36).slice(-4);
  const custom = getUserTemplates();
  custom.push({
    id,
    labelZh: label,
    labelEn: label,
    promptZh: text,
    promptEn: text,
    tags: normalizeTags(tagsRaw || ''),
  });
  setUserTemplates(custom);
  toast(en ? `Saved template: ${label}` : `已保存模板：${label}`, 'ok');
}

// ── Encrypted template pack (AES-GCM + PBKDF2) ──────────
function b64FromBytes(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function bytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveTemplateKey(passphrase, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptAesPayload(jsonStr, passphrase, format) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveTemplateKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(jsonStr)
  );
  return {
    format,
    kdf: 'PBKDF2-SHA256-120k',
    cipher: 'AES-256-GCM',
    salt: b64FromBytes(salt),
    iv: b64FromBytes(iv),
    data: b64FromBytes(ct),
    exportedAt: new Date().toISOString(),
  };
}

async function encryptTemplatesPayload(jsonStr, passphrase) {
  return encryptAesPayload(jsonStr, passphrase, 'grokcode-templates-aes-v1');
}

async function encryptStoryboardPayload(jsonStr, passphrase) {
  return encryptAesPayload(jsonStr, passphrase, 'grokcode-storyboard-aes-v1');
}

async function decryptAesPayload(pack, passphrase, allowedFormats) {
  const formats = Array.isArray(allowedFormats) ? allowedFormats : [allowedFormats];
  if (!pack || !formats.includes(pack.format)) {
    throw new Error('Not an encrypted GrokCode pack');
  }
  const salt = bytesFromB64(pack.salt);
  const iv = bytesFromB64(pack.iv);
  const key = await deriveTemplateKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    bytesFromB64(pack.data)
  );
  return new TextDecoder().decode(pt);
}

async function decryptTemplatesPayload(pack, passphrase) {
  return decryptAesPayload(pack, passphrase, 'grokcode-templates-aes-v1');
}

async function decryptStoryboardPayload(pack, passphrase) {
  return decryptAesPayload(pack, passphrase, 'grokcode-storyboard-aes-v1');
}

async function exportTemplatesEncrypted() {
  const en = localeIsEn();
  const pass = prompt(en ? 'Passphrase for encrypted pack' : '加密包口令');
  if (!pass) return;
  const user = getUserTemplates();
  const packPlain = {
    format: 'grokcode-templates-v1',
    exportedAt: new Date().toISOString(),
    templates: user,
  };
  try {
    const sealed = await encryptTemplatesPayload(JSON.stringify(packPlain), pass);
    const r = await window.grok.templateExportPack({
      json: JSON.stringify(sealed, null, 2),
    });
    if (r?.canceled) return;
    if (r?.ok) toast((en ? 'Encrypted export: ' : '已加密导出：') + (r.file || ''), 'ok');
    else toast(r?.error || 'export failed', 'err');
  } catch (e) {
    toast(e.message || 'encrypt failed', 'err');
  }
}

async function importTemplatesEncrypted() {
  const en = localeIsEn();
  try {
    const raw = await window.grok.templateImportRaw();
    if (raw?.canceled) return;
    if (!raw?.ok) {
      toast(raw?.error || 'import failed', 'err');
      return;
    }
    let data = raw.data;
    if (data?.format === 'grokcode-templates-aes-v1') {
      const pass = prompt(en ? 'Passphrase' : '口令');
      if (!pass) return;
      const json = await decryptTemplatesPayload(data, pass);
      data = JSON.parse(json);
    }
    const list = Array.isArray(data) ? data : data.templates || [];
    const n = mergeImportedTemplates(list);
    toast(en ? `Imported ${n} templates` : `已导入 ${n} 个模板`, 'ok');
  } catch (e) {
    toast(e.message || 'decrypt/import failed', 'err');
  }
}
window.openTemplatesMenu = openTemplatesMenu;
window.applySessionTemplate = applySessionTemplate;
window.exportTemplatesPack = exportTemplatesPack;
window.importTemplatesPack = importTemplatesPack;
window.exportTemplatesEncrypted = exportTemplatesEncrypted;
window.importTemplatesEncrypted = importTemplatesEncrypted;

// ── Welcome ─────────────────────────────────────────────
async function showWelcome(box) {
  box = box || messagesEl();
  if (!box || box.children.length) return;
  const en = localeIsEn();
  const templates = await loadSessionTemplates();
  const favs = templates.filter((t) => t.favorite).slice(0, 6);
  const rest = templates.filter((t) => !t.favorite).slice(0, Math.max(0, 8 - favs.length));
  const quick = [...favs, ...rest].slice(0, 8);
  box.innerHTML = `
    <div class="welcome">
      <div class="welcome-hero">
        <div class="welcome-kicker">xAI · CLI HOST · GrokCode</div>
        <h3>${en ? 'Not just an IDE assistant.' : '不是又一个 IDE 插件。'}<br><em>${en ? 'Parallel agents that grok.' : '能并行理解的 Agent。'}</em></h3>
        <p>${
          en
            ? 'Thin host for <strong>local Grok CLI</strong> — modes via <kbd>/plan</kbd> · <kbd>/ask</kbd> · status-bar chip. Each task has its own session. <kbd>Ctrl</kbd>+<kbd>T</kbd> for parallel.'
            : '本机 <strong>Grok CLI</strong> 的薄宿主 — 模式用 <kbd>/plan</kbd> · <kbd>/ask</kbd> · 状态栏芯片。每个任务独立 session。用 <kbd>Ctrl</kbd>+<kbd>T</kbd> 开并行。'
        }</p>
      </div>
      <ol>
        <li>${en ? 'Open a project workspace' : '打开项目，给 Grok 一块能「理解」的代码宇宙'}</li>
        <li>${en ? 'CLI green in title bar = online (else <code>grok login</code>)' : '顶栏 CLI 亮绿 = 已上线（否则 <code>grok login</code>）'}</li>
        <li>${en ? '<kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>/</kbd> commands · ★ favorites first below' : '当前任务 <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>/</kbd> 命令 · 下方 ★ 收藏优先'}</li>
      </ol>
      ${
        favs.length
          ? `<div class="welcome-fav-label">★ ${en ? 'Favorites' : '收藏'}</div>`
          : ''
      }
      <div class="quick-actions" id="welcomeTemplates">
        ${quick
          .map(
            (t) =>
              `<span class="quick-btn-wrap">
                <button type="button" class="quick-btn craft-q${t.favorite ? ' fav' : ''}" data-tpl="${esc(t.id)}" title="${en ? 'Fill composer' : '填入输入框'}">${
                  t.favorite ? '★ ' : ''
                }${esc(en ? t.labelEn || t.id : t.labelZh || t.id)}</button>
                <button type="button" class="quick-send" data-tpl-send="${esc(t.id)}" title="${en ? 'Apply & send' : '应用并发送'}">↵</button>
              </span>`
          )
          .join('')}
        <button type="button" class="quick-btn" data-act="more-tpl">${en ? 'More…' : '更多…'}</button>
      </div>
      <p class="welcome-send-hint muted">${en ? '↵ = apply template and send immediately' : '↵ = 填入模板并立即发送'}</p>
    </div>`;
  box.querySelectorAll('.quick-btn[data-tpl]').forEach((btn) => {
    btn.onclick = () => {
      const t = quick.find((x) => x.id === btn.dataset.tpl);
      applySessionTemplate(t);
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = quick.find((x) => x.id === btn.dataset.tpl);
      if (t) showWelcomeChipMenu(e.clientX, e.clientY, t, quick);
    };
  });
  box.querySelectorAll('[data-tpl-send]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const t = quick.find((x) => x.id === btn.dataset.tplSend);
      if (!t) return;
      if (!P()) {
        toast(en ? 'Open a project first' : '请先打开项目', 'err');
        openProjectFlow();
        return;
      }
      applySessionTemplate(t, { send: true });
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = quick.find((x) => x.id === btn.dataset.tplSend);
      if (t) showWelcomeChipMenu(e.clientX, e.clientY, t, quick);
    };
  });
  box.querySelector('[data-act="more-tpl"]')?.addEventListener('click', () => openTemplatesMenu());
}

/** Right-click menu on welcome template chips */
function showWelcomeChipMenu(x, y, t, quickList) {
  if (!t) return;
  const en = localeIsEn();
  let menu = document.getElementById('welcomeCtxMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'welcomeCtxMenu';
    menu.className = 'welcome-ctx-menu';
    document.body.appendChild(menu);
  }
  const fav = t.favorite || isTemplateFavorite(t.id);
  menu.innerHTML = `
    <button type="button" data-act="fill">${en ? 'Fill composer' : '填入输入框'}</button>
    <button type="button" data-act="send">${en ? 'Apply & send' : '应用并发送'}</button>
    <button type="button" data-act="pin">${fav ? (en ? 'Unpin favorite' : '取消收藏') : en ? 'Pin favorite' : '固定收藏'}</button>
    <button type="button" data-act="edit">${en ? 'Edit prompt…' : '编辑提示…'}</button>
    <button type="button" data-act="more">${en ? 'Open template pack…' : '打开模板包…'}</button>`;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
  menu.classList.remove('hidden');
  menu.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      menu.classList.add('hidden');
      const act = btn.dataset.act;
      if (act === 'fill') applySessionTemplate(t);
      else if (act === 'send') {
        if (!P()) {
          toast(en ? 'Open a project first' : '请先打开项目', 'err');
          openProjectFlow();
          return;
        }
        applySessionTemplate(t, { send: true });
      } else if (act === 'pin') {
        const on = toggleTemplateFavorite(t.id);
        t.favorite = on;
        if (Array.isArray(quickList)) {
          const q = quickList.find((x) => x.id === t.id);
          if (q) q.favorite = on;
        }
        // refresh welcome if still visible
        const pane = T()?.pane;
        if (pane?.querySelector('.welcome')) {
          pane.innerHTML = '';
          showWelcome(pane);
        }
        toast(on ? (en ? 'Pinned' : '已固定') : en ? 'Unpinned' : '已取消固定', 'ok');
      } else if (act === 'edit') {
        const cur = templatePrompt(t, en);
        const next = prompt(en ? 'Edit template prompt' : '编辑模板内容', cur);
        if (next == null || next === cur) return;
        // user templates: update storage; project: write project; bundled: save as user override
        if (t.source === 'user' || !t.source) {
          const custom = getUserTemplates();
          const i = custom.findIndex((x) => x.id === t.id);
          const entry = {
            id: t.id,
            labelZh: t.labelZh || t.id,
            labelEn: t.labelEn || t.id,
            promptZh: next,
            promptEn: next,
            tags: normalizeTags(t.tags),
          };
          if (i >= 0) custom[i] = entry;
          else custom.push(entry);
          setUserTemplates(custom);
        } else if (t.source === 'project' && P()?.path) {
          await saveTemplateToProject({
            ...t,
            promptZh: next,
            promptEn: next,
          });
        } else {
          // bundled → user override
          const custom = getUserTemplates();
          custom.push({
            id: t.id,
            labelZh: t.labelZh || t.id,
            labelEn: t.labelEn || t.id,
            promptZh: next,
            promptEn: next,
            tags: normalizeTags(t.tags),
          });
          setUserTemplates(custom);
        }
        t.promptZh = next;
        t.promptEn = next;
        applySessionTemplate(t);
        toast(en ? 'Template updated' : '模板已更新', 'ok');
      } else if (act === 'more') openTemplatesMenu();
    };
  });
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.classList.add('hidden');
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ── UI bindings ─────────────────────────────────────────
function bindUi() {
  $('#btnOpen').onclick = () => openProjectFlow();
  $('#btnOpenEmpty')?.addEventListener('click', () => openProjectFlow());
  $('#btnAddProject')?.addEventListener('click', () => openProjectFlow());
  $('#btnOpenWindow')?.addEventListener('click', () => openProjectFlow({ newWindow: true }));
  $('#btnNewWindowProject')?.addEventListener('click', () => openProjectFlow({ newWindow: true }));
  $('#btnRefreshTree').onclick = loadTree;
  $('#btnSettings').onclick = openSettings;
  $('#btnInbox')?.addEventListener('click', () => {
    window.GrokInbox?.toggle?.();
  });
  // Global Inbox handlers (plan / ask reply + jump to task)
  window.GrokInboxHandlers = {
    gotoTask: async (item) => {
      if (!item?.taskId) return;
      if (item.projectId && String(item.projectId) !== String(pid())) {
        try {
          await switchProject(item.projectId);
        } catch {
          /* ignore */
        }
      }
      switchTask(item.taskId);
      window.GrokInbox?.close?.();
      // Focus in-pane bar after switch paints
      requestAnimationFrame(() => {
        const task = window.TaskStore?.get?.(item.taskId) || T();
        const rid = String(item.requestId ?? '');
        const bars =
          item.kind === 'plan'
            ? task?.pane?.querySelectorAll?.('.plan-approval-bar')
            : item.kind === 'permission'
              ? task?.pane?.querySelectorAll?.('.permission-bar')
              : task?.pane?.querySelectorAll?.('.user-question-bar');
        let bar = null;
        bars?.forEach?.((el) => {
          if (String(el.dataset.requestId || '') === rid) bar = el;
        });
        if (bar) {
          bar.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
          window.GrokA11y?.presentInteractive?.(
            bar,
            localeIsEn() ? 'Continue here' : '请在此处理',
            { assertive: false, focus: true }
          );
        }
      });
    },
    replyPlan: async (item, outcome, feedback, execTier) => {
      return window.grok.replyPlanApproval({
        projectId: item.projectId || pid(),
        taskId: item.taskId,
        requestId: item.requestId,
        outcome,
        feedback: feedback || undefined,
        execTier: outcome === 'approved' ? execTier : undefined,
      });
    },
    replyQuestion: async (item, result) => {
      return window.grok.replyUserQuestion({
        projectId: item.projectId || pid(),
        taskId: item.taskId,
        requestId: item.requestId,
        result: result || { outcome: 'cancelled' },
      });
    },
    replyPermission: async (item, payload) => {
      return window.grok.replyPermission({
        projectId: item.projectId || pid(),
        taskId: item.taskId,
        requestId: item.requestId,
        remember: payload?.remember !== false && !payload?.cancelled,
        ...(payload || { cancelled: true }),
      });
    },
    onPlanResolved: (item) => {
      const task = window.TaskStore?.get?.(item.taskId);
      task?.pane?.querySelectorAll?.('.plan-approval-bar')?.forEach((el) => {
        if (String(el.dataset.requestId || '') === String(item.requestId)) el.remove();
      });
    },
    onQuestionResolved: (item) => {
      const task = window.TaskStore?.get?.(item.taskId);
      task?.pane?.querySelectorAll?.('.user-question-bar')?.forEach((el) => {
        if (String(el.dataset.requestId || '') === String(item.requestId)) el.remove();
      });
    },
    onPermissionResolved: (item) => {
      const task = window.TaskStore?.get?.(item.taskId);
      task?.pane?.querySelectorAll?.('.permission-bar')?.forEach((el) => {
        if (String(el.dataset.requestId || '') === String(item.requestId)) el.remove();
      });
    },
  };
  window.GrokInbox?.paintBadge?.();
  $('#btnCloseSettings').onclick = closeSettings;
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnProbeCli').onclick = () => refreshCliStatus();
  /** CSS-only “haptic” flash on critical controls */
  function haptic(el, cls = 'haptic-tap') {
    if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 360);
  }
  window.haptic = haptic;

  $('#btnSend').onclick = () => {
    const btn = $('#btnSend');
    if (btn && !btn.disabled) {
      btn.classList.remove('send-pulse');
      void btn.offsetWidth;
      btn.classList.add('send-pulse');
      haptic(btn);
      setTimeout(() => btn.classList.remove('send-pulse'), 500);
    }
    sendPrompt();
  };
  $('#btnStop')?.addEventListener('click', () => haptic($('#btnStop')));
  $('#btnStop').onclick = stopAgent;
  $('#btnNewChat').onclick = () => addTask();
  $('#btnShareSession')?.addEventListener('click', () => openSessionShareCard());
  $('#btnAddTask')?.addEventListener('click', () => addTask());
  bindLiveFilterUi();
  bindModelChipUi();
  $('#btnSave').onclick = saveCurrentFile;
  $('#btnClearTerm').onclick = () => {
    $('#termOut').innerHTML = '';
    toast(t('term.cleared', '终端已清空'));
  };
  $('#btnCollapseFiles').onclick = toggleFiles;
  $('#btnExpandFiles')?.addEventListener('click', () => {
    if (state.filesCollapsed) toggleFiles();
  });
  $('#btnToggleTerm').onclick = toggleTerm;
  $('#btnToggleLiveSide')?.addEventListener('click', () => toggleLiveSide());
  // 点终端标题条也可展开/收起
  document.querySelector('.terminal-wrap .panel-head')?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (state.termCollapsed) toggleTerm();
  });
  // 布局：Work / Review 主按钮；Pilot / Full 在「更多」菜单
  document.querySelectorAll('#layoutPresets [data-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      haptic(btn);
      applyLayoutMode(btn.dataset.layout, { toast: true });
      setLayoutMoreOpen(false);
    });
  });
  document.getElementById('btnLayoutMore')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('layoutMoreMenu');
    const open = menu && menu.classList.contains('hidden');
    setLayoutMoreOpen(Boolean(open));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#layoutMore')) setLayoutMoreOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setLayoutMoreOpen(false);
  });
  document.getElementById('btnAutoPilot')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = document.getElementById('btnAutoPilot');
    haptic(b);
    setAutoPilotEnabled(!getAutoPilotEnabled());
    toast(
      getAutoPilotEnabled()
        ? localeIsEn()
          ? 'Auto-Pilot on · ≥1600px → Pilot'
          : '超宽自动 Pilot 已开 · ≥1600 → Pilot'
        : localeIsEn()
          ? 'Auto-Pilot off'
          : '超宽自动 Pilot 已关',
      'ok'
    );
  });
  syncAutoPilotUi();
  syncLayoutPresetUi();
  syncCenterTabChrome(state.activeTab || 'live');
  // resize → auto pilot with hysteresis
  let _apResizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(_apResizeT);
    _apResizeT = setTimeout(() => maybeAutoPilot({ toast: false }), 180);
  });


  $('#prompt').addEventListener('keydown', (e) => {
    if (handleAtKeydown(e)) return;
    if (handleSlashKeydown(e)) return;
    if (e.key !== 'Enter') return;
    // Shift+Enter → newline in textarea
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    // Ctrl/Cmd+Shift+Enter → same as send (CLI owns modes; no host Craft inject)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) sendPrompt();
    else sendPrompt();
  });
  $('#prompt').addEventListener('input', () => {
    autoResizePrompt();
    updateCharCount();
    updateSlashMenu();
    scheduleAtMenu();
    schedulePromptDraftSave();
  });

  $('#termInput').addEventListener('keydown', onTermKey);
  $('#treeFilter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    applyTreeFilter();
  });
  $('#btnTreeExpand')?.addEventListener('click', () => {
    $$('#fileTree .tree-item.dir').forEach((row) => {
      row.classList.add('open');
      const next = row.nextElementSibling;
      if (next?.classList.contains('tree-children')) next.classList.remove('hidden');
    });
  });
  $('#btnTreeCollapse')?.addEventListener('click', () => {
    $$('#fileTree .tree-item.dir').forEach((row) => {
      row.classList.remove('open');
      const next = row.nextElementSibling;
      if (next?.classList.contains('tree-children')) next.classList.add('hidden');
    });
  });

  $('#editor').addEventListener('input', () => {
    requireProject().dirty = true;
    updateEditorChrome();
    syncGutter();
  });
  $('#editor').addEventListener('scroll', () => {
    const g = $('#editorGutter');
    if (g) g.scrollTop = $('#editor').scrollTop;
  });
  $('#editor').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const s = el.selectionStart;
      el.value = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd);
      el.selectionStart = el.selectionEnd = s + 2;
      requireProject().dirty = true;
      updateEditorChrome();
      syncGutter();
    }
  });

  $$('.tab').forEach((tab) => {
    tab.onclick = () => switchTab(tab.dataset.tab);
  });

  $('#followAgent')?.addEventListener('change', (e) => {
    state.followAgent = e.target.checked;
  });
  $('#btnRevealDiff')?.addEventListener('click', () => {
    if ((P() && P().currentFile) && changesMap().has((P() && P().currentFile))) {
      openReviewBridge(P().currentFile);
    } else {
      openReviewBridge();
    }
  });
  $('#btnOpenFromDiff')?.addEventListener('click', () => {
    if ((P() && P().selectedDiffPath)) openFile((P() && P().selectedDiffPath));
  });
  $('#btnReviewBridge')?.addEventListener('click', () => {
    haptic($('#btnReviewBridge'));
    openReviewBridge();
  });
  $('#btnDiscussDiff')?.addEventListener('click', () => {
    haptic($('#btnDiscussDiff'));
    discussDiffInAgent();
  });
  $('#btnRestoreFile')?.addEventListener('click', () => restoreSelectedFile());
  $('#btnRestoreAll')?.addEventListener('click', () => restoreAllFiles());
  $('#btnDismissDiff')?.addEventListener('click', () => dismissSelectedDiff());
  $('#btnReviewDiff')?.addEventListener('click', () => {
    const path = P() && P().selectedDiffPath;
    const cur = path && changesMap().get(path);
    markDiffReviewed(path, !cur?.reviewed);
  });
  bindSlashCommands();
  bindChatSearch();
  bindAtMentions();
  bindComposerAttachments();
  bindRulesQuickEdit();
  // restore draft for active task after UI ready
  setTimeout(() => loadPromptDraft(T()), 0);

  $('#linkConsole').onclick = (e) => {
    e.preventDefault();
    window.grok.openExternal('https://console.x.ai');
  };

  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) closeSettings();
  });
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openWorkspace();
    }
    if (mod && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentFile();
    }
    // Ctrl+B 折叠/展开资源管理器
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleFiles();
    }
    // Ctrl+T 新任务
    if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault();
      addTask();
    }
    // Ctrl+F in chat/composer → in-task message search (global content search remains Ctrl+Shift+F)
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
      if (
        document.activeElement?.id === 'prompt' ||
        document.activeElement?.closest?.('#messagesHost') ||
        document.activeElement?.closest?.('.composer') ||
        document.activeElement?.id === 'chatSearchInput'
      ) {
        e.preventDefault();
        openChatSearch();
        return;
      }
    }
    // Diff review keys when Diff tab active and not typing
    if (!mod && !e.altKey && !isTypingTarget(document.activeElement) && state.activeTab === 'diff') {
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        navigateDiffFile(1);
        return;
      }
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        navigateDiffFile(-1);
        return;
      }
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        const path = P() && P().selectedDiffPath;
        const cur = path && changesMap().get(path);
        if (cur && !cur.restored) markDiffReviewed(path, !cur.reviewed);
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        toggleDiffViewMode();
        return;
      }
      // [ ] previous / next agent turn on scrubber
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        stopScrubPlay();
        navigateScrubTurn(e.key === ']' ? 1 : -1);
        return;
      }
      // Space play/pause scrub (when not typing)
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        toggleScrubPlay();
        return;
      }
      // L = loop toggle
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        toggleScrubLoop();
        return;
      }
    }
    if (e.key === 'Escape') {
      hideSlashMenu();
      hideAtMenu();
      if (document.getElementById('chatSearchBar') && !document.getElementById('chatSearchBar').classList.contains('hidden')) {
        closeChatSearch();
        return;
      }
      if (window.GrokCommandPalette?.isOpen?.()) {
        window.GrokCommandPalette.close();
        return;
      }
      if (window.GrokSearch?.isOpen?.()) {
        window.GrokSearch.close();
        return;
      }
      if (window.GrokHelp?.isOpen?.()) {
        window.GrokHelp.close();
        return;
      }
      if (!$('#settingsModal')?.classList.contains('hidden')) closeSettings();
      if (!$('#onboardingModal')?.classList.contains('hidden')) {
        $('#onboardingModal')?.classList.add('hidden');
      }
    }
  });
}

function bindResizers() {
  $$('.resize-v, .resize-h').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('active');
      const type = el.dataset.resize;
      const startX = e.clientX;
      const startY = e.clientY;
      const filesW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--files-w'), 10);
      const chatW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-w'), 10);
      const termH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--term-h'), 10);

      function onMove(ev) {
        if (type === 'files' && !state.filesCollapsed) {
          const w = Math.min(420, Math.max(180, filesW + (ev.clientX - startX)));
          document.documentElement.style.setProperty('--files-w', w + 'px');
        } else if (type === 'chat') {
          const w = Math.min(560, Math.max(300, chatW - (ev.clientX - startX)));
          document.documentElement.style.setProperty('--chat-w', w + 'px');
        } else if (type === 'term' && !state.termCollapsed) {
          const h = Math.min(420, Math.max(100, termH - (ev.clientY - startY)));
          document.documentElement.style.setProperty('--term-h', h + 'px');
        }
      }
      function onUp() {
        el.classList.remove('active');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        persistLayout();
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

function toggleFiles() {
  state.filesCollapsed = !state.filesCollapsed;
  applyChromeCollapse();
  persistLayout();
  if (!state.filesCollapsed) {
    toast(t('toast.explorerOpen', '资源管理器已展开'), 'ok');
  }
}

/** 折叠后显示醒目轨道按钮；展开后隐藏轨道 */
function syncFilesRail() {
  const rail = $('#btnExpandFiles');
  const collapseBtn = $('#btnCollapseFiles');
  if (rail) {
    rail.classList.toggle('hidden', !state.filesCollapsed);
    rail.setAttribute('aria-hidden', state.filesCollapsed ? 'false' : 'true');
  }
  if (collapseBtn) {
    collapseBtn.textContent = '⟨⟨';
    collapseBtn.title = state.filesCollapsed ? '已折叠' : '折叠侧栏 (Ctrl+B)';
  }
  // 折叠时隐藏对应 resize 条，避免误触
  const rz = document.querySelector('.resize-v[data-resize="files"]');
  if (rz) rz.style.display = state.filesCollapsed ? 'none' : '';
  const termRz = document.querySelector('.resize-h[data-resize="term"]');
  if (termRz) termRz.style.display = state.termCollapsed ? 'none' : '';
}

function toggleTerm() {
  state.termCollapsed = !state.termCollapsed;
  applyChromeCollapse();
  persistLayout();
}

function toggleLiveSide(force) {
  if (typeof force === 'boolean') state.liveSideCollapsed = !force;
  else state.liveSideCollapsed = !state.liveSideCollapsed;
  applyChromeCollapse();
  persistLayout();
}
window.toggleLiveSide = toggleLiveSide;

function autoResizePrompt() {
  const el = $('#prompt');
  el.style.height = 'auto';
  el.style.height = Math.min(160, Math.max(52, el.scrollHeight)) + 'px';
}

function updateCharCount() {
  $('#charCount').textContent = String($('#prompt').value.length);
}

// ── Workspace / tree ────────────────────────────────────
async function openWorkspace() {
  return openProjectFlow();
}

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function setWorkspaceLabel(dir) {
  const short = dir ? basename(dir) : '无项目';
  const p = P();
  $('#sbWorkspace').textContent = p
    ? `${p.name}${window.ProjectStore.count() > 1 ? ` · ${window.ProjectStore.count()} 项目` : ''}`
    : '无项目';
  // 兼容旧 pill（若仍存在）
  const label = $('#workspaceLabel');
  const pill = $('#workspacePill');
  if (label) label.textContent = short;
  if (pill) {
    pill.classList.toggle('open', Boolean(dir));
    pill.title = dir || '';
  }
}

function setCliLabel(probe) {
  const pill = $('#cliPill');
  const label = $('#cliLabel');
  if (!pill || !label) return;
  if (probe?.ok) {
    const ver = (probe.version || 'CLI 已连接').replace(/^grok\s+/i, 'v');
    label.textContent = ver;
    pill.classList.add('open');
    pill.classList.remove('err');
    pill.title = probe.binary || '';
    if ($('#sbCli')) $('#sbCli').textContent = probe.version || 'CLI OK';
  } else {
    label.textContent = 'CLI 未找到';
    pill.classList.remove('open');
    pill.classList.add('err');
    pill.title = probe?.error || '';
    if ($('#sbCli')) $('#sbCli').textContent = 'CLI 离线';
  }
}
// 供 settings-extra / 体检 回写顶栏
window.setCliLabelFromProbe = setCliLabel;

async function loadTree() {
  const root = $('#fileTree');
  if (!P()) {
    root.innerHTML = `
      <div class="empty-hint">
        <div class="empty-ico">📂</div>
        <p>打开项目后即可浏览文件<br>可同时挂载多个项目并行开发</p>
        <button class="btn small primary" id="btnOpenEmpty2">选择文件夹</button>
      </div>`;
    $('#btnOpenEmpty2')?.addEventListener('click', () => openProjectFlow());
    $('#treeCount').textContent = '';
    return;
  }
  try {
    const tree = await window.grok.listFiles(pid(), '.');
    state.treeData = tree;
    renderTreeRoot(tree);
    const n = countNodes(tree);
    $('#treeCount').textContent = `${n} 项`;
  } catch (err) {
    root.innerHTML = `<div class="empty-hint">${esc(err.message)}</div>`;
  }
}

function countNodes(nodes) {
  let n = 0;
  for (const x of nodes || []) {
    n += 1;
    if (x.children) n += countNodes(x.children);
  }
  return n;
}

function renderTreeRoot(tree) {
  const root = $('#fileTree');
  root.innerHTML = '';
  if (!tree.length) {
    root.innerHTML = '<div class="empty-hint">空文件夹</div>';
    return;
  }
  root.appendChild(buildTreeFrag(tree, 0));
  applyTreeFilter();
}

function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const map = {
    js: '📜', mjs: '📜', cjs: '📜', ts: '📘', tsx: '📘', jsx: '📜',
    json: '🧩', md: '📝', mdx: '📝', css: '🎨', scss: '🎨', html: '🌐',
    py: '🐍', rs: '🦀', go: '🐹', java: '☕', kt: '☕',
    toml: '⚙️', yml: '⚙️', yaml: '⚙️', env: '🔐', gitignore: '🙈',
    svg: '🖼️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
    lock: '🔒', sh: '💻', bash: '💻', ps1: '💻', bat: '💻',
    vue: '💚', svelte: '🧡', sql: '🗄️', wasm: '📦', zip: '🗜️',
  };
  return map[ext] || '📄';
}

function fileExt(name) {
  if (!name || !name.includes('.')) return '';
  return name.split('.').pop().toLowerCase();
}

function setPathBreadcrumb(relPath) {
  const el = $('#currentPath');
  if (!el) return;
  if (!relPath || relPath === '—') {
    el.textContent = '—';
    el.title = '';
    return;
  }
  const parts = String(relPath).replace(/\\/g, '/').split('/').filter(Boolean);
  el.title = relPath;
  if (parts.length <= 1) {
    el.innerHTML = `<span class="fp-leaf">${esc(parts[0] || relPath)}</span>`;
    return;
  }
  const leaf = parts.pop();
  const head = parts
    .map((p) => `<span class="fp-seg">${esc(p)}</span>`)
    .join('<span class="fp-sep">/</span>');
  el.innerHTML = `${head}<span class="fp-sep">/</span><span class="fp-leaf">${esc(leaf)}</span>`;
}

function buildTreeFrag(nodes, depth) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    const isDir = n.type === 'dir';
    const row = document.createElement('div');
    row.className = 'tree-item' + (isDir ? ' dir open' : '');
    row.dataset.path = n.path;
    row.dataset.name = n.name.toLowerCase();
    row.dataset.type = n.type;
    if (!isDir) row.dataset.ext = fileExt(n.name);
    row.innerHTML = `
      <span class="chev">${isDir ? '▶' : ''}</span>
      <span class="fico">${fileIcon(n.name, isDir)}</span>
      <span class="name">${esc(n.name)}</span>`;

    if (isDir) {
      const childWrap = document.createElement('div');
      childWrap.className = 'tree-children';
      if (n.children?.length) {
        childWrap.appendChild(buildTreeFrag(n.children, depth + 1));
      }
      row.onclick = (e) => {
        e.stopPropagation();
        const open = row.classList.toggle('open');
        childWrap.classList.toggle('hidden', !open);
      };
      frag.appendChild(row);
      frag.appendChild(childWrap);
    } else {
      row.onclick = (e) => {
        e.stopPropagation();
        openFile(n.path);
      };
      frag.appendChild(row);
    }
  }
  return frag;
}

function applyTreeFilter() {
  const q = state.filter;
  const items = $$('#fileTree .tree-item');
  if (!q) {
    items.forEach((el) => el.classList.remove('dim'));
    $$('#fileTree .tree-children').forEach((c) => {
      // keep user fold state; only unhide if parent is open
    });
    return;
  }
  items.forEach((el) => {
    const match = el.dataset.name.includes(q) || el.dataset.path.toLowerCase().includes(q);
    el.classList.toggle('dim', !match);
    if (match && el.dataset.type === 'file') {
      // expand ancestors
      let p = el.parentElement;
      while (p && p.id !== 'fileTree') {
        if (p.classList.contains('tree-children')) {
          p.classList.remove('hidden');
          const prev = p.previousElementSibling;
          if (prev?.classList.contains('dir')) prev.classList.add('open');
        }
        p = p.parentElement;
      }
    }
  });
}

async function openFile(relPath, { fromAgent = false, switchToCode = true } = {}) {
  try {
    const data = await window.grok.readFile(pid(), relPath);
    if (data.error) {
      toast(data.error, 'err');
      return;
    }
    // 缓存当前内容作为后续 diff 的「改前」基线（若尚未有变更记录）
    if (!changesMap().has(relPath) && !contentCacheMap().has(relPath)) {
      contentCacheMap().set(relPath, data.content);
    }
    requireProject().currentFile = relPath;
    requireProject().dirty = false;
    $('#editor').value = data.content;
    setPathBreadcrumb(relPath);
    // highlight in tree
    $$('#fileTree .tree-item').forEach((el) => {
      el.classList.toggle('active-file', el.dataset.path === relPath);
    });
    if (!fromAgent && switchToCode) switchTab('editor');
    updateEditorChrome();
    syncGutter();
    $$('.tree-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.path === relPath);
    });
    setLiveFocus(relPath, data.content);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveCurrentFile() {
  if (!(P() && P().currentFile)) {
    toast('没有打开的文件', 'err');
    return;
  }
  try {
    await window.grok.writeFile(pid(), (P() && P().currentFile), $('#editor').value);
    requireProject().dirty = false;
    updateEditorChrome();
    toast('已保存', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function updateEditorChrome() {
  const hasFile = Boolean((P() && P().currentFile));
  const onCode = state.activeTab === 'editor';
  $('#btnSave').disabled = !hasFile || !(P() && P().dirty);
  $('#dirtyBadge').classList.toggle('hidden', !(P() && P().dirty));
  const hasDiff = hasFile && changesMap().has((P() && P().currentFile));
  if ($('#btnRevealDiff')) $('#btnRevealDiff').disabled = !hasDiff;
  if ($('#btnOpenExternalCode')) $('#btnOpenExternalCode').disabled = !hasFile;

  if (hasFile) {
    $('#editorEmpty')?.classList.add('hidden');
    if ($('#editorStatus')) $('#editorStatus').textContent = (P() && P().dirty) ? '未保存' : '已加载';
    const lines = ($('#editor').value.match(/\n/g) || []).length + 1;
    const bytes = new Blob([$('#editor').value]).size;
    if ($('#editorMeta')) $('#editorMeta').textContent = `${lines} 行 · ${formatBytes(bytes)}`;
  } else {
    if ($('#editorStatus')) $('#editorStatus').textContent = '就绪';
    if ($('#editorMeta')) $('#editorMeta').textContent = '';
    if (onCode) $('#editorEmpty')?.classList.remove('hidden');
    else $('#editorEmpty')?.classList.add('hidden');
  }
}

function syncGutter() {
  const ed = $('#editor');
  const g = $('#editorGutter');
  if (!g || ed.classList.contains('hidden')) return;
  const lines = ed.value.split('\n').length;
  const max = Math.min(lines, 5000);
  let html = '';
  for (let i = 1; i <= max; i++) html += `<span>${i}</span>`;
  if (lines > max) html += `<span>…</span>`;
  g.innerHTML = html;
  g.scrollTop = ed.scrollTop;
}

function switchTab(name, opts = {}) {
  // pause scrub playback when leaving Diff
  if (name !== 'diff' && state.diffScrubPlaying) stopScrubPlay();
  state.activeTab = name;
  // 记住每个项目自己的页签
  if (!opts.skipProjectWrite && P()) {
    P().activeTab = name;
  }
  $$('#editorTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  window.GrokA11y?.syncTabSelection?.();
  syncCenterTabChrome(name);

  const split = window.GrokSplit?.isSplit?.();
  if (split && name !== 'live') {
    // 并排：Code + Diff 同时可见
    $('#livePane')?.classList.add('hidden');
    $('#codePane')?.classList.remove('hidden');
    $('#diffPane')?.classList.remove('hidden');
    window.GrokSplit?.ensureSplitHost?.();
    window.GrokSplit?.applyViewClass?.();
  } else {
    $('#livePane')?.classList.toggle('hidden', name !== 'live');
    $('#codePane')?.classList.toggle('hidden', name !== 'editor');
    $('#diffPane')?.classList.toggle('hidden', name !== 'diff');
    document.body.classList.remove('view-codediff');
  }

  if (name === 'editor' || (split && name !== 'live')) {
    updateEditorChrome();
    syncGutter();
  }
  if (name === 'diff' || (split && name !== 'live')) {
    // re-apply persisted scrub when opening Diff (turns may have grown)
    if (!state.diffScrubTurn) restoreScrubSelection();
    else restoreScrubSelection(); // validate still exists
    renderDiffPane();
  }
  if (name === 'live') {
    const p = P();
    if (p) rebuildLiveTimeline(p);
    renderLiveChanges();
  }
}
// 暴露给搜索 / 分屏
window.openFile = openFile;
window.switchTab = switchTab;
window.renderDiffPane = renderDiffPane;

// ── Work mode: CLI-owned (no GrokCode craft/plan/ask/goal) ─
const WORK_MODES = ['cli'];

const MODE_HINTS = {
  cli: {
    zh: 'CLI · 模式在 TUI：/plan · Shift+Tab · YOLO',
    en: 'CLI · mode in TUI: /plan · Shift+Tab · YOLO',
  },
};

const MODE_SEND = {
  cli: { zh: 'Grok it', en: 'Grok it' },
};

const MODE_PLACEHOLDER = {
  cli: {
    zh: '对当前任务说… Enter 发送 · /plan /ask · 模式由 Grok CLI 拥有',
    en: 'Talk to this task… Enter send · /plan /ask · modes owned by Grok CLI',
  },
};

const MODE_RUN_STATUS = {
  cli: { zh: 'CLI · 运行中', en: 'CLI · running' },
};

function normalizeWorkMode(mode) {
  // Always CLI-native — legacy craft/plan/ask/goal map away
  return 'cli';
}

function localeIsEn() {
  return (window.GrokI18n?.getLocale?.() || 'zh') === 'en';
}

function applySendLabel() {
  const send = document.getElementById('sendLabel');
  if (!send) return;
  const task = typeof T === 'function' ? T() : null;
  if (task?.running) {
    send.textContent = 'grokking';
    return;
  }
  const m = normalizeWorkMode(state.workMode);
  const s = MODE_SEND[m] || MODE_SEND.cli;
  send.textContent = localeIsEn() ? s.en : s.zh;
}

function applyModePlaceholder() {
  const ta = document.getElementById('prompt');
  if (!ta) return;
  const m = normalizeWorkMode(state.workMode);
  const p = MODE_PLACEHOLDER[m] || MODE_PLACEHOLDER.cli;
  ta.placeholder = localeIsEn() ? p.en : p.zh;
}

function setWorkMode(mode, opts = {}) {
  const m = 'cli';
  state.workMode = m;
  saveJson(MODE_KEY, m);
  document.body.dataset.workMode = m;
  document.body.classList.remove('mode-goal');
  document.querySelectorAll('#modeBar .mode-chip, .mode-bar .mode-chip').forEach((btn) => {
    const on = (btn.dataset.mode || '') === 'cli' || btn.dataset.mode === m;
    btn.classList.toggle('active', on || btn.dataset.mode === 'cli');
    btn.setAttribute('aria-pressed', on || btn.dataset.mode === 'cli' ? 'true' : 'false');
  });
  const loc = localeIsEn() ? 'en' : 'zh';
  const hint = MODE_HINTS.cli;
  const el = document.getElementById('modeHint');
  if (el && hint) el.textContent = loc === 'en' ? hint.en : hint.zh;
  applySendLabel();
  applyModePlaceholder();
  // Goal track UI kept optional but not driven by a host "goal mode"
  renderGoalTrack(T());
  let sb = document.getElementById('sbMode');
  if (!sb) {
    const foot = document.querySelector('.statusbar');
    if (foot) {
      sb = document.createElement('span');
      sb.id = 'sbMode';
      sb.className = 'sb-mode';
      sb.tabIndex = 0;
      const brand = foot.querySelector('.sb-brand');
      if (brand?.nextSibling) foot.insertBefore(sb, brand.nextSibling);
      else foot.prepend(sb);
    }
  }
  if (sb) {
    paintCliModeChip(T()?.acpModeId || 'default');
  }
  if (opts.toast) {
    toast(
      loc === 'en'
        ? 'Host docks CLI modes · click status chip or /plan /agent /ask'
        : '宿主对接 CLI 模式 · 点状态栏模式或 /plan /agent /ask',
      'ok'
    );
  }
  if (opts.persistRemote !== false && window.grok?.setConfig) {
    window.grok.setConfig({ workMode: 'cli' }).catch(() => {});
  }
}

/** Paint status bar CLI · {mode} from ACP SessionMode id */
function paintCliModeChip(modeId) {
  const mid = String(modeId || 'default').toLowerCase() || 'default';
  const sb = document.getElementById('sbMode');
  if (sb) {
    sb.textContent = mid === 'default' ? 'CLI · default' : `CLI · ${mid}`;
    sb.dataset.mode = mid;
    sb.dataset.cliMode = mid;
    sb.title = localeIsEn()
      ? `Click to cycle CLI session mode (session/set_mode): default → plan → ask · current ${mid}`
      : `点击循环 CLI 会话模式（session/set_mode）：default → plan → ask · 当前 ${mid}`;
  }
  const hint = document.getElementById('modeHint');
  if (hint) {
    const labels = {
      default: localeIsEn() ? 'Agent (default)' : 'Agent（默认）',
      plan: localeIsEn() ? 'Plan mode' : '计划模式',
      ask: localeIsEn() ? 'Ask (read-only tools)' : 'Ask（只读工具）',
    };
    hint.textContent = labels[mid] || `CLI · ${mid}`;
  }
}

/**
 * Cycle / set ACP session mode via session/set_mode (open-source SessionMode).
 * Needs a warm or running ACP session for the task.
 */
async function setCliSessionMode(modeId, opts = {}) {
  const task = T();
  if (!task?.id || !window.grok?.setSessionMode) {
    toast(
      localeIsEn() ? 'No active task' : '无当前任务',
      'err'
    );
    return { ok: false };
  }
  const r = await window.grok.setSessionMode({
    projectId: task.projectId || pid(),
    taskId: task.id,
    modeId,
    sessionId: task.sessionId || task.acpSessionId || undefined,
  });
  if (!r?.ok) {
    toast(
      r?.error ||
        (localeIsEn()
          ? 'set_mode failed — send a prompt first to warm ACP'
          : 'set_mode 失败 — 请先发一轮对话以预热 ACP'),
      'err'
    );
    return r || { ok: false };
  }
  task.acpModeId = r.modeId || modeId;
  paintCliModeChip(task.acpModeId);
  if (opts.toast !== false) {
    toast(
      localeIsEn()
        ? `CLI mode → ${task.acpModeId}`
        : `CLI 模式 → ${task.acpModeId}`,
      'ok'
    );
  }
  return r;
}

async function cycleWorkMode() {
  setWorkMode('cli', { toast: false });
  const cycle = ['default', 'plan', 'ask'];
  const cur = String(T()?.acpModeId || 'default').toLowerCase();
  const i = cycle.indexOf(cur);
  const next = cycle[(i < 0 ? 0 : i + 1) % cycle.length];
  return setCliSessionMode(next, { toast: true });
}

/** Parse lightweight 【目标进度】 from assistant text (mirrors modes.js) */
function parseGoalProgressLocal(text) {
  const t = String(text || '');
  if (!t) return null;
  const out = {};
  const block = t.match(/【目标进度】([\s\S]{0,800}?)(?=\n【|\n##\s|$)/);
  const body = block ? block[1] : t.slice(-1200);
  const titleM = body.match(/(?:目标|Goal)\s*[:：]\s*(.+)/i);
  if (titleM) out.title = titleM[1].trim().slice(0, 120);
  const progM = body.match(/(?:进度|Progress)\s*[:：]\s*(\d{1,3})\s*%/i);
  if (progM) out.progress = Math.max(0, Math.min(100, parseInt(progM[1], 10)));
  else {
    const loose = body.match(/\b(\d{1,3})\s*%/);
    if (loose && /进度|progress|完成/i.test(body)) {
      out.progress = Math.max(0, Math.min(100, parseInt(loose[1], 10)));
    }
  }
  if (
    /进度\s*[:：]\s*(已完成|完成|done|complete)/i.test(body) ||
    /目标完成|goal\s*(done|complete|achieved)/i.test(t)
  ) {
    out.status = 'done';
    out.progress = 100;
  } else if (/进度\s*[:：]\s*(受阻|blocked|卡住)/i.test(body)) {
    out.status = 'blocked';
  } else if (out.progress === 100) {
    out.status = 'done';
  } else if (out.progress != null || out.title) {
    out.status = 'active';
  }
  const nextM = body.match(/(?:下一步|Next)\s*[:：]\s*(.+)/i);
  if (nextM) out.next = nextM[1].trim().slice(0, 160);
  if (out.progress == null && !out.status && !out.title) return null;
  return out;
}

function extractGoalTitleLocal(text) {
  let t = String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!t) return '';
  t = t.replace(
    /^(目标[:：\s]*|goal\s*[:：-]?\s*|我希望|我想要|请帮我|帮我|实现|完成|做到)\s*/i,
    ''
  );
  const firstLine = t.split(/[\n。！？.!?]/)[0] || t;
  const s = firstLine.trim() || t;
  return s.length > 72 ? s.slice(0, 71) + '…' : s;
}

function ensureTaskGoal(task, userText) {
  if (!task) return null;
  const donePhrase = /^(目标完成|完成目标|goal\s*done|goal\s*complete|算了|放弃目标|取消目标)[\s!！。.~]*$/i.test(
    String(userText || '').trim()
  );
  if (donePhrase && task.goal) {
    task.goal.status = 'done';
    task.goal.progress = 100;
    task.goal.updatedAt = Date.now();
    renderGoalTrack(task);
    return task.goal;
  }
  if (!task.goal?.title || task.goal.status === 'done') {
    const title = extractGoalTitleLocal(userText);
    if (title) {
      task.goal = {
        title,
        status: 'active',
        progress: 0,
        next: '',
        updatedAt: Date.now(),
      };
    }
  }
  renderGoalTrack(task);
  return task.goal || null;
}

function updateTaskGoalFromReply(task, text) {
  if (!task) return;
  const parsed = parseGoalProgressLocal(text);
  if (!parsed) return;
  if (!task.goal) {
    task.goal = {
      title: parsed.title || '目标',
      status: parsed.status || 'active',
      progress: parsed.progress ?? 0,
      next: parsed.next || '',
      updatedAt: Date.now(),
    };
  } else {
    if (parsed.title) task.goal.title = parsed.title;
    if (parsed.progress != null) task.goal.progress = parsed.progress;
    if (parsed.status) task.goal.status = parsed.status;
    if (parsed.next) task.goal.next = parsed.next;
    task.goal.updatedAt = Date.now();
  }
  renderGoalTrack(task);
}

function renderGoalTrack(task) {
  const bar = document.getElementById('goalTrack');
  if (!bar) return;
  const t = task || T();
  const show = (state.workMode === 'goal' || t?.goal?.title) && t?.goal?.title;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  const g = t.goal;
  const titleEl = document.getElementById('goalTrackTitle');
  const pctEl = document.getElementById('goalTrackPct');
  const fill = document.getElementById('goalTrackFill');
  if (titleEl) {
    titleEl.textContent = g.title || '—';
    titleEl.title = g.next ? `${g.title}\n→ ${g.next}` : g.title;
  }
  const pct = g.status === 'done' ? 100 : Math.max(0, Math.min(100, Number(g.progress) || 0));
  if (pctEl) {
    pctEl.textContent =
      g.status === 'done' ? (localeIsEn() ? 'done' : '完成') : g.status === 'blocked' ? '!' : `${pct}%`;
  }
  if (fill) fill.style.width = `${pct}%`;
  bar.dataset.status = g.status || 'active';
}

function clearTaskGoal(task) {
  task = task || T();
  if (!task) return;
  task.goal = null;
  renderGoalTrack(task);
  schedulePersist?.(true);
}

let _workModeUiBound = false;
function bindWorkModeUi() {
  if (_workModeUiBound) {
    setWorkMode(state.workMode || 'cli', { persistRemote: false });
    return;
  }
  _workModeUiBound = true;

  // Event delegation (survives re-render / partial DOM updates)
  const onModeClick = (e) => {
    const btn = e.target?.closest?.('.mode-chip[data-mode]');
    if (!btn || !btn.closest?.('#modeBar, .mode-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    const mode = btn.getAttribute('data-mode') || btn.dataset.mode;
    if (mode) setWorkMode(mode, { toast: true });
  };
  document.addEventListener('click', onModeClick, true);

  // status badge: cycle CLI session mode (session/set_mode)
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'sbMode' || e.target?.closest?.('#sbMode')) {
      cycleWorkMode().catch(() => {});
    }
    if (e.target?.id === 'btnClearGoal' || e.target?.closest?.('#btnClearGoal')) {
      e.preventDefault();
      clearTaskGoal(T());
      toast(localeIsEn() ? 'Goal cleared' : '已清除目标', 'ok');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target?.id === 'sbMode' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      cycleWorkMode().catch(() => {});
    }
  });
  setWorkMode(state.workMode || 'cli', { persistRemote: false });
}
window.setWorkMode = setWorkMode;
window.cycleWorkMode = cycleWorkMode;
window.setCliSessionMode = setCliSessionMode;
window.paintCliModeChip = paintCliModeChip;
window.applySendLabel = applySendLabel;
window.renderGoalTrack = renderGoalTrack;
window.clearTaskGoal = clearTaskGoal;
window.setLiveFilter = setLiveFilter;
window.beginTaskRename = beginTaskRename;

// ── Composer model chip ─────────────────────────────────
function modelLabel(id) {
  const p = MODEL_PRESETS.find((x) => x.id === (id || ''));
  if (p) return p.label;
  return id || 'CLI 默认';
}

function applyModelChip() {
  const chip = document.getElementById('modelChip');
  if (!chip) return;
  const id = state.model || '';
  chip.textContent = id ? id : 'model · default';
  chip.title = (localeIsEn() ? 'Model: ' : '模型：') + modelLabel(id) + ' · click to switch';
  chip.dataset.model = id;
}

async function applyLiveSessionModel(opts = {}) {
  const task = T();
  if (!state.model || !task?.id || !window.grok?.setSessionModel) {
    return null;
  }
  try {
    const live = await window.grok.setSessionModel({
      projectId: task.projectId || pid(),
      taskId: task.id,
      modelId: state.model,
      sessionId: task.sessionId || undefined,
      reasoningEffort: state.reasoningEffort || undefined,
    });
    if (live?.ok) {
      task.acpModelId = state.model;
      if (live.reasoningEffort != null) task.acpEffort = live.reasoningEffort;
    }
    return live;
  } catch {
    return null;
  }
}

async function setModelPreset(id, opts = {}) {
  state.model = id == null ? '' : String(id).trim();
  saveJson(MODEL_KEY, state.model);
  applyModelChip();
  // Refresh effort chip (may flip to n/a when model lacks supportsReasoningEffort)
  applyEffortChip();
  try {
    await window.grok.setConfig({
      model: state.model,
      reasoningEffort: state.reasoningEffort || '',
    });
    const cfgInput = document.getElementById('cfgModel');
    if (cfgInput) cfgInput.value = state.model;
  } catch {
    /* ignore */
  }
  const live = opts.skipLive ? null : await applyLiveSessionModel();
  if (opts.toast !== false) {
    if (live?.ok) {
      toast(
        localeIsEn()
          ? `Model (live): ${modelLabel(state.model)}${state.reasoningEffort ? ` · ${state.reasoningEffort}` : ''}`
          : `模型（已热切换）：${modelLabel(state.model)}${state.reasoningEffort ? ` · ${state.reasoningEffort}` : ''}`,
        'ok'
      );
    } else if (state.model && live && live.ok === false && !live.deferred) {
      toast(
        (localeIsEn() ? 'Model saved; live switch failed: ' : '模型已保存；热切换失败：') +
          (live.error || ''),
        'err'
      );
    } else {
      toast(
        localeIsEn()
          ? `Model: ${modelLabel(state.model)}${state.model ? ' (next run / warm ACP)' : ''}`
          : `模型：${modelLabel(state.model)}${state.model ? '（下次运行 / 预热后可热切）' : ''}`,
        'ok'
      );
    }
  }
  document.getElementById('modelMenu')?.classList.add('hidden');
  return live;
}

/**
 * Effort menu for current model (from ACP catalog when available).
 * Gate: supportsReasoningEffort; server list or legacy xhigh|high|medium|low.
 */
function currentEffortMenu() {
  const modelId = state.model || T()?.acpModelId || '';
  const models = _liveModels.models || [];
  const m = models.find((x) => x && x.id === modelId);
  if (m) {
    if (m.supportsReasoningEffort === false) {
      return { supported: false, options: [], modelId };
    }
    if (Array.isArray(m.effortOptions) && m.effortOptions.length) {
      return {
        supported: true,
        options: m.effortOptions,
        modelId,
        defaultValue: m.defaultEffort || '',
      };
    }
    if (m.supportsReasoningEffort === true) {
      return {
        supported: true,
        options: [
          { id: 'xhigh', value: 'xhigh', label: 'xhigh' },
          { id: 'high', value: 'high', label: 'high' },
          { id: 'medium', value: 'medium', label: 'medium' },
          { id: 'low', value: 'low', label: 'low' },
        ],
        modelId,
      };
    }
  }
  // No catalog meta yet — show generic presets (CLI may still accept)
  return {
    supported: true,
    options: EFFORT_PRESETS.filter((p) => p.id).map((p) => ({
      id: p.id,
      value: p.id,
      label: p.label,
    })),
    modelId,
    generic: true,
  };
}

function effortLabel(id) {
  const menu = currentEffortMenu();
  const hit = (menu.options || []).find(
    (o) => o.id === id || o.value === id
  );
  if (hit) return hit.label || hit.id || id;
  const p = EFFORT_PRESETS.find((x) => x.id === (id || ''));
  if (p) return p.label;
  return id || (localeIsEn() ? 'effort · default' : 'effort · 默认');
}

function applyEffortChip() {
  const chip = document.getElementById('effortChip');
  if (!chip) return;
  const id = state.reasoningEffort || '';
  const menu = currentEffortMenu();
  if (!menu.supported && menu.modelId) {
    chip.textContent = localeIsEn() ? 'effort · n/a' : 'effort · 不支持';
    chip.title = localeIsEn()
      ? 'Current model does not support reasoning effort'
      : '当前模型不支持 reasoning effort';
    chip.classList.add('effort-na');
  } else {
    chip.classList.remove('effort-na');
    chip.textContent = id ? `effort · ${id}` : 'effort · default';
    chip.title =
      (localeIsEn() ? 'Reasoning effort: ' : '推理强度：') +
      effortLabel(id) +
      (localeIsEn()
        ? ' · CLI /effort · session/set_model meta'
        : ' · 对齐 CLI /effort · session/set_model meta') +
      (menu.generic
        ? localeIsEn()
          ? ' (generic until model catalog loads)'
          : '（模型目录加载前用通用档位）'
        : '');
  }
  chip.dataset.effort = id;
}

async function setReasoningEffort(id, opts = {}) {
  // Map menu option id → canonical value when model remaps (e.g. deep → xhigh)
  let raw = String(id || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const menu = currentEffortMenu();
  if (raw && menu.supported) {
    const opt = (menu.options || []).find(
      (o) =>
        String(o.id).toLowerCase() === raw ||
        String(o.value).toLowerCase() === raw
    );
    if (opt?.value) raw = String(opt.value).toLowerCase();
    else if (raw && !(menu.options || []).some((o) => o.value === raw || o.id === raw)) {
      // Strict when we have a non-generic catalog
      if (!menu.generic && menu.options?.length) {
        toast(
          localeIsEn()
            ? `Unknown effort for this model; use: ${menu.options.map((o) => o.id).join(', ')}`
            : `该模型不支持该强度；可选：${menu.options.map((o) => o.id).join(', ')}`,
          'err'
        );
        return { ok: false, error: 'unknown effort' };
      }
    }
  }
  if (raw === 'x_high' || raw === 'max') raw = 'xhigh';
  if (raw === 'med') raw = 'medium';
  state.reasoningEffort = raw;
  saveJson(EFFORT_KEY, state.reasoningEffort);
  applyEffortChip();
  try {
    await window.grok.setConfig({ reasoningEffort: state.reasoningEffort });
    const cfgInput = document.getElementById('cfgReasoningEffort');
    if (cfgInput) cfgInput.value = state.reasoningEffort;
  } catch {
    /* ignore */
  }
  // Live: re-set_model with same model + new effort when possible
  const live = opts.skipLive ? null : await applyLiveSessionModel();
  if (opts.toast !== false) {
    if (live?.ok) {
      toast(
        localeIsEn()
          ? `Effort (live): ${effortLabel(state.reasoningEffort)}`
          : `推理强度（已热切）：${effortLabel(state.reasoningEffort)}`,
        'ok'
      );
    } else if (live && live.ok === false && !live.deferred) {
      toast(
        (localeIsEn() ? 'Effort saved; live apply failed: ' : '强度已保存；热切失败：') +
          (live.error || ''),
        'err'
      );
    } else {
      toast(
        localeIsEn()
          ? `Effort: ${effortLabel(state.reasoningEffort)} (next run / warm ACP)`
          : `推理强度：${effortLabel(state.reasoningEffort)}（下次运行 / 预热后可热切）`,
        'ok'
      );
    }
  }
  document.getElementById('effortMenu')?.classList.add('hidden');
  return live;
}

function bindModelChipUi() {
  const host = document.querySelector('.composer-hints');
  if (!host) return;
  let chip = document.getElementById('modelChip');
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'modelChip';
    chip.className = 'hint-chip model-chip';
    host.insertBefore(chip, host.firstChild);
  }
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute(
    'aria-label',
    localeIsEn() ? 'Model — open menu' : '模型 — 打开菜单'
  );
  let effortChip = document.getElementById('effortChip');
  if (!effortChip) {
    effortChip = document.createElement('button');
    effortChip.type = 'button';
    effortChip.id = 'effortChip';
    effortChip.className = 'hint-chip effort-chip';
    if (chip.nextSibling) host.insertBefore(effortChip, chip.nextSibling);
    else host.appendChild(effortChip);
  }
  effortChip.setAttribute('aria-haspopup', 'menu');
  effortChip.setAttribute('aria-expanded', 'false');
  effortChip.setAttribute(
    'aria-label',
    localeIsEn() ? 'Reasoning effort — open menu' : '推理强度 — 打开菜单'
  );
  let menu = document.getElementById('modelMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'modelMenu';
    menu.className = 'model-menu hidden';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', localeIsEn() ? 'Models' : '模型列表');
    document.body.appendChild(menu);
  }
  let effortMenu = document.getElementById('effortMenu');
  if (!effortMenu) {
    effortMenu = document.createElement('div');
    effortMenu.id = 'effortMenu';
    effortMenu.className = 'model-menu hidden';
    effortMenu.setAttribute('role', 'menu');
    effortMenu.setAttribute(
      'aria-label',
      localeIsEn() ? 'Reasoning effort' : '推理强度'
    );
    document.body.appendChild(effortMenu);
  }
  const placeMenu = (el, anchor) => {
    const rect = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(8, rect.left)}px`;
    el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  };
  const setExpanded = (which, open) => {
    if (which === 'model') chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (which === 'effort') {
      effortChip.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };
  const closeMenus = () => {
    menu.classList.add('hidden');
    effortMenu.classList.add('hidden');
    setExpanded('model', false);
    setExpanded('effort', false);
  };
  const openMenu = async () => {
    effortMenu.classList.add('hidden');
    setExpanded('effort', false);
    menu.innerHTML = `<div class="model-menu-item muted" style="pointer-events:none;opacity:0.7">${localeIsEn() ? 'Loading models…' : '加载模型列表…'}</div>`;
    placeMenu(menu, chip);
    menu.classList.remove('hidden');
    setExpanded('model', true);
    await refreshLiveModels({ force: false });
    const items = mergeModelMenuItems();
    const src = _liveModels.source
      ? ` · ${_liveModels.source}`
      : '';
    menu.innerHTML =
      items
        .map(
          (p) =>
            `<button type="button" class="model-menu-item${(state.model || '') === p.id ? ' active' : ''}" data-id="${esc(p.id)}" role="menuitem">${esc(p.label)}</button>`
        )
        .join('') +
      `<button type="button" class="model-menu-item" data-act="refresh" role="menuitem">${localeIsEn() ? '↻ Refresh list' : '↻ 刷新列表'}${esc(src)}</button>` +
      `<button type="button" class="model-menu-item" data-act="custom" role="menuitem">${localeIsEn() ? 'Custom…' : '自定义…'}</button>`;
    placeMenu(menu, chip);
    menu.querySelectorAll('.model-menu-item').forEach((btn) => {
      btn.onclick = async () => {
        if (btn.dataset.act === 'refresh') {
          await refreshLiveModels({ force: true });
          openMenu();
          return;
        }
        if (btn.dataset.act === 'custom') {
          const cur = state.model || '';
          const v = prompt(localeIsEn() ? 'Model id (empty = CLI default)' : '模型 ID（空=CLI 默认）', cur);
          if (v === null) return;
          await setModelPreset(v.trim());
          return;
        }
        await setModelPreset(btn.dataset.id || '');
      };
    });
    window.GrokA11y?.bindMenuKeyboard?.(menu, { focusFirst: true });
  };
  const openEffortMenu = () => {
    menu.classList.add('hidden');
    setExpanded('model', false);
    const em = currentEffortMenu();
    if (!em.supported && em.modelId) {
      effortMenu.innerHTML = `<div class="model-menu-item muted" style="pointer-events:none">${
        localeIsEn()
          ? 'This model does not support reasoning effort'
          : '当前模型不支持 reasoning effort'
      }</div>`;
      placeMenu(effortMenu, effortChip);
      effortMenu.classList.remove('hidden');
      setExpanded('effort', true);
      return;
    }
    const rows = [
      {
        id: '',
        value: '',
        label: localeIsEn() ? 'default (unset)' : '默认（未设置）',
      },
      ...(em.options || []).map((o) => ({
        id: o.id || o.value,
        value: o.value || o.id,
        label: o.label || o.id || o.value,
      })),
    ];
    effortMenu.innerHTML = rows
      .map((p) => {
        const active =
          (state.reasoningEffort || '') === (p.value || p.id) ||
          (state.reasoningEffort || '') === p.id;
        return `<button type="button" class="model-menu-item${active ? ' active' : ''}" data-id="${esc(p.id)}" data-value="${esc(p.value || p.id)}" role="menuitem">${esc(p.label)}</button>`;
      })
      .join('');
    if (em.generic) {
      effortMenu.innerHTML += `<div class="model-menu-item muted" style="pointer-events:none;font-size:11px;opacity:0.75">${
        localeIsEn()
          ? 'Generic list — run a turn to load model meta'
          : '通用列表 — 跑一轮对话可加载模型 meta'
      }</div>`;
    }
    placeMenu(effortMenu, effortChip);
    effortMenu.classList.remove('hidden');
    setExpanded('effort', true);
    effortMenu.querySelectorAll('button.model-menu-item').forEach((btn) => {
      btn.onclick = async () => {
        await setReasoningEffort(btn.dataset.value || btn.dataset.id || '');
      };
    });
    window.GrokA11y?.bindMenuKeyboard?.(effortMenu, { focusFirst: true });
  };
  chip.onclick = (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenus();
  };
  effortChip.onclick = (e) => {
    e.stopPropagation();
    if (effortMenu.classList.contains('hidden')) openEffortMenu();
    else closeMenus();
  };
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== chip && !effortMenu.contains(e.target) && e.target !== effortChip) {
      closeMenus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menu.classList.contains('hidden') && effortMenu.classList.contains('hidden')) {
      return;
    }
    closeMenus();
    e.preventDefault();
  });
  // hydrate from config later in init; local fallback
  const local = loadJson(MODEL_KEY, null);
  if (typeof local === 'string') state.model = local;
  const localEff = loadJson(EFFORT_KEY, null);
  if (typeof localEff === 'string') state.reasoningEffort = localEff;
  applyModelChip();
  applyEffortChip();
}
window.setModelPreset = setModelPreset;
window.setReasoningEffort = setReasoningEffort;
window.getComposerModel = () => state.model || '';
window.getComposerEffort = () => state.reasoningEffort || '';
window.navigateDiffFile = navigateDiffFile;
window.markDiffReviewed = markDiffReviewed;

// ── Slash commands in composer ──────────────────────────
const SLASH_COMMANDS = () => [
  {
    id: 'cli-mode',
    label: '/cli',
    desc: localeIsEn()
      ? 'Cycle CLI session mode (session/set_mode)'
      : '循环 CLI 会话模式（session/set_mode）',
    run: () => cycleWorkMode(),
  },
  {
    id: 'plan',
    label: '/plan',
    desc: localeIsEn()
      ? 'Enter CLI plan mode (session/set_mode plan)'
      : '进入 CLI 计划模式（session/set_mode plan）',
    run: () => setCliSessionMode('plan', { toast: true }),
  },
  {
    id: 'agent',
    label: '/agent',
    desc: localeIsEn()
      ? 'CLI default agent mode (session/set_mode default)'
      : 'CLI 默认 Agent 模式（session/set_mode default）',
    run: () => setCliSessionMode('default', { toast: true }),
  },
  {
    id: 'ask',
    label: '/ask',
    desc: localeIsEn()
      ? 'CLI ask mode (session/set_mode ask)'
      : 'CLI Ask 模式（session/set_mode ask）',
    run: () => setCliSessionMode('ask', { toast: true }),
  },
  {
    id: 'model',
    label: '/model',
    desc: localeIsEn() ? 'Cycle model preset' : '切换模型预设',
    run: async () => {
      const presets = MODEL_PRESETS.map((p) => p.id);
      const i = presets.indexOf(state.model || '');
      await setModelPreset(presets[(i + 1) % presets.length]);
    },
  },
  {
    id: 'effort',
    label: '/effort',
    desc: localeIsEn()
      ? 'Cycle reasoning effort for current model (CLI /effort)'
      : '循环当前模型的推理强度（对齐 CLI /effort）',
    run: async () => {
      const em = currentEffortMenu();
      if (!em.supported && em.modelId) {
        toast(
          localeIsEn()
            ? 'Current model does not support reasoning effort'
            : '当前模型不支持 reasoning effort',
          'err'
        );
        return;
      }
      const levels = [
        '',
        ...(em.options || []).map((o) => o.value || o.id),
      ];
      const cur = state.reasoningEffort || '';
      const i = levels.indexOf(cur);
      await setReasoningEffort(levels[(i < 0 ? 0 : i + 1) % levels.length]);
    },
  },
  {
    id: 'share',
    label: '/share',
    desc: localeIsEn() ? 'Export session share card' : '导出会话分享卡',
    run: () => openSessionShareCard(),
  },
  {
    id: 'rename',
    label: '/rename',
    desc: localeIsEn() ? 'Rename current task' : '重命名当前任务',
    run: () => {
      const id = window.TaskStore?.activeId;
      if (id) beginTaskRename(id);
    },
  },
  {
    id: 'diff',
    label: '/diff',
    desc: localeIsEn() ? 'Open Diff tab' : '打开 Diff',
    run: () => switchTab('diff'),
  },
  {
    id: 'search',
    label: '/search',
    desc: localeIsEn() ? 'Search messages in task' : '搜索本任务消息',
    run: () => openChatSearch(),
  },
  {
    id: 'skill',
    label: '/skill',
    desc: localeIsEn() ? 'Browse skills…' : '浏览 Skills…',
    run: async () => {
      try {
        const list = await window.grok.skillsList({ projectPath: P()?.path || null });
        const enabled = (list || []).filter((s) => s.enabled !== false).slice(0, 12);
        if (!enabled.length) {
          toast(localeIsEn() ? 'No skills' : '暂无 Skills', 'err');
          return;
        }
        // open first match menu via skill preview list in toast-style picker
        showSkillPickMenu(enabled);
      } catch (e) {
        toast(e.message || 'skills failed', 'err');
      }
    },
  },
  {
    id: 'help',
    label: '/help',
    desc: localeIsEn() ? 'Keyboard shortcuts' : '快捷键速查',
    run: () => window.GrokHelp?.open?.(),
  },
  {
    id: 'sbs',
    label: '/sbs',
    desc: localeIsEn() ? 'Toggle Diff side-by-side' : '切换 Diff 并排视图',
    run: () => {
      switchTab('diff');
      toggleDiffViewMode();
    },
  },
  {
    id: 'template',
    label: '/template',
    desc: localeIsEn() ? 'Session templates pack' : '会话模板包',
    run: () => openTemplatesMenu(),
  },
];

let slashIndex = 0;
let slashFiltered = [];

function ensureSlashMenu() {
  let menu = document.getElementById('slashMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'slashMenu';
  menu.className = 'slash-menu hidden';
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);
  return menu;
}

function hideSlashMenu() {
  const menu = document.getElementById('slashMenu');
  if (menu) menu.classList.add('hidden');
  slashFiltered = [];
}

function getSlashQuery() {
  const ta = document.getElementById('prompt');
  if (!ta) return null;
  const val = ta.value;
  // only when line starts with /
  if (!val.startsWith('/')) return null;
  const space = val.indexOf(' ');
  if (space !== -1) return null; // already chose a command with args
  return val.slice(1).toLowerCase();
}

function updateSlashMenu() {
  const q = getSlashQuery();
  const menu = ensureSlashMenu();
  if (q == null) {
    hideSlashMenu();
    return;
  }
  const all = SLASH_COMMANDS();
  slashFiltered = all.filter(
    (c) => !q || c.id.includes(q) || c.label.slice(1).includes(q) || (c.desc || '').toLowerCase().includes(q)
  );
  if (!slashFiltered.length) {
    hideSlashMenu();
    return;
  }
  if (slashIndex >= slashFiltered.length) slashIndex = 0;
  const ta = document.getElementById('prompt');
  const rect = ta.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  menu.style.width = `${Math.min(360, rect.width)}px`;
  menu.innerHTML = slashFiltered
    .map(
      (c, i) =>
        `<button type="button" class="slash-item${i === slashIndex ? ' active' : ''}" data-idx="${i}" role="option">
          <span class="slash-label">${esc(c.label)}</span>
          <span class="slash-desc">${esc(c.desc)}</span>
        </button>`
    )
    .join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('.slash-item').forEach((btn) => {
    btn.onmousedown = (e) => {
      e.preventDefault();
      runSlashAt(Number(btn.dataset.idx));
    };
  });
}

function runSlashAt(idx) {
  const cmd = slashFiltered[idx];
  if (!cmd) return;
  const ta = document.getElementById('prompt');
  if (ta) {
    ta.value = '';
    autoResizePrompt();
    updateCharCount();
  }
  hideSlashMenu();
  Promise.resolve(cmd.run()).catch((e) => toast(e.message || String(e), 'err'));
}

function handleSlashKeydown(e) {
  const menu = document.getElementById('slashMenu');
  const open = menu && !menu.classList.contains('hidden') && slashFiltered.length;
  if (!open) {
    if (e.key === 'Escape' && getSlashQuery() != null) {
      hideSlashMenu();
    }
    return false;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    slashIndex = (slashIndex + 1) % slashFiltered.length;
    updateSlashMenu();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    slashIndex = (slashIndex - 1 + slashFiltered.length) % slashFiltered.length;
    updateSlashMenu();
    return true;
  }
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    runSlashAt(slashIndex);
    return true;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    runSlashAt(slashIndex);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashMenu();
    return true;
  }
  return false;
}

function bindSlashCommands() {
  ensureSlashMenu();
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#slashMenu') && e.target?.id !== 'prompt') hideSlashMenu();
  });
}

function showSkillPickMenu(skills) {
  let menu = document.getElementById('skillPickMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skillPickMenu';
    menu.className = 'slash-menu skill-pick-menu';
    document.body.appendChild(menu);
  }
  menu.innerHTML =
    `<div class="slash-head">${localeIsEn() ? 'Skills' : 'Skills · 点开预览'}</div>` +
    skills
      .map(
        (s) =>
          `<button type="button" class="slash-item" data-file="${esc(s.skillFile || s.path || '')}" data-name="${esc(s.name)}">
            <span class="slash-label">${esc(s.name)}</span>
            <span class="slash-desc">${esc((s.description || '').slice(0, 80))}</span>
          </button>`
      )
      .join('');
  const ta = document.getElementById('prompt');
  const rect = ta?.getBoundingClientRect() || { left: 40, top: window.innerHeight - 120, width: 320 };
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  menu.style.width = `${Math.min(400, rect.width || 360)}px`;
  menu.classList.remove('hidden');
  menu.querySelectorAll('.slash-item').forEach((btn) => {
    btn.onclick = async () => {
      menu.classList.add('hidden');
      await openSkillPreview(btn.dataset.file, btn.dataset.name);
    };
  });
}

// ── In-task message search ──────────────────────────────
let chatSearchHits = [];
let chatSearchIdx = 0;

function ensureChatSearchBar() {
  let bar = document.getElementById('chatSearchBar');
  if (bar) return bar;
  const host = document.querySelector('.composer')?.parentElement || document.getElementById('messagesHost')?.parentElement;
  if (!host) return null;
  bar = document.createElement('div');
  bar.id = 'chatSearchBar';
  bar.className = 'chat-search-bar hidden';
  bar.innerHTML = `
    <span class="chat-search-label">⌕</span>
    <input type="search" id="chatSearchInput" placeholder="搜索本任务消息…" autocomplete="off" />
    <span class="chat-search-count" id="chatSearchCount">0/0</span>
    <button type="button" class="icon-btn" id="chatSearchPrev" title="上一个">↑</button>
    <button type="button" class="icon-btn" id="chatSearchNext" title="下一个">↓</button>
    <button type="button" class="icon-btn" id="chatSearchClose" title="关闭">✕</button>`;
  const messagesHost = document.getElementById('messagesHost');
  if (messagesHost) messagesHost.parentElement.insertBefore(bar, messagesHost);
  else host.prepend(bar);
  bar.querySelector('#chatSearchInput').addEventListener('input', () => runChatSearch());
  bar.querySelector('#chatSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) chatSearchStep(-1);
      else chatSearchStep(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeChatSearch();
    }
  });
  bar.querySelector('#chatSearchPrev').onclick = () => chatSearchStep(-1);
  bar.querySelector('#chatSearchNext').onclick = () => chatSearchStep(1);
  bar.querySelector('#chatSearchClose').onclick = () => closeChatSearch();
  return bar;
}

function openChatSearch() {
  const bar = ensureChatSearchBar();
  if (!bar) return;
  bar.classList.remove('hidden');
  const input = bar.querySelector('#chatSearchInput');
  input?.focus();
  input?.select();
  runChatSearch();
}

function closeChatSearch() {
  const bar = document.getElementById('chatSearchBar');
  if (bar) bar.classList.add('hidden');
  clearChatSearchHighlights();
  chatSearchHits = [];
  chatSearchIdx = 0;
}

function clearChatSearchHighlights() {
  document.querySelectorAll('.msg.chat-hit, .msg.chat-hit-active').forEach((el) => {
    el.classList.remove('chat-hit', 'chat-hit-active');
  });
}

function runChatSearch() {
  const q = (document.getElementById('chatSearchInput')?.value || '').trim().toLowerCase();
  clearChatSearchHighlights();
  chatSearchHits = [];
  chatSearchIdx = 0;
  const task = T();
  const pane = task?.pane;
  const countEl = document.getElementById('chatSearchCount');
  if (!pane || !q) {
    if (countEl) countEl.textContent = '0/0';
    return;
  }
  pane.querySelectorAll('.msg').forEach((el) => {
    const text = (el.textContent || '').toLowerCase();
    if (text.includes(q)) {
      el.classList.add('chat-hit');
      chatSearchHits.push(el);
    }
  });
  if (chatSearchHits.length) {
    chatSearchIdx = 0;
    focusChatHit(0);
  }
  if (countEl) {
    countEl.textContent = chatSearchHits.length
      ? `${chatSearchIdx + 1}/${chatSearchHits.length}`
      : '0/0';
  }
}

function focusChatHit(idx) {
  if (!chatSearchHits.length) return;
  chatSearchHits.forEach((el) => el.classList.remove('chat-hit-active'));
  chatSearchIdx = ((idx % chatSearchHits.length) + chatSearchHits.length) % chatSearchHits.length;
  const el = chatSearchHits[chatSearchIdx];
  el.classList.add('chat-hit-active');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const countEl = document.getElementById('chatSearchCount');
  if (countEl) countEl.textContent = `${chatSearchIdx + 1}/${chatSearchHits.length}`;
}

function chatSearchStep(delta) {
  if (!chatSearchHits.length) {
    runChatSearch();
    return;
  }
  focusChatHit(chatSearchIdx + delta);
}

function bindChatSearch() {
  ensureChatSearchBar();
  document.getElementById('btnChatSearch')?.addEventListener('click', () => openChatSearch());
}
window.openChatSearch = openChatSearch;
window.toggleDiffViewMode = toggleDiffViewMode;

// ── Background flight complete notify ───────────────────
function getQuietHours() {
  return (
    loadJson('grokcode-quiet-hours', { enabled: false, start: '22:00', end: '08:00' }) || {
      enabled: false,
      start: '22:00',
      end: '08:00',
    }
  );
}

function setQuietHours(q) {
  saveJson('grokcode-quiet-hours', q);
}

function parseHm(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function isQuietHoursNow() {
  const q = getQuietHours();
  if (!q?.enabled) return false;
  const start = parseHm(q.start || '22:00');
  const end = parseHm(q.end || '08:00');
  if (start == null || end == null) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true; // whole day quiet
  if (start < end) return cur >= start && cur < end;
  // overnight e.g. 22:00–08:00
  return cur >= start || cur < end;
}

function playCompleteChime() {
  if (state.notifySound === false) return;
  if (isQuietHoursNow()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = playCompleteChime._ctx || new Ctx();
    playCompleteChime._ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume?.();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.05, now + 0.02 + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28 + i * 0.08);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(now + i * 0.08);
      o.stop(now + 0.35 + i * 0.08);
    });
  } catch {
    /* ignore */
  }
}

function notifyFlightComplete(task, stats = {}) {
  if (!task) return;
  const bg = !isActiveTask(task) || document.hidden;
  if (!bg && task.turnMode !== 'craft') return;
  // Always soft-notify when not focused / not active task
  if (!bg && !document.hidden) {
    // active craft still gets a short toast if multi-task running elsewhere only
    return;
  }
  const files = stats.files || 0;
  const tools = stats.tools || 0;
  const msg = localeIsEn()
    ? `Flight done · ${task.title} · ${tools} tools · ${files} files`
    : `飞行完成 · ${task.title} · ${tools} 工具 · ${files} 文件`;
  toast(msg, 'ok');
  playCompleteChime();
  try {
    if (document.hidden && typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        new Notification('GrokCode', { body: msg, silent: true });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission?.();
      }
    }
  } catch {
    /* ignore */
  }
}

// ── Rules quick edit from status bar ────────────────────
function bindRulesQuickEdit() {
  let chip = document.getElementById('sbRules');
  if (!chip) {
    const foot = document.querySelector('.statusbar');
    if (!foot) return;
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'sbRules';
    chip.className = 'sb-rules';
    chip.textContent = 'rules';
    const agent = document.getElementById('sbAgent');
    if (agent?.nextSibling) foot.insertBefore(chip, agent.nextSibling);
    else foot.appendChild(chip);
  }
  const refresh = async () => {
    try {
      const cfg = await window.grok.getConfig();
      const rules = String(cfg.rules || '').trim();
      let proj = '';
      try {
        if (P()?.path) {
          const pr = await window.grok.projectRulesGet({ projectPath: P().path, projectId: pid() });
          proj = String(pr?.text || '').trim();
        }
      } catch {
        /* ignore */
      }
      const any = rules || proj;
      const quiet = isQuietHoursNow();
      chip.textContent = quiet
        ? 'rules · quiet'
        : any
          ? `rules · ${(rules || proj).slice(0, 14)}${(rules || proj).length > 14 ? '…' : ''}`
          : 'rules';
      chip.title =
        (rules ? `global:\n${rules.slice(0, 200)}\n` : '') +
        (proj ? `project:\n${proj.slice(0, 200)}\n` : '') +
        (localeIsEn() ? 'Click to edit' : '点击编辑') +
        (quiet ? (localeIsEn() ? ' · quiet hours' : ' · 静音时段') : '');
      chip.classList.toggle('has-rules', Boolean(any));
      chip.classList.toggle('quiet', quiet);
    } catch {
      /* ignore */
    }
  };
  chip.onclick = () => openRulesQuickEdit();
  refresh();
  window.refreshRulesChip = refresh;
}

window.openRulesQuickEdit = openRulesQuickEdit;
async function openRulesQuickEdit() {
  let cfg;
  try {
    cfg = await window.grok.getConfig();
  } catch {
    cfg = {};
  }
  let projRules = { text: '', file: null, exists: false };
  try {
    if (P()?.path) {
      projRules = await window.grok.projectRulesGet({ projectPath: P().path, projectId: pid() });
    }
  } catch {
    /* ignore */
  }
  const quiet = getQuietHours();
  let root = document.getElementById('rulesQuickModal');
  if (!root) {
    root = document.createElement('div');
    root.id = 'rulesQuickModal';
    root.className = 'gc-modal hidden';
    root.setAttribute('role', 'dialog');
    document.body.appendChild(root);
  }
  const en = localeIsEn();
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="gc-modal-backdrop" data-close="1"></div>
    <div class="gc-modal-card glass" style="width:min(560px,94vw);max-height:min(88vh,760px);overflow:auto">
      <div class="gc-modal-head">
        <div>
          <div class="skill-preview-kicker">RULES</div>
          <h2>${en ? 'Rules & notify' : '规则与通知'}</h2>
          <p class="skill-preview-desc">${en ? 'Global --rules + workspace .grok/rules.md' : '全局 --rules + 工作区 .grok/rules.md'}</p>
        </div>
        <button type="button" class="icon-btn" data-close="1">✕</button>
      </div>
      <label class="rules-label">${en ? 'Global rules (--rules)' : '全局规则 (--rules)'}</label>
      <textarea id="rulesQuickText" class="rules-quick-ta" rows="5" placeholder="${en ? 'e.g. Prefer Chinese; no git commit' : '例如：优先中文；不要 git commit'}"></textarea>
      <label class="rules-label">${en ? 'Project rules (.grok/rules.md)' : '项目规则 (.grok/rules.md)'}${projRules.file ? ` · ${esc(String(projRules.file).split(/[/\\]/).slice(-2).join('/'))}` : ''}</label>
      <textarea id="projectRulesText" class="rules-quick-ta" rows="5" placeholder="${en ? 'Overrides for this workspace only' : '仅对本工作区生效'}" ${P() ? '' : 'disabled'}></textarea>
      <div class="rules-quiet-row">
        <label><input type="checkbox" id="quietEnabled" ${quiet.enabled ? 'checked' : ''}/> ${en ? 'Quiet hours (mute chime)' : '静音时段（关闭提示音）'}</label>
        <input type="time" id="quietStart" value="${esc(quiet.start || '22:00')}" />
        <span>–</span>
        <input type="time" id="quietEnd" value="${esc(quiet.end || '08:00')}" />
      </div>
      <div class="gc-modal-actions">
        <button type="button" class="btn small ghost" data-act="sound">${state.notifySound !== false ? (en ? 'Chime on' : '提示音开') : en ? 'Chime off' : '提示音关'}</button>
        <button type="button" class="btn small ghost" data-act="open-file" ${P() ? '' : 'disabled'}>${en ? 'Open in Code' : '在 Code 打开'}</button>
        <button type="button" class="btn small ghost" data-close="1">${en ? 'Cancel' : '取消'}</button>
        <button type="button" class="btn small primary" data-act="save">${en ? 'Save' : '保存'}</button>
      </div>
    </div>`;
  const ta = root.querySelector('#rulesQuickText');
  const pta = root.querySelector('#projectRulesText');
  if (ta) ta.value = cfg.rules || '';
  if (pta) pta.value = projRules.text || '';
  const close = () => root.classList.add('hidden');
  root.querySelectorAll('[data-close]').forEach((el) => {
    el.onclick = () => close();
  });
  root.querySelector('[data-act="sound"]').onclick = (e) => {
    state.notifySound = state.notifySound === false;
    saveJson('grokcode-notify-sound', state.notifySound);
    e.currentTarget.textContent =
      state.notifySound !== false ? (en ? 'Chime on' : '提示音开') : en ? 'Chime off' : '提示音关';
    if (state.notifySound !== false) playCompleteChime();
  };
  const saveAll = async () => {
    const rules = ta?.value || '';
    const projectText = pta?.value || '';
    await window.grok.setConfig({ rules });
    const cfgEl = document.getElementById('cfgRules');
    if (cfgEl) cfgEl.value = rules;
    if (P()?.path) {
      await window.grok.projectRulesSet({
        projectPath: P().path,
        projectId: pid(),
        content: projectText,
      });
    }
    setQuietHours({
      enabled: Boolean(root.querySelector('#quietEnabled')?.checked),
      start: root.querySelector('#quietStart')?.value || '22:00',
      end: root.querySelector('#quietEnd')?.value || '08:00',
    });
    window.refreshRulesChip?.();
  };
  root.querySelector('[data-act="open-file"]')?.addEventListener('click', async () => {
    if (!P()) {
      toast(en ? 'Open a project first' : '请先打开项目', 'err');
      return;
    }
    try {
      await saveAll();
      const rel = '.grok/rules.md';
      close();
      await openFile(rel, { switchToCode: true });
      switchTab('editor');
      toast(en ? 'Opened .grok/rules.md' : '已打开 .grok/rules.md', 'ok');
    } catch (err) {
      toast(err.message || 'open failed', 'err');
    }
  });
  root.querySelector('[data-act="save"]').onclick = async () => {
    try {
      await saveAll();
      toast(en ? 'Rules saved' : '规则已保存', 'ok');
      close();
    } catch (err) {
      toast(err.message || 'save failed', 'err');
    }
  };
  ta?.focus();
}

// ── Composer paste / drag-drop attachments ──────────────
function bindComposerAttachments() {
  const ta = document.getElementById('prompt');
  if (!ta || ta._attachBound) return;
  ta._attachBound = true;
  ta.addEventListener('paste', onComposerPaste);
  ensureAttachBar();
  const zone = document.querySelector('.composer') || document.querySelector('.composer-box');
  if (zone && !zone._dropBound) {
    zone._dropBound = true;
    zone.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      zone.classList.add('drag-attach');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-attach');
    });
    zone.addEventListener('drop', async (e) => {
      zone.classList.remove('drag-attach');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      for (const file of files.slice(0, 6)) {
        await addAttachmentFromFile(file);
      }
      renderAttachBar();
      toast(
        localeIsEn()
          ? `Attached ${Math.min(files.length, 6)} file(s)`
          : `已附加 ${Math.min(files.length, 6)} 个文件`,
        'ok'
      );
    });
  }
}

function ensureAttachBar() {
  let bar = document.getElementById('attachBar');
  if (bar) return bar;
  const box = document.querySelector('.composer-box');
  if (!box) return null;
  bar = document.createElement('div');
  bar.id = 'attachBar';
  bar.className = 'attach-bar hidden';
  box.parentElement?.insertBefore(bar, box);
  return bar;
}

function renderAttachBar() {
  const bar = ensureAttachBar();
  if (!bar) return;
  if (!state.attachments.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML =
    state.attachments
      .map(
        (a, i) =>
          `<span class="attach-chip" title="${esc(a.relPath || a.mime || '')} · ${formatBytes(a.size || 0)}">
            ${a.kind === 'image' ? '🖼' : a.kind === 'text' ? '📄' : '📎'} ${esc(a.name)}${
              a.relPath ? ' · saved' : ''
            }
            <button type="button" data-i="${i}" aria-label="remove">×</button>
          </span>`
      )
      .join('') +
    `<button type="button" class="link-btn" id="attachClearAll">${localeIsEn() ? 'Clear' : '清空'}</button>`;
  bar.querySelectorAll('button[data-i]').forEach((btn) => {
    btn.onclick = () => {
      state.attachments.splice(Number(btn.dataset.i), 1);
      renderAttachBar();
    };
  });
  bar.querySelector('#attachClearAll')?.addEventListener('click', () => clearAttachments());
}

function clearAttachments() {
  state.attachments = [];
  renderAttachBar();
}

function buildAttachmentContextNote() {
  if (!state.attachments.length) return '';
  const lines = [
    localeIsEn()
      ? '【Pasted attachments — context notes for the agent】'
      : '【粘贴附件 · 供 Agent 参考的上下文笔记】',
  ];
  for (const a of state.attachments) {
    if (a.kind === 'text' && a.text) {
      lines.push(`\n### ${a.name} (${a.mime || 'text'})\n\`\`\`\n${a.text.slice(0, 12000)}\n\`\`\``);
    } else if (a.kind === 'image') {
      if (a.relPath) {
        lines.push(
          `\n### ${a.name} (image · ${formatBytes(a.size || 0)})\n` +
            (localeIsEn()
              ? `Saved under workspace: \`${a.relPath}\` — open/read this file if you need the visual reference.`
              : `已保存到工作区：\`${a.relPath}\` — 如需视觉参考可读取该文件。`)
        );
      } else {
        lines.push(
          `\n### ${a.name} (image/${(a.mime || '').replace('image/', '') || 'png'} · ${formatBytes(a.size || 0)})\n` +
            (localeIsEn()
              ? 'User pasted an image in the desktop UI. Image bytes are not sent to CLI; treat as visual intent and follow the user text.'
              : '用户在桌面端粘贴了图片；图片字节未上传 CLI，请结合用户文字理解意图。')
        );
      }
    } else {
      lines.push(`\n### ${a.name} (${a.mime || 'file'} · ${formatBytes(a.size || 0)})`);
    }
  }
  return lines.join('\n');
}

async function onComposerPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [...(cd.files || [])];
  // also items
  if (!files.length && cd.items) {
    for (const item of cd.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (!files.length) return;
  e.preventDefault();
  for (const file of files.slice(0, 6)) {
    await addAttachmentFromFile(file);
  }
  renderAttachBar();
  toast(
    localeIsEn()
      ? `Attached ${state.attachments.length} item(s)`
      : `已附加 ${state.attachments.length} 项`,
    'ok'
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

async function addAttachmentFromFile(file) {
  if (!file) return;
  const name = file.name || `paste-${Date.now()}`;
  const mime = file.type || 'application/octet-stream';
  const size = file.size || 0;
  if (mime.startsWith('image/')) {
    if (size > 4_000_000) {
      toast(localeIsEn() ? 'Image too large (>4MB)' : '图片过大（>4MB）', 'err');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    let relPath = null;
    // Prefer saving into workspace .grok/paste/ so agent can read the file
    if (P()?.path && pid()) {
      try {
        const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const saved = await window.grok.pasteSaveImage({
          projectId: pid(),
          projectPath: P().path,
          base64: dataUrl,
          ext,
          name: name.replace(/\.[^.]+$/, '') || 'paste',
        });
        relPath = saved?.relPath || null;
      } catch (err) {
        console.warn('pasteSaveImage', err);
      }
    }
    state.attachments.push({
      kind: 'image',
      name: relPath ? relPath.split('/').pop() : name,
      mime,
      size,
      dataUrl,
      relPath,
    });
    return;
  }
  // text-like
  if (
    mime.startsWith('text/') ||
    /\.(md|txt|json|js|ts|tsx|jsx|css|html|py|go|rs|java|yml|yaml|toml|xml|csv|log)$/i.test(name) ||
    size < 200_000
  ) {
    if (size > 200_000) {
      toast(localeIsEn() ? 'Text file too large' : '文本文件过大', 'err');
      return;
    }
    try {
      const text = await readFileAsText(file);
      state.attachments.push({ kind: 'text', name, mime, size, text: String(text || '') });
      return;
    } catch {
      /* fallthrough */
    }
  }
  state.attachments.push({ kind: 'file', name, mime, size });
}

// ── @file mentions ──────────────────────────────────────
let atIndex = 0;
let atHits = [];
let atMeta = null; // { start, query }
let atTimer = null;

function ensureAtMenu() {
  let menu = document.getElementById('atMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'atMenu';
  menu.className = 'slash-menu at-menu hidden';
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);
  return menu;
}

function hideAtMenu() {
  document.getElementById('atMenu')?.classList.add('hidden');
  atHits = [];
  atMeta = null;
}

function getAtContext() {
  const ta = document.getElementById('prompt');
  if (!ta) return null;
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  // @query at end of typed text before cursor (no spaces in query)
  const m = before.match(/(^|[\s([{])@([^\s@]*)$/);
  if (!m) return null;
  const query = m[2] || '';
  const start = before.length - query.length - 1; // index of @
  return { start, query, pos };
}

function scheduleAtMenu() {
  clearTimeout(atTimer);
  atTimer = setTimeout(() => updateAtMenu().catch(() => hideAtMenu()), 120);
}

async function updateAtMenu() {
  const ctx = getAtContext();
  const menu = ensureAtMenu();
  if (!ctx || !P()) {
    hideAtMenu();
    return;
  }
  // if slash menu owns the input, skip
  if (getSlashQuery() != null) {
    hideAtMenu();
    return;
  }
  atMeta = ctx;
  let hits = [];
  try {
    const res = await window.grok.searchPaths(pid(), ctx.query || '', { maxHits: 24 });
    hits = (res?.hits || res || []).map((h) => (typeof h === 'string' ? h : h.path || h.rel || '')).filter(Boolean);
  } catch {
    hits = [];
  }
  // also include open / changed files when query empty
  if (!ctx.query) {
    const extra = [];
    if (P()?.currentFile) extra.push(P().currentFile);
    for (const p of changesMap().keys()) extra.push(p);
    hits = [...new Set([...extra, ...hits])].slice(0, 24);
  }
  atHits = hits;
  if (!atHits.length) {
    menu.innerHTML = `<div class="slash-head">@ files</div><div class="slash-desc" style="padding:8px 10px">${localeIsEn() ? 'No matches' : '无匹配文件'}</div>`;
    positionMentionMenu(menu);
    menu.classList.remove('hidden');
    return;
  }
  if (atIndex >= atHits.length) atIndex = 0;
  menu.innerHTML =
    `<div class="slash-head">@ ${localeIsEn() ? 'insert path' : '插入路径'}</div>` +
    atHits
      .map(
        (p, i) =>
          `<button type="button" class="slash-item${i === atIndex ? ' active' : ''}" data-idx="${i}" role="option">
            <span class="slash-label">${esc(p.split(/[/\\]/).pop())}</span>
            <span class="slash-desc">${esc(p)}</span>
          </button>`
      )
      .join('');
  positionMentionMenu(menu);
  menu.classList.remove('hidden');
  menu.querySelectorAll('.slash-item').forEach((btn) => {
    btn.onmousedown = (e) => {
      e.preventDefault();
      insertAtPath(Number(btn.dataset.idx));
    };
  });
}

function positionMentionMenu(menu) {
  const ta = document.getElementById('prompt');
  if (!ta) return;
  const rect = ta.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  menu.style.width = `${Math.min(420, rect.width)}px`;
}

function insertAtPath(idx) {
  const path = atHits[idx];
  const ta = document.getElementById('prompt');
  if (!path || !ta || !atMeta) return;
  const val = ta.value;
  const before = val.slice(0, atMeta.start);
  const after = val.slice(atMeta.pos ?? ta.selectionStart);
  const insert = `\`${path.replace(/\\/g, '/')}\``;
  ta.value = before + insert + after;
  const caret = (before + insert).length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  hideAtMenu();
  autoResizePrompt();
  updateCharCount();
  schedulePromptDraftSave();
}

function handleAtKeydown(e) {
  const menu = document.getElementById('atMenu');
  const open = menu && !menu.classList.contains('hidden') && atHits.length;
  if (!open) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    atIndex = (atIndex + 1) % atHits.length;
    updateAtMenu();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    atIndex = (atIndex - 1 + atHits.length) % atHits.length;
    updateAtMenu();
    return true;
  }
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    insertAtPath(atIndex);
    return true;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    insertAtPath(atIndex);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideAtMenu();
    return true;
  }
  return false;
}

function bindAtMentions() {
  ensureAtMenu();
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#atMenu') && e.target?.id !== 'prompt') hideAtMenu();
  });
}

// ── Prompt draft auto-backup ────────────────────────────
const DRAFT_KEY = 'grokcode-prompt-drafts-v1';
let draftTimer = null;

function draftStorageKey(task) {
  task = task || T();
  const proj = task ? window.ProjectStore.get(task.projectId) : P();
  if (!task || !proj) return null;
  return `${proj.path || proj.id}::${task.id}`;
}

function schedulePromptDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => savePromptDraft(), 400);
}

function savePromptDraft(task) {
  task = task || T();
  const key = draftStorageKey(task);
  if (!key) return;
  const text = document.getElementById('prompt')?.value || '';
  const all = loadJson(DRAFT_KEY, {}) || {};
  if (!text.trim()) {
    if (all[key]) {
      delete all[key];
      saveJson(DRAFT_KEY, all);
    }
    return;
  }
  all[key] = { text, ts: Date.now() };
  // prune old drafts (> 50)
  const keys = Object.keys(all);
  if (keys.length > 50) {
    keys
      .sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0))
      .slice(0, keys.length - 50)
      .forEach((k) => delete all[k]);
  }
  saveJson(DRAFT_KEY, all);
}

function loadPromptDraft(task) {
  task = task || T();
  const key = draftStorageKey(task);
  const ta = document.getElementById('prompt');
  if (!key || !ta) return;
  const all = loadJson(DRAFT_KEY, {}) || {};
  const d = all[key];
  ta.value = d?.text || '';
  autoResizePrompt();
  updateCharCount();
}

function clearPromptDraft(task) {
  task = task || T();
  const key = draftStorageKey(task);
  if (!key) return;
  const all = loadJson(DRAFT_KEY, {}) || {};
  if (all[key]) {
    delete all[key];
    saveJson(DRAFT_KEY, all);
  }
}



// ── Live / Diff mission control ─────────────────────────
/** Coalesce timeline rebuilds under tool storms (perf) */
const LiveBatcher = {
  MS: 56,
  timer: 0,
  dirty: false,
  projId: null,

  schedule(proj) {
    this.dirty = true;
    this.projId = proj?.id || this.projId;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.MS);
  },

  flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (!this.dirty) return;
    this.dirty = false;
    const proj =
      (this.projId && window.ProjectStore?.get?.(this.projId)) || P();
    this.projId = null;
    if (proj && P() && proj.id === P().id) {
      rebuildLiveTimeline(proj);
    }
    updateLiveStats();
  },
};

function pushLiveEvent({ kind, title, sub, running = false, projectId = null, immediate = false }) {
  const proj = projectId ? window.ProjectStore.get(projectId) : P();
  const ev = { kind, title, sub, ts: Date.now(), running: Boolean(running) };
  if (proj) {
    if (!Array.isArray(proj.activity)) proj.activity = [];
    proj.activity.push(ev);
    const maxKeep = window.GrokLiveVirtual?.MAX_KEEP || 500;
    if (proj.activity.length > maxKeep) proj.activity = proj.activity.slice(-maxKeep);
  }

  // 仅当前激活项目刷新 DOM
  if (!proj || !P() || proj.id !== P().id) {
    updateLiveStats();
    return;
  }

  // Fast path: unfiltered append without full rebuild
  if (
    !immediate &&
    (state.liveFilter || 'all') === 'all' &&
    window.GrokLiveVirtual?.appendEvent
  ) {
    const box = document.getElementById('liveTimeline');
    if (box && !box.querySelector('#liveEmpty') && (box._virt || box.children.length > 0)) {
      window.GrokLiveVirtual.appendEvent(box, ev, { esc });
      const task = T();
      if (task?.running && (task.streamBuf || task.thoughtBuf)) {
        paintLiveStreamMirrors(task);
      }
      updateLiveStats();
      return;
    }
  }

  if (immediate) {
    LiveBatcher.flush();
    rebuildLiveTimeline(proj);
    updateLiveStats();
    return;
  }
  LiveBatcher.schedule(proj);
}

function setLivePhase(phase, detail) {
  if ($('#livePhase')) $('#livePhase').textContent = phase;
  if ($('#liveDetail')) $('#liveDetail').textContent = detail || '';
  const p = P();
  if (p) {
    p.livePhase = phase;
    p.liveDetail = detail || '';
  }
  const run = anyRunning();
  $('#livePulse')?.classList.toggle('on', run);
  $('#liveBadge')?.classList.toggle('hidden', !run);
}

function updateLiveStats() {
  const tools = window.TaskStore.list().reduce((n, t) => n + (t.toolCount || 0), 0);
  if ($('#statTools')) $('#statTools').textContent = `${tools} tools`;
  if ($('#statFiles')) $('#statFiles').textContent = `${changesMap().size} files`;
  const task = T();
  if (task?.running && task.elapsedStart) {
    const s = Math.floor((Date.now() - task.elapsedStart) / 1000);
    if ($('#statElapsed')) $('#statElapsed').textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  } else if ($('#statElapsed') && !anyRunning()) {
    $('#statElapsed').textContent = '—';
  }
  const r = window.TaskStore.countRunning();
  if ($('#liveBadge') && r > 1) {
    $('#liveBadge').textContent = `● ${r} LIVE`;
  } else if ($('#liveBadge')) {
    $('#liveBadge').textContent = '● LIVE';
  }
  updateReviewBridgeUi();
}

function setLiveFocus(path, content, opts = {}) {
  const snip = String(content || '')
    .split(/\r?\n/)
    .slice(0, 12)
    .join('\n');
  if (opts.persist !== false && P()) {
    P().focusPath = path;
    P().focusSnippet = snip;
  }
  state.focusPath = path;
  const el = $('#liveFocus');
  if (!el) return;
  el.innerHTML = `
    <div class="path">${esc(path)}</div>
    <div class="snippet">${esc(snip || '(空文件)')}</div>`;
}

function renderLiveChanges() {
  const el = $('#liveChanges');
  if (!el) return;
  if (!changesMap().size) {
    el.innerHTML = '<div class="muted">尚无文件变更</div>';
    return;
  }
  const items = [...changesMap().entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  el.innerHTML = items
    .map(([p, c]) => {
      const tag = c.restored ? 'mod' : c.created ? 'add' : 'mod';
      const label = c.restored ? 'RST' : c.created ? 'NEW' : 'MOD';
      const name = p.split('/').pop();
      return `<div class="change-item" data-path="${esc(p)}"><span class="tag ${tag}">${label}</span><span class="name" title="${esc(p)}">${esc(name)}</span></div>`;
    })
    .join('');
  el.querySelectorAll('.change-item').forEach((node) => {
    node.onclick = () => {
      requireProject().selectedDiffPath = node.dataset.path;
      switchTab('diff');
      renderDiffPane();
    };
  });
}

async function cacheFileBefore(path) {
  if (!path || contentCacheMap().has(path)) return;
  try {
    const exists = await window.grok.exists(pid(), path);
    if (!exists) {
      contentCacheMap().set(path, '');
      return;
    }
    const data = await window.grok.readFile(pid(), path);
    if (!data.error) contentCacheMap().set(path, data.content);
  } catch {
    /* ignore */
  }
}

async function recordFileChange(path, { reason = 'change' } = {}) {
  if (!path || !P()) return;
  try {
    const exists = await window.grok.exists(pid(), path);
    let after = '';
    if (exists) {
      const data = await window.grok.readFile(pid(), path);
      if (data.error) return;
      after = data.content;
    }
    const cached = contentCacheMap().has(path) ? contentCacheMap().get(path) : null;
    const prev = changesMap().get(path);
    // 连续修改保留最初 before；已还原则重新开基线
    const keepBefore =
      prev && !prev.restored ? prev.before : cached != null ? cached : exists ? '' : '';
    if (keepBefore === after && prev && !prev.restored) {
      return; // 相对最初基线无变化
    }
    if (cached != null && cached === after && !prev) {
      return; // 相对缓存无变化
    }
    const recomputed = window.DiffUtil.computeLineDiff(keepBefore, after);
    const task = T();
    const turnMeta = {
      turnId: task?.turnId || null,
      taskId: task?.id || null,
      taskTitle: task?.title || null,
      prompt: task?.lastPrompt || null,
      ts: Date.now(),
      reason,
    };
    const turns = Array.isArray(prev?.turns) ? prev.turns.slice(-8) : [];
    if (turnMeta.turnId || turnMeta.taskTitle) turns.push(turnMeta);
    const entry = {
      path,
      before: keepBefore,
      after,
      stats: recomputed.stats,
      ops: recomputed.ops,
      created: (prev && !prev.restored ? prev.created : false) || keepBefore === '',
      ts: Date.now(),
      turnId: turnMeta.turnId,
      taskTitle: turnMeta.taskTitle,
      taskId: turnMeta.taskId,
      prompt: turnMeta.prompt,
      turns,
      reason,
      restored: false,
      reviewed: prev && !prev.restored ? Boolean(prev.reviewed) : false,
      checkpoints: Array.isArray(prev?.checkpoints) ? prev.checkpoints.slice() : [],
      viewCheckpoint: prev?.viewCheckpoint ?? -1,
    };
    // store content snapshot for turn replay (cap size)
    if (String(after).length <= 400_000) {
      pushFileCheckpoint(entry, {
        ...turnMeta,
        after,
      });
    }
    changesMap().set(path, entry);
    // 更新缓存到最新，便于后续二次修改
    contentCacheMap().set(path, after);
    state.lastDiffs = [...changesMap().values()].map((c) => ({
      path: c.path,
      content: c.after,
    }));

    pushLiveEvent({
      kind: 'write',
      title: entry.created ? `创建 ${path}` : `修改 ${path}`,
      sub: `+${recomputed.stats.adds}  -${recomputed.stats.dels}`,
    });
    renderLiveChanges();
    if (state.activeTab === 'diff') renderDiffPane();
    updateLiveStats();
    updateEditorChrome();
    updateReviewBridgeUi();

    // 跟随：写文件后可选跳转 Diff
    if (state.followAgent && anyRunning()) {
      requireProject().selectedDiffPath = path;
      setLiveFocus(path, after);
      if (state.activeTab === 'editor') {
        // 静默刷新编辑器内容
        if (requireProject().currentFile === path && !(P() && P().dirty)) {
          $('#editor').value = after;
          syncGutter();
        }
      }
    }
  } catch (err) {
    console.warn('recordFileChange', path, err);
  }
}

function onFsChanged(payload) {
  const rel = payload?.path;
  if (!rel) return;
  if (state._restoring) return;
  const projectId = payload.projectId;
  // 只处理本窗口已挂载的项目
  const proj = projectId ? window.ProjectStore.get(projectId) : P();
  if (!proj) return;

  const key = `${proj.id}::${rel}`;
  clearTimeout(state.fsDebounce.get(key));
  state.fsDebounce.set(
    key,
    setTimeout(() => {
      state.fsDebounce.delete(key);
      if (state._restoring) return;
      const runningHere = (proj.tasks || []).some((t) => t.running);
      if (runningHere || proj.contentCache.has(rel) || proj.changes.has(rel)) {
        // 临时切到该项目上下文记录 diff（不改变 UI 激活项）
        recordFileChangeForProject(proj, rel, { reason: 'fs' });
      }
    }, 350)
  );
}

/** 向指定项目记录变更（后台项目也能记） */
async function recordFileChangeForProject(proj, filePath, { reason = 'change' } = {}) {
  if (!proj || !filePath) return;
  const was = window.ProjectStore.activeId;
  // 若就是当前项目，走原逻辑
  if (was === proj.id) {
    return recordFileChange(filePath, { reason });
  }
  // 后台项目：直接操作其 maps
  try {
    const exists = await window.grok.exists(proj.id, filePath);
    let after = '';
    if (exists) {
      const data = await window.grok.readFile(proj.id, filePath);
      if (data.error) return;
      after = data.content;
    }
    const cached = proj.contentCache.has(filePath) ? proj.contentCache.get(filePath) : null;
    const prev = proj.changes.get(filePath);
    const keepBefore =
      prev && !prev.restored ? prev.before : cached != null ? cached : exists ? '' : '';
    if (keepBefore === after && prev && !prev.restored) return;
    if (cached != null && cached === after && !prev) return;
    const recomputed = window.DiffUtil.computeLineDiff(keepBefore, after);
    const runningTask = (proj.tasks || []).find((t) => t.running) || null;
    const turnMeta = {
      turnId: runningTask?.turnId || null,
      taskId: runningTask?.id || null,
      taskTitle: runningTask?.title || proj.name,
      prompt: runningTask?.lastPrompt || null,
      ts: Date.now(),
      reason,
    };
    const turns = Array.isArray(prev?.turns) ? prev.turns.slice(-8) : [];
    if (turnMeta.turnId || turnMeta.taskTitle) turns.push(turnMeta);
    const entry = {
      path: filePath,
      before: keepBefore,
      after,
      stats: recomputed.stats,
      ops: recomputed.ops,
      created: (prev && !prev.restored ? prev.created : false) || keepBefore === '',
      ts: Date.now(),
      turnId: turnMeta.turnId,
      taskTitle: turnMeta.taskTitle,
      taskId: turnMeta.taskId,
      prompt: turnMeta.prompt,
      turns,
      reason,
      restored: false,
      reviewed: prev && !prev.restored ? Boolean(prev.reviewed) : false,
      checkpoints: Array.isArray(prev?.checkpoints) ? prev.checkpoints.slice() : [],
      viewCheckpoint: prev?.viewCheckpoint ?? -1,
    };
    if (String(after).length <= 400_000) {
      pushFileCheckpoint(entry, { ...turnMeta, after });
    }
    proj.changes.set(filePath, entry);
    proj.contentCache.set(filePath, after);
    pushLiveEvent({
      kind: 'write',
      title: `[${proj.name}] ${keepBefore === '' ? '创建' : '修改'} ${filePath}`,
      sub: `+${recomputed.stats.adds}  -${recomputed.stats.dels}`,
    });
    renderProjectTabs();
  } catch (e) {
    console.warn('recordFileChangeForProject', e);
  }
}

function sortedDiffItems() {
  return [...changesMap().entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
}

/** Collect agent turns across all Diff files for the scrubber */
function collectGlobalTurns() {
  // Offline storyboard pack → filmstrip (imported JSON/HTML/AES)
  if (state.storyboardOverlay?.turns?.length) {
    return state.storyboardOverlay.turns.map((t, i) => {
      const key = t.key || `imp-${t.ts || i}`;
      return {
        key,
        turnId: t.turnId || t.key || null,
        ts: t.ts || 0,
        taskTitle: t.taskTitle || '',
        prompt: t.prompt || '',
        files: new Set(Array.isArray(t.files) ? t.files : []),
        imported: true,
        diffs: t.diffs || [],
        note: t.note || '',
      };
    });
  }
  const map = new Map();
  for (const [filePath, e] of changesMap()) {
    const cps = e.checkpoints || [];
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      const key = cp.turnId || `ts-${cp.ts || i}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          turnId: cp.turnId || null,
          ts: cp.ts || 0,
          taskTitle: cp.taskTitle || '',
          prompt: cp.prompt || '',
          files: new Set(),
        });
      }
      const g = map.get(key);
      g.files.add(filePath);
      if ((cp.ts || 0) > (g.ts || 0)) {
        g.ts = cp.ts;
        g.taskTitle = cp.taskTitle || g.taskTitle;
        g.prompt = cp.prompt || g.prompt;
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/**
 * Import storyboard pack into Diff filmstrip (offline re-view).
 * Hydrates change entries + checkpoints; mini-diff text when full content missing.
 * If project open and paths still exist on disk → rehydrate after/ops from disk.
 */
async function importStoryboardToFilmstrip() {
  const en = localeIsEn();
  try {
    toast(en ? 'Pick storyboard pack…' : '选择 storyboard 包…', 'ok');
    const raw = await window.grok.templateImportRaw({ storyboard: true });
    if (raw?.canceled) return;
    const resolved = await resolveStoryboardImport(raw, en);
    if (!resolved.pack) {
      toast(resolved.error || 'import failed', 'err');
      return;
    }
    hydrateStoryboardOverlay(resolved.pack, resolved.file);
    applyLayoutMode('review', { toast: false, persist: true });
    switchTab('diff');
    const turns = collectGlobalTurns();
    if (turns.length) scrubToTurn(turns[turns.length - 1].key);

    let re = { ok: 0, miss: 0, skipped: true };
    if (P()?.path || P()?.id) {
      re = await rehydrateStoryboardFromDisk({ silent: true });
    }

    renderDiffPane();
    updateReviewBridgeUi();
    const n = turns.length;
    const reBit =
      re.skipped
        ? en
          ? ' · open a project to rehydrate from disk'
          : ' · 打开项目可从磁盘 rehydrate'
        : en
          ? ` · disk ${re.ok} ok / ${re.miss} miss`
          : ` · 磁盘 ${re.ok} 成功 / ${re.miss} 缺失`;
    toast(
      en
        ? `Storyboard loaded · ${n} turns · ${resolved.file?.split(/[/\\]/).pop() || 'pack'}${reBit}`
        : `已载入 storyboard · ${n} 轮 · ${resolved.file?.split(/[/\\]/).pop() || '包'}${reBit}`,
      'ok'
    );
  } catch (e) {
    toast(e.message || 'import failed', 'err');
  }
}
window.importStoryboardToFilmstrip = importStoryboardToFilmstrip;

function hydrateStoryboardOverlay(pack, file) {
  const turns = Array.isArray(pack?.turns) ? pack.turns : [];
  state.storyboardOverlay = {
    pack,
    file: file || '',
    turns,
    importedAt: Date.now(),
    rehydrate: null,
  };
  for (const t of turns) {
    const key = t.key || `imp-${t.ts || Math.random().toString(36).slice(2, 8)}`;
    if (!t.key) t.key = key;
    if (t.note) setTurnNote(key, t.note);
    const paths = Array.isArray(t.files) ? t.files : [];
    for (const filePath of paths) {
      if (!filePath) continue;
      let entry = changesMap().get(filePath);
      if (!entry) {
        entry = {
          path: filePath,
          before: '',
          after: '',
          created: false,
          restored: false,
          reviewed: false,
          ts: t.ts || Date.now(),
          stats: { adds: 0, dels: 0 },
          ops: [],
          checkpoints: [],
          fromImport: true,
        };
        changesMap().set(filePath, entry);
      }
      if (!Array.isArray(entry.checkpoints)) entry.checkpoints = [];
      const exists = entry.checkpoints.some((c, i) => turnKeyOfCheckpoint(c, i) === key);
      if (!exists) {
        const d = (t.diffs || []).find((x) => x && x.path === filePath);
        entry.checkpoints.push({
          turnId: key,
          ts: t.ts || Date.now(),
          prompt: t.prompt || '',
          taskTitle: t.taskTitle || '',
          after: entry.after ?? '',
          fromImport: true,
          importDiffText: d?.text || '',
          importStats: d?.stats || null,
        });
        if (d?.stats) {
          entry.stats = {
            adds: (entry.stats?.adds || 0) + (d.stats.adds || 0),
            dels: (entry.stats?.dels || 0) + (d.stats.dels || 0),
          };
        }
      }
    }
  }
  // Offline: reconstruct ops (and snippet before) from mini-diffs when no disk yet
  for (const [, entry] of changesMap()) {
    if (!entry.fromImport && !(entry.checkpoints || []).some((c) => c.fromImport)) continue;
    applyMiniDiffReconstruct(entry, { allowSnippetBefore: true });
  }
  // pick first file if none selected
  if (P() && !P().selectedDiffPath && changesMap().size) {
    P().selectedDiffPath = changesMap().keys().next().value;
  }
}

/**
 * Reconstruct before / ops from storyboard mini-diff when possible.
 * Full-file before when disk `after` matches the mini-diff after-snippet;
 * otherwise snippet-level ops for side-by-side / unified view.
 */
function applyMiniDiffReconstruct(entry, opts = {}) {
  if (!entry || !window.DiffUtil?.reconstructFromUnified) return { ok: 0, full: 0, snippet: 0 };
  let ok = 0;
  let full = 0;
  let snippet = 0;
  const diskAfter = opts.after != null ? opts.after : entry.after;
  for (const cp of entry.checkpoints || []) {
    if (!cp.fromImport || !cp.importDiffText) continue;
    // Skip only when we already have full-file reconstruct unless force
    if (
      cp.reconstructed &&
      cp.reconstructMode === 'full' &&
      entry.before &&
      !opts.forceBefore
    ) {
      continue;
    }
    try {
      const afterForCp = cp.after != null && cp.after !== '' ? cp.after : diskAfter;
      const r = window.DiffUtil.reconstructFromUnified(cp.importDiffText, {
        after: afterForCp != null && afterForCp !== '' ? afterForCp : undefined,
      });
      if (!r.ok || !r.ops?.length) continue;
      cp.importOps = r.ops;
      cp.importStats = r.stats || cp.importStats;
      cp.reconstructed = true;
      cp.reconstructMode = r.mode;
      cp.truncated = Boolean(r.truncated);
      if (r.fullBefore && r.before != null) {
        cp.before = r.before;
        if (!entry.before || opts.forceBefore) entry.before = r.before;
        full += 1;
      } else if (r.before != null && r.mode === 'snippet') {
        cp.beforeSnippet = r.before;
        // Only set entry.before from snippet if we have no better baseline
        if (!entry.before && opts.allowSnippetBefore) entry.before = r.before;
        snippet += 1;
      }
      if (r.mode === 'full' && afterForCp != null) {
        cp.after = afterForCp;
        cp.preferDisk = true;
      }
      ok += 1;
    } catch {
      /* skip checkpoint */
    }
  }

  // Entry-level ops from best reconstruct or live recompute
  if (entry.before != null && entry.after != null && window.DiffUtil.computeLineDiff) {
    if (entry.before !== '' || entry.after !== '') {
      try {
        const recomputed = window.DiffUtil.computeLineDiff(entry.before || '', entry.after || '');
        entry.ops = recomputed.ops;
        entry.stats = recomputed.stats || entry.stats;
      } catch {
        /* keep */
      }
    }
  } else {
    // Prefer first reconstructed ops for display
    const cp = (entry.checkpoints || []).find((c) => c.importOps?.length);
    if (cp?.importOps) {
      entry.ops = cp.importOps;
      if (cp.importStats) entry.stats = cp.importStats;
    }
  }
  return { ok, full, snippet };
}

/**
 * When paths still exist under the open project, pull disk content into
 * after/ops so Diff can show real line diffs (not only mini-diff text).
 * Also reverse-apply mini-diff to recover before when possible.
 */
async function rehydrateStoryboardFromDisk(opts = {}) {
  const en = localeIsEn();
  if (!state.storyboardOverlay?.turns?.length) {
    if (!opts.silent) toast(en ? 'No storyboard overlay' : '当前无 storyboard 回灌', 'err');
    return { ok: 0, miss: 0, skipped: true };
  }
  if (!P()) {
    if (!opts.silent) toast(en ? 'Open a project first' : '请先打开项目', 'err');
    return { ok: 0, miss: 0, skipped: true };
  }

  const paths = new Set();
  for (const t of state.storyboardOverlay.turns) {
    for (const p of t.files || []) {
      if (p) paths.add(String(p));
    }
  }

  let ok = 0;
  let miss = 0;
  const projectId = pid();

  for (const path of paths) {
    try {
      let exists = true;
      if (typeof window.grok.exists === 'function') {
        const ex = await window.grok.exists(projectId, path);
        // preload may return boolean or { exists }
        exists = typeof ex === 'boolean' ? ex : ex?.exists !== false && !ex?.error;
        if (ex && ex.exists === false) exists = false;
      }
      if (!exists) {
        miss += 1;
        const e = changesMap().get(path);
        if (e) e.rehydrated = false;
        continue;
      }

      const data = await window.grok.readFile(projectId, path);
      if (data?.error || data?.content == null) {
        miss += 1;
        continue;
      }

      const after = String(data.content);
      let entry = changesMap().get(path);
      if (!entry) {
        entry = {
          path,
          before: '',
          after: '',
          created: false,
          restored: false,
          reviewed: false,
          ts: Date.now(),
          stats: { adds: 0, dels: 0 },
          ops: [],
          checkpoints: [],
          fromImport: true,
        };
        changesMap().set(path, entry);
      }

      // Preserve session "before" if agent already tracked this file
      const before =
        entry.before != null && entry.before !== ''
          ? entry.before
          : contentCacheMap().has(path) && contentCacheMap().get(path) !== after
            ? contentCacheMap().get(path)
            : entry.before ?? '';

      entry.after = after;
      entry.rehydrated = true;
      entry.fromImport = entry.fromImport || true;
      contentCacheMap().set(path, after);

      // Prefer existing session before; else reconstruct from mini-diff + disk after
      if (before) {
        entry.before = before;
      }
      entry.after = after;

      // Upgrade import checkpoints with disk after, then reverse mini-diff → before
      for (const cp of entry.checkpoints || []) {
        if (!cp.fromImport) continue;
        cp.after = after;
      }
      const recon = applyMiniDiffReconstruct(entry, {
        after,
        forceBefore: !before,
        allowSnippetBefore: false,
      });

      const base = entry.before || before || '';
      if (window.DiffUtil?.computeLineDiff) {
        const recomputed = window.DiffUtil.computeLineDiff(base, after);
        entry.ops = recomputed.ops;
        entry.stats = recomputed.stats || entry.stats;
        if (base && !entry.before) entry.before = base;
      }
      if (recon.full > 0 || base) {
        for (const cp of entry.checkpoints || []) {
          if (cp.fromImport) cp.preferDisk = true;
        }
      }

      // view live (rehydrated disk)
      entry.viewCheckpoint = -1;
      entry.compareA = null;
      entry.compareB = null;
      changesMap().set(path, entry);
      ok += 1;
    } catch {
      miss += 1;
    }
  }

  state.storyboardOverlay.rehydrate = { ok, miss, at: Date.now() };
  if (!opts.silent) {
    toast(
      en
        ? `Disk rehydrate · ${ok} ok · ${miss} missing`
        : `磁盘 rehydrate · ${ok} 成功 · ${miss} 缺失`,
      miss && !ok ? 'err' : 'ok'
    );
    renderDiffPane();
    updateReviewBridgeUi();
  }
  return { ok, miss, skipped: false };
}
window.rehydrateStoryboardFromDisk = rehydrateStoryboardFromDisk;

function clearStoryboardOverlay() {
  if (!state.storyboardOverlay) return;
  // remove import-only file entries (no live agent content)
  for (const [path, e] of [...changesMap().entries()]) {
    if (e.fromImport && !(e.after || e.before) && (e.checkpoints || []).every((c) => c.fromImport)) {
      changesMap().delete(path);
    } else if (e.checkpoints?.length) {
      e.checkpoints = e.checkpoints.filter((c) => !c.fromImport);
      if (!e.checkpoints.length && e.fromImport && !e.rehydrated) changesMap().delete(path);
    }
  }
  state.storyboardOverlay = null;
  state.diffScrubTurn = null;
  saveScrubSelection(null);
  renderDiffPane();
  updateReviewBridgeUi();
  toast(localeIsEn() ? 'Storyboard overlay cleared' : '已退出 storyboard 回灌', 'ok');
}
window.clearStoryboardOverlay = clearStoryboardOverlay;

function turnKeyOfCheckpoint(cp, fallbackIdx = 0) {
  if (!cp) return null;
  return cp.turnId || `ts-${cp.ts || fallbackIdx}`;
}

function scrubProjectKey() {
  const p = P();
  return p?.path || p?.id || null;
}

function saveScrubSelection(turnKey) {
  const pk = scrubProjectKey();
  if (!pk) return;
  const all = loadJson(SCRUB_KEY, {}) || {};
  if (!turnKey) delete all[pk];
  else all[pk] = { turnKey, savedAt: Date.now() };
  // prune old entries (> 40 projects)
  const keys = Object.keys(all);
  if (keys.length > 40) {
    keys
      .sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0))
      .slice(0, keys.length - 40)
      .forEach((k) => delete all[k]);
  }
  saveJson(SCRUB_KEY, all);
}

function loadScrubSelection() {
  const pk = scrubProjectKey();
  if (!pk) return null;
  const all = loadJson(SCRUB_KEY, {}) || {};
  return all[pk]?.turnKey || null;
}

/** Apply stored scrub for current project if turn still exists */
function restoreScrubSelection() {
  const saved = loadScrubSelection();
  if (!saved) {
    state.diffScrubTurn = null;
    return false;
  }
  const turns = collectGlobalTurns();
  if (!turns.some((t) => t.key === saved)) {
    state.diffScrubTurn = null;
    saveScrubSelection(null);
    return false;
  }
  // apply without re-saving (already persisted)
  state.diffScrubTurn = saved;
  for (const [, e] of changesMap()) {
    const cps = e.checkpoints || [];
    const idx = cps.findIndex((c, i) => turnKeyOfCheckpoint(c, i) === saved);
    if (idx >= 0) {
      e.viewCheckpoint = idx;
      e.compareA = null;
      e.compareB = null;
    }
  }
  return true;
}

/** Scrub all files to checkpoints matching turn key */
function scrubToTurn(turnKey, opts = {}) {
  state.diffScrubTurn = turnKey || null;
  if (opts.persist !== false) saveScrubSelection(turnKey || null);
  if (!turnKey) {
    for (const [, e] of changesMap()) {
      e.viewCheckpoint = -1;
      e.compareA = null;
      e.compareB = null;
    }
    if (opts.render !== false) renderDiffPane();
    return;
  }
  let firstPath = null;
  for (const [filePath, e] of changesMap()) {
    const cps = e.checkpoints || [];
    const idx = cps.findIndex((c, i) => turnKeyOfCheckpoint(c, i) === turnKey);
    if (idx >= 0) {
      e.viewCheckpoint = idx;
      e.compareA = null;
      e.compareB = null;
      if (!firstPath) firstPath = filePath;
    }
  }
  if (firstPath && (!P()?.selectedDiffPath || !fileHasTurn(P().selectedDiffPath, turnKey))) {
    requireProject().selectedDiffPath = firstPath;
  }
  if (opts.render !== false) renderDiffPane();
}

/** Keyboard [ ] navigation on Diff scrubber */
function navigateScrubTurn(delta) {
  const turns = collectGlobalTurns();
  if (!turns.length) {
    toast(localeIsEn() ? 'No turns yet' : '暂无 turn', 'err');
    return;
  }
  const cur = state.diffScrubTurn;
  let idx = cur ? turns.findIndex((t) => t.key === cur) : -1;
  if (idx < 0) {
    // from live: [ goes to last turn, ] stays on last / first
    idx = delta < 0 ? turns.length - 1 : 0;
  } else {
    const next = idx + delta;
    if (next < 0 || next >= turns.length) {
      // past ends → live
      scrubToTurn(null);
      toast(localeIsEn() ? 'Live view' : '回到 Live', 'ok');
      return;
    }
    idx = next;
  }
  scrubToTurn(turns[idx].key);
  const t = turns[idx];
  const label = t.ts ? new Date(t.ts).toLocaleTimeString() : t.key;
  toast(`${label} · ${t.files?.size || 0} files`, 'ok');
}
window.navigateScrubTurn = navigateScrubTurn;
window.scrubToTurn = scrubToTurn;

function fileHasTurn(filePath, turnKey) {
  if (!turnKey || !filePath) return true;
  const e = changesMap().get(filePath);
  if (!e) return false;
  return (e.checkpoints || []).some((c, i) => turnKeyOfCheckpoint(c, i) === turnKey);
}

function stopScrubPlay() {
  if (state.diffScrubPlayTimer) {
    clearInterval(state.diffScrubPlayTimer);
    state.diffScrubPlayTimer = null;
  }
  state.diffScrubPlaying = false;
}

const SCRUB_SPEEDS = [0.5, 1, 1.5, 2];

function scrubIntervalMs() {
  const speed = Number(state.diffScrubPlaySpeed) || 1;
  const base = Number(state.diffScrubPlayMs) || 1400;
  return Math.max(400, Math.min(6000, Math.round(base / speed)));
}

function setScrubPlaySpeed(speed) {
  const s = SCRUB_SPEEDS.includes(Number(speed)) ? Number(speed) : 1;
  state.diffScrubPlaySpeed = s;
  saveJson('grokcode-diff-scrub-speed', s);
  // restart interval if playing
  if (state.diffScrubPlaying) {
    startScrubPlay({ quiet: true });
  } else {
    renderDiffPane();
  }
}

function startScrubPlay(opts = {}) {
  const turns = collectGlobalTurns();
  if (turns.length < 1) {
    toast(localeIsEn() ? 'No turns to play' : '暂无 turn 可播放', 'err');
    return;
  }
  stopScrubPlay();
  state.diffScrubPlaying = true;
  // start from beginning if on live
  if (!state.diffScrubTurn || !turns.some((t) => t.key === state.diffScrubTurn)) {
    scrubToTurn(turns[0].key, { render: true });
  }
  const ms = scrubIntervalMs();
  state.diffScrubPlayTimer = setInterval(() => {
    if (!state.diffScrubPlaying) return;
    const list = collectGlobalTurns();
    if (!list.length) {
      stopScrubPlay();
      renderDiffPane();
      return;
    }
    const cur = state.diffScrubTurn;
    let idx = cur ? list.findIndex((t) => t.key === cur) : -1;
    if (idx < 0) idx = 0;
    else idx += 1;
    if (idx >= list.length) {
      if (state.diffScrubLoop) {
        scrubToTurn(list[0].key);
        return;
      }
      // end → live and stop
      stopScrubPlay();
      scrubToTurn(null);
      toast(localeIsEn() ? 'Playback done · Live' : '播放结束 · Live', 'ok');
      return;
    }
    scrubToTurn(list[idx].key);
  }, ms);
  if (!opts.quiet) renderDiffPane();
  else {
    // update play button state only
    document.querySelectorAll('[data-scrub-play]').forEach((b) => {
      b.classList.add('on');
      b.textContent = '❚❚';
    });
    document.querySelectorAll('.diff-scrub-speed').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.speed) === Number(state.diffScrubPlaySpeed));
    });
    document.querySelectorAll('[data-scrub-loop]').forEach((b) => {
      b.classList.toggle('on', state.diffScrubLoop);
    });
  }
}

function toggleScrubPlay() {
  if (state.diffScrubPlaying) {
    stopScrubPlay();
    renderDiffPane();
    toast(localeIsEn() ? 'Playback paused' : '已暂停播放', 'ok');
  } else {
    startScrubPlay();
    const sp = state.diffScrubPlaySpeed || 1;
    const loop = state.diffScrubLoop ? ' · loop' : '';
    toast(
      localeIsEn() ? `Playing turns… ${sp}x${loop}` : `正在播放 turn… ${sp}x${loop}`,
      'ok'
    );
  }
}

function toggleScrubLoop() {
  state.diffScrubLoop = !state.diffScrubLoop;
  saveJson('grokcode-diff-scrub-loop', state.diffScrubLoop);
  document.querySelectorAll('[data-scrub-loop]').forEach((b) => {
    b.classList.toggle('on', state.diffScrubLoop);
  });
  toast(
    state.diffScrubLoop
      ? localeIsEn()
        ? 'Loop on'
        : '循环开'
      : localeIsEn()
        ? 'Loop off'
        : '循环关',
    'ok'
  );
}
window.toggleScrubPlay = toggleScrubPlay;
window.stopScrubPlay = stopScrubPlay;
window.setScrubPlaySpeed = setScrubPlaySpeed;
window.toggleScrubLoop = toggleScrubLoop;

/** Filmstrip cards for each turn (file count + heat) */
function filmstripHtml(turns) {
  if (!turns.length) return '';
  const cur = state.diffScrubTurn;
  const heatFn =
    typeof window.DiffUtil?.heatFromTs === 'function'
      ? window.DiffUtil.heatFromTs
      : () => 0;
  return `<div class="diff-filmstrip" id="diffFilmstrip">
    ${turns
      .map((t) => {
        const heat = heatFn(t.ts);
        const paths = [...(t.files || [])];
        const n = paths.length;
        const names = paths
          .slice(0, 4)
          .map((p) => String(p).split(/[/\\]/).pop())
          .join(', ');
        const time = t.ts ? new Date(t.ts).toLocaleTimeString() : '—';
        const title = t.taskTitle || 'turn';
        const hasNote = !!getTurnNote(t.key);
        // encode full paths for hover panel (base64 to avoid quote issues)
        const pathsB64 = btoa(unescape(encodeURIComponent(JSON.stringify(paths))));
        return `<button type="button" class="diff-film-card heat-${heat}${cur === t.key ? ' active' : ''}${hasNote ? ' has-note' : ''}" data-scrub="${esc(t.key)}" data-paths-b64="${pathsB64}" data-task="${esc(title)}" data-prompt="${esc(String(t.prompt || '').slice(0, 200))}" data-time="${esc(time)}" data-heat="${heat}">
          <span class="dfc-heat heat-${heat}"></span>
          <span class="dfc-time">${esc(time)}</span>
          <span class="dfc-title">${esc(String(title).slice(0, 18))}</span>
          <span class="dfc-meta">${n} files · H${heat}${hasNote ? ' · ✎' : ''}</span>
          <span class="dfc-files">${esc(names)}${n > 4 ? '…' : ''}</span>
        </button>`;
      })
      .join('')}
  </div>`;
}

function parseFilmPaths(card) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(card.dataset.pathsB64 || ''))));
  } catch {
    return [];
  }
}

/** Hover panel listing full paths — click path to open in Code */
function bindFilmstripHover(root) {
  if (!root) return;
  let tip = document.getElementById('diffFilmTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'diffFilmTip';
    tip.className = 'diff-film-tip hidden';
    document.body.appendChild(tip);
  }
  let hideTimer = null;
  const hide = () => {
    hideTimer = setTimeout(() => tip.classList.add('hidden'), 180);
  };
  const cancelHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  };
  tip.onmouseenter = () => cancelHide();
  tip.onmouseleave = () => tip.classList.add('hidden');

  root.querySelectorAll('.diff-film-card').forEach((card) => {
    card.addEventListener('mouseenter', (e) => {
      cancelHide();
      const paths = parseFilmPaths(card);
      const task = card.dataset.task || 'turn';
      const prompt = card.dataset.prompt || '';
      const time = card.dataset.time || '';
      const heat = card.dataset.heat || '0';
      const en = localeIsEn();
      tip.innerHTML = `
        <div class="dft-head">
          <strong>${esc(task)}</strong>
          <span>${esc(time)} · heat ${esc(heat)}</span>
        </div>
        ${prompt ? `<div class="dft-prompt">${esc(prompt)}</div>` : ''}
        <div class="dft-label">${en ? 'Changed files · click to open' : '变更文件 · 点击打开'} (${paths.length})</div>
        <ul class="dft-paths">
          ${
            paths.length
              ? paths
                  .map(
                    (p) =>
                      `<li><button type="button" class="dft-path-btn" data-path="${esc(p)}" title="${esc(p)}">${esc(p)}</button></li>`
                  )
                  .join('')
              : `<li class="muted">${en ? '(none)' : '（无）'}</li>`
          }
        </ul>`;
      tip.querySelectorAll('.dft-path-btn').forEach((btn) => {
        btn.onclick = async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const rel = btn.dataset.path;
          if (!rel || !P()) return;
          tip.classList.add('hidden');
          try {
            await openFile(rel, { switchToCode: true });
            switchTab('editor');
          } catch (err) {
            toast(err.message || 'open failed', 'err');
          }
        };
      });
      tip.classList.remove('hidden');
      const x = Math.min(e.clientX + 14, window.innerWidth - 320);
      const y = Math.min(e.clientY + 12, window.innerHeight - 200);
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
    card.addEventListener('mousemove', (e) => {
      if (tip.classList.contains('hidden') || tip.matches(':hover')) return;
      tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 320)}px`;
      tip.style.top = `${Math.min(e.clientY + 12, window.innerHeight - 200)}px`;
    });
    card.addEventListener('mouseleave', hide);
  });
}

const STORYBOARD_NOTES_KEY = 'grokcode-storyboard-notes-v1';
const STORYBOARD_BUDGET_MODE_KEY = 'grokcode-storyboard-budget-mode';
/** Soft budget for exported JSON (chars); over → progressive strip */
const STORYBOARD_JSON_BUDGET = 900_000;
const STORYBOARD_BUDGET_MODES = {
  full: 2_000_000,
  balanced: 900_000,
  compact: 300_000,
};

function getStoryboardBudgetMode() {
  const m = loadJson(STORYBOARD_BUDGET_MODE_KEY, 'balanced');
  return STORYBOARD_BUDGET_MODES[m] != null ? m : 'balanced';
}

function setStoryboardBudgetMode(mode) {
  const m = STORYBOARD_BUDGET_MODES[mode] != null ? mode : 'balanced';
  saveJson(STORYBOARD_BUDGET_MODE_KEY, m);
  return m;
}

function storyboardBudgetChars(mode = getStoryboardBudgetMode()) {
  return STORYBOARD_BUDGET_MODES[mode] || STORYBOARD_JSON_BUDGET;
}

function notesProjectKey() {
  const p = P();
  return p?.path || p?.id || '_global';
}

function getAllStoryboardNotes() {
  return loadJson(STORYBOARD_NOTES_KEY, {}) || {};
}

function getTurnNote(turnKey) {
  if (!turnKey) return '';
  const all = getAllStoryboardNotes();
  const bucket = all[notesProjectKey()] || {};
  return bucket[turnKey] || '';
}

function setTurnNote(turnKey, note) {
  if (!turnKey) return;
  const all = getAllStoryboardNotes();
  const pk = notesProjectKey();
  if (!all[pk]) all[pk] = {};
  const text = String(note || '').slice(0, 4000);
  if (!text.trim()) delete all[pk][turnKey];
  else all[pk][turnKey] = text;
  saveJson(STORYBOARD_NOTES_KEY, all);
}

/**
 * Attach size-capped mini unified diffs per turn file (from checkpoints).
 */
function enrichStoryboardDiffs(data, { maxFiles = 6, maxRows = 36 } = {}) {
  if (!data?.turns || !window.DiffUtil?.computeLineDiff) return data;
  for (const turn of data.turns) {
    const diffs = [];
    const paths = (turn.files || []).slice(0, maxFiles);
    for (const filePath of paths) {
      const entry = changesMap().get(filePath);
      if (!entry) continue;
      const cps = entry.checkpoints || [];
      const idx = cps.findIndex((c, i) => turnKeyOfCheckpoint(c, i) === turn.key);
      if (idx < 0) continue;
      const after = cps[idx].after ?? '';
      const before =
        idx > 0 ? cps[idx - 1].after ?? entry.before ?? '' : entry.before ?? '';
      try {
        const recomputed = window.DiffUtil.computeLineDiff(before, after);
        const text =
          typeof window.DiffUtil.toUnifiedText === 'function'
            ? window.DiffUtil.toUnifiedText(recomputed.ops, { context: 2, maxRows })
            : '';
        diffs.push({
          path: filePath,
          stats: recomputed.stats || { adds: 0, dels: 0 },
          text: String(text || '').slice(0, 8000),
        });
      } catch {
        /* skip file */
      }
    }
    turn.diffs = diffs;
  }
  return data;
}

/**
 * Progressive pack compress until under char budget:
 * 1) shrink diff text · 2) drop cold-turn diffs · 3) drop all diffs · 4) trim prompts
 */
function applyStoryboardBudget(data, maxBytes = storyboardBudgetChars()) {
  if (!data?.turns) return data;
  const originalSize = JSON.stringify(data).length;
  data.budgetMode = getStoryboardBudgetMode();
  data.budget = maxBytes;
  data.originalSize = originalSize;
  let json = JSON.stringify(data);
  if (json.length <= maxBytes) {
    data.compressed = false;
    data.compressedSize = json.length;
    data.compressStages = [];
    data.omittedTurns = 0;
    return data;
  }

  const stages = [];
  const byCold = () => [...data.turns].sort((a, b) => (a.heat || 0) - (b.heat || 0));
  const reserialize = () => {
    json = JSON.stringify(data);
  };

  // Stage 1: shrink long mini-diff texts (cold first)
  if (json.length > maxBytes) {
    let shrunk = 0;
    for (const t of byCold()) {
      if (json.length <= maxBytes) break;
      if (!t.diffs?.length) continue;
      for (const d of t.diffs) {
        if (typeof d.text === 'string' && d.text.length > 1200) {
          d.text = d.text.slice(0, 1200) + '\n…';
          shrunk++;
        }
      }
      reserialize();
    }
    if (shrunk) stages.push({ stage: 'trim-diff-text', count: shrunk });
  }

  // Stage 2: drop whole-file diffs from coldest turns
  if (json.length > maxBytes) {
    let dropped = 0;
    for (const t of byCold()) {
      if (json.length <= maxBytes) break;
      if (!t.diffs?.length) continue;
      t.diffs = [];
      t.diffsOmitted = true;
      dropped++;
      reserialize();
    }
    if (dropped) stages.push({ stage: 'omit-cold-diffs', count: dropped });
  }

  // Stage 3: ensure all diffs gone
  if (json.length > maxBytes) {
    let n = 0;
    for (const t of data.turns) {
      if (t.diffs?.length) {
        t.diffs = [];
        t.diffsOmitted = true;
        n++;
      }
    }
    if (n) {
      reserialize();
      stages.push({ stage: 'omit-all-diffs', count: n });
    }
  }

  // Stage 4: trim long prompts
  if (json.length > maxBytes) {
    let n = 0;
    for (const t of byCold()) {
      if (json.length <= maxBytes) break;
      if (typeof t.prompt === 'string' && t.prompt.length > 240) {
        t.prompt = t.prompt.slice(0, 240) + '…';
        n++;
        reserialize();
      }
    }
    if (n) stages.push({ stage: 'trim-prompts', count: n });
  }

  const omittedTurns = data.turns.filter((t) => t.diffsOmitted).length;
  data.compressed = true;
  data.compressedSize = json.length;
  data.compressStages = stages;
  data.omittedTurns = omittedTurns;
  return data;
}

function buildStoryboardData({ withDiffs = true, withNotes = true } = {}) {
  const turns = collectGlobalTurns();
  const proj = P();
  const heatFn =
    typeof window.DiffUtil?.heatFromTs === 'function' ? window.DiffUtil.heatFromTs : () => 0;
  const data = {
    format: 'grokcode-storyboard-v1',
    project: { name: proj?.name || null, path: proj?.path || null },
    exportedAt: new Date().toISOString(),
    turns: turns.map((t) => ({
      key: t.key,
      turnId: t.turnId,
      ts: t.ts,
      taskTitle: t.taskTitle,
      prompt: t.prompt,
      heat: heatFn(t.ts),
      files: [...(t.files || [])],
      note: withNotes ? getTurnNote(t.key) : '',
    })),
  };
  if (withDiffs) enrichStoryboardDiffs(data);
  if (withDiffs) applyStoryboardBudget(data);
  return data;
}

function storyboardCompressToast(data, en) {
  if (!data?.compressed) return '';
  const from = data.originalSize || 0;
  const to = data.compressedSize || 0;
  const omitted = data.omittedTurns || 0;
  const stages = (data.compressStages || []).map((s) => s.stage).join('→') || 'budget';
  if (en) {
    return ` · compressed ${Math.round(from / 1000)}k→${Math.round(to / 1000)}k · ${omitted} turns stripped (${stages})`;
  }
  return ` · 已压缩 ${Math.round(from / 1000)}k→${Math.round(to / 1000)}k · 省略 ${omitted} 轮 diffs (${stages})`;
}

/** Notes UI under filmstrip when a turn is scrubbed */
function storyboardNotesBarHtml() {
  const key = state.diffScrubTurn;
  if (!key) return '';
  const en = localeIsEn();
  const note = getTurnNote(key);
  return `<div class="diff-note-bar" id="diffNoteBar">
    <span class="diff-note-label">${en ? 'Review note' : '审阅批注'}</span>
    <textarea id="turnReviewNote" rows="2" placeholder="${en ? 'Local note for this turn (exported in storyboard)' : '本 turn 的本地批注（会打进 storyboard）'}">${esc(note)}</textarea>
    <button type="button" class="btn small ghost" data-note-save>${en ? 'Save' : '保存'}</button>
  </div>`;
}

function buildStoryboardMarkdown(data) {
  const lines = [
    `# GrokCode Diff Storyboard`,
    '',
    `- **Project**: ${data.project?.name || '—'}`,
    `- **Path**: ${data.project?.path || '—'}`,
    `- **Turns**: ${data.turns?.length || 0}`,
    `- **Exported**: ${data.exportedAt || ''}`,
    '',
    '---',
    '',
  ];
  if (data.compressed) {
    lines.push(
      `- **Compressed**: yes · mode \`${data.budgetMode || 'balanced'}\` · budget ${data.budget || STORYBOARD_JSON_BUDGET} chars · ${data.originalSize || '?'}→${data.compressedSize || '?'}`
    );
    if (data.compressStages?.length) {
      lines.push(
        `- **Stages**: ${data.compressStages.map((s) => `${s.stage}(${s.count})`).join(' → ')}`
      );
    }
    lines.push('');
  }
  (data.turns || []).forEach((t, i) => {
    const time = t.ts ? new Date(t.ts).toISOString() : '—';
    lines.push(`## Turn ${i + 1} · ${t.taskTitle || 'task'} · heat ${t.heat ?? 0}`);
    lines.push('');
    lines.push(`- **Time**: ${time}`);
    lines.push(`- **Key**: \`${t.key}\``);
    if (t.prompt) lines.push(`- **Prompt**: ${String(t.prompt).replace(/\n/g, ' ').slice(0, 300)}`);
    if (t.note) lines.push(`- **Reviewer note**: ${String(t.note).replace(/\n/g, ' ')}`);
    lines.push(`- **Files** (${(t.files || []).length}):`);
    (t.files || []).forEach((p) => lines.push(`  - \`${p}\``));
    if (t.diffsOmitted) lines.push(`- **Mini diffs**: omitted (pack budget)`);
    if (Array.isArray(t.diffs) && t.diffs.length) {
      lines.push('');
      lines.push('### Mini diffs');
      t.diffs.forEach((d) => {
        lines.push('');
        lines.push(
          `#### \`${d.path}\` (+${d.stats?.adds ?? 0}/-${d.stats?.dels ?? 0})`
        );
        lines.push('```diff');
        lines.push(d.text || '');
        lines.push('```');
      });
    }
    lines.push('');
  });
  lines.push('---');
  lines.push('');
  lines.push('_Generated by GrokCode Diff filmstrip_');
  return lines.join('\n');
}

/** Self-contained HTML review pack (shareable offline, optional mini diffs) */
function buildStoryboardHtml(data) {
  const en = localeIsEn();
  const turnsJson = JSON.stringify(data.turns || []);
  const title = `GrokCode Storyboard · ${data.project?.name || 'session'}`;
  return `<!DOCTYPE html>
<html lang="${en ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0a0c12; --card:#12161f; --ice:#7dd3fc; --muted:#a1a1aa; --faint:#71717a; --ok:#34d399; --hot:#f97316; --del:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color:#e4e4e7; line-height:1.45; }
  header { padding: 20px 24px 12px; border-bottom: 1px solid rgba(125,211,252,.15); background: linear-gradient(120deg, rgba(56,189,248,.08), rgba(249,115,22,.06)); }
  header h1 { margin:0 0 6px; font-size: 20px; }
  header .meta { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
  .strip { display:flex; gap:10px; overflow-x:auto; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,.06); }
  .card { flex:0 0 auto; width: 140px; border:1px solid rgba(125,211,252,.2); background: var(--card); border-radius: 12px; padding: 10px; cursor:pointer; position:relative; }
  .card:hover, .card.active { border-color: rgba(56,189,248,.55); box-shadow: 0 0 0 1px rgba(56,189,248,.2); }
  .card .h { position:absolute; left:0; top:0; bottom:0; width:3px; border-radius:12px 0 0 12px; }
  .h0{background:rgba(52,211,153,.4)} .h1{background:rgba(52,211,153,.6)} .h2{background:#34d399} .h3{background:#facc15} .h4{background:#f97316}
  .card .t { font-family: ui-monospace, monospace; font-size:10px; color:var(--ice); padding-left:6px; }
  .card .n { font-size:13px; font-weight:600; padding:2px 0 2px 6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .card .m { font-size:11px; color:var(--faint); padding-left:6px; }
  main { display:grid; grid-template-columns: 1fr 1.2fr; gap:16px; padding: 16px 20px 40px; max-width: 1200px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background: var(--card); border:1px solid rgba(125,211,252,.12); border-radius: 12px; padding: 14px 16px; min-height: 200px; }
  section h2 { margin:0 0 8px; font-size: 14px; color: var(--ice); font-family: ui-monospace, monospace; letter-spacing:.06em; text-transform:uppercase; }
  .prompt { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
  .note { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #fde68a; background: rgba(251,191,36,.08); border:1px solid rgba(251,191,36,.25); border-radius:8px; padding:8px 10px; margin-bottom: 12px; min-height: 2.5em; }
  ul.files { margin:0 0 12px; padding-left: 18px; font-family: ui-monospace, monospace; font-size: 12px; }
  ul.files li { margin: 3px 0; word-break: break-all; }
  .diff-block { margin: 10px 0 14px; border:1px solid rgba(255,255,255,.08); border-radius: 8px; overflow:hidden; }
  .diff-block h3 { margin:0; padding:6px 10px; font-size:11px; font-family: ui-monospace, monospace; background:rgba(0,0,0,.35); color:var(--ice); }
  .diff-block pre { margin:0; padding:8px 10px; font-size:11px; font-family: ui-monospace, monospace; white-space:pre-wrap; word-break:break-all; max-height:220px; overflow:auto; background:rgba(0,0,0,.25); }
  .diff-block .add { color: var(--ok); }
  .diff-block .del { color: var(--del); }
  footer { padding: 12px 20px 24px; font-size: 11px; color: var(--faint); font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="meta">
    ${esc(data.project?.path || '—')} · ${data.turns?.length || 0} turns · ${esc(data.exportedAt || '')}${data.compressed ? ` · compressed (${esc(data.budgetMode || 'balanced')}${data.originalSize ? ` ${Math.round(data.originalSize / 1000)}k→${Math.round((data.compressedSize || 0) / 1000)}k` : ''})` : ''}
  </div>
</header>
<div class="strip" id="strip"></div>
<main>
  <section>
    <h2>${en ? 'Prompt' : '提示'}</h2>
    <div class="prompt" id="prompt">—</div>
    <h2>${en ? 'Reviewer note' : '审阅批注'}</h2>
    <div class="note" id="note">—</div>
    <h2>${en ? 'Files' : '文件'}</h2>
    <ul class="files" id="files"></ul>
  </section>
  <section>
    <h2>${en ? 'Mini diffs' : '迷你 Diff'}</h2>
    <div id="diffs"></div>
  </section>
</main>
<footer>GrokCode Diff storyboard · offline review pack · notes + mini diffs (budget-capped)</footer>
<script>
const TURNS = ${turnsJson};
const strip = document.getElementById('strip');
const promptEl = document.getElementById('prompt');
const noteEl = document.getElementById('note');
const filesEl = document.getElementById('files');
const diffsEl = document.getElementById('diffs');
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function colorDiff(text){
  return escHtml(text).split('\\n').map(function(line){
    if (line.charAt(0)==='+') return '<span class="add">'+line+'</span>';
    if (line.charAt(0)==='-') return '<span class="del">'+line+'</span>';
    return line;
  }).join('\\n');
}
function show(i) {
  const t = TURNS[i];
  if (!t) return;
  [...strip.children].forEach((c, j) => c.classList.toggle('active', j === i));
  promptEl.textContent = t.prompt || '(no prompt captured)';
  noteEl.textContent = t.note || '(no reviewer note)';
  filesEl.innerHTML = (t.files || []).map(p => '<li>' + escHtml(p) + '</li>').join('')
    || '<li style="color:#71717a">(none)</li>';
  const diffs = t.diffs || [];
  if (!diffs.length) {
    diffsEl.innerHTML = '<div style="color:#71717a;font-size:12px">' + (t.diffsOmitted ? '${en ? 'Diffs omitted (pack budget)' : 'diffs 已省略（包体积预算）'}' : '${en ? 'No mini diffs captured for this turn' : '该轮无迷你 diff 快照'}') + '</div>';
  } else {
    diffsEl.innerHTML = diffs.map(function(d){
      const st = d.stats || {};
      return '<div class="diff-block"><h3>' + escHtml(d.path) + '  +' + (st.adds||0) + ' −' + (st.dels||0) + '</h3><pre>' + colorDiff(d.text||'') + '</pre></div>';
    }).join('');
  }
}
TURNS.forEach((t, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card';
  const heat = t.heat || 0;
  const time = t.ts ? new Date(t.ts).toLocaleString() : '—';
  const noteMark = t.note ? ' · ✎' : '';
  b.innerHTML = '<span class="h h' + heat + '"></span>'
    + '<div class="t">' + time + '</div>'
    + '<div class="n">' + (t.taskTitle || ('Turn ' + (i+1))).slice(0, 24) + '</div>'
    + '<div class="m">' + (t.files||[]).length + ' files · H' + heat + noteMark + '</div>';
  b.onclick = () => show(i);
  strip.appendChild(b);
});
if (TURNS.length) show(0);
</script>
</body>
</html>`;
}

/** Extract balanced JSON value starting at index (array/object). */
function extractBalancedJson(text, startIdx) {
  if (startIdx < 0 || startIdx >= text.length) return null;
  const open = text[startIdx];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = text.slice(startIdx, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Parse offline HTML review pack → storyboard data (const TURNS = …). */
function parseStoryboardFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const marker = /const\s+TURNS\s*=\s*/;
  const m = marker.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < html.length && /\s/.test(html[i])) i++;
  const turns = extractBalancedJson(html, i);
  if (!Array.isArray(turns)) return null;
  let name = null;
  let path = null;
  const titleM = html.match(/<title>\s*GrokCode Storyboard\s*[·•]\s*([^<]+?)\s*<\/title>/i);
  if (titleM) name = titleM[1].trim();
  const metaM = html.match(/class="meta"[^>]*>\s*([^<]+)/i);
  if (metaM) {
    const parts = metaM[1].split('·').map((s) => s.trim());
    if (parts[0] && parts[0] !== '—') path = parts[0];
  }
  return {
    format: 'grokcode-storyboard-v1',
    project: { name: name || null, path: path || null },
    exportedAt: null,
    turns,
    source: 'html',
  };
}

/**
 * Resolve a picked file (JSON / encrypted AES / HTML) into storyboard pack.
 * @returns {{ pack: object|null, file: string, error?: string }}
 */
async function resolveStoryboardImport(raw, en) {
  if (!raw?.ok) return { pack: null, file: raw?.file || '', error: raw?.error || 'import failed' };
  const file = raw.file || '';
  let data = raw.data;
  const text = raw.text || '';

  // Encrypted storyboard JSON
  if (data?.format === 'grokcode-storyboard-aes-v1') {
    const pass = prompt(en ? 'Passphrase for encrypted storyboard' : '加密 storyboard 口令');
    if (!pass) return { pack: null, file, error: en ? 'Canceled' : '已取消' };
    try {
      const json = await decryptStoryboardPayload(data, pass);
      data = JSON.parse(json);
    } catch (e) {
      return { pack: null, file, error: e.message || 'decrypt failed' };
    }
  }

  let pack = normalizeStoryboardPack(data);
  if (pack) return { pack, file };

  // HTML offline pack
  const lower = file.toLowerCase();
  if (text && (lower.endsWith('.html') || lower.endsWith('.htm') || /const\s+TURNS\s*=/.test(text))) {
    pack = parseStoryboardFromHtml(text);
    if (pack) return { pack, file };
  }

  // raw text that is actually JSON storyboard (data parse failed earlier? unlikely)
  if (!data && text) {
    try {
      pack = normalizeStoryboardPack(JSON.parse(text));
      if (pack) return { pack, file };
    } catch {
      /* ignore */
    }
    pack = parseStoryboardFromHtml(text);
    if (pack) return { pack, file };
  }

  return {
    pack: null,
    file,
    error: en
      ? 'Need storyboard JSON, encrypted pack, or HTML review pack'
      : '需要 storyboard JSON、加密包或 HTML 审阅包',
  };
}

/** Side-by-side compare of two storyboard packs (JSON / HTML / encrypted) */
async function compareStoryboardPacks() {
  const en = localeIsEn();
  try {
    toast(en ? 'Pick pack A (JSON/HTML)…' : '选择包 A（JSON/HTML）…', 'ok');
    const rawA = await window.grok.templateImportRaw({ storyboard: true });
    if (rawA?.canceled) return;
    const resolvedA = await resolveStoryboardImport(rawA, en);
    if (!resolvedA.pack) {
      toast(resolvedA.error || 'import A failed', 'err');
      return;
    }
    toast(en ? 'Pick pack B (JSON/HTML)…' : '选择包 B（JSON/HTML）…', 'ok');
    const rawB = await window.grok.templateImportRaw({ storyboard: true });
    if (rawB?.canceled) return;
    const resolvedB = await resolveStoryboardImport(rawB, en);
    if (!resolvedB.pack) {
      toast(resolvedB.error || 'import B failed', 'err');
      return;
    }
    showStoryboardCompareModal(resolvedA.pack, resolvedB.pack, resolvedA.file, resolvedB.file);
  } catch (e) {
    toast(e.message || 'compare failed', 'err');
  }
}

function normalizeStoryboardPack(data) {
  if (!data) return null;
  if (data.format === 'grokcode-storyboard-aes-v1') return null; // needs decrypt first
  if (data.format === 'grokcode-storyboard-v1' && Array.isArray(data.turns)) return data;
  if (Array.isArray(data.turns)) return { ...data, format: data.format || 'grokcode-storyboard-v1' };
  return null;
}

/** Export passphrase-encrypted storyboard JSON (AES-GCM) */
async function exportStoryboardEncrypted() {
  const turns = collectGlobalTurns();
  if (!turns.length) {
    toast(localeIsEn() ? 'No turns to export' : '暂无 turn 可导出', 'err');
    return;
  }
  const en = localeIsEn();
  const pass = prompt(en ? 'Passphrase for encrypted storyboard' : '加密 storyboard 口令');
  if (!pass) return;
  const pass2 = prompt(en ? 'Confirm passphrase' : '再次确认口令');
  if (pass2 !== pass) {
    toast(en ? 'Passphrases do not match' : '两次口令不一致', 'err');
    return;
  }
  try {
    const data = buildStoryboardData({ withDiffs: true });
    const sealed = await encryptStoryboardPayload(JSON.stringify(data), pass);
    const safe = String(data.project?.name || 'session')
      .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
      .slice(0, 40);
    const r = await window.grok.templateExportPack({
      json: JSON.stringify(sealed, null, 2),
      defaultName: `grok-storyboard-${safe}.enc.json`,
      title: en ? 'Export encrypted storyboard' : '导出加密 storyboard',
    });
    if (r?.canceled) return;
    if (r?.ok) {
      toast(
        (en ? 'Encrypted storyboard: ' : '已加密导出：') +
          (r.file || '') +
          storyboardCompressToast(data, en),
        'ok'
      );
    } else toast(r?.error || 'export failed', 'err');
  } catch (e) {
    toast(e.message || 'encrypt failed', 'err');
  }
}
window.exportStoryboardEncrypted = exportStoryboardEncrypted;

function fileSetKey(files) {
  return [...(files || [])].map(String).sort().join('\n');
}

function classifyCompareTurn(a, b) {
  if (a && !b) return 'only-a';
  if (!a && b) return 'only-b';
  if (!a && !b) return 'same';
  const filesDiff = fileSetKey(a.files) !== fileSetKey(b.files);
  const noteDiff = String(a.note || '') !== String(b.note || '');
  const promptDiff = String(a.prompt || '') !== String(b.prompt || '');
  const heatDiff = (a.heat ?? 0) !== (b.heat ?? 0);
  if (filesDiff || noteDiff || promptDiff || heatDiff) return 'diff';
  return 'same';
}

function compareFileLists(aFiles, bFiles) {
  const A = new Set((aFiles || []).map(String));
  const B = new Set((bFiles || []).map(String));
  const both = [...A].filter((p) => B.has(p)).sort();
  const onlyA = [...A].filter((p) => !B.has(p)).sort();
  const onlyB = [...B].filter((p) => !A.has(p)).sort();
  return { both, onlyA, onlyB };
}

function compareDiffSummaries(a, b) {
  const mapDiffs = (t) => {
    const m = new Map();
    for (const d of t?.diffs || []) {
      if (d?.path) m.set(String(d.path), d);
    }
    return m;
  };
  const ma = mapDiffs(a);
  const mb = mapDiffs(b);
  const paths = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  return paths.map((p) => {
    const da = ma.get(p);
    const db = mb.get(p);
    const sa = da?.stats || {};
    const sb = db?.stats || {};
    return {
      path: p,
      a: da ? `+${sa.adds ?? 0}/-${sa.dels ?? 0}${da.text ? '' : ''}` : null,
      b: db ? `+${sb.adds ?? 0}/-${sb.dels ?? 0}` : null,
      onlyA: da && !db,
      onlyB: db && !da,
      textA: da?.text || '',
      textB: db?.text || '',
    };
  });
}

function buildCompareSummaryMarkdown(packA, packB, fileA, fileB, rows) {
  const lines = [
    `# Storyboard compare`,
    '',
    `- **A**: ${fileA || 'A'} (${packA.turns?.length || 0} turns)`,
    `- **B**: ${fileB || 'B'} (${packB.turns?.length || 0} turns)`,
    `- **Keys**: ${rows.length}`,
    '',
  ];
  const counts = { same: 0, diff: 0, 'only-a': 0, 'only-b': 0 };
  rows.forEach((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });
  lines.push(
    `- **Summary**: same ${counts.same} · diff ${counts.diff} · only-A ${counts['only-a']} · only-B ${counts['only-b']}`
  );
  lines.push('');
  rows.forEach((r) => {
    lines.push(`## ${r.title} · \`${r.key}\` · ${r.status}`);
    lines.push(`- A files: ${r.fa} · B files: ${r.fb}`);
    if (r.a?.note || r.b?.note) {
      lines.push(`- A note: ${String(r.a?.note || '—').replace(/\n/g, ' ')}`);
      lines.push(`- B note: ${String(r.b?.note || '—').replace(/\n/g, ' ')}`);
    }
    const fl = compareFileLists(r.a?.files, r.b?.files);
    if (fl.onlyA.length) lines.push(`- Only A: ${fl.onlyA.map((p) => `\`${p}\``).join(', ')}`);
    if (fl.onlyB.length) lines.push(`- Only B: ${fl.onlyB.map((p) => `\`${p}\``).join(', ')}`);
    lines.push('');
  });
  return lines.join('\n');
}

function showStoryboardCompareModal(packA, packB, fileA, fileB) {
  const en = localeIsEn();
  let root = document.getElementById('storyboardCompareModal');
  if (!root) {
    root = document.createElement('div');
    root.id = 'storyboardCompareModal';
    root.className = 'gc-modal hidden';
    document.body.appendChild(root);
  }
  const keysA = new Map((packA.turns || []).map((t) => [t.key || String(t.ts), t]));
  const keysB = new Map((packB.turns || []).map((t) => [t.key || String(t.ts), t]));
  const allKeys = [...new Set([...keysA.keys(), ...keysB.keys()])];
  const rowData = allKeys.map((k) => {
    const a = keysA.get(k);
    const b = keysB.get(k);
    const status = classifyCompareTurn(a, b);
    return {
      key: k,
      a,
      b,
      status,
      title: (a || b)?.taskTitle || k.slice(0, 16),
      fa: a ? (a.files || []).length : 0,
      fb: b ? (b.files || []).length : 0,
      ha: a ? a.heat ?? 0 : null,
      hb: b ? b.heat ?? 0 : null,
    };
  });
  const counts = { same: 0, diff: 0, 'only-a': 0, 'only-b': 0 };
  rowData.forEach((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });

  let filter = 'all';
  let selectedKey = rowData.find((r) => r.status === 'diff')?.key || rowData[0]?.key || null;

  const statusLabel = (s) => {
    if (en) {
      return { same: 'same', diff: 'diff', 'only-a': 'only A', 'only-b': 'only B' }[s] || s;
    }
    return { same: '相同', diff: '差异', 'only-a': '仅 A', 'only-b': '仅 B' }[s] || s;
  };

  const renderDetail = (key) => {
    const row = rowData.find((r) => r.key === key);
    if (!row) {
      return `<div class="sc-detail-empty">${en ? 'Select a turn' : '选择一个 turn'}</div>`;
    }
    const { a, b } = row;
    const fl = compareFileLists(a?.files, b?.files);
    const diffs = compareDiffSummaries(a, b);
    const fileLi = (paths, cls) =>
      paths.length
        ? paths.map((p) => `<li class="${cls}">${esc(p)}</li>`).join('')
        : `<li class="muted">—</li>`;
    const diffRows = diffs.length
      ? diffs
          .map((d) => {
            const mark = d.onlyA ? 'only-a' : d.onlyB ? 'only-b' : 'both';
            return `<tr class="sc-d-${mark}">
              <td class="sc-path">${esc(d.path)}</td>
              <td>${d.a ? esc(d.a) : '—'}</td>
              <td>${d.b ? esc(d.b) : '—'}</td>
            </tr>
            ${
              d.textA || d.textB
                ? `<tr class="sc-d-text"><td colspan="3"><div class="sc-diff-pair">
                    <pre class="sc-pre a">${esc((d.textA || '').slice(0, 900)) || '—'}</pre>
                    <pre class="sc-pre b">${esc((d.textB || '').slice(0, 900)) || '—'}</pre>
                  </div></td></tr>`
                : ''
            }`;
          })
          .join('')
      : `<tr><td colspan="3" class="muted">${en ? 'No mini diffs in either pack' : '两边均无迷你 diff'}</td></tr>`;

    return `
      <div class="sc-detail-head">
        <strong>${esc(row.title)}</strong>
        <span class="sc-pill sc-${row.status}">${statusLabel(row.status)}</span>
        <code class="sc-key">${esc(row.key)}</code>
      </div>
      <div class="sc-detail-grid">
        <section>
          <h3>A</h3>
          <div class="sc-field"><label>Heat</label><span>${a ? esc(String(a.heat ?? 0)) : '—'}</span></div>
          <div class="sc-field"><label>Prompt</label><pre class="sc-pre-sm">${esc(String(a?.prompt || '—').slice(0, 500))}</pre></div>
          <div class="sc-field"><label>${en ? 'Note' : '批注'}</label><pre class="sc-pre-sm note">${esc(String(a?.note || '—'))}</pre></div>
        </section>
        <section>
          <h3>B</h3>
          <div class="sc-field"><label>Heat</label><span>${b ? esc(String(b.heat ?? 0)) : '—'}</span></div>
          <div class="sc-field"><label>Prompt</label><pre class="sc-pre-sm">${esc(String(b?.prompt || '—').slice(0, 500))}</pre></div>
          <div class="sc-field"><label>${en ? 'Note' : '批注'}</label><pre class="sc-pre-sm note">${esc(String(b?.note || '—'))}</pre></div>
        </section>
      </div>
      <div class="sc-files-block">
        <h3>${en ? 'Files' : '文件'}</h3>
        <div class="sc-files-cols">
          <div><h4>${en ? 'Both' : '共有'} (${fl.both.length})</h4><ul>${fileLi(fl.both, 'both')}</ul></div>
          <div><h4>${en ? 'Only A' : '仅 A'} (${fl.onlyA.length})</h4><ul>${fileLi(fl.onlyA, 'only-a')}</ul></div>
          <div><h4>${en ? 'Only B' : '仅 B'} (${fl.onlyB.length})</h4><ul>${fileLi(fl.onlyB, 'only-b')}</ul></div>
        </div>
      </div>
      <div class="sc-diffs-block">
        <h3>${en ? 'Mini diffs' : '迷你 Diff'}</h3>
        <table class="sc-diff-table">
          <thead><tr><th>${en ? 'Path' : '路径'}</th><th>A</th><th>B</th></tr></thead>
          <tbody>${diffRows}</tbody>
        </table>
      </div>`;
  };

  const paint = () => {
    const filtered =
      filter === 'all' ? rowData : rowData.filter((r) => r.status === filter);
    if (selectedKey && !filtered.some((r) => r.key === selectedKey)) {
      selectedKey = filtered[0]?.key || null;
    }
    const rowsHtml = filtered
      .map((r) => {
        const active = r.key === selectedKey ? ' active' : '';
        return `<tr class="sc-${r.status}${active}" data-sc-key="${esc(r.key)}" tabindex="0">
          <td>${esc(r.title)}</td>
          <td>${r.ha != null ? esc(String(r.ha)) : '—'}</td>
          <td>${r.a ? r.fa : '—'}</td>
          <td>${r.hb != null ? esc(String(r.hb)) : '—'}</td>
          <td>${r.b ? r.fb : '—'}</td>
          <td><span class="sc-pill sc-${r.status}">${statusLabel(r.status)}</span></td>
          <td class="sc-notes">${esc((r.a?.note || '').slice(0, 40))}</td>
          <td class="sc-notes">${esc((r.b?.note || '').slice(0, 40))}</td>
        </tr>`;
      })
      .join('');

    root.classList.remove('hidden');
    root.innerHTML = `
    <div class="gc-modal-backdrop" data-close="1"></div>
    <div class="gc-modal-card glass storyboard-compare-card sc-polished">
      <div class="gc-modal-head">
        <div>
          <div class="skill-preview-kicker">STORYBOARD COMPARE</div>
          <h2>${en ? 'Pack A vs Pack B' : '包 A vs 包 B'}</h2>
          <p class="skill-preview-desc">${esc((fileA || 'A').split(/[/\\]/).pop())} · ${esc((fileB || 'B').split(/[/\\]/).pop())}</p>
        </div>
        <button type="button" class="icon-btn" data-close="1">✕</button>
      </div>
      <div class="sc-meta">
        A: ${packA.turns?.length || 0} · B: ${packB.turns?.length || 0} ·
        <span class="sc-pill sc-same">${counts.same} same</span>
        <span class="sc-pill sc-diff">${counts.diff} diff</span>
        <span class="sc-pill sc-only-a">${counts['only-a']} only A</span>
        <span class="sc-pill sc-only-b">${counts['only-b']} only B</span>
      </div>
      <div class="sc-filters">
        ${['all', 'diff', 'only-a', 'only-b', 'same']
          .map(
            (f) =>
              `<button type="button" class="sc-filter${filter === f ? ' active' : ''}" data-sc-filter="${f}">${
                f === 'all' ? (en ? 'All' : '全部') : statusLabel(f)
              }${f === 'all' ? ` (${rowData.length})` : ` (${counts[f] || 0})`}</button>`
          )
          .join('')}
      </div>
      <div class="sc-body">
        <div class="sc-table-wrap">
          <table class="sc-table">
            <thead>
              <tr>
                <th>${en ? 'Turn' : 'Turn'}</th>
                <th>A H</th><th>A files</th>
                <th>B H</th><th>B files</th>
                <th>${en ? 'Status' : '状态'}</th>
                <th>A note</th><th>B note</th>
              </tr>
            </thead>
            <tbody>${rowsHtml || `<tr><td colspan="8">${en ? 'No rows' : '无行'}</td></tr>`}</tbody>
          </table>
        </div>
        <div class="sc-detail" id="scDetail">${renderDetail(selectedKey)}</div>
      </div>
      <div class="gc-modal-actions">
        <button type="button" class="btn small ghost" data-sc-copy>${en ? 'Copy summary' : '复制摘要'}</button>
        <button type="button" class="btn small primary" data-close="1">${en ? 'Close' : '关闭'}</button>
      </div>
    </div>`;

    root.querySelectorAll('[data-close]').forEach((el) => {
      el.onclick = () => root.classList.add('hidden');
    });
    root.querySelectorAll('[data-sc-filter]').forEach((btn) => {
      btn.onclick = () => {
        filter = btn.dataset.scFilter || 'all';
        paint();
      };
    });
    root.querySelectorAll('[data-sc-key]').forEach((tr) => {
      tr.onclick = () => {
        selectedKey = tr.dataset.scKey;
        paint();
      };
      tr.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectedKey = tr.dataset.scKey;
          paint();
        }
      };
    });
    root.querySelector('[data-sc-copy]')?.addEventListener('click', async () => {
      const md = buildCompareSummaryMarkdown(packA, packB, fileA, fileB, rowData);
      try {
        await navigator.clipboard.writeText(md);
        toast(en ? 'Compare summary copied' : '对比摘要已复制', 'ok');
      } catch {
        toast('copy failed', 'err');
      }
    });
  };

  paint();
}
window.compareStoryboardPacks = compareStoryboardPacks;
window.getStoryboardBudgetMode = getStoryboardBudgetMode;
window.setStoryboardBudgetMode = setStoryboardBudgetMode;
window.storyboardBudgetChars = storyboardBudgetChars;

/** Raster PNG overview of the filmstrip (canvas) */
function renderStoryboardPngDataUrl(data) {
  const turns = data.turns || [];
  const cardW = 150;
  const cardH = 96;
  const pad = 16;
  const gap = 10;
  const headerH = 56;
  const cols = Math.min(turns.length || 1, 6);
  const rows = Math.max(1, Math.ceil((turns.length || 1) / cols));
  const w = pad * 2 + cols * cardW + (cols - 1) * gap;
  const h = pad * 2 + headerH + rows * cardH + (rows - 1) * gap;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(480, w);
  canvas.height = Math.max(200, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // bg
  ctx.fillStyle = '#0a0c12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // header
  ctx.fillStyle = '#7dd3fc';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('GrokCode Storyboard · ' + (data.project?.name || 'session'), pad, 28);
  ctx.fillStyle = '#71717a';
  ctx.font = '11px monospace';
  ctx.fillText((data.turns?.length || 0) + ' turns · ' + (data.exportedAt || ''), pad, 46);
  const heats = ['#34d39955', '#34d39988', '#34d399', '#facc15', '#f97316'];
  turns.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cardW + gap);
    const y = pad + headerH + row * (cardH + gap);
    ctx.fillStyle = '#12161f';
    ctx.strokeStyle = '#7dd3fc33';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cardW, cardH, 10);
    ctx.fill();
    ctx.stroke();
    const heat = Math.max(0, Math.min(4, t.heat || 0));
    ctx.fillStyle = heats[heat];
    ctx.fillRect(x, y, 4, cardH);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '10px monospace';
    const time = t.ts ? new Date(t.ts).toLocaleTimeString() : '—';
    ctx.fillText(time, x + 10, y + 18);
    ctx.fillStyle = '#e4e4e7';
    ctx.font = 'bold 12px sans-serif';
    const name = String(t.taskTitle || 'Turn ' + (i + 1)).slice(0, 16);
    ctx.fillText(name, x + 10, y + 38);
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '11px monospace';
    ctx.fillText((t.files || []).length + ' files · H' + heat, x + 10, y + 58);
    if (t.prompt) {
      ctx.fillStyle = '#71717a';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(t.prompt).slice(0, 22), x + 10, y + 78);
    }
  });
  return canvas.toDataURL('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Export turn filmstrip as Markdown / HTML / PNG / folder pack */
async function exportFilmstripStoryboard(opts = {}) {
  const turns = collectGlobalTurns();
  if (!turns.length) {
    toast(localeIsEn() ? 'No turns to export' : '暂无 turn 可导出', 'err');
    return;
  }
  const en = localeIsEn();
  const data = buildStoryboardData({ withDiffs: true });
  const markdown = buildStoryboardMarkdown(data);
  const html = buildStoryboardHtml(data);
  const format = opts.format || 'auto'; // auto | md | html | png | folder
  const safe = String(data.project?.name || 'session')
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
    .slice(0, 40);

  if (format === 'folder') {
    try {
      const png = renderStoryboardPngDataUrl(data);
      const r = await window.grok.reviewExportFolder({
        folderName: `grok-review-${safe}`,
        html,
        markdown,
        json: JSON.stringify(data, null, 2),
        pngBase64: png || '',
      });
      if (r?.canceled) return;
      if (r?.ok) {
        toast(
          (en ? 'Review folder: ' : '审阅包：') + (r.dir || '') + storyboardCompressToast(data, en),
          'ok'
        );
      } else toast(r?.error || 'export failed', 'err');
    } catch (e) {
      toast(e.message || 'export failed', 'err');
    }
    return;
  }

  if (format === 'png') {
    try {
      const png = renderStoryboardPngDataUrl(data);
      if (!png) {
        toast('PNG render failed', 'err');
        return;
      }
      const folder = await window.grok.reviewExportFolder({
        folderName: `grok-storyboard-png-${safe}`,
        pngBase64: png,
      });
      if (folder?.canceled) return;
      if (folder?.ok) toast((en ? 'PNG saved in: ' : 'PNG 已保存：') + folder.dir, 'ok');
      else toast(folder?.error || 'export failed', 'err');
    } catch (e) {
      toast(e.message || 'PNG export failed', 'err');
    }
    return;
  }

  const defaultName =
    format === 'html'
      ? `grok-storyboard-${safe}.html`
      : `grok-storyboard-${safe}.md`;
  try {
    const r = await window.grok.sessionExportShare({
      title: en ? 'Export Diff storyboard' : '导出 Diff storyboard',
      markdown,
      html,
      json: JSON.stringify(data, null, 2),
      defaultName,
    });
    if (r?.canceled) return;
    if (r?.ok) {
      toast(
        (en ? 'Storyboard saved: ' : '已导出 storyboard：') +
          (r.file || '') +
          storyboardCompressToast(data, en),
        'ok'
      );
    } else toast(r?.error || 'export failed', 'err');
  } catch (e) {
    try {
      await navigator.clipboard.writeText(format === 'html' ? html : markdown);
      toast(en ? 'Storyboard copied (save dialog failed)' : '已复制 storyboard（保存失败）', 'ok');
    } catch {
      toast(e.message || 'export failed', 'err');
    }
  }
}
window.exportFilmstripStoryboard = exportFilmstripStoryboard;
window.exportFilmstripHtml = () => exportFilmstripStoryboard({ format: 'html' });
window.exportFilmstripPng = () => exportFilmstripStoryboard({ format: 'png' });
window.exportReviewFolder = () => exportFilmstripStoryboard({ format: 'folder' });
window.exportStoryboardEncrypted = exportStoryboardEncrypted;

function scrubberHtml(turns) {
  if (!turns.length) return '';
  const en = localeIsEn();
  const cur = state.diffScrubTurn;
  const idx = cur ? turns.findIndex((t) => t.key === cur) : -1;
  const playing = state.diffScrubPlaying;
  const speed = Number(state.diffScrubPlaySpeed) || 1;
  const loop = state.diffScrubLoop;
  const chromeOpen = Boolean(state.diffChromeOpen);
  const budgetMode = getStoryboardBudgetMode();
  const budgetLabels = en
    ? { full: 'Full', balanced: 'Bal', compact: 'Sml' }
    : { full: '全量', balanced: '均衡', compact: '精简' };
  const turnLabel =
    idx >= 0 && turns[idx]
      ? turns[idx].ts
        ? new Date(turns[idx].ts).toLocaleTimeString()
        : turns[idx].taskTitle || turns[idx].key.slice(0, 8)
      : en
        ? 'All'
        : '全部';
  // Compact primary row — always visible
  const primary = `<div class="diff-scrub-bar diff-scrub-primary" id="diffScrubBar">
    <span class="diff-scrub-label">${en ? 'Turns' : '轮次'}</span>
    <button type="button" class="diff-cp-chip${!cur ? ' active' : ''}" data-scrub="">${en ? 'Live' : 'Live'}</button>
    <button type="button" class="diff-scrub-play${playing ? ' on' : ''}" data-scrub-play="1" title="${en ? 'Play / pause' : '播放 / 暂停'}">${playing ? '❚❚' : '▶'}</button>
    <button type="button" class="diff-scrub-nav" data-scrub-nav="-1" title="[">‹</button>
    <input type="range" id="diffScrubRange" min="0" max="${Math.max(0, turns.length - 1)}" value="${idx >= 0 ? idx : turns.length - 1}" ${turns.length < 2 ? 'disabled' : ''} />
    <button type="button" class="diff-scrub-nav" data-scrub-nav="1" title="]">›</button>
    <span class="diff-scrub-pos muted">${esc(turnLabel)} · ${turns.length}</span>
    <button type="button" class="diff-chrome-toggle${chromeOpen ? ' open' : ''}" data-diff-chrome-toggle="1" aria-expanded="${chromeOpen ? 'true' : 'false'}" title="${en ? 'Filmstrip · export · notes' : '胶片 · 导出 · 批注'}">${chromeOpen ? (en ? '▾ Hide tools' : '▾ 收起工具') : en ? '▸ Tools' : '▸ 工具'}</button>
  </div>`;
  // Advanced: filmstrip, exports, ticks, speeds — collapsed by default
  const advanced = `<div class="diff-chrome-advanced${chromeOpen ? '' : ' collapsed'}" id="diffChromeAdvanced">
    <div class="diff-scrub-bar diff-scrub-extra">
      <button type="button" class="diff-scrub-loop${loop ? ' on' : ''}" data-scrub-loop="1" title="${en ? 'Loop (L)' : '循环 (L)'}">↻</button>
      <button type="button" class="diff-scrub-export" data-scrub-export="1" title="${en ? 'Export Markdown' : '导出 Markdown'}">⬇</button>
      <button type="button" class="diff-scrub-export html" data-scrub-export-html="1" title="HTML">HTML</button>
      <button type="button" class="diff-scrub-export html" data-scrub-export-png="1" title="PNG">PNG</button>
      <button type="button" class="diff-scrub-export html" data-scrub-export-folder="1" title="${en ? 'Folder pack' : '文件夹'}">📁</button>
      <button type="button" class="diff-scrub-export html" data-scrub-compare="1" title="A|B">A|B</button>
      <button type="button" class="diff-scrub-export html" data-scrub-import="1" title="${en ? 'Import' : '导入'}">⬆</button>
      <button type="button" class="diff-scrub-export html" data-scrub-export-enc="1" title="${en ? 'Encrypted' : '加密'}">🔒</button>
      <span class="diff-scrub-budget" title="${en ? 'Pack budget' : '体积预算'}">
        ${['full', 'balanced', 'compact']
          .map(
            (m) =>
              `<button type="button" class="diff-budget-chip${budgetMode === m ? ' active' : ''}" data-budget-mode="${m}" title="${m}">${budgetLabels[m]}</button>`
          )
          .join('')}
      </span>
      <span class="diff-scrub-speeds" title="${en ? 'Speed' : '倍速'}">
        ${SCRUB_SPEEDS.map(
          (s) =>
            `<button type="button" class="diff-scrub-speed${speed === s ? ' active' : ''}" data-speed="${s}">${s}x</button>`
        ).join('')}
      </span>
      <span class="muted" style="font-size:10px"><kbd>[</kbd><kbd>]</kbd> · <kbd>L</kbd></span>
    </div>
    <div class="diff-scrub-ticks">
      ${turns
        .map((t) => {
          const label = t.ts ? new Date(t.ts).toLocaleTimeString() : t.key.slice(0, 8);
          const n = t.files?.size || 0;
          const noteMark = getTurnNote(t.key) ? ' ✎' : '';
          return `<button type="button" class="diff-scrub-tick${cur === t.key ? ' active' : ''}" data-scrub="${esc(t.key)}" title="${esc(t.taskTitle || '')} · ${n} files · ${esc(String(t.prompt || '').slice(0, 80))}">${esc(label)}<small>${n}f${noteMark}</small></button>`;
        })
        .join('')}
    </div>
    ${filmstripHtml(turns)}
    ${storyboardNotesBarHtml()}
  </div>`;
  return primary + advanced;
}

function heatLegendHtml() {
  if (!state.diffHeatLegend) return '';
  return `<div class="diff-heat-legend" id="diffHeatLegend">
    <span class="dhl-label">Heat</span>
    <span class="dhl-swatch heat-0" title="old">0</span>
    <span class="dhl-swatch heat-1">1</span>
    <span class="dhl-swatch heat-2">2</span>
    <span class="dhl-swatch heat-3">3</span>
    <span class="dhl-swatch heat-4" title="fresh">&lt;2m</span>
  </div>`;
}

/** Keep last N content snapshots for Diff turn replay */
function pushFileCheckpoint(entry, meta = {}) {
  if (!entry) return;
  if (!Array.isArray(entry.checkpoints)) entry.checkpoints = [];
  const after = meta.after;
  if (after == null) return;
  const last = entry.checkpoints[entry.checkpoints.length - 1];
  // update same turn in place
  if (last && meta.turnId && last.turnId === meta.turnId) {
    last.after = after;
    last.ts = meta.ts || Date.now();
    last.prompt = meta.prompt || last.prompt;
    last.taskTitle = meta.taskTitle || last.taskTitle;
    return;
  }
  entry.checkpoints.push({
    turnId: meta.turnId || null,
    taskId: meta.taskId || null,
    taskTitle: meta.taskTitle || null,
    prompt: meta.prompt || null,
    ts: meta.ts || Date.now(),
    reason: meta.reason || null,
    after,
  });
  if (entry.checkpoints.length > 8) {
    entry.checkpoints = entry.checkpoints.slice(-8);
  }
  // viewing live by default
  entry.viewCheckpoint = -1;
}

function resolveCheckpointContent(entry, idx) {
  if (!entry) return null;
  // -1 = original before, -2 = live after, >=0 = checkpoint
  if (idx === -1 || idx === 'before') return entry.before ?? '';
  if (idx == null || idx === -2 || idx === 'live') return entry.after ?? '';
  const cps = entry.checkpoints || [];
  const i = Number(idx);
  if (i < 0 || i >= cps.length) return entry.after ?? '';
  return cps[i].after ?? '';
}

function getDiffViewSnapshot(entry) {
  if (!entry) return null;
  const cps = entry.checkpoints || [];
  // A→B compare mode
  const a = entry.compareA;
  const b = entry.compareB;
  if (a != null && b != null && String(a) !== '' && String(b) !== '') {
    const left = resolveCheckpointContent(entry, a);
    const right = resolveCheckpointContent(entry, b);
    const recomputed = window.DiffUtil.computeLineDiff(left ?? '', right ?? '');
    const labelA = a === -1 || a === 'before' ? 'before' : a === -2 || a === 'live' ? 'live' : `cp#${Number(a) + 1}`;
    const labelB = b === -1 || b === 'before' ? 'before' : b === -2 || b === 'live' ? 'live' : `cp#${Number(b) + 1}`;
    return {
      ops: recomputed.ops,
      stats: recomputed.stats,
      after: right,
      label: `${labelA}→${labelB}`,
      checkpoint: typeof b === 'number' && b >= 0 ? cps[b] : null,
      index: typeof b === 'number' ? b : -1,
      compare: { a, b, labelA, labelB },
    };
  }
  const idx = entry.viewCheckpoint;
  if (idx == null || idx < 0 || idx >= cps.length) {
    return {
      ops: entry.ops,
      stats: entry.stats,
      after: entry.after,
      label: 'live',
      checkpoint: null,
      index: -1,
    };
  }
  const cp = cps[idx];
  // Prefer disk-rehydrated content when checkpoint was upgraded
  if (cp?.fromImport && cp.preferDisk && (cp.after != null || entry.after != null)) {
    const left = cp.before ?? entry.before ?? '';
    const right = cp.after ?? entry.after ?? '';
    const recomputed = window.DiffUtil.computeLineDiff(left, right);
    return {
      ops: recomputed.ops,
      stats: recomputed.stats,
      after: right,
      label: `disk#${idx + 1}`,
      checkpoint: cp,
      index: idx,
      rehydrated: true,
      reconstructed: Boolean(cp.reconstructed && cp.reconstructMode === 'full'),
    };
  }
  // Reconstructed ops from mini-diff (snippet or full) — prefer over raw text
  if (cp?.fromImport && (cp.importOps?.length || cp.importDiffText)) {
    if (!cp.importOps?.length && cp.importDiffText && window.DiffUtil?.reconstructFromUnified) {
      try {
        const r = window.DiffUtil.reconstructFromUnified(cp.importDiffText, {
          after: cp.after ?? entry.after ?? undefined,
        });
        if (r.ok && r.ops?.length) {
          cp.importOps = r.ops;
          cp.importStats = r.stats || cp.importStats;
          cp.reconstructed = true;
          cp.reconstructMode = r.mode;
          if (r.fullBefore) cp.before = r.before;
          else if (r.mode === 'snippet') cp.beforeSnippet = r.before;
        }
      } catch {
        /* fall through */
      }
    }
    if (cp.importOps?.length) {
      return {
        ops: cp.importOps,
        stats: cp.importStats || { adds: 0, dels: 0 },
        after: cp.after ?? entry.after,
        label: `recon#${idx + 1}`,
        checkpoint: cp,
        index: idx,
        reconstructed: true,
        reconstructMode: cp.reconstructMode || 'snippet',
        truncated: Boolean(cp.truncated),
      };
    }
    // Offline storyboard mini-diff text (no reconstructable ops)
    return {
      ops: null,
      importText: cp.importDiffText,
      stats: cp.importStats || { adds: 0, dels: 0 },
      after: cp.after,
      label: `import#${idx + 1}`,
      checkpoint: cp,
      index: idx,
    };
  }
  const recomputed = window.DiffUtil.computeLineDiff(entry.before ?? '', cp.after ?? '');
  return {
    ops: recomputed.ops,
    stats: recomputed.stats,
    after: cp.after,
    label: `cp-${idx + 1}`,
    checkpoint: cp,
    index: idx,
  };
}

function selectDiffFile(path, opts = {}) {
  if (!path || !changesMap().has(path)) return;
  requireProject().selectedDiffPath = path;
  if (opts.render !== false) renderDiffPane();
}

function navigateDiffFile(delta) {
  const items = sortedDiffItems();
  if (!items.length) return;
  const cur = (P() && P().selectedDiffPath) || items[0][0];
  let idx = items.findIndex(([p]) => p === cur);
  if (idx < 0) idx = 0;
  idx = (idx + delta + items.length) % items.length;
  selectDiffFile(items[idx][0]);
}

function markDiffReviewed(path, reviewed = true) {
  path = path || (P() && P().selectedDiffPath);
  if (!path || !changesMap().has(path)) return;
  const entry = changesMap().get(path);
  entry.reviewed = Boolean(reviewed);
  entry.reviewedAt = reviewed ? Date.now() : null;
  changesMap().set(path, entry);
  renderLiveChanges();
  renderDiffPane();
  toast(
    reviewed
      ? localeIsEn()
        ? `Reviewed: ${path.split('/').pop()}`
        : `已审阅：${path.split('/').pop()}`
      : localeIsEn()
        ? 'Unmarked'
        : '已取消审阅',
    'ok'
  );
}

function getDiffSelectedPaths() {
  // prune stale
  for (const p of [...state.diffSelected]) {
    if (!changesMap().has(p)) state.diffSelected.delete(p);
  }
  return [...state.diffSelected];
}

function dismissDiffPaths(paths) {
  const list = paths?.length ? paths : [(P() && P().selectedDiffPath)].filter(Boolean);
  if (!list.length) return 0;
  let n = 0;
  for (const path of list) {
    if (!changesMap().has(path)) continue;
    changesMap().delete(path);
    state.diffSelected.delete(path);
    n += 1;
  }
  if (P() && !changesMap().has(P().selectedDiffPath)) {
    const next = changesMap().keys().next();
    requireProject().selectedDiffPath = next.done ? null : next.value;
  }
  renderLiveChanges();
  renderDiffPane();
  updateEditorChrome();
  return n;
}

async function restoreDiffPaths(paths) {
  const list = (paths?.length ? paths : [(P() && P().selectedDiffPath)].filter(Boolean)).filter(
    (p) => changesMap().has(p) && !changesMap().get(p).restored
  );
  if (!list.length) {
    toast(localeIsEn() ? 'Nothing to restore' : '没有可还原的文件');
    return;
  }
  const ok = confirm(
    list.length === 1
      ? localeIsEn()
        ? `Restore ${list[0]} to pre-agent snapshot?`
        : `还原「${list[0]}」到改前快照？`
      : localeIsEn()
        ? `Restore ${list.length} files? New files will be deleted.`
        : `还原 ${list.length} 个文件？新建文件会被删除。`
  );
  if (!ok) return;

  let done = 0;
  let failed = 0;
  state._restoring = true;
  for (const path of list) {
    try {
      const entry = changesMap().get(path);
      if (!entry || entry.restored) continue;
      requireProject().selectedDiffPath = path;
      const isCreate = entry.created || entry.before === '';
      if (isCreate) {
        await window.grok.deleteFile(pid(), path);
        contentCacheMap().set(path, '');
      } else {
        await window.grok.writeFile(pid(), path, entry.before ?? '');
        contentCacheMap().set(path, entry.before ?? '');
      }
      entry.restored = true;
      entry.restoredAt = Date.now();
      changesMap().set(path, entry);
      state.diffSelected.delete(path);
      done += 1;
    } catch {
      failed += 1;
    }
  }
  state._restoring = false;
  pushLiveEvent({
    kind: 'status',
    title: localeIsEn() ? 'Restore done' : '还原完成',
    sub: `${done}${failed ? ` · fail ${failed}` : ''}`,
  });
  renderLiveChanges();
  renderDiffPane();
  await loadTree();
  toast(
    localeIsEn()
      ? `Restored ${done}${failed ? `, failed ${failed}` : ''}`
      : `已还原 ${done}${failed ? `，失败 ${failed}` : ''}`,
    failed ? 'err' : 'ok'
  );
}

function renderDiffPane() {
  const body = $('#diffFileListBody');
  const content = $('#diffContent');
  if (!body || !content) return;

  const restoreAllBtn = $('#btnRestoreAll');
  const multiBar = ensureDiffMultiBar();

  if (!changesMap().size) {
    body.innerHTML = '<div class="muted pad">本会话还没有捕获到变更。<br>Agent 写文件后会出现在这里。</div>';
    content.innerHTML = `<div class="diff-placeholder"><h3>Real Diff</h3><p>统一 diff · 行级 +/- · 实时捕获 Agent 写入<br>审阅后可 <strong>还原此文件</strong> 或 <strong>忽略</strong> · <kbd>j</kbd>/<kbd>k</kbd> 切文件 · <kbd>a</kbd> 已审阅</p></div>`;
    $('#diffTitle').textContent = '选择左侧文件';
    $('#diffStats').textContent = '';
    setDiffActionsEnabled(false);
    restoreAllBtn?.classList.add('hidden');
    multiBar?.classList.add('hidden');
    state.diffSelected.clear();
    return;
  }

  const items = sortedDiffItems();
  if (!(P() && P().selectedDiffPath) || !changesMap().has((P() && P().selectedDiffPath))) {
    requireProject().selectedDiffPath = items[0][0];
  }

  // prune selection
  for (const p of [...state.diffSelected]) {
    if (!changesMap().has(p)) state.diffSelected.delete(p);
  }

  const pending = items.filter(([, c]) => !c.restored);
  restoreAllBtn?.classList.toggle('hidden', pending.length === 0);
  multiBar?.classList.remove('hidden');
  updateDiffMultiBar();

  const scrubTurn = state.diffScrubTurn;
  body.innerHTML = items
    .map(([p, c]) => {
      const active = p === (P() && P().selectedDiffPath) ? ' active' : '';
      const restored = c.restored ? ' restored' : '';
      const reviewed = c.reviewed && !c.restored ? ' reviewed' : '';
      const checked = state.diffSelected.has(p) ? ' checked' : '';
      const inScrub = scrubTurn ? fileHasTurn(p, scrubTurn) : true;
      const dim = scrubTurn && !inScrub ? ' dim' : '';
      const name = p.split('/').pop();
      const meta = c.restored
        ? '已还原'
        : c.reviewed
          ? '已审阅'
          : `<span class="a">+${c.stats?.adds ?? 0}</span> <span class="d">-${c.stats?.dels ?? 0}</span>`;
      return `<div class="diff-file${active}${restored}${reviewed}${dim}" data-path="${esc(p)}">
        <label class="df-check" title="多选">
          <input type="checkbox" data-path="${esc(p)}"${checked} />
        </label>
        <button type="button" class="df-main" data-path="${esc(p)}" title="${esc(p)}">
          <span class="df-path">${esc(name)}${c.reviewed && !c.restored ? ' <em class="df-badge">OK</em>' : ''}${
            inScrub && scrubTurn ? ' <em class="df-badge turn">T</em>' : ''
          }</span>
          <span class="df-meta">${meta}</span>
        </button>
      </div>`;
    })
    .join('');

  body.querySelectorAll('.df-main').forEach((btn) => {
    btn.onclick = () => selectDiffFile(btn.dataset.path);
  });
  body.querySelectorAll('.df-check input').forEach((inp) => {
    inp.onclick = (e) => e.stopPropagation();
    inp.onchange = () => {
      const path = inp.dataset.path;
      if (inp.checked) state.diffSelected.add(path);
      else state.diffSelected.delete(path);
      updateDiffMultiBar();
    };
  });

  const cur = changesMap().get((P() && P().selectedDiffPath));
  if (!cur) return;
  $('#diffTitle').textContent = (P() && P().selectedDiffPath);
  const bits = [];
  if (cur.restored) bits.push('<span style="color:var(--ok)">已还原</span>');
  else {
    bits.push(
      `<span class="a" style="color:var(--ok)">+${cur.stats.adds}</span> · <span class="d" style="color:var(--danger)">-${cur.stats.dels}</span>`
    );
    if (cur.reviewed) bits.push('<span style="color:#7dd3fc">· 已审阅</span>');
  }
  $('#diffStats').innerHTML = bits.join(' ');

  setDiffActionsEnabled(true);
  $('#btnRestoreFile').disabled = Boolean(cur.restored);
  $('#btnRestoreFile').textContent = cur.created && !cur.restored ? '删除此文件' : '还原此文件';
  const reviewBtn = $('#btnReviewDiff');
  if (reviewBtn) {
    reviewBtn.disabled = Boolean(cur.restored);
    reviewBtn.textContent = cur.reviewed ? '取消审阅' : '已审阅';
  }

  let banner = '';
  if (cur.restored) {
    banner = `<div class="diff-banner">✓ 已还原到改前快照${cur.created ? '（新建文件已删除）' : ''}</div>`;
  } else if (cur.reviewed) {
    banner = `<div class="diff-banner">✓ 已标记审阅 · 磁盘未改 · 可继续忽略或还原</div>`;
  } else if (cur.created) {
    banner = `<div class="diff-banner warn">此文件为 Agent 新建 · 还原 = 从磁盘删除</div>`;
  }

  // Reset hunk collapse when switching files
  if (content.dataset.diffPath !== (P() && P().selectedDiffPath)) {
    state.diffHunkCollapsed = new Set();
    content.dataset.diffPath = (P() && P().selectedDiffPath) || '';
    // default to live view when changing files
    if (cur.viewCheckpoint != null && cur.viewCheckpoint >= 0) {
      /* keep selection if same session */
    }
  }

  const snap = getDiffViewSnapshot(cur);
  const viewMode = state.diffViewMode === 'split' ? 'split' : 'unified';
  const lastTurn = Array.isArray(cur.turns) && cur.turns.length ? cur.turns[cur.turns.length - 1] : null;
  const cp = snap?.checkpoint;
  const blameTs = cp?.ts || cur.ts || lastTurn?.ts || null;
  const blame = {
    turnId: cp?.turnId || cur.turnId || lastTurn?.turnId || '',
    taskTitle: cp?.taskTitle || cur.taskTitle || lastTurn?.taskTitle || '',
    prompt: cp?.prompt || cur.prompt || lastTurn?.prompt || '',
    ts: blameTs,
    reason: cp?.reason || cur.reason || lastTurn?.reason || '',
    turns: cur.turns || [],
    heat:
      typeof window.DiffUtil?.heatFromTs === 'function'
        ? window.DiffUtil.heatFromTs(blameTs)
        : 0,
  };
  if (blame.taskTitle || blame.turnId) {
    const when = blame.ts ? new Date(blame.ts).toLocaleTimeString() : '';
    const viewHint =
      snap?.index >= 0
        ? ` · 查看 checkpoint #${snap.index + 1}`
        : ' · hover +/- 行看详情';
    banner += `<div class="diff-banner blame-banner">Agent turn · ${esc(blame.taskTitle || 'task')}${when ? ` · ${esc(when)}` : ''}${blame.prompt ? ` · ${esc(String(blame.prompt).slice(0, 80))}` : ''}${viewHint}</div>`;
  }

  const cps = cur.checkpoints || [];
  const cmpOn = cur.compareA != null && cur.compareB != null;
  const optLabel = (v) => {
    if (v === -1 || v === 'before') return 'before';
    if (v === -2 || v === 'live') return 'live';
    return `cp#${Number(v) + 1}`;
  };
  const cpOptions = [
    `<option value="-1">before</option>`,
    ...cps.map((_, i) => `<option value="${i}">cp#${i + 1}</option>`),
    `<option value="-2">live</option>`,
  ].join('');
  const cpOpen = Boolean(state.diffCpOpen);
  const cpSummary =
    cps.length > 0
      ? cmpOn
        ? `A→B · ${optLabel(cur.compareA)}→${optLabel(cur.compareB)}`
        : snap?.index >= 0
          ? `cp#${snap.index + 1}/${cps.length}`
          : `Live · ${cps.length} cp`
      : '';
  const cpBar =
    cps.length > 0
      ? `<div class="diff-cp-bar${cpOpen ? ' is-open' : ' is-collapsed'}">
          <button type="button" class="diff-cp-toggle" data-diff-cp-toggle="1" aria-expanded="${cpOpen ? 'true' : 'false'}">
            <span class="diff-cp-label">Checkpoints</span>
            <span class="diff-cp-summary muted">${esc(cpSummary)}</span>
            <span class="diff-cp-chev">${cpOpen ? '▾' : '▸'}</span>
          </button>
          <div class="diff-cp-body${cpOpen ? '' : ' collapsed'}">
          <button type="button" class="diff-cp-chip${!cmpOn && snap?.index < 0 ? ' active' : ''}" data-cp="-1">Live</button>
          ${cps
            .map((c, i) => {
              const t = c.ts ? new Date(c.ts).toLocaleTimeString() : `#${i + 1}`;
              return `<button type="button" class="diff-cp-chip${!cmpOn && snap?.index === i ? ' active' : ''}" data-cp="${i}" title="${esc(c.taskTitle || '')} · ${esc(String(c.prompt || '').slice(0, 80))}">${esc(t)}</button>`;
            })
            .join('')}
          ${
            snap?.index >= 0 && !cur.restored && !cmpOn
              ? `<button type="button" class="btn small ghost" data-cp-act="restore">${localeIsEn() ? 'Restore file' : '还原此文件'}</button>
                 <button type="button" class="btn small ghost" data-cp-act="restore-turn">${localeIsEn() ? 'Restore whole turn' : '还原整轮'}</button>`
              : ''
          }
          <span class="diff-cp-sep">|</span>
          <label class="diff-cp-cmp">A
            <select id="cpCompareA">${cpOptions}</select>
          </label>
          <label class="diff-cp-cmp">B
            <select id="cpCompareB">${cpOptions}</select>
          </label>
          <button type="button" class="btn small ghost${cmpOn ? ' active-view' : ''}" data-cp-act="compare">${localeIsEn() ? 'Compare A→B' : '对比 A→B'}</button>
          ${
            cmpOn
              ? `<button type="button" class="link-btn" data-cp-act="clear-cmp">${localeIsEn() ? 'Clear compare' : '清除对比'}</button>
                 <span class="muted" style="font-size:11px">${esc(snap?.label || '')}</span>`
              : ''
          }
          </div>
        </div>`
      : '';

  let bodyHtml = '';
  if (snap?.importText) {
    // Offline pack mini-diff (no full file content)
    const lines = String(snap.importText)
      .split('\n')
      .map((line) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'del'
              : 'ctx';
        return `<div class="diff-import-line ${cls}">${esc(line) || ' '}</div>`;
      })
      .join('');
    bodyHtml = `<div class="diff-import-pack">
      <div class="diff-import-hint">${localeIsEn() ? 'Imported mini-diff (offline pack · no full file snapshot)' : '导入的迷你 Diff（离线包 · 无完整文件快照）'}</div>
      <pre class="diff-import-pre">${lines}</pre>
    </div>`;
  } else {
    const viewOps = snap?.ops || cur.ops || [];
    bodyHtml =
      viewMode === 'split'
        ? window.DiffUtil.toSideBySideHtml(viewOps, { context: 3, blame })
        : window.DiffUtil.toUnifiedHtml(viewOps, {
            context: 3,
            collapsed: state.diffHunkCollapsed,
            blame,
          });
  }

  // stats reflect current view
  if (snap?.stats && !cur.restored) {
    const bits2 = [
      `<span class="a" style="color:var(--ok)">+${snap.stats.adds}</span> · <span class="d" style="color:var(--danger)">-${snap.stats.dels}</span>`,
    ];
    if (snap.importText) bits2.push(`<span style="color:#fbbf24">· import</span>`);
    else if (snap.reconstructed) {
      bits2.push(
        snap.reconstructMode === 'full'
          ? `<span style="color:#34d399">${localeIsEn() ? '· recon full' : '· 已反推 before'}</span>`
          : `<span style="color:#fbbf24">${localeIsEn() ? '· recon snippet' : '· 片段反推'}</span>`
      );
      if (snap.truncated) bits2.push(`<span style="color:#71717a">${localeIsEn() ? '· truncated' : '· 截断'}</span>`);
    } else if (snap.rehydrated) bits2.push(`<span style="color:#34d399">· disk</span>`);
    else if (snap.index >= 0) bits2.push(`<span style="color:#fbbf24">· cp#${snap.index + 1}</span>`);
    if (cur.reviewed) bits2.push('<span style="color:#7dd3fc">· 已审阅</span>');
    $('#diffStats').innerHTML = bits2.join(' ');
  }

  const globalTurns = collectGlobalTurns();
  let overlayBanner = '';
  if (state.storyboardOverlay) {
    const en = localeIsEn();
    const name = (state.storyboardOverlay.file || '').split(/[/\\]/).pop() || 'pack';
    const rh = state.storyboardOverlay.rehydrate;
    const rhBit = rh
      ? en
        ? ` · disk ${rh.ok}/${rh.ok + rh.miss}`
        : ` · 磁盘 ${rh.ok}/${rh.ok + rh.miss}`
      : '';
    const rehydratedFile = cur?.rehydrated
      ? en
        ? ' · this file on disk'
        : ' · 本文件已 rehydrate'
      : '';
    overlayBanner = `<div class="diff-banner storyboard-overlay-banner">
      <span>${en ? 'Offline storyboard' : '离线 Storyboard'} · ${esc(name)} · ${globalTurns.length} turns${rhBit}${rehydratedFile}</span>
      <span class="storyboard-overlay-actions">
        <button type="button" class="link-btn" data-storyboard-rehydrate>${en ? 'Rehydrate disk' : '从磁盘恢复'}</button>
        <button type="button" class="link-btn" data-storyboard-clear>${en ? 'Exit' : '退出回灌'}</button>
      </span>
    </div>`;
  }
  // Chrome (scrub/film) stays in flex head; line diff scrolls in .diff-body-scroll
  content.innerHTML =
    `<div class="diff-chrome-stack">` +
    scrubberHtml(globalTurns) +
    `</div>` +
    `<div class="diff-body-scroll">` +
    overlayBanner +
    banner +
    cpBar +
    `<div class="diff-hunk-toolbar">
      <button type="button" class="link-btn${viewMode === 'unified' ? ' active-view' : ''}" data-diff-act="unified">Unified</button>
      <button type="button" class="link-btn${viewMode === 'split' ? ' active-view' : ''}" data-diff-act="split">Side-by-side</button>
      ${
        viewMode === 'unified' && !snap?.importText
          ? `<button type="button" class="link-btn" data-diff-act="expand">全部展开</button>
      <button type="button" class="link-btn" data-diff-act="collapse">全部折叠</button>`
          : ''
      }
      <button type="button" class="link-btn${state.diffHeatLegend ? ' active-view' : ''}" data-diff-act="heat-legend">${localeIsEn() ? 'Heat' : '热力'}</button>
      <span class="muted diff-hunk-hint" style="font-size:11px"><kbd>j</kbd>/<kbd>k</kbd> · <kbd>a</kbd> · <kbd>s</kbd></span>
    </div>` +
    heatLegendHtml() +
    bodyHtml +
    `</div>`;

  bindDiffBlameTooltips(content, blame);

  content.querySelector('[data-diff-chrome-toggle]')?.addEventListener('click', () => {
    state.diffChromeOpen = !state.diffChromeOpen;
    saveJson('grokcode-diff-chrome-open', state.diffChromeOpen);
    renderDiffPane();
  });
  content.querySelector('[data-diff-cp-toggle]')?.addEventListener('click', () => {
    state.diffCpOpen = !state.diffCpOpen;
    saveJson('grokcode-diff-cp-open', state.diffCpOpen);
    renderDiffPane();
  });

  // turn scrubber
  content.querySelectorAll('[data-scrub]').forEach((btn) => {
    btn.onclick = () => scrubToTurn(btn.dataset.scrub || null);
  });
  content.querySelectorAll('[data-scrub-nav]').forEach((btn) => {
    btn.onclick = () => {
      stopScrubPlay();
      navigateScrubTurn(Number(btn.dataset.scrubNav) || 0);
    };
  });
  content.querySelector('[data-scrub-play]')?.addEventListener('click', () => toggleScrubPlay());
  content.querySelector('[data-scrub-loop]')?.addEventListener('click', () => toggleScrubLoop());
  content.querySelector('[data-scrub-export]')?.addEventListener('click', () => {
    exportFilmstripStoryboard({ format: 'md' });
  });
  content.querySelector('[data-scrub-export-html]')?.addEventListener('click', () => {
    exportFilmstripStoryboard({ format: 'html' });
  });
  content.querySelector('[data-scrub-export-png]')?.addEventListener('click', () => {
    exportFilmstripStoryboard({ format: 'png' });
  });
  content.querySelector('[data-scrub-export-folder]')?.addEventListener('click', () => {
    exportFilmstripStoryboard({ format: 'folder' });
  });
  content.querySelector('[data-scrub-compare]')?.addEventListener('click', () => {
    compareStoryboardPacks();
  });
  content.querySelector('[data-scrub-export-enc]')?.addEventListener('click', () => {
    exportStoryboardEncrypted();
  });
  content.querySelector('[data-scrub-import]')?.addEventListener('click', () => {
    importStoryboardToFilmstrip();
  });
  content.querySelector('[data-storyboard-clear]')?.addEventListener('click', () => {
    clearStoryboardOverlay();
  });
  content.querySelector('[data-storyboard-rehydrate]')?.addEventListener('click', () => {
    rehydrateStoryboardFromDisk({ silent: false });
  });
  content.querySelectorAll('[data-budget-mode]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const mode = setStoryboardBudgetMode(btn.dataset.budgetMode);
      const kb = Math.round(storyboardBudgetChars(mode) / 1000);
      toast(
        localeIsEn()
          ? `Pack budget: ${mode} (~${kb}k chars)`
          : `导出预算：${mode}（约 ${kb}k 字符）`,
        'ok'
      );
      renderDiffPane();
    };
  });
  content.querySelector('[data-note-save]')?.addEventListener('click', () => {
    const key = state.diffScrubTurn;
    const ta = content.querySelector('#turnReviewNote');
    if (!key || !ta) return;
    setTurnNote(key, ta.value);
    toast(localeIsEn() ? 'Review note saved' : '批注已保存', 'ok');
    // refresh filmstrip note markers without losing textarea focus issue: re-render
    renderDiffPane();
  });
  content.querySelector('#turnReviewNote')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      content.querySelector('[data-note-save]')?.click();
    }
  });
  content.querySelectorAll('[data-speed]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      setScrubPlaySpeed(Number(btn.dataset.speed));
      toast(`${btn.dataset.speed}x`, 'ok');
    };
  });
  bindFilmstripHover(content);
  // filmstrip cards share data-scrub
  const range = content.querySelector('#diffScrubRange');
  if (range && globalTurns.length) {
    range.oninput = () => {
      stopScrubPlay();
      const i = Number(range.value);
      const t = globalTurns[i];
      if (t) scrubToTurn(t.key);
    };
  }
  // clicking ticks should pause play
  content.querySelectorAll('[data-scrub]').forEach((btn) => {
    const prev = btn.onclick;
    btn.onclick = (e) => {
      stopScrubPlay();
      if (prev) prev(e);
      else scrubToTurn(btn.dataset.scrub || null);
    };
  });
  content.querySelector('[data-diff-act="heat-legend"]')?.addEventListener('click', () => {
    state.diffHeatLegend = !state.diffHeatLegend;
    saveJson('grokcode-diff-heat-legend', state.diffHeatLegend);
    renderDiffPane();
  });

  // init compare selects
  const selA = content.querySelector('#cpCompareA');
  const selB = content.querySelector('#cpCompareB');
  if (selA) {
    selA.value = String(cur.compareA != null ? cur.compareA : cps.length ? cps.length - 2 : -1);
    if (cur.compareA == null && cps.length >= 2) selA.value = String(cps.length - 2);
    else if (cur.compareA == null) selA.value = '-1';
  }
  if (selB) {
    if (cur.compareB != null) selB.value = String(cur.compareB);
    else selB.value = cps.length ? String(cps.length - 1) : '-2';
  }

  content.querySelectorAll('[data-cp]').forEach((btn) => {
    btn.onclick = () => {
      const path = P() && P().selectedDiffPath;
      const entry = path && changesMap().get(path);
      if (!entry) return;
      entry.viewCheckpoint = Number(btn.dataset.cp);
      entry.compareA = null;
      entry.compareB = null;
      changesMap().set(path, entry);
      state.diffHunkCollapsed = new Set();
      renderDiffPane();
    };
  });
  content.querySelector('[data-cp-act="restore"]')?.addEventListener('click', () => {
    restoreToCheckpoint();
  });
  content.querySelector('[data-cp-act="restore-turn"]')?.addEventListener('click', () => {
    restoreWholeTurn();
  });
  content.querySelector('[data-cp-act="compare"]')?.addEventListener('click', () => {
    const path = P() && P().selectedDiffPath;
    const entry = path && changesMap().get(path);
    if (!entry) return;
    const a = Number(content.querySelector('#cpCompareA')?.value);
    const b = Number(content.querySelector('#cpCompareB')?.value);
    if (a === b) {
      toast(localeIsEn() ? 'Pick two different points' : '请选择两个不同的点', 'err');
      return;
    }
    entry.compareA = a;
    entry.compareB = b;
    entry.viewCheckpoint = -1;
    changesMap().set(path, entry);
    state.diffHunkCollapsed = new Set();
    renderDiffPane();
  });
  content.querySelector('[data-cp-act="clear-cmp"]')?.addEventListener('click', () => {
    const path = P() && P().selectedDiffPath;
    const entry = path && changesMap().get(path);
    if (!entry) return;
    entry.compareA = null;
    entry.compareB = null;
    changesMap().set(path, entry);
    renderDiffPane();
  });

  content.querySelector('[data-diff-act="unified"]')?.addEventListener('click', () => {
    state.diffViewMode = 'unified';
    saveJson('grokcode-diff-view', 'unified');
    renderDiffPane();
  });
  content.querySelector('[data-diff-act="split"]')?.addEventListener('click', () => {
    state.diffViewMode = 'split';
    saveJson('grokcode-diff-view', 'split');
    renderDiffPane();
  });
  content.querySelectorAll('.diff-hunk-head').forEach((btn) => {
    btn.onclick = () => {
      const hi = Number(btn.dataset.hunk);
      if (state.diffHunkCollapsed.has(hi)) state.diffHunkCollapsed.delete(hi);
      else state.diffHunkCollapsed.add(hi);
      renderDiffPane();
    };
  });
  content.querySelector('[data-diff-act="expand"]')?.addEventListener('click', () => {
    state.diffHunkCollapsed = new Set();
    renderDiffPane();
  });
  content.querySelector('[data-diff-act="collapse"]')?.addEventListener('click', () => {
    const heads = content.querySelectorAll('.diff-hunk-head');
    state.diffHunkCollapsed = new Set([...heads].map((h) => Number(h.dataset.hunk)));
    renderDiffPane();
  });
}

/** Apply one file checkpoint to disk + entry maps */
async function applyCheckpointToFile(path, entry, afterContent) {
  const isEmpty = afterContent === '';
  if (isEmpty && entry.created) {
    await window.grok.deleteFile(pid(), path);
    contentCacheMap().set(path, '');
  } else {
    await window.grok.writeFile(pid(), path, afterContent ?? '');
    contentCacheMap().set(path, afterContent ?? '');
  }
  const recomputed = window.DiffUtil.computeLineDiff(entry.before ?? '', afterContent ?? '');
  entry.after = afterContent ?? '';
  entry.ops = recomputed.ops;
  entry.stats = recomputed.stats;
  entry.viewCheckpoint = -1;
  entry.compareA = null;
  entry.compareB = null;
  entry.ts = Date.now();
  changesMap().set(path, entry);
  if (requireProject().currentFile === path) {
    $('#editor').value = afterContent ?? '';
    requireProject().dirty = false;
    syncGutter();
    updateEditorChrome();
  }
}

/** Write selected checkpoint content back to disk (single file) */
async function restoreToCheckpoint() {
  const path = P() && P().selectedDiffPath;
  if (!path || !changesMap().has(path)) return;
  const entry = changesMap().get(path);
  const snap = getDiffViewSnapshot(entry);
  if (!snap || snap.index < 0 || snap.after == null) {
    toast(localeIsEn() ? 'Select a checkpoint first' : '请先选择一个 checkpoint', 'err');
    return;
  }
  const ok = confirm(
    localeIsEn()
      ? `Write checkpoint #${snap.index + 1} content back to disk for\n${path}?`
      : `将 checkpoint #${snap.index + 1} 的内容写回磁盘？\n${path}`
  );
  if (!ok) return;
  try {
    state._restoring = true;
    await applyCheckpointToFile(path, entry, snap.after);
    pushLiveEvent({
      kind: 'status',
      title: localeIsEn() ? `Restored checkpoint ${path}` : `已还原 checkpoint ${path}`,
      sub: `#${snap.index + 1}`,
    });
    renderLiveChanges();
    renderDiffPane();
    await loadTree();
    toast(localeIsEn() ? 'Checkpoint restored to disk' : '已写回 checkpoint 内容', 'ok');
  } catch (err) {
    toast(err.message || 'restore failed', 'err');
  } finally {
    setTimeout(() => {
      state._restoring = false;
    }, 500);
  }
}

/**
 * Restore all Diff files that share the selected checkpoint's turnId
 * (whole agent turn multi-file restore).
 */
async function restoreWholeTurn() {
  const path = P() && P().selectedDiffPath;
  if (!path || !changesMap().has(path)) return;
  const entry = changesMap().get(path);
  const snap = getDiffViewSnapshot(entry);
  if (!snap || snap.index < 0) {
    toast(localeIsEn() ? 'Select a checkpoint first' : '请先选择一个 checkpoint', 'err');
    return;
  }
  const turnId = snap.checkpoint?.turnId || entry.turnId;
  const targets = [];
  for (const [p, e] of changesMap()) {
    if (e.restored) continue;
    let cp = null;
    if (turnId && Array.isArray(e.checkpoints)) {
      cp = e.checkpoints.find((c) => c.turnId && c.turnId === turnId) || null;
    }
    // fallback: same checkpoint index if no turnId
    if (!cp && snap.index >= 0 && e.checkpoints?.[snap.index]) {
      cp = e.checkpoints[snap.index];
    }
    if (!cp || cp.after == null) continue;
    targets.push({ path: p, entry: e, after: cp.after, turnId: cp.turnId || turnId });
  }
  if (!targets.length) {
    toast(localeIsEn() ? 'No files for this turn' : '该轮没有可还原的文件', 'err');
    return;
  }
  const names = targets.map((t) => t.path.split('/').pop()).slice(0, 8).join(', ');
  const ok = confirm(
    localeIsEn()
      ? `Restore whole turn across ${targets.length} file(s)?\n${names}${targets.length > 8 ? '…' : ''}`
      : `整轮还原 ${targets.length} 个文件？\n${names}${targets.length > 8 ? '…' : ''}`
  );
  if (!ok) return;
  let done = 0;
  let failed = 0;
  state._restoring = true;
  for (const t of targets) {
    try {
      await applyCheckpointToFile(t.path, t.entry, t.after);
      done += 1;
    } catch {
      failed += 1;
    }
  }
  state._restoring = false;
  pushLiveEvent({
    kind: 'status',
    title: localeIsEn() ? 'Whole-turn restore' : '整轮还原',
    sub: `${done} files${failed ? ` · fail ${failed}` : ''}${turnId ? ` · ${turnId}` : ''}`,
  });
  renderLiveChanges();
  renderDiffPane();
  await loadTree();
  toast(
    localeIsEn()
      ? `Restored ${done} file(s)${failed ? `, failed ${failed}` : ''}`
      : `已还原 ${done} 个文件${failed ? `，失败 ${failed}` : ''}`,
    failed ? 'err' : 'ok'
  );
}
window.restoreWholeTurn = restoreWholeTurn;

function toggleDiffViewMode() {
  state.diffViewMode = state.diffViewMode === 'split' ? 'unified' : 'split';
  saveJson('grokcode-diff-view', state.diffViewMode);
  if (state.activeTab === 'diff') renderDiffPane();
  toast(state.diffViewMode === 'split' ? 'Side-by-side' : 'Unified', 'ok');
}

/** Richer floating tooltip for blamed +/- lines */
function bindDiffBlameTooltips(root, blame) {
  if (!root || !blame) return;
  let tip = document.getElementById('diffBlameTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'diffBlameTip';
    tip.className = 'diff-blame-tip hidden';
    document.body.appendChild(tip);
  }
  const show = (e, el) => {
    const title = el.getAttribute('title') || '';
    if (!title) return;
    const turns = Array.isArray(blame.turns) ? blame.turns : [];
    const hist =
      turns.length > 1
        ? `<div class="dbt-hist">${turns
            .slice(-4)
            .map(
              (t) =>
                `<div>${esc(t.taskTitle || 'task')} · ${t.ts ? esc(new Date(t.ts).toLocaleTimeString()) : ''}</div>`
            )
            .join('')}</div>`
        : '';
    tip.innerHTML = `<div class="dbt-title">Agent 归属</div><div class="dbt-body">${esc(title)}</div>${hist}`;
    tip.classList.remove('hidden');
    const x = Math.min(e.clientX + 12, window.innerWidth - 280);
    const y = Math.min(e.clientY + 14, window.innerHeight - 120);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const hide = () => tip.classList.add('hidden');
  root.querySelectorAll('.diff-row.has-blame, .diff-sbs-row.has-blame').forEach((el) => {
    el.addEventListener('mouseenter', (e) => show(e, el));
    el.addEventListener('mousemove', (e) => {
      if (tip.classList.contains('hidden')) return;
      tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 280)}px`;
      tip.style.top = `${Math.min(e.clientY + 14, window.innerHeight - 120)}px`;
    });
    el.addEventListener('mouseleave', hide);
  });
}

function ensureDiffMultiBar() {
  let bar = document.getElementById('diffMultiBar');
  if (bar) return bar;
  const list = document.getElementById('diffFileList');
  if (!list) return null;
  bar = document.createElement('div');
  bar.id = 'diffMultiBar';
  bar.className = 'diff-multi-bar hidden';
  bar.innerHTML = `
    <button type="button" class="link-btn" data-act="all">全选</button>
    <button type="button" class="link-btn" data-act="none">清空</button>
    <span class="diff-multi-count" id="diffMultiCount">0 选中</span>
    <button type="button" class="btn small ghost" data-act="dismiss">忽略选中</button>
    <button type="button" class="btn small danger" data-act="restore">还原选中</button>
    <button type="button" class="btn small ghost" data-act="review">审阅选中</button>`;
  const head = list.querySelector('.diff-list-head');
  if (head?.nextSibling) list.insertBefore(bar, head.nextSibling);
  else list.appendChild(bar);
  bar.querySelector('[data-act="all"]').onclick = () => {
    for (const [p] of changesMap()) state.diffSelected.add(p);
    renderDiffPane();
  };
  bar.querySelector('[data-act="none"]').onclick = () => {
    state.diffSelected.clear();
    renderDiffPane();
  };
  bar.querySelector('[data-act="dismiss"]').onclick = () => {
    const n = dismissDiffPaths(getDiffSelectedPaths());
    if (n) toast(localeIsEn() ? `Dismissed ${n}` : `已忽略 ${n} 个`, 'ok');
  };
  bar.querySelector('[data-act="restore"]').onclick = () => restoreDiffPaths(getDiffSelectedPaths());
  bar.querySelector('[data-act="review"]').onclick = () => {
    const paths = getDiffSelectedPaths();
    if (!paths.length) {
      toast(localeIsEn() ? 'Select files first' : '先勾选文件', 'err');
      return;
    }
    for (const p of paths) {
      const e = changesMap().get(p);
      if (e && !e.restored) {
        e.reviewed = true;
        e.reviewedAt = Date.now();
        changesMap().set(p, e);
      }
    }
    renderDiffPane();
    toast(localeIsEn() ? `Reviewed ${paths.length}` : `已审阅 ${paths.length} 个`, 'ok');
  };
  return bar;
}

function updateDiffMultiBar() {
  const el = document.getElementById('diffMultiCount');
  if (el) {
    const n = getDiffSelectedPaths().length;
    el.textContent = localeIsEn() ? `${n} selected` : `${n} 选中`;
  }
}

function setDiffActionsEnabled(on) {
  if ($('#btnOpenFromDiff')) $('#btnOpenFromDiff').disabled = !on;
  if ($('#btnOpenExternal')) $('#btnOpenExternal').disabled = !on;
  if ($('#btnDiscussDiff')) $('#btnDiscussDiff').disabled = !on;
  if ($('#btnRestoreFile')) $('#btnRestoreFile').disabled = !on;
  if ($('#btnDismissDiff')) $('#btnDismissDiff').disabled = !on;
  if ($('#btnReviewDiff')) $('#btnReviewDiff').disabled = !on;
}

/**
 * 还原单个文件：把 before 快照写回磁盘
 * - 修改文件：writeFile(before)
 * - 新建文件：deleteFile
 */
async function restoreSelectedFile() {
  const path = (P() && P().selectedDiffPath);
  if (!path || !changesMap().has(path)) return;
  const entry = changesMap().get(path);
  if (entry.restored) {
    toast('该文件已还原过');
    return;
  }

  const isCreate = entry.created || entry.before === '';
  const ok = confirm(
    isCreate
      ? `「${path}」是 Agent 新建的文件。\n还原将从磁盘删除它，确定吗？`
      : `将「${path}」还原到 Agent 改之前的内容？\n当前磁盘上的版本会被覆盖。`
  );
  if (!ok) return;

  try {
    // 短暂忽略 fs.watch，避免还原过程又记一条变更
    state._restoring = true;
    if (isCreate) {
      await window.grok.deleteFile(pid(), path);
      contentCacheMap().set(path, '');
    } else {
      await window.grok.writeFile(pid(), path, entry.before ?? '');
      contentCacheMap().set(path, entry.before ?? '');
    }

    entry.restored = true;
    entry.restoredAt = Date.now();
    changesMap().set(path, entry);

    // 若 Code 正打开该文件，同步编辑器
    if (requireProject().currentFile === path) {
      if (isCreate) {
        requireProject().currentFile = null;
        $('#editor').value = '';
        $('#currentPath').textContent = '—';
        requireProject().dirty = false;
      } else {
        $('#editor').value = entry.before ?? '';
        requireProject().dirty = false;
        syncGutter();
      }
      updateEditorChrome();
    }

    pushLiveEvent({
      kind: 'status',
      title: isCreate ? `已删除 ${path}` : `已还原 ${path}`,
      sub: '用户从 Diff 审阅回滚',
    });
    renderLiveChanges();
    renderDiffPane();
    await loadTree();
    toast(isCreate ? '已删除新建文件' : '已还原到改前快照', 'ok');
  } catch (err) {
    toast(err.message || '还原失败', 'err');
  } finally {
    setTimeout(() => {
      state._restoring = false;
    }, 500);
  }
}

/** 批量还原所有尚未还原的变更 */
async function restoreAllFiles() {
  const pending = [...changesMap().entries()].filter(([, c]) => !c.restored);
  if (!pending.length) {
    toast('没有可还原的变更');
    return;
  }
  const ok = confirm(
    `将还原 ${pending.length} 个文件到改前快照。\n新建文件会被删除，已有文件会被覆盖。\n确定继续？`
  );
  if (!ok) return;

  let done = 0;
  let failed = 0;
  state._restoring = true;
  for (const [path, entry] of pending) {
    try {
      requireProject().selectedDiffPath = path;
      const isCreate = entry.created || entry.before === '';
      if (isCreate) {
        await window.grok.deleteFile(pid(), path);
        contentCacheMap().set(path, '');
      } else {
        await window.grok.writeFile(pid(), path, entry.before ?? '');
        contentCacheMap().set(path, entry.before ?? '');
      }
      entry.restored = true;
      entry.restoredAt = Date.now();
      changesMap().set(path, entry);
      done += 1;
    } catch {
      failed += 1;
    }
  }
  state._restoring = false;

  pushLiveEvent({
    kind: 'status',
    title: `批量还原完成`,
    sub: `成功 ${done}${failed ? ` · 失败 ${failed}` : ''}`,
  });
  renderLiveChanges();
  renderDiffPane();
  await loadTree();
  if ((P() && P().currentFile) && changesMap().get((P() && P().currentFile))?.restored) {
    const e = changesMap().get((P() && P().currentFile));
    if (e.created) {
      requireProject().currentFile = null;
      $('#editor').value = '';
      $('#currentPath').textContent = '—';
    } else {
      $('#editor').value = e.before ?? '';
    }
    requireProject().dirty = false;
    updateEditorChrome();
    syncGutter();
  }
  toast(`已还原 ${done} 个文件${failed ? `，失败 ${failed}` : ''}`, failed ? 'err' : 'ok');
}

/** 仅从列表移除，不改磁盘 */
function dismissSelectedDiff() {
  const n = dismissDiffPaths([(P() && P().selectedDiffPath)].filter(Boolean));
  if (n) toast(localeIsEn() ? 'Removed from list (disk unchanged)' : '已从变更列表移除（磁盘未改）');
}

function clearMissionSession() {
  state.activity = [];
  state.toolCount = 0;
  changesMap().clear();
  // 保留 contentCache 作为基线更合理；新对话可选择清空变更列表
  requireProject().selectedDiffPath = null;
  const tl = $('#liveTimeline');
  if (tl) {
    tl.innerHTML = `<div class="live-empty" id="liveEmpty">
      <div class="grok-sigil" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>Mission Control</h3>
      <p>实时显示：思考 → 读文件 → 改代码 → 跑命令。</p>
    </div>`;
  }
  renderLiveChanges();
  renderDiffPane();
  setLivePhase('待命', '丢一个任务给 Grok，这里会变成任务驾驶舱');
  updateLiveStats();
}

// ── Terminal ────────────────────────────────────────────
async function onTermKey(e) {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!state.termHistory.length) return;
    if (state.termHistIdx < 0) state.termHistIdx = state.termHistory.length - 1;
    else state.termHistIdx = Math.max(0, state.termHistIdx - 1);
    $('#termInput').value = state.termHistory[state.termHistIdx] || '';
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.termHistIdx < 0) return;
    state.termHistIdx += 1;
    if (state.termHistIdx >= state.termHistory.length) {
      state.termHistIdx = -1;
      $('#termInput').value = '';
    } else {
      $('#termInput').value = state.termHistory[state.termHistIdx] || '';
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const cmd = $('#termInput').value.trim();
    if (!cmd) return;
    $('#termInput').value = '';
    state.termHistory.push(cmd);
    if (state.termHistory.length > 80) state.termHistory.shift();
    state.termHistIdx = -1;
    saveJson(TERM_HIST_KEY, state.termHistory);
    await runTerminal(cmd);
  }
}

async function runTerminal(cmd) {
  appendTerm(`❯ ${cmd}`, 'cmd');
  if (!P()) {
    appendTerm(t('term.needWs', '请先打开工作区。'), 'err');
    return;
  }
  // Terminal pane is always allowed; permission is CLI YOLO / always-approve
  try {
    const res = await window.grok.runTerminal(pid(), cmd);
    if (res.stdout) appendTerm(res.stdout, 'ok');
    if (res.stderr) appendTerm(res.stderr, 'err');
    appendTerm(`退出码 ${res.code}${res.killed ? '（超时）' : ''}`, res.code === 0 ? 'ok' : 'err');
  } catch (err) {
    appendTerm(err.message, 'err');
  }
}

function appendTerm(text, cls = '') {
  const out = $('#termOut');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  out.appendChild(line);
  // cap terminal DOM
  while (out.children.length > 500) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}

// ── Agent（多任务路由） ─────────────────────────────────
function taskFromEvent(d) {
  if (d?.taskId) {
    const t = window.TaskStore.get(d.taskId);
    if (t) return t;
  }
  // 若事件带来 projectId，尽量落到该项目当前任务
  if (d?.projectId) {
    const proj = window.ProjectStore.get(d.projectId);
    if (proj?.activeTaskId) {
      const t = (proj.tasks || []).find((x) => x.id === proj.activeTaskId);
      if (t) return t;
    }
  }
  return T();
}

function isActiveTask(task) {
  if (!task) return false;
  const p = P();
  return Boolean(p && p.id === task.projectId && task.id === p.activeTaskId);
}

function isActiveProjectId(projectId) {
  return Boolean(P() && P().id === projectId);
}

/** Multi-task fairness: active paints every frame (true stream); background throttles */
const StreamFair = {
  /** Active task: no artificial delay — next rAF paints (≈60fps stream feel) */
  ACTIVE_MS: 0,
  BG_MS: 100,
  TAB_MS: 280,
  LIVE_BG_MS: 400,
  /** Live mirror ~30fps is enough; chat body still paints every frame via markStream */
  LIVE_MIRROR_MS: 32,
  MAX_PAINT_PER_TICK: 4,
  /** @type {Map<string, { task: object, streamDirty: boolean, thoughtDirty: boolean, lastStream: number, lastThought: number }>} */
  q: new Map(),
  raf: 0,
  lastTab: 0,
  lastLiveBg: 0,
  lastLiveMirror: 0,
  liveMirrorRaf: 0,
  tabTimer: 0,

  ensure(task) {
    if (!task?.id) return null;
    let e = this.q.get(task.id);
    if (!e) {
      e = {
        task,
        streamDirty: false,
        thoughtDirty: false,
        lastStream: 0,
        lastThought: 0,
      };
      this.q.set(task.id, e);
    } else {
      e.task = task;
    }
    return e;
  },

  isActive(task) {
    return Boolean(task?.id && task.id === (window.TaskStore?.activeId || null));
  },

  markStream(task) {
    const e = this.ensure(task);
    if (!e) return;
    e.streamDirty = true;
    // Active: force eligible this frame (no minMs holdback)
    if (this.isActive(task)) e.lastStream = 0;
    this.kick();
  },

  markThought(task) {
    const e = this.ensure(task);
    if (!e) return;
    e.thoughtDirty = true;
    if (this.isActive(task)) e.lastThought = 0;
    this.kick();
  },

  kick() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => this.tick());
  },

  tick() {
    this.raf = 0;
    const now = performance.now();
    const activeId = window.TaskStore?.activeId || null;
    const sched = window.GrokStreamScheduler;

    // Pure planner (stream-scheduler.js) drives fair order + throttle decisions
    const raw = [...this.q.values()];
    const planEntries = raw.map((e) => ({
      id: e.task.id,
      streamDirty: e.streamDirty,
      thoughtDirty: e.thoughtDirty,
      lastStream: e.lastStream,
      lastThought: e.lastThought,
      running: Boolean(e.task.running),
    }));
    const plan = sched
      ? sched.planTick(planEntries, {
          activeId,
          now,
          ACTIVE_MS: this.ACTIVE_MS,
          BG_MS: this.BG_MS,
          MAX_PAINT_PER_TICK: this.MAX_PAINT_PER_TICK,
        })
      : null;

    if (plan) {
      for (const id of plan.drop) this.q.delete(id);
      for (const p of plan.paint) {
        const e = this.q.get(p.id);
        if (!e) continue;
        if (p.kind === 'stream') {
          e.streamDirty = false;
          e.lastStream = now;
          if (e.task.streamRaf) {
            cancelAnimationFrame(e.task.streamRaf);
            e.task.streamRaf = null;
          }
          upsertAssistant(e.task.streamBuf, true, e.task);
          if (e.task.id === activeId) this.scheduleLiveMirror(e.task);
        } else if (p.kind === 'thought') {
          e.thoughtDirty = false;
          e.lastThought = now;
          if (e.task.thoughtRaf) {
            cancelAnimationFrame(e.task.thoughtRaf);
            e.task.thoughtRaf = null;
          }
          upsertThought(e.task.thoughtBuf, true, e.task);
          if (e.task.id === activeId) this.scheduleLiveMirror(e.task);
        }
      }
      for (const [id, e] of this.q) {
        if (!e.streamDirty && !e.thoughtDirty && !e.task.running) this.q.delete(id);
      }
      if (plan.needMore || [...this.q.values()].some((e) => e.streamDirty || e.thoughtDirty)) {
        this.kick();
      }
      return;
    }

    // Fallback if stream-scheduler.js failed to load
    let painted = 0;
    const entries = raw.sort((a, b) => {
      const aA = a.task.id === activeId ? 0 : 1;
      const bA = b.task.id === activeId ? 0 : 1;
      if (aA !== bA) return aA - bA;
      const aWait = Math.min(
        a.streamDirty ? a.lastStream : Infinity,
        a.thoughtDirty ? a.lastThought : Infinity
      );
      const bWait = Math.min(
        b.streamDirty ? b.lastStream : Infinity,
        b.thoughtDirty ? b.lastThought : Infinity
      );
      return aWait - bWait;
    });

    let needMore = false;
    for (const e of entries) {
      if (!e.streamDirty && !e.thoughtDirty) continue;
      if (!e.task.running && !e.streamDirty && !e.thoughtDirty) {
        this.q.delete(e.task.id);
        continue;
      }
      const active = e.task.id === activeId;
      const minMs = active ? this.ACTIVE_MS : this.BG_MS;

      if (e.streamDirty) {
        if (now - e.lastStream < minMs) {
          needMore = true;
        } else if (painted < this.MAX_PAINT_PER_TICK || active) {
          e.streamDirty = false;
          e.lastStream = now;
          if (e.task.streamRaf) {
            cancelAnimationFrame(e.task.streamRaf);
            e.task.streamRaf = null;
          }
          upsertAssistant(e.task.streamBuf, true, e.task);
          if (active) this.scheduleLiveMirror(e.task);
          painted += 1;
        } else {
          needMore = true;
        }
      }

      if (e.thoughtDirty) {
        if (now - e.lastThought < minMs) {
          needMore = true;
        } else if (painted < this.MAX_PAINT_PER_TICK + (active ? 1 : 0) || active) {
          e.thoughtDirty = false;
          e.lastThought = now;
          if (e.task.thoughtRaf) {
            cancelAnimationFrame(e.task.thoughtRaf);
            e.task.thoughtRaf = null;
          }
          upsertThought(e.task.thoughtBuf, true, e.task);
          if (active) this.scheduleLiveMirror(e.task);
          painted += 1;
        } else {
          needMore = true;
        }
      }
    }

    for (const [id, e] of this.q) {
      if (!e.streamDirty && !e.thoughtDirty && !e.task.running) this.q.delete(id);
    }

    if (needMore || [...this.q.values()].some((e) => e.streamDirty || e.thoughtDirty)) {
      this.kick();
    }
  },

  /** Force immediate paint when user focuses a task */
  flushTask(task) {
    if (!task) return;
    const e = this.q.get(task.id);
    if (e) {
      e.streamDirty = false;
      e.thoughtDirty = false;
      e.lastStream = 0;
      e.lastThought = 0;
    }
    if (task.streamRaf) {
      cancelAnimationFrame(task.streamRaf);
      task.streamRaf = null;
    }
    if (task.thoughtRaf) {
      cancelAnimationFrame(task.thoughtRaf);
      task.thoughtRaf = null;
    }
    if (task.streamBuf) upsertAssistant(task.streamBuf, true, task);
    if (task.thoughtBuf) upsertThought(task.thoughtBuf, true, task);
    if (this.isActive(task)) paintLiveStreamMirrors(task);
  },

  /** Throttled Live-panel stream/thought mirror (path visible while Chat also streams) */
  scheduleLiveMirror(task) {
    if (!task || !this.isActive(task)) return;
    const now = performance.now();
    if (now - this.lastLiveMirror < this.LIVE_MIRROR_MS) {
      if (this.liveMirrorRaf) return;
      this.liveMirrorRaf = requestAnimationFrame(() => {
        this.liveMirrorRaf = 0;
        this.lastLiveMirror = performance.now();
        paintLiveStreamMirrors(task);
      });
      return;
    }
    this.lastLiveMirror = now;
    paintLiveStreamMirrors(task);
  },

  scheduleTabs() {
    const now = performance.now();
    const delay = Math.max(0, this.TAB_MS - (now - this.lastTab));
    if (this.tabTimer) return;
    this.tabTimer = setTimeout(() => {
      this.tabTimer = 0;
      this.lastTab = performance.now();
      renderTaskTabs();
      // Project strip only when multi-running (avoid constant rebuild)
      if (window.TaskStore.countRunningAll() > 1) renderProjectTabs();
    }, delay);
  },

  /** Background live events: batch into occasional summary */
  pushLiveBg(kind, title, sub, projectId) {
    const now = performance.now();
    if (!this._bgLive) this._bgLive = [];
    this._bgLive.push({ kind, title, sub, projectId, ts: now });
    if (this._bgLive.length > 40) this._bgLive = this._bgLive.slice(-40);
    if (now - this.lastLiveBg < this.LIVE_BG_MS) return;
    this.lastLiveBg = now;
    const batch = this._bgLive.splice(0, this._bgLive.length);
    if (!batch.length) return;
    const last = batch[batch.length - 1];
    pushLiveEvent({
      kind: last.kind || 'tool',
      title:
        batch.length > 1
          ? `${batch.length} bg events · ${last.title}`
          : last.title,
      sub: last.sub,
      projectId: last.projectId,
    });
  },
};

function setTaskPhase(task, phase, detail) {
  if (!task) return;
  const next = phase || 'running';
  const det = detail || '';
  const prev = task.phase;
  if (task.phase === next && task.phaseDetail === det) return;
  task.phase = next;
  task.phaseDetail = det;
  StreamFair.scheduleTabs();
  // Keep "Grok · stream" role in sync with real phase — otherwise long tool
  // stretches look frozen under a stuck "stream" label (log: only tool_delta).
  paintLiveAssistantRole(task);
  // Discrete path breadcrumbs (active only). Skip streaming spam + tool
  // (tool_start already records name/path). Skip boot duplicate if same turn.
  if (
    isActiveTask(task) &&
    prev !== next &&
    next !== 'streaming' &&
    next !== 'tool' &&
    next !== 'idle' &&
    next !== 'done'
  ) {
    const labels = {
      boot: '启动 CLI',
      thinking: '思考中',
      error: '出错',
      retry: '重试',
      max_turns: '达到轮次上限',
      stopped: '已停止',
    };
    pushLiveEvent({
      kind: next === 'error' ? 'error' : 'status',
      title: labels[next] || next,
      sub: det || task.title,
      projectId: task.projectId,
    });
  }
}

/** Update live assistant chrome: "Grok · tool · write 3s" not stuck "Grok · stream". */
function paintLiveAssistantRole(task) {
  task = task || T();
  if (!task) return;
  const el =
    task.liveAssistantEl ||
    (task.turnId && task.pane?.querySelector?.(`.msg.assistant[data-turn="${cssEscape(task.turnId)}"]`)) ||
    task.pane?.querySelector?.('.msg.assistant[data-live="1"]');
  if (!el) return;
  const role = el.querySelector('.role');
  if (!role || !task.running) return;
  const phase = task.phase || '';
  const det = String(task.phaseDetail || '').slice(0, 48);
  const gate = window.GrokStreamGate?.modeForTask?.(task);
  if (gate === 'quiet' || gate === 'hold') {
    role.textContent = localeIsEn() ? 'Grok · mid-turn' : 'Grok · 回合中';
    return;
  }
  if (phase === 'tool') {
    role.textContent = det ? `Grok · tool · ${det}` : 'Grok · tool';
  } else if (phase === 'thinking') {
    role.textContent = det ? `Grok · think · ${det}` : 'Grok · think';
  } else if (phase === 'streaming') {
    role.textContent = det ? `Grok · stream · ${det}` : 'Grok · stream';
  } else if (phase === 'running' || phase === 'boot' || phase === 'retry') {
    role.textContent = det ? `Grok · ${det}` : `Grok · ${phase || 'run'}`;
  }
}

/**
 * Sticky Live cards for live stream/thought so center Live is never a black box.
 * Updated in-place; re-attached after timeline rebuilds.
 */
function paintLiveStreamMirrors(task) {
  task = task || T();
  if (!task || !isActiveTask(task)) return;
  const box = $('#liveTimeline');
  if (!box) return;
  const empty = box.querySelector('#liveEmpty');
  if (empty && (task.streamBuf || task.thoughtBuf || task.running)) empty.remove();

  const paintOne = (kind, text, streamMode) => {
    if (!text && kind === 'thought') return;
    // none: no mirror; quiet/answer always show (no blank hold — refuse OW black-box)
    if (kind === 'stream' && streamMode === 'none') {
      document.getElementById('liveStreamMirror')?.remove();
      return;
    }
    if (!text) return;
    const id = kind === 'thought' ? 'liveThoughtMirror' : 'liveStreamMirror';
    let row = document.getElementById(id);
    if (!row || !row.isConnected) {
      row = document.createElement('div');
      row.id = id;
      row.dataset.sticky = id;
      row.className = `live-event ${kind === 'thought' ? 'thought' : 'stream'} running live-mirror`;
      row.innerHTML = `
        <div class="t"></div>
        <div class="dot"></div>
        <div class="card">
          <div class="kind">${kind === 'thought' ? 'think' : 'stream'}</div>
          <div class="title"></div>
          <pre class="sub stream-mirror-body"></pre>
        </div>`;
      box.appendChild(row);
    }
    row.dataset.streamMode = streamMode || '';
    const ts = new Date();
    const t = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(
      ts.getSeconds()
    ).padStart(2, '0')}`;
    const tEl = row.querySelector('.t');
    if (tEl) tEl.textContent = t;
    const titleEl = row.querySelector('.title');
    if (titleEl) {
      if (kind === 'thought') {
        titleEl.textContent = `Thinking · ${text.length} 字`;
      } else if (streamMode === 'quiet') {
        titleEl.textContent = localeIsEn()
          ? `Quiet · mid-turn · ${text.length} chars`
          : `旁白 · 回合中 · ${text.length} 字`;
      } else if (task.phase === 'tool') {
        titleEl.textContent = `回复流 · ${text.length} 字（工具进行中）`;
      } else {
        titleEl.textContent = `流式输出 · ${text.length} 字`;
      }
    }
    const body = row.querySelector('.stream-mirror-body');
    if (body) {
      let s = String(text);
      if (kind === 'stream' && streamMode === 'quiet') {
        s = window.GrokStreamGate?.displayForMode?.(s, 'quiet', { en: localeIsEn() }) || s.slice(0, 120);
      } else if (s.length > 1600) {
        s = `…${s.slice(-1600)}`;
      }
      body.textContent = s;
    }
    row.classList.toggle('running', Boolean(task.running));
    row.classList.toggle('stream-quiet', kind === 'stream' && streamMode === 'quiet');
  };

  // Thought first, then stream (path order) — stream gated (OpenWorker-style)
  if (task.thoughtBuf) paintOne('thought', task.thoughtBuf, 'answer');
  if (task.streamBuf) {
    const mode = window.GrokStreamGate?.modeForTask?.(task) || 'answer';
    paintOne('stream', task.streamBuf, mode);
  }

  if (box.scrollHeight - box.scrollTop - box.clientHeight < 140) {
    box.scrollTop = box.scrollHeight;
  }
}

function clearLiveStreamMirrors() {
  document.getElementById('liveStreamMirror')?.remove();
  document.getElementById('liveThoughtMirror')?.remove();
  document.getElementById('livePlanMirror')?.remove();
}

function paintLivePlanMirror(task, lines) {
  if (!isActiveTask(task)) return;
  const box = document.getElementById('liveTimeline');
  if (!box || !lines?.length) return;
  let row = document.getElementById('livePlanMirror');
  if (!row || !row.isConnected) {
    row = document.createElement('div');
    row.id = 'livePlanMirror';
    row.className = 'live-event status live-mirror';
    row.innerHTML = `
      <div class="t"></div>
      <div class="dot"></div>
      <div class="card">
        <div class="kind">plan</div>
        <div class="title">执行计划</div>
        <pre class="sub stream-mirror-body"></pre>
      </div>`;
    box.appendChild(row);
  }
  const body = row.querySelector('.stream-mirror-body');
  if (body) {
    body.textContent = lines
      .map((l, i) => `${i + 1}. ${l}`)
      .join('\n')
      .slice(0, 2000);
  }
  const title = row.querySelector('.title');
  if (title) title.textContent = `执行计划 · ${lines.length} 步`;
}

function formatUsageBrief(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const inT = usage.input_tokens ?? usage.inputTokens;
  const outT = usage.output_tokens ?? usage.outputTokens;
  const total = usage.total_tokens ?? usage.totalTokens;
  const cache = usage.cache_read_input_tokens ?? usage.cachedReadTokens ?? usage.cached_read_tokens;
  const bits = [];
  if (inT != null) bits.push(`in ${inT}`);
  if (cache != null && Number(cache) > 0) bits.push(`cache ${cache}`);
  if (outT != null) bits.push(`out ${outT}`);
  if (total != null && !bits.length) bits.push(usage.live ? `~${total} tok` : `Σ ${total}`);
  else if (total != null) bits.push(usage.live ? `~${total}` : `Σ ${total}`);
  if (usage.live && inT == null && outT == null) {
    /* mid-turn estimate only — already covered by ~N tok */
  }
  if (usage.usage_is_incomplete || usage.usageIsIncomplete) bits.push('incomplete');
  if (usage.cost_is_partial || usage.costIsPartial) bits.push('cost partial');
  return bits.join(' · ');
}

/**
 * Coalesce parallel tool_start storms (ACP often emits 5–20 tools in 1ms).
 * Still tracks each tool id for tool_end; UI shows one batch card when ≥3.
 */
const ToolStorm = {
  WINDOW_MS: 90,
  /** @type {Map<string, { timer: any, starts: object[], task: object }>} */
  pending: new Map(),

  /** True when a storm card is still absorbing late parallel tools. */
  isOpen(task) {
    if (!task?._toolStorm?.size || !task._toolStormEl) return false;
    if (task._toolStormEl.classList?.contains('running')) return true;
    return [...task._toolStorm.values()].some((t) => t.status === 'running');
  },

  onStart(d, task) {
    if (!task?.id) {
      appendToolStartDirect(d, task);
      return;
    }
    // Progress / mid-flight updates: refresh storm row args, never open a new card
    if (d?.progress) {
      if (task._toolStorm?.has(String(d.id))) {
        const rec = task._toolStorm.get(String(d.id));
        if (d.name) rec.name = d.name;
        if (d.args && typeof d.args === 'object' && Object.keys(d.args).length) {
          rec.args = { ...rec.args, ...d.args };
        }
        paintToolStorm(task);
      }
      return;
    }
    // Late tools after the 90ms window still join an open storm (ACP tool batches
    // often arrive in waves of 3–20 over a few hundred ms).
    if (this.isOpen(task)) {
      trackToolInStorm(task, d);
      if (window.DiffUtil?.isWriteTool?.(d.name)) {
        task.writeCount = (task.writeCount || 0) + 1;
      }
      const fpath = window.DiffUtil?.extractPathFromTool?.(d.name, d.args || {});
      if (fpath && isActiveTask(task) && window.DiffUtil?.isWriteTool?.(d.name)) {
        cacheFileBefore(fpath);
      }
      return;
    }
    let bag = this.pending.get(task.id);
    if (!bag) {
      bag = { timer: null, starts: [], task };
      this.pending.set(task.id, bag);
    }
    bag.task = task;
    bag.starts.push(d);
    if (bag.timer) return;
    bag.timer = setTimeout(() => this.flush(task.id), this.WINDOW_MS);
  },

  flush(taskId) {
    const bag = this.pending.get(taskId);
    if (!bag) return;
    this.pending.delete(taskId);
    clearTimeout(bag.timer);
    const { starts, task } = bag;
    if (!starts.length) return;
    if (starts.length < 3) {
      for (const d of starts) appendToolStartDirect(d, task);
      return;
    }
    ensureToolStormCard(task, starts);
    if (!task._toolStorm) task._toolStorm = new Map();
    for (const d of starts) {
      const id = String(d.id || '');
      if (!id) continue;
      task._toolStorm.set(id, {
        id,
        name: d.name || 'tool',
        args: d.args || {},
        status: 'running',
        startedAt: Number(d.startedAt) || Date.now(),
        result: '',
      });
      const fpath = window.DiffUtil?.extractPathFromTool?.(d.name, d.args || {});
      if (fpath && isActiveTask(task) && window.DiffUtil?.isWriteTool?.(d.name)) {
        cacheFileBefore(fpath);
      }
      if (window.DiffUtil?.isWriteTool?.(d.name)) {
        task.writeCount = (task.writeCount || 0) + 1;
      }
    }
    paintToolStorm(task);
    if (isActiveTask(task)) {
      const n = task._toolStorm.size;
      pushLiveEvent({
        kind: 'tool',
        title: `[${task.title}] 并行 ${n} tools`,
        sub: starts
          .map((s) => s.name)
          .filter(Boolean)
          .slice(0, 8)
          .join(', '),
        running: true,
        projectId: task.projectId,
        immediate: true,
      });
      setLivePhase(`工具 ×${n}`, task.title);
      paintLiveStreamMirrors(task);
    }
  },

  onEnd(d, task) {
    // Flush any pending starts first so end can match
    if (task?.id && this.pending.has(task.id)) this.flush(task.id);
    if (updateToolStormCard(task, d)) return;
    appendToolEndDirect(d, task);
  },
};

function ensureToolStormCard(task, starts) {
  task = task || T();
  if (!task?.pane) return null;
  const box = task.pane;
  let el = box.querySelector(`.msg.tool-storm[data-turn="${cssEscape(task.turnId || '')}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg tool tool-storm running';
    if (task.turnId) el.dataset.turn = task.turnId;
    el.dataset.storm = '1';
    el.innerHTML = `
      <div class="role">Tools</div>
      <div class="body">
        <div class="name storm-title">⚙ 并行工具</div>
        <div class="args storm-list"></div>
        <div class="result storm-result">starting…</div>
      </div>`;
    const asst = task.liveAssistantEl;
    if (asst?.parentNode === box) box.insertBefore(el, asst);
    else box.appendChild(el);
    task._toolStormEl = el;
    task._toolStorm = new Map();
    const startedAt = Date.now();
    el.dataset.toolStarted = String(startedAt);
    el._toolTimer = setInterval(() => {
      if (!el.isConnected || !el.classList.contains('running')) {
        clearInterval(el._toolTimer);
        return;
      }
      paintToolStorm(task);
    }, 500);
  }
  return el;
}

function trackToolInStorm(task, d) {
  if (!task._toolStorm) task._toolStorm = new Map();
  const id = String(d.id || '');
  if (!id) return;
  if (!task._toolStorm.has(id)) {
    task._toolStorm.set(id, {
      id,
      name: d.name || 'tool',
      args: d.args || {},
      status: 'running',
      startedAt: Number(d.startedAt) || Date.now(),
      result: '',
    });
  }
  ensureToolStormCard(task, [d]);
  paintToolStorm(task);
}

function paintToolStorm(task) {
  const el = task?._toolStormEl;
  const map = task?._toolStorm;
  if (!el || !map) return;
  const list = el.querySelector('.storm-list');
  const result = el.querySelector('.storm-result');
  const title = el.querySelector('.storm-title');
  const items = [...map.values()];
  const running = items.filter((t) => t.status === 'running').length;
  const done = items.length - running;
  const startedAt = Number(el.dataset.toolStarted) || Date.now();
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (title) title.textContent = `⚙ 并行工具 · ${items.length}（运行 ${running} / 完成 ${done}）`;
  if (list) {
    list.innerHTML = items
      .slice(0, 24)
      .map((t) => {
        const mark = t.status === 'running' ? '…' : t.ok === false ? '✗' : '✓';
        const human = humanToolTitle(t.name, t.args || {});
        return `<div class="storm-row" title="${esc(t.name || '')}">${mark} ${esc(human)}</div>`;
      })
      .join('');
    if (items.length > 24) {
      list.innerHTML += `<div class="storm-row muted">+${items.length - 24} more</div>`;
    }
  }
  if (result) {
    result.textContent =
      running > 0 ? `running… ${sec}s` : `批次完成 · ${sec}s · ${done}/${items.length}`;
  }
  el.classList.toggle('running', running > 0);
  if (running === 0 && el._toolTimer) {
    clearInterval(el._toolTimer);
    el._toolTimer = null;
  }
}

/** @returns {boolean} true if handled by storm card */
function updateToolStormCard(task, d) {
  if (!task?._toolStorm?.has(String(d.id))) return false;
  const rec = task._toolStorm.get(String(d.id));
  rec.status = 'done';
  rec.ok = d.ok !== false;
  rec.result = String(d.result || '').slice(0, 500);
  paintToolStorm(task);
  return true;
}

function bindAgentEvents() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [
    window.grok.on('agent:phase', (d) => {
      const task = taskFromEvent(d);
      if (!task?.running) return;
      setTaskPhase(task, d.phase || d.status, d.detail || '');
      if (isActiveTask(task)) {
        setAgentStatus(d.detail || d.phase || 'running', true);
        setLivePhase(d.detail || d.phase || 'running', `${task.title} · ${d.phase || 'run'}`);
      }
    }),
    window.grok.on('agent:status', (d) => {
      const task = taskFromEvent(d);
      if (!task?.running) return;
      // Prefer agent:phase when present; keep status as fallback
      if (d.status && !d.phase) setTaskPhase(task, d.status, d.detail || '');
      if (isActiveTask(task)) {
        setAgentStatus(d.detail || d.status, true);
        setLivePhase(d.detail || d.status || 'running', `${task.title} · CLI`);
      }
    }),
    window.grok.on('agent:text', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      const prevLen = (task.streamBuf || '').length;
      // Prefer full text snapshot (main coalesces ~60fps); delta only as fallback
      if (typeof d.text === 'string') task.streamBuf = d.text;
      else if (d.delta) task.streamBuf = (task.streamBuf || '') + d.delta;
      if (task.running) setTaskPhase(task, 'streaming', 'speaking…');
      // Active: paint every frame with latest buf (true stream). Never wait for done.
      scheduleStreamPaint(task);
      if (isActiveTask(task) && task.running) {
        if (prevLen === 0 && task.streamBuf) {
          StreamFair.flushTask(task);
          setLivePhase('streaming…', `${task.title} · ${task.streamBuf.length} 字`);
        } else {
          // Throttle status label only — body paints via StreamFair/rAF
          const now = performance.now();
          if (!task._lastStreamPhaseAt || now - task._lastStreamPhaseAt > 100) {
            task._lastStreamPhaseAt = now;
            setLivePhase('streaming…', `${task.title} · ${(task.streamBuf || '').length} 字`);
          }
          StreamFair.scheduleLiveMirror(task);
        }
      }
    }),
    window.grok.on('agent:thought', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      const prevLen = (task.thoughtBuf || '').length;
      if (typeof d.text === 'string') task.thoughtBuf = d.text;
      else if (d.delta) task.thoughtBuf = (task.thoughtBuf || '') + d.delta;
      if (task.running) setTaskPhase(task, 'thinking', 'thinking…');
      scheduleThoughtPaint(task);
      if (isActiveTask(task) && task.running) {
        const now = performance.now();
        if (!task._lastThoughtPhaseAt || now - task._lastThoughtPhaseAt > 100) {
          task._lastThoughtPhaseAt = now;
          setLivePhase('thinking…', `${task.title} · ${(task.thoughtBuf || '').length} 字`);
        }
        if (prevLen === 0 && task.thoughtBuf) StreamFair.flushTask(task);
        else StreamFair.scheduleLiveMirror(task);
      }
    }),
    window.grok.on('agent:tool_start', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      if (d?.progress) {
        // Mid-flight status only — don't double-count or re-row
        setTaskPhase(task, 'tool', `${d.name || 'tool'}…`);
        // Still refresh storm args if ToolCallDelta / in_progress refine lands
        ToolStorm.onStart(d, task);
        return;
      }
      const active = isActiveTask(task);
      if (active) StreamFair.flushTask(task);
      appendToolStart(d, task);
      task.toolCount += 1;
      task._hasToolThisTurn = true;
      // Re-gate stream: short narration may flip hold → quiet once tools start
      if (task.streamBuf) scheduleStreamPaint(task);
      setTaskPhase(task, 'tool', `${d.name || 'tool'}…`);
      // Live noise for single tools only (storm path emits one summary)
      const pending = ToolStorm.pending.get(task.id);
      if (pending && pending.starts.length >= 2) {
        StreamFair.scheduleTabs();
        return;
      }
      if (ToolStorm.isOpen(task)) {
        StreamFair.scheduleTabs();
        return;
      }
      const fpath = window.DiffUtil.extractPathFromTool(d.name, d.args || {});
      const write = window.DiffUtil.isWriteTool(d.name);
      if (write) task.writeCount = (task.writeCount || 0) + 1;
      if (fpath && active) cacheFileBefore(fpath);
      task._hasToolThisTurn = true;
      const human = humanToolTitle(d.name, d.args || {});
      const liveTitle = `[${task.title}] ${human}`;
      const liveSub = fpath || summarizeToolSub(d.name, d.args);
      if (active) {
        pushLiveEvent({
          kind: write ? 'write' : 'tool',
          title: liveTitle,
          sub: liveSub,
          running: true,
          projectId: task.projectId,
        });
        setLivePhase(write ? 'writing…' : human, fpath || task.title);
        if (fpath && state.followAgent) {
          setLiveFocus(fpath, contentCacheMap().get(fpath) || '');
        }
        updateLiveStats();
        paintLiveStreamMirrors(task);
      } else {
        StreamFair.pushLiveBg(write ? 'write' : 'tool', liveTitle, liveSub, task.projectId);
      }
      StreamFair.scheduleTabs();
    }),
    window.grok.on('agent:tool_end', (d) => {
      const task = taskFromEvent(d);
      appendToolEnd(d, task);
      const active = isActiveTask(task);
      const fpath = window.DiffUtil.extractPathFromTool(d.name, d.args || {});
      const proj = task ? window.ProjectStore.get(task.projectId) : null;
      const inStorm = task?._toolStorm?.has(String(d.id));
      if (fpath && window.DiffUtil.isWriteTool(d.name) && proj) {
        recordFileChangeForProject(proj, fpath, { reason: 'write' });
      } else if (fpath && window.DiffUtil.isReadTool(d.name) && !inStorm) {
        if (active) {
          cacheFileBefore(fpath).then(() => {
            if (state.followAgent) openFile(fpath, { fromAgent: true, switchToCode: false });
          });
        }
        if (active) {
          pushLiveEvent({
            kind: 'tool',
            title: `已读 ${fpath}`,
            sub: task ? task.title : d.name,
            projectId: task?.projectId,
          });
        } else {
          StreamFair.pushLiveBg('tool', `已读 ${fpath}`, task?.title || d.name, task?.projectId);
        }
      } else if (active && !inStorm) {
        pushLiveEvent({
          kind: 'tool',
          title: `${d.name || 'tool'} 完成`,
          sub: fpath || (d.ok === false ? '可能失败' : 'ok'),
          projectId: task?.projectId,
        });
      } else if (!active && !inStorm) {
        StreamFair.pushLiveBg(
          'tool',
          `${d.name || 'tool'} 完成`,
          fpath || (d.ok === false ? '可能失败' : 'ok'),
          task?.projectId
        );
      }
      if (active && window.DiffUtil.isWriteTool(d.name)) scheduleTreeRefresh();
    }),
    window.grok.on('agent:plan', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      task.lastPlanEntries = d.entries || [];
      if (!isActiveTask(task)) return;
      const lines = d.entries || [];
      pushLiveEvent({
        kind: 'status',
        title: `计划 · ${lines.length || d.rawCount || 0} 步`,
        sub: lines.slice(0, 3).join(' · ') || task.title,
        projectId: task.projectId,
      });
      setLivePhase('计划更新', lines[0] || task.title);
      paintLivePlanMirror(task, lines);
    }),
    window.grok.on('agent:mode', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      task.acpModeId = d.modeId || '';
      // Mirror CLI session mode on host chip (current_mode_update / set_mode)
      if (isActiveTask(task) && d.modeId) {
        paintCliModeChip(d.modeId);
        setLivePhase(`模式 · ${d.modeId}`, task.title);
        pushLiveEvent({
          kind: 'status',
          title: `CLI 模式 · ${d.modeId}`,
          sub: d.source === 'set_mode' ? 'session/set_mode' : task.title,
          projectId: task.projectId,
        });
      }
    }),
    window.grok.on('agent:model', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      if (d.modelId) {
        task.acpModelId = d.modelId;
        // Keep composer chip in sync when agent broadcasts ModelChanged
        if (isActiveTask(task) && d.source === 'model_changed') {
          state.model = d.modelId;
          saveJson(MODEL_KEY, state.model);
          applyModelChip();
        }
      }
      if (d.reasoningEffort != null && d.reasoningEffort !== '') {
        task.acpEffort = d.reasoningEffort;
        if (isActiveTask(task)) {
          state.reasoningEffort = String(d.reasoningEffort);
          saveJson(EFFORT_KEY, state.reasoningEffort);
          applyEffortChip();
        }
      }
      if (isActiveTask(task) && d.modelId) {
        const eff = d.reasoningEffort ? ` · ${d.reasoningEffort}` : '';
        setLivePhase(`模型 · ${d.modelId}${eff}`, task.title);
        pushLiveEvent({
          kind: 'status',
          title: `CLI 模型 · ${d.modelId}${eff}`,
          sub:
            d.source === 'set_model'
              ? 'session/set_model'
              : d.source === 'model_changed'
                ? 'ModelChanged'
                : task.title,
          projectId: task.projectId,
        });
      }
    }),
    window.grok.on('agent:models', (d) => {
      if (!d?.ok && !(Array.isArray(d?.models) && d.models.length)) return;
      _liveModels = {
        models: d.models || [],
        defaultId: d.defaultId || '',
        at: Date.now(),
        source: d.source || 'acp',
      };
      applyEffortChip();
      if (isActiveTask(taskFromEvent(d) || T())) {
        pushLiveEvent({
          kind: 'status',
          title: localeIsEn() ? 'Model list' : '模型列表',
          sub: `${_liveModels.models.length} · ${_liveModels.source}`,
          projectId: (taskFromEvent(d) || T())?.projectId,
        });
      }
    }),
    window.grok.on('agent:commands', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      task.acpCommands = d.commands || [];
      if (isActiveTask(task) && (d.count || 0) > 0) {
        setLivePhase(`命令 ${d.count}`, (d.commands || []).slice(0, 4).join(' · '));
      }
    }),
    window.grok.on('agent:permission', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      if (d.pending && d.requestId != null) {
        showPermissionBar(task, d);
        if (isActiveTask(task)) {
          pushLiveEvent({
            kind: 'status',
            title: localeIsEn() ? 'Tool permission' : '工具授权',
            sub: d.toolName || d.toolTitle || 'CLI request_permission',
            projectId: task.projectId,
            immediate: true,
          });
          setLivePhase(localeIsEn() ? 'Permission' : '工具授权', task.title);
        } else {
          pushLiveEvent({
            kind: 'status',
            title: localeIsEn() ? `Perm · ${task.title}` : `授权 · ${task.title}`,
            sub: localeIsEn() ? 'Waiting in Inbox' : '等待 Inbox 处理',
            projectId: task.projectId,
            immediate: true,
          });
        }
        return;
      }
      if (d.requestId != null) {
        window.GrokInbox?.removeMatching?.({
          kind: 'permission',
          taskId: task.id,
          requestId: d.requestId,
        });
      }
      if (!isActiveTask(task)) return;
      const en = localeIsEn();
      let sub;
      if (d.mode === 'auto') {
        sub = `${en ? 'auto' : '自动'} · ${d.selected || '?'}`;
      } else if (d.mode === 'standing') {
        sub = `${en ? 'standing grant' : '本回合记忆'} · ${d.selected || '?'}`;
      } else if (d.mode === 'no-allow-option') {
        sub = en ? 'no allow option · cancelled' : '无 allow 选项 · 已取消';
      } else {
        sub = d.selected || d.mode || 'done';
      }
      pushLiveEvent({
        kind: 'status',
        title: en ? 'Permission' : '权限',
        sub,
        projectId: task.projectId,
      });
    }),
    window.grok.on('agent:plan_approval', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      if (d.pending) {
        showPlanApprovalBar(task, d);
        if (isActiveTask(task)) {
          pushLiveEvent({
            kind: 'status',
            title: '计划待审批',
            sub: localeIsEn()
              ? 'Approve · request changes · quit (CLI exit_plan_mode)'
              : '批准执行 · 要求修改 · 放弃（对齐 CLI exit_plan_mode）',
            projectId: task.projectId,
            immediate: true,
          });
          setLivePhase('计划审批', task.title);
        } else {
          // Non-active task: still surface in Live + badge via Inbox
          pushLiveEvent({
            kind: 'status',
            title: localeIsEn() ? `Plan · ${task.title}` : `计划 · ${task.title}`,
            sub: localeIsEn() ? 'Waiting in Inbox' : '等待 Inbox 处理',
            projectId: task.projectId,
            immediate: true,
          });
        }
      } else {
        if (d.requestId != null) {
          window.GrokInbox?.removeMatching?.({
            kind: 'plan',
            taskId: task.id,
            requestId: d.requestId,
          });
        } else {
          window.GrokInbox?.removeMatching?.({ kind: 'plan', taskId: task.id });
        }
        if (d.mode === 'auto' && isActiveTask(task)) {
          pushLiveEvent({
            kind: 'status',
            title: '计划已自动批准',
            sub: d.selected || 'approved',
            projectId: task.projectId,
          });
        }
      }
    }),
    window.grok.on('agent:user_question', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      if (d.pending) {
        showUserQuestionBar(task, d);
        if (isActiveTask(task)) {
          const n = Array.isArray(d.questions) ? d.questions.length : 0;
          pushLiveEvent({
            kind: 'status',
            title: localeIsEn() ? 'Question for you' : '需要你回答',
            sub: localeIsEn()
              ? `${n} question(s) · CLI ask_user_question`
              : `${n} 个问题 · 对齐 CLI ask_user_question`,
            projectId: task.projectId,
            immediate: true,
          });
          setLivePhase(localeIsEn() ? 'User question' : '用户提问', task.title);
        } else {
          pushLiveEvent({
            kind: 'status',
            title: localeIsEn() ? `Ask · ${task.title}` : `提问 · ${task.title}`,
            sub: localeIsEn() ? 'Waiting in Inbox' : '等待 Inbox 处理',
            projectId: task.projectId,
            immediate: true,
          });
        }
      } else {
        if (d.requestId != null) {
          window.GrokInbox?.removeMatching?.({
            kind: 'question',
            taskId: task.id,
            requestId: d.requestId,
          });
        } else {
          window.GrokInbox?.removeMatching?.({ kind: 'question', taskId: task.id });
        }
        if (isActiveTask(task)) {
          pushLiveEvent({
            kind: 'status',
            title: localeIsEn() ? 'Question auto-cancelled' : '问题已自动取消',
            sub: d.selected || 'cancelled',
            projectId: task.projectId,
          });
        }
      }
    }),
    window.grok.on('agent:ext', (d) => {
      const task = taskFromEvent(d);
      if (!isActiveTask(task) || !d?.kind) return;
      // Low-noise: only surface interesting kinds
      if (/retry|compact|goal|subagent|recovery|hook/i.test(d.kind)) {
        pushLiveEvent({
          kind: 'status',
          title: `ext · ${d.kind}`,
          sub: String(d.preview || '').slice(0, 100),
          projectId: task.projectId,
        });
      }
    }),
    window.grok.on('agent:usage', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      task.lastUsage = d.usage || null;
      if (isActiveTask(task) && d.usage) {
        const brief = formatUsageBrief(d.usage);
        if (brief) setLivePhase('usage', brief);
      }
    }),
    window.grok.on('agent:error', (d) => {
      const task = taskFromEvent(d);
      if (task) {
        setTaskPhase(task, 'error', d.error || 'error');
        withTask(task, () => {
          if (task.liveAssistantEl || task.streamBuf) {
            const prev = task.streamBuf ? task.streamBuf + '\n\n' : '';
            upsertAssistant(prev + `⚠ ${d.error}`, true, task);
          } else {
            appendMessage('assistant', `⚠ ${d.error}`, {}, task);
          }
        });
      }
      pushLiveEvent({
        kind: 'error',
        title: 'Error',
        sub: d.error,
        projectId: task?.projectId,
      });
      if (isActiveTask(task)) {
        setLivePhase('出错', d.error);
        setAgentStatus('出错', false, true);
      }
    }),
    window.grok.on('agent:done', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      const proj = window.ProjectStore.get(task.projectId);
      if (d?.text && d.text.length > (task.streamBuf || '').length) {
        task.streamBuf = d.text;
      }
      if (typeof d?.thought === 'string' && d.thought.length > (task.thoughtBuf || '').length) {
        task.thoughtBuf = d.thought;
      }
      if (d?.sessionId) task.sessionId = d.sessionId;
      if (d?.usage) task.lastUsage = d.usage;
      // Always paint whatever we have so a finished turn never looks blank
      if (task.streamBuf) upsertAssistant(task.streamBuf, true, task);
      if (task.thoughtBuf) upsertThought(task.thoughtBuf, false, task);
      flushStreamPaint(task);
      // User stop: leave finalize / stop-bar to runTaskPrompt stopped branch
      if (d?.stopped || task.stopRequested) {
        task.phase = 'stopped';
        task.phaseDetail = '';
        // Do not set running=false here if runTaskPrompt still awaiting — it will
        // but if stop raced after await, safe to clear
        if (task.running) {
          /* runTaskPrompt owns finalize */
        }
        renderTaskTabs();
        return;
      }
      finalizeLiveMessages(task);
      clearLiveStreamMirrors();
      task.running = false;
      task.phase = 'done';
      task.phaseDetail = '';
      const fileCount = proj?.changes?.size || 0;
      const usageBit = formatUsageBrief(d?.usage || task.lastUsage);
      pushLiveEvent({
        kind: 'done',
        title: `${task.title} 完成`,
        sub: `${task.toolCount} tools · ${fileCount} files${usageBit ? ` · ${usageBit}` : ''}`,
        projectId: task.projectId,
      });
      renderTaskTabs();
      renderProjectTabs();
      const nRun = window.TaskStore.countRunningAll
        ? window.TaskStore.countRunningAll()
        : window.TaskStore.countRunning();
      if (isActiveTask(task)) {
        setRunningUi(false);
        setLivePhase(
          nRun > 0 ? `${nRun} 个任务运行中` : '完成',
          usageBit || (fileCount ? `捕获 ${fileCount} 个文件变更` : '无文件变更')
        );
        if (nRun === 0) setAgentStatus('待命', false);
        scheduleTreeRefresh(true);
      }
      notifyFlightComplete(task, {
        files: fileCount,
        tools: task.toolCount || 0,
        mode: task.turnMode || 'cli',
      });
    }),
    window.grok.on('fs:changed', (d) => onFsChanged(d)),
  ];
}

/** 在指定任务上下文执行（临时切换 active 仅用于 DOM 定位时，直接传 task 更安全） */
function withTask(task, fn) {
  return fn(task);
}

function summarizeToolSub(name, args = {}) {
  if (window.GrokHumanize?.formatLine) {
    const line = window.GrokHumanize.humanizeTool(name, args, { en: localeIsEn() });
    const s = window.GrokHumanize.formatLine(line);
    if (s) return s.slice(0, 140);
  }
  if (args.command) return String(args.command).slice(0, 120);
  if (args.query) return String(args.query).slice(0, 80);
  if (args.path || args.file_path || args.target_file) {
    return args.path || args.file_path || args.target_file;
  }
  try {
    return JSON.stringify(args).slice(0, 100);
  } catch {
    return '';
  }
}

/** Human one-liner for tool cards / Live titles */
function humanToolTitle(name, args = {}) {
  if (window.GrokHumanize?.formatLine) {
    return window.GrokHumanize.formatLine(
      window.GrokHumanize.humanizeTool(name, args, { en: localeIsEn() })
    );
  }
  return name || 'tool';
}

function scheduleStreamPaint(task) {
  task = task || T();
  if (!task) return;
  // Fair multi-task scheduler (active ~60fps, bg ~7fps, max 2 paints/frame)
  StreamFair.markStream(task);
}

function scheduleThoughtPaint(task) {
  task = task || T();
  if (!task) return;
  StreamFair.markThought(task);
}

function flushStreamPaint(task) {
  task = task || T();
  if (!task) return;
  StreamFair.flushTask(task);
  if (task.thoughtBuf) upsertThought(task.thoughtBuf, false, task);
  if (task._phaseTabRaf) {
    cancelAnimationFrame(task._phaseTabRaf);
    task._phaseTabRaf = null;
  }
}

let treeRefreshTimer = null;
function scheduleTreeRefresh(immediate = false) {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(
    async () => {
      await loadTree();
      if ((P() && P().currentFile)) {
        try {
          const data = await window.grok.readFile(pid(), (P() && P().currentFile));
          if (!data.error && !(P() && P().dirty)) {
            $('#editor').value = data.content;
            syncGutter();
            updateEditorChrome();
          }
        } catch {
          /* ignore */
        }
      }
    },
    immediate ? 200 : 800
  );
}

async function sendPrompt(opts = {}) {
  if (!P()) {
    toast(t('chat.needProject', '请先添加项目（可多开并行）'), 'err');
    openProjectFlow();
    return;
  }
  ensureAtLeastOneTask();
  const task = T();
  if (!task) return;
  if (task.running) {
    toast(t('chat.busy', '当前任务正在运行 — 可开新任务或切换到其他项目'), 'err');
    return;
  }

  let text = $('#prompt').value.trim();
  const attachNote = buildAttachmentContextNote();
  if (attachNote) {
    text = text ? `${attachNote}\n\n${text}` : attachNote;
  }
  if (!text) return;
  await runTaskPrompt(task, text, { fromComposer: true, forceCraft: Boolean(opts.forceCraft) });
  clearAttachments();
}

/**
 * 执行任务提示（支持重试 / 跳过 resume / 单次 Craft）
 * @param {object} task
 * @param {string} text
 * @param {{ fromComposer?: boolean, skipResume?: boolean, resetSession?: boolean, forceCraft?: boolean, workMode?: string }} opts
 */
async function runTaskPrompt(task, text, opts = {}) {
  if (!task || !text) return;
  if (task.running) {
    toast(t('chat.busy', '当前任务正在运行'), 'err');
    return;
  }

  const cfg = await window.grok.getConfig();
  if (!P()) {
    appendMessage('assistant', t('chat.needProject'), {}, task);
    toast(t('chat.needProject'), 'err');
    return;
  }
  if (!cfg.cli?.ok) {
    appendMessage(
      'assistant',
      t('chat.cliMissing'),
      {},
      task
    );
    openSettings();
    window.GrokSettingsExtra?.runDoctorUi?.();
    return;
  }

  const welcome = task.pane.querySelector('.welcome');
  if (welcome) welcome.remove();

  // 用首条消息命名任务
  if (task.title.startsWith('任务 ')) {
    const named = window.TaskStore.titleFromPrompt(text);
    if (named) task.title = named;
  }

  if (opts.fromComposer) {
    $('#prompt').value = '';
    autoResizePrompt();
    updateCharCount();
    clearPromptDraft(task);
  }

  // CLI owns plan/normal/yolo — host always tags turn as "cli"
  const modeUsed = 'cli';

  // 重试时不重复追加相同 user 消息
  const lastUser = [...(task.messages || [])].reverse().find((m) => m.role === 'user');
  const skipUserAppend = opts.skipResume || opts.isRetry;
  if (!skipUserAppend || !lastUser || lastUser.content !== text) {
    appendMessage('user', text, { persist: true }, task);
  }

  const proj = P();
  const filesBefore = proj?.changes?.size || 0;

  task.lastPrompt = text;
  task.running = true;
  task.stopRequested = Boolean(opts.isStopCleanup);
  task.phase = 'boot';
  task.phaseDetail = 'booting CLI…';
  task.turnId = `turn-${Date.now()}`;
  task.streamBuf = '';
  task.thoughtBuf = '';
  task.lastUsage = null;
  task.liveAssistantEl = null;
  task.liveThoughtEl = null;
  task.toolCount = 0;
  task.writeCount = 0;
  task._hasToolThisTurn = false;
  task.turnMode = modeUsed;
  task.lastError = null;
  if (!Array.isArray(task.turns)) task.turns = [];
  task.turns.push({
    id: task.turnId,
    mode: modeUsed,
    prompt: String(text || '').slice(0, 500),
    startedAt: Date.now(),
    continueFrom: Boolean(opts.isContinue),
  });
  if (task.turns.length > 40) task.turns = task.turns.slice(-40);
  // Remove prior action bars for a clean turn
  task.pane?.querySelectorAll?.('.retry-bar, .stop-bar, .turn-marker-pending')?.forEach((el) => el.remove());
  if (!opts.skipTurnMarker) {
    appendTurnMarker(task, {
      mode: modeUsed,
      prompt: text,
      continueFrom: Boolean(opts.isContinue),
      retry: Boolean(opts.isRetry),
    });
  }
  setRunningUi(true);
  {
    const st = MODE_RUN_STATUS[modeUsed] || MODE_RUN_STATUS.cli;
    setAgentStatus(localeIsEn() ? st.en : st.zh, true);
  }
  startElapsed(task);
  ensureLiveAssistant(task);
  renderTaskTabs();

  if (state.followAgent || state.activeTab === 'live') switchTab('live');
  pushLiveEvent({
    kind: 'status',
    title: `${task.title} ${opts.isRetry ? (localeIsEn() ? 'retry' : '重试') : localeIsEn() ? 'start' : '开始'}`,
    sub: text.slice(0, 100),
  });
  setLivePhase(
    localeIsEn() ? 'grokking…' : 'grokking…',
    `${task.title}: ${text.slice(0, 60)}`
  );
  updateLiveStats();

  const liveTick = setInterval(updateLiveStats, 500);

  try {
    const result = await window.grok.runAgent({
      message: text,
      projectId: pid(),
      taskId: task.id,
      sessionId: opts.resetSession || opts.skipResume ? null : task.sessionId,
      resetSession: Boolean(opts.resetSession),
      skipResume: Boolean(opts.skipResume),
      taskTitle: task.title,
      messages: task.messages || [],
      prevContext: task.context || null,
      contextMode: cfg.contextMode,
      workMode: modeUsed,
      stylePack: cfg.stylePack || 'default',
      turns: task.turns || [],
      changedFiles: [...changesMap().keys()],
      isContinue: Boolean(opts.isContinue),
      lastStopped: Boolean(opts.isContinue || opts.isStopCleanup),
      forceCraft: Boolean(opts.forceCraft),
      fromPlanExecute: Boolean(opts.fromPlanExecute),
      goal: modeUsed === 'goal' || task.goal ? task.goal : null,
    });
    flushStreamPaint(task);
    LiveBatcher.flush();

    const finalText = result?.text || task.streamBuf || '';
    if (result?.sessionId) task.sessionId = result.sessionId;
    if (result?.usage) task.lastUsage = result.usage;
    if (result?.context) {
      task.context = result.context;
      task.contextTiers = result.contextTiers || result.context.tiers;
    }
    if (result?.resumedFallback) {
      toast(t('chat.resumeFallback'), 'ok');
    }
    // Goal track: parse progress from reply
    if ((modeUsed === 'goal' || task.goal) && finalText) {
      updateTaskGoalFromReply(task, finalText);
    }
    // User stop: keep partial stream, offer continue / retry
    if (result?.stopped || task.stopRequested) {
      const partial = finalText || task.streamBuf || '';
      if (partial) {
        task.streamBuf = partial;
        upsertAssistant(partial, true, task);
        if (!Array.isArray(task.messages)) task.messages = [];
        const last = task.messages[task.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.content !== partial) {
          task.messages.push({
            role: 'assistant',
            content: partial,
            ts: Date.now(),
            stopped: true,
          });
        }
      }
      finalizeLiveMessages(task);
      clearLiveStreamMirrors();
      markTurnEnded(task, { stopped: true, tools: task.toolCount || 0 });
      appendStopBar(task, text, { partial: Boolean(partial) });
      pushLiveEvent({
        kind: 'signal',
        title: `${task.title} 已停止`,
        sub: partial ? `已保留 ${partial.length} 字部分输出` : '无文本输出',
        projectId: task.projectId,
      });
      if (isActiveTask(task)) {
        setLivePhase(localeIsEn() ? 'Stopped' : '已停止', task.title);
        setAgentStatus(localeIsEn() ? 'Stopped' : '已停止', false);
      }
      schedulePersist(true);
      return;
    }

    if (finalText) {
      task.streamBuf = finalText;
      upsertAssistant(finalText, true, task);
      if (!Array.isArray(task.messages)) task.messages = [];
      task.messages.push({ role: 'assistant', content: finalText, ts: Date.now() });
    } else {
      upsertAssistant('（无文本输出 — 可能只做了工具操作，请看资源管理器 / Diff）', true, task);
    }
    finalizeLiveMessages(task);
    clearLiveStreamMirrors();
    markTurnEnded(task, {
      stopped: false,
      tools: task.toolCount || 0,
      usage: result?.usage || task.lastUsage,
    });
    // Plan：模式标志 或 回复像可执行方案 → 一键执行条（执行语本身不再弹条）
    const wasExec = isPlanExecutePhrase(text) || opts.fromPlanExecute || opts.forceCraft;
    if (
      !wasExec &&
      finalText &&
      modeUsed !== 'ask' &&
      (modeUsed === 'plan' || looksLikePlan(finalText))
    ) {
      task.lastPlan = finalText;
      appendPlanExecuteBar(task, {
        autoDetected: modeUsed !== 'plan' && looksLikePlan(finalText),
        planText: finalText,
      });
    }
    // Mission summary after CLI turns (and plan-execute flights)
    if (modeUsed === 'cli' || opts.fromPlanExecute) {
      const filesAfter = P()?.changes?.size || 0;
      const filesDelta = Math.max(0, filesAfter - filesBefore);
      appendCraftMissionBar(task, {
        tools: task.toolCount || 0,
        writes: task.writeCount || 0,
        files: filesDelta || filesAfter,
        fromPlan: Boolean(opts.fromPlanExecute),
      });
    }
    // Skills 匹配提示
    showSkillHints(text, task).catch(() => {});
    await refreshTaskContext(task);
    schedulePersist(true);
    if (isActiveTask(task)) renderContextTiers(task);
  } catch (err) {
    const msg = err.message || String(err);
    // Stop can race as error depending on kill timing — treat as stop when requested
    if (task.stopRequested || /已由用户停止|aborted|AbortError/i.test(msg)) {
      const partial = task.streamBuf || '';
      if (partial) {
        finalizeLiveMessages(task);
        if (!Array.isArray(task.messages)) task.messages = [];
        task.messages.push({ role: 'assistant', content: partial, ts: Date.now(), stopped: true });
      }
      markTurnEnded(task, { stopped: true, tools: task.toolCount || 0 });
      appendStopBar(task, text, { partial: Boolean(partial) });
      if (isActiveTask(task)) {
        setLivePhase(localeIsEn() ? 'Stopped' : '已停止', task.title);
        setAgentStatus(localeIsEn() ? 'Stopped' : '已停止', false);
      }
      schedulePersist(true);
      return;
    }
    task.lastError = msg;
    upsertAssistant(t('chat.error', `错误：${msg}`, { msg }), true, task);
    finalizeLiveMessages(task);
    markTurnEnded(task, { error: msg, tools: task.toolCount || 0 });
    appendRetryBar(task, text, msg);
    if (isActiveTask(task)) {
      setAgentStatus(t('live.phase.error', '出错'), false, true);
      setLivePhase(t('live.phase.error', '出错'), msg);
    }
    toast(msg || t('live.phase.error'), 'err');
  } finally {
    clearInterval(liveTick);
    const wasStopped = task.stopRequested || task.phase === 'stopped';
    task.running = false;
    task.stopRequested = false;
    if (task.phase !== 'error' && task.phase !== 'stopped') task.phase = 'idle';
    if (wasStopped) task.phase = 'stopped';
    task.phaseDetail = '';
    task.liveAssistantEl = null;
    task.liveThoughtEl = null;
    stopElapsed(task);
    renderTaskTabs();
    schedulePersist(true);
    if (isActiveTask(task)) {
      setRunningUi(false);
      $('#livePulse')?.classList.toggle('on', anyRunning());
      $('#liveBadge')?.classList.toggle('hidden', !anyRunning());
      if (!$('#agentStatus').classList.contains('error')) {
        if (wasStopped) {
          setAgentStatus(localeIsEn() ? 'Stopped' : '已停止', false);
        } else {
          setAgentStatus(localeIsEn() ? 'Ready' : '待命', false);
        }
        if ($('#livePhase')?.textContent !== t('live.phase.error', '出错')) {
          const r = window.TaskStore.countRunning();
          if (wasStopped && r === 0) {
            setLivePhase(
              localeIsEn() ? 'Stopped' : '已停止',
              localeIsEn() ? 'Continue or retry from the bar above' : '可从上方操作条续跑 / 重试'
            );
          } else {
            setLivePhase(
              r > 0 ? t('live.running', `${r} 个任务运行中`, { n: r }) : t('live.idle', '待命'),
              changesMap().size
                ? t('live.changes.hint', `累计 ${changesMap().size} 文件变更 · 去 Diff`, {
                    n: changesMap().size,
                  })
                : r > 0
                  ? t('live.running', `${r} 个任务运行中`, { n: r })
                  : t('live.readyNext', '准备下一条 / 开新任务并行')
            );
          }
        }
      }
    }
    renderTaskTabs();
    updateLiveStats();
    scheduleTreeRefresh(true);
  }
}

/** CLI 回合后：任务简报（工具 / 写入 / Diff 文件） */
function appendCraftMissionBar(task, stats = {}) {
  if (!task?.pane) return;
  const tools = Number(stats.tools) || 0;
  const writes = Number(stats.writes) || 0;
  const files = Number(stats.files) || 0;
  if (tools === 0 && writes === 0 && files === 0) return;
  task.pane.querySelectorAll('.craft-mission-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'craft-mission-bar' + (stats.fromPlan ? ' from-plan' : '');
  const en = localeIsEn();
  bar.innerHTML = `
    <span class="craft-mission-label">${stats.fromPlan ? 'PLAN→EXEC' : 'MISSION'}</span>
    <span class="craft-mission-stats">
      <span class="cms">${tools} ${en ? 'tools' : '工具'}</span>
      <span class="cms">${writes} ${en ? 'writes' : '写入'}</span>
      <span class="cms">${files} ${en ? 'files in Diff' : 'Diff 文件'}</span>
    </span>
    <div class="retry-actions">
      <button type="button" class="btn small ghost" data-act="diff">${en ? 'Open Diff' : '打开 Diff'}</button>
      <button type="button" class="btn small ghost" data-act="dismiss">OK</button>
    </div>`;
  bar.querySelector('[data-act="diff"]').onclick = () => {
    if (typeof switchTab === 'function') switchTab('diff');
  };
  bar.querySelector('[data-act="dismiss"]').onclick = () => bar.remove();
  task.pane.appendChild(bar);
  scrollMessages(true, task);
}

/** Shared with modes.js heuristics (browser copy — keep in sync with electron/modes.js) */
function isPlanExecutePhrase(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (
    /^(执行|开干|按方案|按方案做|按方案执行|implement|execute|do it|lgtm|开搞|动手|开始改|开始实现|go|ship it|run it)[\s!！。.~]*$/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /^(执行方案|执行计划|implement the plan|execute the plan|start implementing)/i.test(t) ||
    /^(请)?(开始)?(执行|实现|落地).{0,24}(方案|计划|plan)/i.test(t)
  ) {
    return true;
  }
  return false;
}

function buildPlanExecutePrompt(planText) {
  const plan = String(planText || '').trim();
  const cap = 7000;
  const body = plan.length > cap ? plan.slice(0, cap) + '\n…' : plan;
  const en = localeIsEn();
  if (en) {
    if (!body) {
      return 'Execute the plan from your previous message. Implement step by step, skip finished items, keep changes focused, then verify.';
    }
    return (
      'Execute this plan now. Implement remaining steps; do not re-plan unless blocked.\n\n' +
      '—— PLAN ——\n' +
      body +
      '\n—— END PLAN ——\n\n' +
      'Work through the steps and summarize what changed + how to verify.'
    );
  }
  if (!body) {
    return '执行方案：按你上一条给出的步骤动手实现，跳过已完成项，保持聚焦，改完做必要检查。';
  }
  return (
    '执行下列方案。按步骤落地；已完成的跳过；缺信息再问；改完做必要检查。\n\n' +
    '—— 方案 ——\n' +
    body +
    '\n—— 方案结束 ——\n\n' +
    '动手改代码；结束后用 2–5 行说明改了什么、怎么验。'
  );
}

/** Plan / 自动识别方案：确认后一键执行（注入方案原文；不切换宿主伪模式） */
function appendPlanExecuteBar(task, opts = {}) {
  if (!task?.pane) return;
  task.pane.querySelectorAll('.plan-exec-bar').forEach((el) => el.remove());
  const en = localeIsEn();
  const planText = opts.planText || task.lastPlan || '';
  task.lastPlan = planText || task.lastPlan || '';
  const bar = document.createElement('div');
  bar.className = 'plan-exec-bar' + (opts.autoDetected ? ' plan-exec-auto' : '');
  const hint = opts.autoDetected
    ? en
      ? 'Plan-like reply detected · confirm to execute'
      : '检测到方案结构 · 确认后执行'
    : en
      ? 'Plan ready · confirm to execute'
      : '方案已就绪 · 确认后执行';
  const preview = oneLinePlanPreview(planText);
  bar.innerHTML = `
    <div class="plan-exec-main">
      <span class="plan-exec-hint">${esc(hint)}</span>
      ${preview ? `<span class="plan-exec-preview" title="${esc(planText.slice(0, 400))}">${esc(preview)}</span>` : ''}
    </div>
    <div class="retry-actions">
      <button type="button" class="btn small primary" data-act="exec">▶ ${en ? 'Execute' : '执行方案'}</button>
      <button type="button" class="btn small ghost" data-act="refine">${en ? 'Refine' : '调整方案'}</button>
      <button type="button" class="btn small ghost" data-act="dismiss">${en ? 'Later' : '稍后'}</button>
    </div>`;
  bar.querySelector('[data-act="exec"]').onclick = () => {
    bar.remove();
    // Do not switch host "modes" — send plain execute request; CLI owns plan tools
    const execText = en
      ? 'Please implement the plan above step by step.'
      : '请按上面的方案逐步实现。';
    const prompt = document.getElementById('prompt');
    if (prompt) {
      prompt.value = '';
      autoResizePrompt();
      updateCharCount();
    }
    runTaskPrompt(task, execText, { fromComposer: false });
  };
  bar.querySelector('[data-act="refine"]').onclick = () => {
    const prompt = document.getElementById('prompt');
    if (prompt) {
      prompt.value = en
        ? 'Revise the plan: '
        : '请调整方案：';
      autoResizePrompt();
      updateCharCount();
      prompt.focus();
    }
  };
  bar.querySelector('[data-act="dismiss"]').onclick = () => bar.remove();
  task.pane.appendChild(bar);
  scrollMessages(true, task);
}

function oneLinePlanPreview(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // Prefer first numbered step
  const m = t.match(/(?:^|\s)(?:1[\.)、]|一[、.)])\s*([^\n]{8,80})/);
  if (m) return (localeIsEn() ? '1. ' : '1. ') + m[1].trim();
  return t.slice(0, 72) + (t.length > 72 ? '…' : '');
}

/**
 * ACP x.ai/exit_plan_mode — interactive approve / revise / abandon
 * (matches open-source grok-build pager plan_approval_view outcomes).
 * Also mirrors into global Inbox for cross-task attention.
 */
function showPlanApprovalBar(task, d) {
  task = task || T();
  if (!task?.pane || !d?.requestId) return;
  const en = localeIsEn();
  const proj = window.ProjectStore?.get?.(task.projectId);
  // Global inbox (OpenWorker-style attention queue)
  window.GrokInbox?.upsert?.({
    kind: 'plan',
    taskId: task.id,
    projectId: task.projectId || pid(),
    requestId: d.requestId,
    taskTitle: task.title || '',
    projectName: proj?.name || '',
    title: en ? 'Plan approval' : '计划审批',
    body: String(d.planContent || ''),
    meta: { sessionId: d.sessionId || '' },
  });
  // Replace existing bar for this task
  task.pane.querySelectorAll('.plan-approval-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'plan-approval-bar msg status';
  bar.dataset.requestId = String(d.requestId);
  const body = String(d.planContent || '').trim();
  const preview = body
    ? esc(body.slice(0, 1200)) + (body.length > 1200 ? '\n…' : '')
    : en
      ? '(No plan content — agent exited plan mode empty)'
      : '（无计划正文 — agent 未写入 plan）';
  bar.innerHTML = `
    <div class="plan-approval-head">
      <strong>${en ? 'Plan approval' : '计划审批'}</strong>
      <span class="muted">${en ? 'CLI exit_plan_mode' : '对齐 CLI · exit_plan_mode'}</span>
    </div>
    <pre class="plan-approval-body">${preview}</pre>
    <label class="plan-approval-feedback">
      <span>${en ? 'Feedback (optional, for request changes)' : '修改意见（可选，用于「要求修改」）'}</span>
      <input type="text" class="plan-feedback-input" placeholder="${en ? 'What should change…' : '希望如何调整…'}" />
    </label>
    <div class="retry-actions plan-exec-tiers">
      <button type="button" class="btn small primary" data-act="approve-yolo" title="${en ? 'Approve plan; auto-allow tool options for this flight' : '批准计划；本回合工具自动允许（CLI option）'}">✓ ${en ? 'Approve · YOLO tools' : '批准 · YOLO 工具'}</button>
      <button type="button" class="btn small ghost" data-act="approve-ask" title="${en ? 'Approve plan; each tool parks for your pick from CLI options' : '批准计划；后续工具逐次弹出 CLI 选项'}">✓ ${en ? 'Approve · ask tools' : '批准 · 工具逐次确认'}</button>
      <button type="button" class="btn small ghost" data-act="revise">✎ ${en ? 'Request changes' : '要求修改'}</button>
      <button type="button" class="btn small ghost" data-act="quit">✕ ${en ? 'Quit plan' : '放弃计划'}</button>
    </div>`;
  const send = async (outcome, execTier) => {
    const inboxId = window.GrokInbox?.itemId?.('plan', task.id, d.requestId);
    // Shared lock with Inbox drawer — no double RPC to ACP
    if (inboxId && window.GrokInbox?.isResolving?.(inboxId)) {
      toast(en ? 'Already resolving…' : '正在处理，请勿重复点击', 'err');
      return;
    }
    if (inboxId && window.GrokInbox?.tryBeginResolve && !window.GrokInbox.tryBeginResolve(inboxId)) {
      toast(en ? 'Already resolving…' : '正在处理，请勿重复点击', 'err');
      return;
    }
    const feedback = bar.querySelector('.plan-feedback-input')?.value || '';
    bar.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      const r = await window.grok.replyPlanApproval({
        projectId: task.projectId || pid(),
        taskId: task.id,
        requestId: d.requestId,
        outcome,
        feedback: outcome === 'cancelled' ? feedback || undefined : undefined,
        execTier: outcome === 'approved' ? execTier : undefined,
      });
      if (!r?.ok) {
        if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
        toast(r?.error || 'plan reply failed', 'err');
        bar.querySelectorAll('button').forEach((b) => {
          b.disabled = false;
        });
        return;
      }
      bar.remove();
      window.GrokInbox?.removeMatching?.({
        kind: 'plan',
        taskId: task.id,
        requestId: d.requestId,
      });
      const tierNote =
        outcome === 'approved' && execTier === 'ask'
          ? en
            ? ' · tools will ask'
            : ' · 工具将逐次确认'
          : outcome === 'approved' && execTier === 'yolo'
            ? en
              ? ' · YOLO tools'
              : ' · YOLO 工具'
            : '';
      toast(
        outcome === 'approved'
          ? en
            ? `Plan approved${tierNote}`
            : `已批准计划${tierNote}`
          : outcome === 'abandoned'
            ? en
              ? 'Plan abandoned'
              : '已放弃计划'
            : en
              ? 'Requested plan changes'
              : '已要求修改计划',
        'ok'
      );
    } catch (err) {
      if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
      toast(err.message || String(err), 'err');
      bar.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
  };
  bar.querySelector('[data-act="approve-yolo"]').onclick = () => send('approved', 'yolo');
  bar.querySelector('[data-act="approve-ask"]').onclick = () => send('approved', 'ask');
  bar.querySelector('[data-act="revise"]').onclick = () => send('cancelled');
  bar.querySelector('[data-act="quit"]').onclick = () => send('abandoned');
  task.pane.appendChild(bar);
  scrollMessages(true, task);
  window.GrokA11y?.presentInteractive?.(
    bar,
    en ? 'Plan approval required' : '需要计划审批',
    { assertive: true, focus: isActiveTask(task) }
  );
}

/**
 * ACP session/request_permission — park when YOLO off / plan "ask tools".
 * Only shows optionIds returned by the CLI (never invent).
 */
function showPermissionBar(task, d) {
  task = task || T();
  if (!task?.pane || !d?.requestId) return;
  const en = localeIsEn();
  const options = Array.isArray(d.options) ? d.options : [];
  const proj = window.ProjectStore?.get?.(task.projectId);
  const human = window.GrokHumanize?.formatLine?.(
    window.GrokHumanize.humanizeApproval?.(d.toolName || d.toolTitle || 'tool', d.toolArgs || {}, {
      en,
    })
  );
  const title = human || d.toolTitle || d.toolName || (en ? 'Tool permission' : '工具授权');
  window.GrokInbox?.upsert?.({
    kind: 'permission',
    taskId: task.id,
    projectId: task.projectId || pid(),
    requestId: d.requestId,
    taskTitle: task.title || '',
    projectName: proj?.name || '',
    title,
    body: summarizeToolSub(d.toolName, d.toolArgs || {}),
    meta: { options, toolName: d.toolName, toolArgs: d.toolArgs },
  });
  task.pane.querySelectorAll('.permission-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'permission-bar msg status';
  bar.dataset.requestId = String(d.requestId);
  const optBtns = options
    .map((o, i) => {
      const id = esc(o.optionId || '');
      const label = esc(o.name || o.optionId || `opt ${i + 1}`);
      const isAllow = /allow|approve|yes|ok/i.test(String(o.optionId) + ' ' + String(o.name));
      const isDeny = /reject|deny|cancel|no\b/i.test(String(o.optionId) + ' ' + String(o.name));
      const cls = isAllow ? 'btn small primary' : isDeny ? 'btn small ghost' : 'btn small ghost';
      return `<button type="button" class="${cls}" data-opt="${id}" title="${id}">${label}</button>`;
    })
    .join('');
  let argsPreview = '';
  try {
    argsPreview = JSON.stringify(summarizeArgs(d.toolName, d.toolArgs || {}), null, 0);
  } catch {
    argsPreview = '';
  }
  bar.innerHTML = `
    <div class="permission-head">
      <strong>${en ? 'Tool permission' : '工具授权'}</strong>
      <span class="muted">${en ? 'CLI request_permission' : '对齐 CLI · request_permission'}</span>
    </div>
    <div class="permission-title">${esc(title)}</div>
    ${argsPreview ? `<div class="permission-args muted">${esc(argsPreview)}</div>` : ''}
    <label class="permission-remember">
      <input type="checkbox" class="perm-remember-cb" checked />
      <span>${en ? 'Remember for this flight (same tool + CLI optionId only)' : '本回合记住此工具选择（仅 CLI optionId）'}</span>
    </label>
    <div class="retry-actions permission-opts">
      ${optBtns || `<span class="muted">${en ? 'No options from CLI' : 'CLI 未返回选项'}</span>`}
      <button type="button" class="btn small ghost" data-act="cancel">✕ ${en ? 'Cancel' : '取消'}</button>
    </div>`;
  const send = async (payload) => {
    const inboxId = window.GrokInbox?.itemId?.('permission', task.id, d.requestId);
    if (inboxId && window.GrokInbox?.isResolving?.(inboxId)) {
      toast(en ? 'Already resolving…' : '正在处理，请勿重复点击', 'err');
      return;
    }
    if (inboxId && window.GrokInbox?.tryBeginResolve && !window.GrokInbox.tryBeginResolve(inboxId)) {
      toast(en ? 'Already resolving…' : '正在处理，请勿重复点击', 'err');
      return;
    }
    const remember = Boolean(bar.querySelector('.perm-remember-cb')?.checked);
    bar.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      const r = await window.grok.replyPermission({
        projectId: task.projectId || pid(),
        taskId: task.id,
        requestId: d.requestId,
        remember: payload.cancelled ? false : remember,
        ...payload,
      });
      if (!r?.ok) {
        if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
        toast(r?.error || 'permission reply failed', 'err');
        bar.querySelectorAll('button').forEach((b) => {
          b.disabled = false;
        });
        return;
      }
      bar.remove();
      window.GrokInbox?.removeMatching?.({
        kind: 'permission',
        taskId: task.id,
        requestId: d.requestId,
      });
      const mem =
        r.remembered || (remember && !payload.cancelled)
          ? en
            ? ' · remembered'
            : ' · 已记住'
          : '';
      toast(
        payload.cancelled
          ? en
            ? 'Permission cancelled'
            : '已取消授权'
          : en
            ? `Allowed · ${payload.optionId || payload.selected || ''}${mem}`
            : `已允许 · ${payload.optionId || payload.selected || ''}${mem}`,
        'ok'
      );
    } catch (err) {
      if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
      toast(err.message || String(err), 'err');
      bar.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
  };
  bar.querySelectorAll('[data-opt]').forEach((btn) => {
    btn.onclick = () => send({ optionId: btn.dataset.opt });
  });
  bar.querySelector('[data-act="cancel"]').onclick = () => send({ cancelled: true });
  task.pane.appendChild(bar);
  scrollMessages(true, task);
  window.GrokA11y?.presentInteractive?.(
    bar,
    en ? 'Tool permission required' : '需要工具授权',
    { assertive: true, focus: isActiveTask(task) }
  );
}

/**
 * ACP x.ai/ask_user_question — multi-choice questionnaire
 * (matches open-source grok-build AskUserQuestionExtResponse).
 * outcomes: accepted | chat_about_this | skip_interview | cancelled
 */
function showUserQuestionBar(task, d) {
  task = task || T();
  if (!task?.pane || !d?.requestId) return;
  const en = localeIsEn();
  const questions = Array.isArray(d.questions) ? d.questions : [];
  const isPlan = String(d.mode || '').toLowerCase() === 'plan';
  const modeLabel = isPlan
    ? en
      ? 'plan interview'
      : '计划访谈'
    : en
      ? 'default'
      : '常规';
  const proj = window.ProjectStore?.get?.(task.projectId);
  const firstQ = questions[0]?.question || '';
  window.GrokInbox?.upsert?.({
    kind: 'question',
    taskId: task.id,
    projectId: task.projectId || pid(),
    requestId: d.requestId,
    taskTitle: task.title || '',
    projectName: proj?.name || '',
    title: en ? `Agent asks · ${modeLabel}` : `Agent 提问 · ${modeLabel}`,
    body: firstQ,
    meta: { mode: d.mode, questions, sessionId: d.sessionId || '' },
  });
  task.pane.querySelectorAll('.user-question-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'user-question-bar msg status';
  bar.dataset.requestId = String(d.requestId);

  const blocks = questions
    .map((q, qi) => {
      const qText = esc(String(q.question || '').trim() || `(Q${qi + 1})`);
      const multi = Boolean(q.multiSelect);
      const opts = Array.isArray(q.options) ? q.options : [];
      const optHtml = opts
        .map((o, oi) => {
          const label = esc(o.label || '');
          const desc = o.description ? `<span class="uq-opt-desc">${esc(o.description)}</span>` : '';
          const prev = o.preview
            ? `<pre class="uq-opt-preview">${esc(String(o.preview).slice(0, 800))}</pre>`
            : '';
          const type = multi ? 'checkbox' : 'radio';
          const name = multi ? `uq-${qi}-o${oi}` : `uq-${qi}`;
          return `<label class="uq-option">
            <input type="${type}" name="${name}" data-q="${qi}" data-label="${escAttr(o.label || '')}" data-preview="${escAttr(String(o.preview || '').slice(0, 500))}" />
            <span class="uq-opt-main"><strong>${label}</strong>${desc}</span>
            ${prev}
          </label>`;
        })
        .join('');
      // Upstream always offers freeform "Other"
      const other = `<label class="uq-option uq-other">
          <input type="${multi ? 'checkbox' : 'radio'}" name="${multi ? `uq-${qi}-other` : `uq-${qi}`}" data-q="${qi}" data-label="Other" data-other="1" />
          <span class="uq-opt-main"><strong>${en ? 'Other' : '其他'}</strong>
            <span class="uq-opt-desc">${en ? 'Type your own answer' : '自行填写'}</span>
          </span>
        </label>
        <input type="text" class="uq-other-input" data-q="${qi}" placeholder="${en ? 'Your answer…' : '你的回答…'}" />`;
      const notes = `<label class="uq-notes">
          <span>${en ? 'Notes (optional)' : '备注（可选）'}</span>
          <input type="text" class="uq-notes-input" data-q="${qi}" placeholder="${en ? 'Extra context…' : '补充说明…'}" />
        </label>`;
      return `<div class="uq-block" data-qi="${qi}" data-question="${escAttr(q.question || '')}" data-multi="${multi ? '1' : '0'}">
        <div class="uq-qtext">${qi + 1}. ${qText}${multi ? ` <span class="muted">(${en ? 'multi' : '多选'})</span>` : ''}</div>
        <div class="uq-options">${optHtml}${other}</div>
        ${notes}
      </div>`;
    })
    .join('');

  bar.innerHTML = `
    <div class="user-question-head">
      <strong>${en ? 'Agent asks' : 'Agent 提问'}</strong>
      <span class="muted">${en ? 'CLI ask_user_question' : '对齐 CLI · ask_user_question'} · ${modeLabel}</span>
    </div>
    <div class="user-question-body">${blocks || `<p class="muted">${en ? 'No questions in payload' : '无问题内容'}</p>`}</div>
    <div class="retry-actions">
      <button type="button" class="btn small primary" data-act="accept">✓ ${en ? 'Submit answers' : '提交回答'}</button>
      ${
        isPlan
          ? `<button type="button" class="btn small ghost" data-act="chat">💬 ${en ? 'Chat about this' : '继续讨论'}</button>
             <button type="button" class="btn small ghost" data-act="skip">⏭ ${en ? 'Skip interview' : '跳过访谈'}</button>`
          : ''
      }
      <button type="button" class="btn small ghost" data-act="cancel">✕ ${en ? 'Cancel' : '取消'}</button>
    </div>`;

  function collectAnswers(partialOnly) {
    const answers = {};
    const annotations = {};
    bar.querySelectorAll('.uq-block').forEach((block) => {
      const qText = block.dataset.question || '';
      if (!qText) return;
      const multi = block.dataset.multi === '1';
      const selected = [];
      let otherNotes = '';
      let preview = null;
      block.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((inp) => {
        if (!inp.checked) return;
        const lab = inp.dataset.label || '';
        if (inp.dataset.other === '1') {
          selected.push('Other');
          otherNotes = block.querySelector(`.uq-other-input[data-q="${inp.dataset.q}"]`)?.value?.trim() || '';
        } else if (lab) {
          selected.push(lab);
          if (!multi && inp.dataset.preview) preview = inp.dataset.preview;
        }
      });
      const notesExtra = block.querySelector(`.uq-notes-input`)?.value?.trim() || '';
      const notes = [otherNotes, notesExtra].filter(Boolean).join('\n') || null;
      if (selected.length === 0 && !notes) return;
      if (selected.length === 0 && notes) {
        selected.push('Other');
      }
      if (partialOnly) {
        // plan-mode partial paths: single label string, notes dropped
        answers[qText] = selected[0] || 'Other';
      } else {
        answers[qText] = selected;
        if (preview || notes) {
          annotations[qText] = {};
          if (preview) annotations[qText].preview = preview;
          if (notes) annotations[qText].notes = notes;
        }
      }
    });
    return { answers, annotations };
  }

  const send = async (outcome) => {
    const inboxId = window.GrokInbox?.itemId?.('question', task.id, d.requestId);
    if (inboxId && window.GrokInbox?.isResolving?.(inboxId)) {
      toast(en ? 'Already resolving…' : '正在处理，请勿重复点击', 'err');
      return;
    }
    if (inboxId && window.GrokInbox?.tryBeginResolve && !window.GrokInbox.tryBeginResolve(inboxId)) {
      toast(en ? 'Already resolving…' : '正在处理，请勿重复点击', 'err');
      return;
    }
    bar.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    let result = { outcome };
    try {
      if (outcome === 'accepted') {
        const { answers, annotations } = collectAnswers(false);
        if (!Object.keys(answers).length) {
          if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
          toast(en ? 'Pick at least one option' : '请至少选择一个选项', 'err');
          bar.querySelectorAll('button').forEach((b) => {
            b.disabled = false;
          });
          return;
        }
        result = { outcome: 'accepted', answers };
        if (Object.keys(annotations).length) result.annotations = annotations;
      } else if (outcome === 'chat_about_this' || outcome === 'skip_interview') {
        const { answers } = collectAnswers(true);
        result = { outcome, partial_answers: answers };
      } else {
        result = { outcome: 'cancelled' };
      }
      const r = await window.grok.replyUserQuestion({
        projectId: task.projectId || pid(),
        taskId: task.id,
        requestId: d.requestId,
        result,
      });
      if (!r?.ok) {
        if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
        toast(r?.error || 'question reply failed', 'err');
        bar.querySelectorAll('button').forEach((b) => {
          b.disabled = false;
        });
        return;
      }
      bar.remove();
      window.GrokInbox?.removeMatching?.({
        kind: 'question',
        taskId: task.id,
        requestId: d.requestId,
      });
      const msg =
        outcome === 'accepted'
          ? en
            ? 'Answers submitted'
            : '已提交回答'
          : outcome === 'chat_about_this'
            ? en
              ? 'Continue chat'
              : '已选择继续讨论'
            : outcome === 'skip_interview'
              ? en
                ? 'Interview skipped'
                : '已跳过访谈'
              : en
                ? 'Question cancelled'
                : '已取消提问';
      toast(msg, 'ok');
    } catch (err) {
      if (inboxId) window.GrokInbox?.endResolve?.(inboxId);
      toast(err.message || String(err), 'err');
      bar.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
  };

  bar.querySelector('[data-act="accept"]').onclick = () => send('accepted');
  bar.querySelector('[data-act="cancel"]').onclick = () => send('cancelled');
  const chatBtn = bar.querySelector('[data-act="chat"]');
  const skipBtn = bar.querySelector('[data-act="skip"]');
  if (chatBtn) chatBtn.onclick = () => send('chat_about_this');
  if (skipBtn) skipBtn.onclick = () => send('skip_interview');
  task.pane.appendChild(bar);
  scrollMessages(true, task);
  const n = Array.isArray(d.questions) ? d.questions.length : 0;
  window.GrokA11y?.presentInteractive?.(
    bar,
    en
      ? `Agent asks ${n} question${n === 1 ? '' : 's'}`
      : `Agent 提问（${n} 题）`,
    { assertive: true, focus: isActiveTask(task) }
  );
}

/** Escape for HTML attribute values */
function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Heuristic: assistant reply looks like an actionable plan */
function looksLikePlan(text) {
  const t = String(text || '');
  if (t.length < 60) return false;
  let score = 0;
  if (
    /(目标|步骤|涉及文件|风险|实施计划|执行步骤|验收|plan|steps?|risks?|files?\s*(to\s*)?(change|touch|edit)?)/i.test(
      t
    )
  ) {
    score += 2;
  }
  const nums = t.match(/(^|\n)\s*(\d+[\.\)、]|[一二三四五六七八九十]+[、\.\)])\s+\S+/g);
  if (nums && nums.length >= 2) score += 3;
  else if (nums && nums.length === 1) score += 1;
  const bullets = t.match(/(^|\n)\s*[-*•]\s+\S+/g);
  if (bullets && bullets.length >= 3) score += 2;
  if (/(接下来|然后|首先|最后|TODO|实施|改动|建议)/i.test(t)) score += 1;
  if (
    /`[^`]+\.(js|ts|tsx|py|go|rs|java|css|html|md)`/i.test(t) ||
    /[\w./\\-]+\.(js|ts|tsx|py|go|rs)\b/.test(t)
  ) {
    score += 1;
  }
  const codeBlocks = (t.match(/```/g) || []).length;
  if (codeBlocks >= 4 && score < 4) return false;
  return score >= 4;
}

/** Skill preview modal — works for user/bundled skills outside workspace */
async function openSkillPreview(skillFile, displayName) {
  if (!skillFile) {
    toast('无 skill 路径', 'err');
    return;
  }
  let data;
  try {
    data = await window.grok.skillsRead({ path: skillFile });
  } catch (e) {
    toast(e.message || '无法读取 SKILL.md', 'err');
    return;
  }
  const name = displayName || data?.meta?.name || 'Skill';
  const desc = data?.meta?.description || '';
  const body = data?.body || data?.raw || '';
  const raw = data?.raw || body;
  const file = data?.path || skillFile;

  let root = document.getElementById('skillPreviewModal');
  if (!root) {
    root = document.createElement('div');
    root.id = 'skillPreviewModal';
    root.className = 'gc-modal hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    document.body.appendChild(root);
  }
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="gc-modal-backdrop" data-close="1"></div>
    <div class="gc-modal-card glass skill-preview-card">
      <div class="gc-modal-head">
        <div>
          <div class="skill-preview-kicker">SKILL · 只读预览</div>
          <h2 id="skillPreviewTitle">${esc(name)}</h2>
          ${desc ? `<p class="skill-preview-desc">${esc(desc)}</p>` : ''}
        </div>
        <button type="button" class="icon-btn" data-close="1" aria-label="close">✕</button>
      </div>
      <div class="skill-preview-path" title="${esc(file)}">${esc(file)}</div>
      <pre class="skill-preview-body" id="skillPreviewBody"></pre>
      <div class="gc-modal-actions">
        <button type="button" class="btn small ghost" data-act="copy">复制</button>
        <button type="button" class="btn small ghost" data-act="folder">打开目录</button>
        <button type="button" class="btn small ghost" data-act="editor">工作区内打开</button>
        <button type="button" class="btn small primary" data-close="1">关闭</button>
      </div>
    </div>`;
  const pre = root.querySelector('#skillPreviewBody');
  if (pre) pre.textContent = raw;

  const close = () => root.classList.add('hidden');
  root.querySelectorAll('[data-close]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target === el || el.dataset.close) close();
    };
  });
  root.querySelector('[data-act="copy"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      toast('已复制 SKILL.md', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  };
  root.querySelector('[data-act="folder"]').onclick = async () => {
    try {
      const dir = file.replace(/[/\\]SKILL\.md$/i, '');
      await window.grok.skillsOpenDir({ path: dir });
    } catch (e) {
      toast(e.message || '无法打开目录', 'err');
    }
  };
  root.querySelector('[data-act="editor"]').onclick = async () => {
    const proj = P();
    if (!proj) {
      toast('请先打开项目', 'err');
      return;
    }
    const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const base = norm(proj.path);
    const f = norm(file);
    if (f.startsWith(base + '/') || f.startsWith(base + '\\') || f.startsWith(base)) {
      const rel = file.slice(proj.path.length).replace(/^[/\\]+/, '');
      close();
      await openFile(rel);
      if (typeof switchTab === 'function') switchTab('editor');
    } else {
      toast('Skill 不在当前工作区，请用只读预览', 'ok');
    }
  };
  // Esc
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
}

/** 根据用户句匹配 skills 元数据，提示可读 SKILL.md */
async function showSkillHints(userText, task) {
  if (!task?.pane || !userText) return;
  task.pane.querySelectorAll('.skill-hint-bar').forEach((el) => el.remove());
  let list = [];
  try {
    const projectPath = P()?.path || null;
    list = await window.grok.skillsList({ projectPath });
  } catch {
    return;
  }
  const q = String(userText).toLowerCase();
  const tokens = q
    .split(/[\s,./\\:;|!?'"，。、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const scored = (list || [])
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const hay = `${s.name || ''} ${s.description || ''}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score += t.length > 4 ? 2 : 1;
      }
      if (hay && q.length > 8 && hay.includes(q.slice(0, 24))) score += 3;
      return { s, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!scored.length) return;
  const bar = document.createElement('div');
  bar.className = 'skill-hint-bar';
  bar.innerHTML = `
    <span class="skill-hint-label">可能相关 Skills</span>
    <div class="skill-hint-list">
      ${scored
        .map(
          ({ s }) =>
            `<button type="button" class="skill-hint-chip" data-file="${esc(
              s.skillFile || s.path || ''
            )}" data-name="${esc(s.name || '')}" title="${esc(s.description || '')}">${esc(s.name)}</button>`
        )
        .join('')}
    </div>
    <span class="skill-hint-tip">点击芯片可只读预览 SKILL.md（含工作区外）</span>`;
  bar.querySelectorAll('.skill-hint-chip').forEach((btn) => {
    btn.onclick = async () => {
      const file = btn.dataset.file;
      if (!file) return;
      try {
        await openSkillPreview(file, btn.dataset.name || btn.textContent);
      } catch (e) {
        toast(e.message || '无法打开 skill', 'err');
      }
    };
  });
  task.pane.appendChild(bar);
  scrollMessages(true, task);
}

/** Build markdown + JSON share payload for current task */
function buildSessionShare(task) {
  task = task || T();
  const proj = task ? window.ProjectStore.get(task.projectId) : P();
  const msgs = Array.isArray(task?.messages) ? task.messages : [];
  const exportedAt = new Date().toISOString();
  const title = task?.title || 'session';
  const mode = state.workMode || 'cli';
  const header = [
    `# GrokCode Session · ${title}`,
    '',
    `- **Project**: ${proj?.name || '—'}`,
    `- **Path**: ${proj?.path || '—'}`,
    `- **Mode**: ${mode}`,
    `- **Exported**: ${exportedAt}`,
    `- **Messages**: ${msgs.length}`,
    '',
    '---',
    '',
  ].join('\n');
  const body = msgs
    .map((m) => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role || 'Note';
      const content = String(m.content || '').trim();
      return `### ${role}\n\n${content || '_(empty)_'}\n`;
    })
    .join('\n');
  const markdown = header + body + '\n---\n\n_Shared from [GrokCode](https://github.com/sunormesky-max/grok-code)_\n';
  const json = {
    format: 'grokcode-session-v1',
    title,
    project: { name: proj?.name || null, path: proj?.path || null },
    mode,
    exportedAt,
    messages: msgs.map((m) => ({
      role: m.role,
      content: m.content,
      ts: m.ts || null,
    })),
  };
  return { markdown, json, title, exportedAt };
}

async function openSessionShareCard(task) {
  task = task || T();
  if (!task) {
    toast(localeIsEn() ? 'No active task' : '无活动任务', 'err');
    return;
  }
  const pack = buildSessionShare(task);
  if (!pack.json.messages.length) {
    toast(localeIsEn() ? 'Empty session' : '会话为空', 'err');
    return;
  }
  let root = document.getElementById('sessionShareModal');
  if (!root) {
    root = document.createElement('div');
    root.id = 'sessionShareModal';
    root.className = 'gc-modal hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    document.body.appendChild(root);
  }
  const en = localeIsEn();
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="gc-modal-backdrop" data-close="1"></div>
    <div class="gc-modal-card glass session-share-card">
      <div class="gc-modal-head">
        <div>
          <div class="skill-preview-kicker">SESSION SHARE</div>
          <h2>${esc(pack.title)}</h2>
          <p class="skill-preview-desc">${pack.json.messages.length} msgs · ${esc(pack.exportedAt.slice(0, 19).replace('T', ' '))}</p>
        </div>
        <button type="button" class="icon-btn" data-close="1" aria-label="close">✕</button>
      </div>
      <pre class="skill-preview-body session-share-preview" id="sessionSharePreview"></pre>
      <div class="gc-modal-actions">
        <button type="button" class="btn small ghost" data-act="copy-md">${en ? 'Copy Markdown' : '复制 Markdown'}</button>
        <button type="button" class="btn small ghost" data-act="copy-json">${en ? 'Copy JSON' : '复制 JSON'}</button>
        <button type="button" class="btn small primary" data-act="save">${en ? 'Save…' : '保存…'}</button>
        <button type="button" class="btn small ghost" data-close="1">${en ? 'Close' : '关闭'}</button>
      </div>
    </div>`;
  const pre = root.querySelector('#sessionSharePreview');
  if (pre) pre.textContent = pack.markdown.slice(0, 12000) + (pack.markdown.length > 12000 ? '\n…' : '');

  const close = () => root.classList.add('hidden');
  root.querySelectorAll('[data-close]').forEach((el) => {
    el.onclick = () => close();
  });
  root.querySelector('[data-act="copy-md"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(pack.markdown);
      toast(en ? 'Markdown copied' : '已复制 Markdown', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  };
  root.querySelector('[data-act="copy-json"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(pack.json, null, 2));
      toast(en ? 'JSON copied' : '已复制 JSON', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  };
  root.querySelector('[data-act="save"]').onclick = async () => {
    try {
      const safe = String(pack.title || 'session')
        .replace(/[^\w\u4e00-\u9fff.-]+/g, '-')
        .slice(0, 48);
      const r = await window.grok.sessionExportShare({
        markdown: pack.markdown,
        json: JSON.stringify(pack.json, null, 2),
        defaultName: `grok-session-${safe}.md`,
      });
      if (r?.canceled) return;
      if (r?.ok) toast((en ? 'Saved: ' : '已保存：') + (r.file || ''), 'ok');
      else toast(r?.error || '保存失败', 'err');
    } catch (e) {
      toast(e.message || '保存失败', 'err');
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
}
window.openSessionShareCard = openSessionShareCard;
window.openSkillPreview = openSkillPreview;

/** Chat turn divider — mode · time · prompt snippet */
function appendTurnMarker(task, opts = {}) {
  if (!task?.pane) return;
  const en = localeIsEn();
  const mode = (opts.mode || task.turnMode || 'cli').toUpperCase();
  const when = new Date().toLocaleTimeString();
  const snippet = String(opts.prompt || '').replace(/\s+/g, ' ').slice(0, 72);
  const tags = [];
  if (opts.continueFrom) tags.push(en ? 'continue' : '续跑');
  if (opts.retry) tags.push(en ? 'retry' : '重试');
  const div = document.createElement('div');
  div.className = 'turn-marker';
  if (task.turnId) div.dataset.turn = task.turnId;
  div.innerHTML = `
    <span class="tm-line" aria-hidden="true"></span>
    <span class="tm-chip mode-${esc((opts.mode || task.turnMode || 'cli').toLowerCase())}">${esc(mode)}</span>
    <span class="tm-time">${esc(when)}</span>
    ${tags.map((x) => `<span class="tm-tag">${esc(x)}</span>`).join('')}
    <span class="tm-prompt" title="${esc(String(opts.prompt || ''))}">${esc(snippet || (en ? '(no text)' : '（无文本）'))}</span>`;
  task.pane.appendChild(div);
  scrollMessages(true, task);
}

function markTurnEnded(task, meta = {}) {
  if (!task || !Array.isArray(task.turns) || !task.turns.length) return;
  const last = task.turns[task.turns.length - 1];
  if (!last || last.id !== task.turnId) return;
  last.endedAt = Date.now();
  last.stopped = Boolean(meta.stopped);
  last.error = meta.error || null;
  last.tools = meta.tools || 0;
  last.usage = meta.usage || null;
  // Stamp marker
  const marker = task.pane?.querySelector?.(`.turn-marker[data-turn="${cssEscape(task.turnId)}"]`);
  if (marker && !marker.querySelector('.tm-end')) {
    const end = document.createElement('span');
    end.className = 'tm-end' + (meta.stopped ? ' stopped' : meta.error ? ' error' : ' ok');
    end.textContent = meta.stopped
      ? localeIsEn()
        ? 'stopped'
        : '已停'
      : meta.error
        ? localeIsEn()
          ? 'error'
          : '失败'
        : localeIsEn()
          ? 'done'
          : '完成';
    marker.appendChild(end);
  }
}

/** 失败后可一键重试 / 清空 session 重试 / 导出诊断 */
function appendRetryBar(task, promptText, errMsg) {
  if (!task?.pane) return;
  task.pane.querySelectorAll('.retry-bar, .stop-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'retry-bar';
  bar.innerHTML = `
    <span class="retry-hint">${esc(t('chat.retryHint', '任务失败 — 可重试或新开会话'))}${errMsg ? ` · ${esc(String(errMsg).slice(0, 80))}` : ''}</span>
    <div class="retry-actions">
      <button type="button" class="btn small primary" data-act="retry">${esc(t('chat.retry', '重试'))}</button>
      <button type="button" class="btn small ghost" data-act="fresh">${esc(t('chat.retryFresh', '新会话重试'))}</button>
      <button type="button" class="btn small ghost" data-act="diag">${esc(t('chat.exportDiag', '导出诊断'))}</button>
    </div>`;
  bar.querySelector('[data-act="retry"]').onclick = () => {
    bar.remove();
    runTaskPrompt(task, promptText, { isRetry: true, skipResume: false });
  };
  bar.querySelector('[data-act="fresh"]').onclick = async () => {
    bar.remove();
    try {
      await window.grok.clearSession({ projectId: task.projectId, taskId: task.id });
    } catch {
      /* ignore */
    }
    task.sessionId = null;
    runTaskPrompt(task, promptText, { isRetry: true, skipResume: true, resetSession: true });
  };
  bar.querySelector('[data-act="diag"]').onclick = () => {
    window.GrokSettingsExtra?.exportDiag?.();
  };
  task.pane.appendChild(bar);
  scrollMessages(true, task);
}

/** After user stop: continue (resume) / retry same / fresh session */
function appendStopBar(task, promptText, opts = {}) {
  if (!task?.pane) return;
  task.pane.querySelectorAll('.retry-bar, .stop-bar').forEach((el) => el.remove());
  const en = localeIsEn();
  const bar = document.createElement('div');
  bar.className = 'stop-bar';
  bar.innerHTML = `
    <span class="retry-hint">${
      opts.partial
        ? en
          ? 'Stopped · partial output kept · resume session or retry'
          : '已停止 · 已保留部分输出 · 可续跑或重试'
        : en
          ? 'Stopped · continue or retry'
          : '已停止 · 可续跑或重试'
    }</span>
    <div class="retry-actions">
      <button type="button" class="btn small primary" data-act="continue">${en ? 'Continue' : '续跑'}</button>
      <button type="button" class="btn small ghost" data-act="retry">${en ? 'Retry prompt' : '重试原提示'}</button>
      <button type="button" class="btn small ghost" data-act="fresh">${en ? 'Fresh session' : '新会话'}</button>
    </div>`;
  const continuePrompt = en
    ? 'Continue from where you stopped. Finish the remaining work without redoing completed steps.'
    : '从刚才中断处继续，完成剩余工作，不要重复已完成步骤。';
  bar.querySelector('[data-act="continue"]').onclick = () => {
    bar.remove();
    runTaskPrompt(task, continuePrompt, {
      isContinue: true,
      fromComposer: false,
      skipResume: false,
    });
  };
  bar.querySelector('[data-act="retry"]').onclick = () => {
    bar.remove();
    runTaskPrompt(task, promptText || task.lastPrompt || continuePrompt, {
      isRetry: true,
      skipResume: false,
    });
  };
  bar.querySelector('[data-act="fresh"]').onclick = async () => {
    bar.remove();
    try {
      await window.grok.clearSession({ projectId: task.projectId, taskId: task.id });
    } catch {
      /* ignore */
    }
    task.sessionId = null;
    runTaskPrompt(task, promptText || task.lastPrompt || continuePrompt, {
      isRetry: true,
      skipResume: true,
      resetSession: true,
    });
  };
  task.pane.appendChild(bar);
  scrollMessages(true, task);
}

async function stopAgent() {
  const task = T();
  if (!task) return;
  if (!task.running) {
    toast(localeIsEn() ? 'Nothing running' : '当前没有运行中的任务', 'ok');
    return;
  }
  task.stopRequested = true;
  task.phase = 'stopped';
  task.phaseDetail = localeIsEn() ? 'stopping…' : '停止中…';
  renderTaskTabs();
  try {
    await window.grok.stopAgent({ projectId: task.projectId || pid(), taskId: task.id });
  } catch (e) {
    toast(e.message || 'stop failed', 'err');
  }
  // runTaskPrompt finally / stopped branch will finalize UI;
  // do not force-clear stream here (keep partial tokens)
  if (isActiveTask(task)) {
    setAgentStatus(localeIsEn() ? 'Stopping…' : '停止中…', false);
  }
  toast(t('chat.stopped', `已停止：${task.title}`, { title: task.title }));
}

function setRunningUi(on) {
  // 仅影响当前任务的发送/停止按钮
  const task = T();
  const running = on || Boolean(task?.running);
  $('#btnSend').disabled = Boolean(task?.running);
  $('#btnStop').classList.toggle('hidden', !task?.running);
  applySendLabel();
  {
    const m = task?.turnMode || state.workMode;
    document.body.classList.toggle(
      'craft-inflight',
      Boolean(task?.running && (m === 'craft' || m === 'goal'))
    );
  }
  if (!running && anyRunning()) {
    // 其他任务还在跑
    $('#liveBadge')?.classList.remove('hidden');
  }
}

function setAgentStatus(text, busy, isError) {
  const chip = $('#agentStatus');
  const label = $('#agentStatusText');
  label.textContent = text;
  chip.classList.toggle('busy', Boolean(busy));
  chip.classList.toggle('error', Boolean(isError));
  chip.title = text;
  chip.setAttribute('aria-busy', busy ? 'true' : 'false');
  $('#sbAgent').textContent = text;
  // Announce errors always; phase updates throttled polite in GrokA11y
  if (text) {
    window.GrokA11y?.announce?.(text, {
      assertive: Boolean(isError),
      force: Boolean(isError),
    });
  }
}

function startElapsed(task) {
  task = task || T();
  if (!task) return;
  stopElapsed(task);
  task.elapsedStart = Date.now();
  if (isActiveTask(task)) {
    const el = $('#elapsedTimer');
    el?.classList.remove('hidden');
    if (el) el.textContent = '0s';
  }
  task.elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - task.elapsedStart) / 1000);
    if (isActiveTask(task)) {
      const el = $('#elapsedTimer');
      if (el) el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
    }
    updateLiveStats();
  }, 500);
}

function stopElapsed(task) {
  task = task || T();
  if (!task) return;
  if (task.elapsedTimer) clearInterval(task.elapsedTimer);
  task.elapsedTimer = null;
  setTimeout(() => {
    if (isActiveTask(task) && !task.running) {
      $('#elapsedTimer')?.classList.add('hidden');
    }
  }, 2000);
}

function messagesNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function scrollMessages(force = false, task) {
  const box = task?.pane || messagesEl();
  if (!box) return;
  if (force || messagesNearBottom(box)) box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, { markdown = true, persist = true } = {}, task) {
  task = task || T();
  const box = task?.pane || messagesEl();
  if (!box) return null;
  // 去掉 welcome
  box.querySelector('.welcome')?.remove();
  const div = document.createElement('div');
  const roleLabel = role === 'user' ? 'You' : role === 'tool' ? 'Tool' : 'Grok';
  div.className = `msg ${role}`;
  if (task?.turnId && role === 'assistant') div.dataset.turn = task.turnId;
  div.innerHTML = `<div class="role">${roleLabel}</div><div class="body${markdown && role === 'assistant' ? ' md' : ''}"></div>`;
  const body = div.querySelector('.body');
  if (markdown && role === 'assistant') body.innerHTML = renderMarkdown(content);
  else body.textContent = content;
  box.appendChild(div);
  scrollMessages(true, task);

  if (persist && task && (role === 'user' || role === 'assistant')) {
    if (!Array.isArray(task.messages)) task.messages = [];
    task.messages.push({ role, content: String(content || ''), ts: Date.now() });
    // 限制内存：最多保留 200 条原文（压缩会吃更早的）
    if (task.messages.length > 200) task.messages = task.messages.slice(-200);
    schedulePersist();
  }
  return div;
}

function ensureLiveAssistant(task) {
  task = task || T();
  if (!task) return null;
  if (task.liveAssistantEl?.isConnected) return task.liveAssistantEl;
  const box = task.pane;
  let el =
    (task.turnId && box.querySelector(`.msg.assistant[data-turn="${task.turnId}"]`)) ||
    box.querySelector('.msg.assistant[data-live="1"]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg assistant is-streaming';
    el.dataset.live = '1';
    if (task.turnId) el.dataset.turn = task.turnId;
    el.innerHTML = `<div class="role">Grok · stream</div><div class="body stream-body is-streaming"></div>`;
    box.appendChild(el);
  }
  task.liveAssistantEl = el;
  return el;
}

function upsertAssistant(text, streaming, task) {
  task = task || T();
  if (!task) return null;
  const el = ensureLiveAssistant(task);
  const body = el.querySelector('.body');
  const role = el.querySelector('.role');
  if (streaming) {
    el.dataset.live = '1';
    el.classList.add('is-streaming');
    body.classList.remove('md');
    body.classList.add('stream-body', 'is-streaming');
    // OpenWorker-style gate: hold short pre-tool narration; quiet mid-tool; answer otherwise
    const raw = text || '';
    const mode =
      window.GrokStreamGate?.streamMode?.(raw, window.GrokStreamGate.ctxFromTask(task)) ||
      'answer';
    el.dataset.streamMode = mode;
    el.classList.toggle('stream-hold', mode === 'hold');
    el.classList.toggle('stream-quiet', mode === 'quiet');
    const next =
      window.GrokStreamGate?.displayForMode?.(raw, mode, { en: localeIsEn() }) ?? raw;
    // Prefer append when prefix matches — avoids full string rewrite every frame
    const prev = body.textContent || '';
    if (prev === next) {
      /* no-op */
    } else if (
      mode === 'answer' &&
      next.startsWith(prev) &&
      next.length - prev.length < 400 &&
      !el.classList.contains('stream-quiet') &&
      !el.classList.contains('stream-hold')
    ) {
      body.appendChild(document.createTextNode(next.slice(prev.length)));
    } else {
      body.textContent = next;
    }
    if (role) paintLiveAssistantRole(task);
  } else {
    el.classList.remove('is-streaming', 'stream-hold', 'stream-quiet');
    body.classList.add('md');
    body.classList.remove('stream-body', 'is-streaming');
    body.innerHTML = renderMarkdown(text || '');
    delete el.dataset.live;
    delete el.dataset.streamMode;
    if (role) role.textContent = 'Grok';
  }
  scrollMessages(false, task);
  return el;
}

function finalizeLiveMessages(task) {
  task = task || T();
  if (!task) return;
  const el =
    task.liveAssistantEl ||
    (task.turnId && task.pane.querySelector(`.msg.assistant[data-turn="${task.turnId}"]`)) ||
    task.pane.querySelector('.msg.assistant[data-live="1"]');
  if (el) {
    const body = el.querySelector('.body');
    const role = el.querySelector('.role');
    const text = task.streamBuf || body.textContent || '';
    el.classList.remove('is-streaming');
    body.classList.add('md');
    body.classList.remove('stream-body', 'is-streaming');
    body.innerHTML = renderMarkdown(text);
    delete el.dataset.live;
    if (role) role.textContent = 'Grok';
    // Optional usage footer on this turn
    const brief = formatUsageBrief(task.lastUsage);
    if (brief) {
      let foot = el.querySelector('.stream-usage');
      if (!foot) {
        foot = document.createElement('div');
        foot.className = 'stream-usage';
        el.appendChild(foot);
      }
      foot.textContent = brief;
    }
  }
  // 对话很长时压缩历史 DOM（保留 task.messages 全量）
  if (window.GrokChatVirtual && (task.messages || []).length > window.GrokChatVirtual.TAIL + 15) {
    window.GrokChatVirtual.maybeCompact(task.pane, task.messages, {
      renderOne: (m) =>
        window.GrokChatVirtual.makeMessageEl(m, { renderMarkdown, esc }),
    });
  }
  const thought =
    task.liveThoughtEl ||
    task.pane.querySelector('.msg.thought[data-live="1"]') ||
    (task.turnId && task.pane.querySelector(`.msg.thought[data-turn="${task.turnId}"]`));
  if (thought) {
    delete thought.dataset.live;
    thought.classList.add('collapsed');
    const summary = thought.querySelector('.thought-summary');
    if (summary) {
      const n = (task.thoughtBuf || '').length;
      summary.textContent = n ? `Thinking · ${n} 字 · 点击展开` : 'Thinking';
    }
  }
}

function upsertThought(text, streaming, task) {
  task = task || T();
  if (!task) return;
  const box = task.pane;
  let el = task.liveThoughtEl;
  if (!el?.isConnected) {
    el =
      (task.turnId && box.querySelector(`.msg.thought[data-turn="${task.turnId}"]`)) ||
      box.querySelector('.msg.thought[data-live="1"]');
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg thought collapsed';
    el.dataset.live = '1';
    if (task.turnId) el.dataset.turn = task.turnId;
    el.innerHTML = `
      <button type="button" class="thought-summary">Thinking…</button>
      <div class="thought-body"></div>`;
    el.querySelector('.thought-summary').onclick = () => {
      el.classList.toggle('collapsed');
    };
    const asst = task.liveAssistantEl;
    if (asst?.parentNode === box) box.insertBefore(el, asst);
    else box.appendChild(el);
  }
  task.liveThoughtEl = el;
  if (streaming) el.dataset.live = '1';
  const body = el.querySelector('.thought-body');
  const summary = el.querySelector('.thought-summary');
  body.textContent = text || '';
  if (streaming) {
    // Keep thinking OPEN while live so long runs are not a black box
    const n = (text || '').length;
    summary.textContent = n ? `Thinking · 流式 ${n} 字` : 'Thinking…';
    el.classList.remove('collapsed');
  } else {
    summary.textContent = `Thinking · ${(text || '').length} 字 · 点击展开`;
    el.classList.add('collapsed');
  }
  scrollMessages(false, task);
}

function appendToolStart(d, task) {
  ToolStorm.onStart(d, task || T());
}

function appendToolStartDirect(d, task) {
  task = task || T();
  if (!task) return;
  const box = task.pane;
  if (!box) return;
  // Dedupe (ACP may re-send tool_call + tool_call_update)
  if (d?.id && box.querySelector(`.msg.tool[data-tool-id="${cssEscape(d.id)}"]`)) return;
  // If storm card already tracks this id, skip individual row
  if (task._toolStorm?.has(String(d.id))) {
    trackToolInStorm(task, d);
    return;
  }
  const div = document.createElement('div');
  div.className = 'msg tool running';
  div.dataset.toolId = d.id;
  if (task.turnId) div.dataset.turn = task.turnId;
  const startedAt = Number(d.startedAt) || Date.now();
  div.dataset.toolStarted = String(startedAt);
  const human = humanToolTitle(d.name, d.args || {});
  let argsPreview = '';
  try {
    argsPreview = JSON.stringify(summarizeArgs(d.name, d.args), null, 0);
  } catch {
    argsPreview = '';
  }
  div.innerHTML = `
    <div class="role">Tool</div>
    <div class="body">
      <div class="name" title="${esc(d.name || '')}">⚙ ${esc(human || d.name)}</div>
      <div class="args">${esc(argsPreview)}</div>
      <div class="result">running… 0s</div>
    </div>`;
  const resultEl = div.querySelector('.result');
  const tick = () => {
    if (!div.isConnected || !div.classList.contains('running')) {
      if (div._toolTimer) {
        clearInterval(div._toolTimer);
        div._toolTimer = null;
      }
      return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (resultEl) resultEl.textContent = `running… ${sec}s`;
    if (isActiveTask(task)) {
      setLivePhase(`${d.name || 'tool'}… ${sec}s`, task.title || '');
    }
  };
  div._toolTimer = setInterval(tick, 500);
  tick();
  const asst = task.liveAssistantEl;
  if (asst?.parentNode === box) box.insertBefore(div, asst);
  else box.appendChild(div);
  scrollMessages(true, task);
}

function appendToolEnd(d, task) {
  ToolStorm.onEnd(d, task || T());
}

function appendToolEndDirect(d, task) {
  task = task || T();
  const scope = task?.pane || document;
  let div = scope.querySelector?.(`.msg.tool[data-tool-id="${cssEscape(d.id)}"]`);
  if (!div && task) {
    appendToolStartDirect(d, task);
    div = task.pane.querySelector(`.msg.tool[data-tool-id="${cssEscape(d.id)}"]`);
  }
  if (div?._toolTimer) {
    clearInterval(div._toolTimer);
    div._toolTimer = null;
  }
  div?.classList.remove('running');
  const startedAt = Number(div?.dataset?.toolStarted) || 0;
  const elapsedSec = startedAt ? ((Date.now() - startedAt) / 1000).toFixed(1) : '';
  const el = div?.querySelector('.result');
  if (el) {
    const full = String(d.result || '');
    const preview = full.slice(0, 500);
    const head = elapsedSec ? `✓ ${elapsedSec}s · ` : '';
    const body = preview + (full.length > 500 ? '…（点击展开）' : '');
    el.textContent = head + (body || (d.ok === false ? 'failed' : 'done'));
    el.title = '点击展开/收起';
    el.onclick = () => {
      el.classList.toggle('expanded');
      if (el.classList.contains('expanded')) el.textContent = full || '（空）';
      else el.textContent = head + (body || 'done');
    };
  }
}

function summarizeArgs(name, args = {}) {
  if (/write|replace|edit/i.test(name || '')) {
    return { path: args.path || args.file_path || args.target_file, note: '内容已省略' };
  }
  if (/run_command|run_terminal|bash|shell/i.test(name || '')) {
    return { command: args.command };
  }
  return args;
}

// ── Settings ────────────────────────────────────────────
function openSettings() {
  refreshConfigUi();
  // 默认打开通用页
  document.querySelectorAll('.stab').forEach((b) => b.classList.toggle('active', b.dataset.stab === 'general'));
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.add('hidden'));
  $('#stab-general')?.classList.remove('hidden');
  const modal = $('#settingsModal');
  modal?.classList.remove('hidden');
  modal?.setAttribute('role', 'dialog');
  modal?.setAttribute('aria-modal', 'true');
  modal?.setAttribute('aria-label', localeIsEn() ? 'Settings' : '设置');
  const card = modal?.querySelector('.modal-card, .settings-card, .settings-body') || modal;
  window.GrokA11y?.trapFocus?.(card || modal);
}

function closeSettings() {
  $('#settingsModal')?.classList.add('hidden');
  window.GrokA11y?.releaseTrap?.();
}

async function refreshCliStatus() {
  const probe = await window.grok.probeCli();
  setCliLabel(probe);
  const box = $('#cliStatusDetail');
  const badge = $('#cliBadge');
  if (probe.ok) {
    box.innerHTML = `${esc(probe.version)}<br><code>${esc(probe.binary)}</code>`;
    $('#cliStatusBox').classList.add('ok');
    $('#cliStatusBox').classList.remove('bad');
    badge.textContent = '在线';
  } else {
    box.innerHTML = `${esc(probe.error || '未知错误')}${
      probe.binary ? `<br><code>${esc(probe.binary)}</code>` : ''
    }`;
    $('#cliStatusBox').classList.add('bad');
    $('#cliStatusBox').classList.remove('ok');
    badge.textContent = '离线';
  }
  return probe;
}

async function refreshConfigUi() {
  const cfg = await window.grok.getConfig();
  setCliLabel(cfg.cli);
  await refreshCliStatus();

  $('#cfgApiKey').value = '';
  $('#cfgApiKey').placeholder = cfg.hasApiKey
    ? `已保存 ${cfg.apiKey}（留空不修改）`
    : 'xai-… 或留空，使用 grok login';
  $('#cfgModel').value = cfg.model || '';
  const cfgEff = document.getElementById('cfgReasoningEffort');
  if (cfgEff) cfgEff.value = cfg.reasoningEffort || '';
  $('#cfgGrokPath').value = cfg.grokPath || '';
  $('#cfgRounds').value = cfg.maxTurns || 30;
  $('#cfgYolo').checked = cfg.alwaysApprove !== false;
  const patchedEl = document.getElementById('cfgGrokPatched');
  if (patchedEl) patchedEl.checked = Boolean(cfg.grokPatched);
  $('#cfgRules').value = cfg.rules || '';
  const tr = document.getElementById('cfgAgentTransport');
  if (tr) {
    tr.value = ['auto', 'acp', 'headless'].includes(cfg.agentTransport)
      ? cfg.agentTransport
      : 'auto';
  }

  state.model = cfg.model || '';
  saveJson(MODEL_KEY, state.model);
  applyModelChip();
  state.reasoningEffort = cfg.reasoningEffort || '';
  saveJson(EFFORT_KEY, state.reasoningEffort);
  applyEffortChip();

  window.GrokSettingsExtra?.fillFromConfig?.(cfg);

  if (cfg.workspace) {
    state.workspace = cfg.workspace;
    setWorkspaceLabel(cfg.workspace);
  }
}

async function saveSettings() {
  const partial = {
    model: $('#cfgModel').value.trim(),
    reasoningEffort: (
      document.getElementById('cfgReasoningEffort')?.value || ''
    ).trim(),
    grokPath: $('#cfgGrokPath').value.trim(),
    maxTurns: Number($('#cfgRounds').value) || 30,
    alwaysApprove: $('#cfgYolo').checked,
    grokPatched: Boolean(document.getElementById('cfgGrokPatched')?.checked),
    agentTransport: document.getElementById('cfgAgentTransport')?.value || 'auto',
    rules: $('#cfgRules').value,
    ...(window.GrokSettingsExtra?.collectPartial?.() || {}),
  };
  const key = $('#cfgApiKey').value.trim();
  if (key) partial.apiKey = key;
  const setRes = await window.grok.setConfig(partial);
  state.model = partial.model || '';
  saveJson(MODEL_KEY, state.model);
  applyModelChip();
  state.reasoningEffort = partial.reasoningEffort || '';
  saveJson(EFFORT_KEY, state.reasoningEffort);
  applyEffortChip();
  // Live set_model with effort when warm
  try {
    await applyLiveSessionModel();
  } catch {
    /* ignore */
  }
  window.refreshRulesChip?.();
  closeSettings();
  await refreshCliStatus();
  const warmN = Number(setRes?.warmCleared) || 0;
  if (warmN > 0) {
    toast(
      localeIsEn()
        ? `Settings saved · recycled ${warmN} warm ACP session(s)`
        : `设置已保存 · 已回收 ${warmN} 个 ACP 热会话`,
      'ok'
    );
  } else {
    toast(t('toast.saved', '设置已保存'), 'ok');
  }
}

const toast = U.toast || window.toast || ((msg) => console.log(msg));
window.toast = toast;

init().catch((err) => {
  console.error(err);
  toast('初始化失败: ' + err.message, 'err');
});
