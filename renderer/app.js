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

/** Common model presets — empty string = CLI default */
const MODEL_PRESETS = [
  { id: '', label: 'CLI 默认' },
  { id: 'grok-build', label: 'grok-build' },
  { id: 'grok-4.5', label: 'grok-4.5' },
  { id: 'grok-4', label: 'grok-4' },
];

const state = {
  workMode: loadJson(MODE_KEY, 'craft') || 'craft',
  workspace: null,
  treeData: [],
  currentFile: null,
  dirty: false,
  lastDiffs: [],
  unsubs: [],
  termHistory: loadJson(TERM_HIST_KEY, []),
  termHistIdx: -1,
  filesCollapsed: false,
  termCollapsed: false,
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
  /** show blame heat legend in Diff */
  diffHeatLegend: loadJson('grokcode-diff-heat-legend', true) !== false,
  /** global turn scrubber key (turnId or ts-*) or null */
  diffScrubTurn: null,
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
  restoreLayout();
  bindUi();
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

  bindWorkModeUi();
  // sync mode from config if present
  try {
    const cfg = await window.grok.getConfig();
    if (cfg.workMode) setWorkMode(cfg.workMode, { persistRemote: false });
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

async function restoreAllProjectsFromDisk() {
  const list = window.ProjectStore.list();
  for (const proj of list) {
    await restoreProjectFromDisk(proj);
  }
  // 若内存无项目，尝试从 persist 索引恢复最近项目
  if (!list.length) {
    try {
      const snaps = await window.grok.persistList();
      for (const s of (snaps || []).slice(0, 5)) {
        if (!s.path) continue;
        try {
          const info = await window.grok.projectOpenPath(s.path);
          if (info) {
            window.ProjectStore.add(info);
            const p = window.ProjectStore.get(info.id) || window.ProjectStore.list().find((x) => x.path === info.path);
            if (p) await restoreProjectFromDisk(p);
          }
        } catch (e) {
          console.warn('restore open', s.path, e);
        }
      }
      if (window.ProjectStore.count() > 0) {
        const p = P();
        setWorkspaceLabel(p.path);
        window.TaskStore.onProjectSwitch();
        await loadTree();
        toast(
          t('projects.restored', `已恢复 ${window.ProjectStore.count()} 个项目的上下文`, {
            n: window.ProjectStore.count(),
          }),
          'ok'
        );
      }
    } catch (e) {
      console.warn(e);
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
    const ctx = await window.grok.compressContext({
      messages: task.messages || [],
      prevContext: task.context || {},
      projectName: P().name,
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
    return;
  }
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
      return `<div class="task-tab${act}${run}${pin}" data-id="${t.id}" draggable="true" title="${esc(t.title)} · 双击重命名 · 拖拽排序">
        <button type="button" class="task-pin" data-pin="${t.id}" title="${t.pinned ? '取消固定' : '固定'}">${t.pinned ? '📌' : '📍'}</button>
        <span class="task-dot"></span>
        <span class="task-name" data-rename="${t.id}">${esc(t.title)}</span>
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
  const pc = window.ProjectStore.count();
  const el = $('#taskQueueHint');
  if (el) {
    el.textContent =
      pc > 1
        ? `${pc} projects · ${n} tasks`
        : r > 0
          ? `${n} tasks · ${r} running`
          : `${n} tasks · multi`;
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
  // 状态条反映当前任务
  if (t.running) {
    setAgentStatus('grokking…', true);
    $('#elapsedTimer')?.classList.remove('hidden');
  } else {
    setAgentStatus('待命', false);
    $('#elapsedTimer')?.classList.add('hidden');
  }
  setRunningUi(t.running);
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

// ── 无边框窗口控制 ──────────────────────────────────────
function bindWindowControls() {
  $('#btnWinMin')?.addEventListener('click', () => window.grok.windowMinimize?.());
  $('#btnWinMax')?.addEventListener('click', async () => {
    const max = await window.grok.windowMaximize?.();
    syncMaxBtn(max);
  });
  $('#btnWinClose')?.addEventListener('click', () => window.grok.windowClose?.());

  // 双击标题栏区域最大化
  $('#titlebar')?.addEventListener('dblclick', async (e) => {
    if (e.target.closest('button, input, a, .pill, .win-controls, .no-drag')) return;
    const max = await window.grok.windowMaximize?.();
    syncMaxBtn(max);
  });

  window.grok.on?.('window:maximized', (d) => syncMaxBtn(d?.maximized));
  window.grok.windowIsMaximized?.().then(syncMaxBtn).catch(() => {});
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
  if (!L) return;
  if (L.filesW) document.documentElement.style.setProperty('--files-w', L.filesW + 'px');
  if (L.chatW) document.documentElement.style.setProperty('--chat-w', L.chatW + 'px');
  if (L.termH) document.documentElement.style.setProperty('--term-h', L.termH + 'px');
  if (L.filesCollapsed) {
    state.filesCollapsed = true;
    $('#filesPanel')?.classList.add('collapsed');
  }
  if (L.termCollapsed) {
    state.termCollapsed = true;
    $('.terminal-wrap')?.classList.add('collapsed');
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
  });
}

// ── Session templates (starters pack) ───────────────────
const USER_TEMPLATES_KEY = 'grokcode-session-templates';
let _bundledTemplates = null;

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
  // custom overrides by id
  const map = new Map();
  for (const t of bundled) map.set(t.id, { ...t, source: 'bundled' });
  for (const t of custom) if (t?.id) map.set(t.id, { ...t, source: 'user' });
  return [...map.values()];
}

function templatePrompt(t, en) {
  if (!t) return '';
  if (en) return t.promptEn || t.prompt || t.promptZh || '';
  return t.promptZh || t.prompt || t.promptEn || '';
}

function applySessionTemplate(t) {
  if (!t) return;
  const en = localeIsEn();
  if (state.workMode !== 'craft') setWorkMode('craft');
  const prompt = templatePrompt(t, en);
  const el = document.getElementById('prompt');
  if (el) {
    el.value = prompt;
    autoResizePrompt();
    updateCharCount();
    el.focus();
  }
  schedulePromptDraftSave();
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

function renderTemplateListItems(list, en, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const filtered = !q
    ? list
    : list.filter((t) => templateSearchHay(t, en).includes(q) || normalizeTags(t.tags).some((tag) => tag.includes(q)));
  if (!filtered.length) {
    return `<div class="slash-desc" style="padding:10px">${en ? 'No matches' : '无匹配模板'}</div>`;
  }
  return filtered
    .map((t) => {
      const tags = normalizeTags(t.tags);
      return `<button type="button" class="slash-item" data-id="${esc(t.id)}">
        <span class="slash-label">${esc(en ? t.labelEn || t.id : t.labelZh || t.id)}${
          t.source === 'user' ? ' · user' : ''
        }</span>
        ${
          tags.length
            ? `<span class="tpl-tags">${tags.map((tag) => `<em class="tpl-tag">${esc(tag)}</em>`).join('')}</span>`
            : ''
        }
        <span class="slash-desc">${esc(templatePrompt(t, en).slice(0, 90))}</span>
      </button>`;
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
  const bindListClicks = () => {
    host.querySelectorAll('.slash-item[data-id]').forEach((btn) => {
      btn.onclick = () => {
        const t = list.find((x) => x.id === btn.dataset.id);
        menu.classList.add('hidden');
        applySessionTemplate(t);
      };
    });
  };
  const refreshList = (q) => {
    host.innerHTML = renderTemplateListItems(list, en, q);
    bindListClicks();
  };
  bindListClicks();
  search?.addEventListener('input', () => refreshList(search.value));
  search?.addEventListener('keydown', (e) => e.stopPropagation());
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

async function encryptTemplatesPayload(jsonStr, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveTemplateKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(jsonStr)
  );
  return {
    format: 'grokcode-templates-aes-v1',
    kdf: 'PBKDF2-SHA256-120k',
    cipher: 'AES-256-GCM',
    salt: b64FromBytes(salt),
    iv: b64FromBytes(iv),
    data: b64FromBytes(ct),
    exportedAt: new Date().toISOString(),
  };
}

async function decryptTemplatesPayload(pack, passphrase) {
  if (!pack || pack.format !== 'grokcode-templates-aes-v1') {
    throw new Error('Not an encrypted GrokCode template pack');
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
  const quick = templates.slice(0, 8);
  box.innerHTML = `
    <div class="welcome">
      <div class="welcome-hero">
        <div class="welcome-kicker">xAI · CRAFT FLIGHT DECK</div>
        <h3>Not just an IDE assistant.<br><em>Parallel agents that grok.</em></h3>
        <p>${
          en
            ? 'Default mode is <strong>Craft</strong> — act now. Each task has its own CLI session. <kbd>Ctrl</kbd>+<kbd>T</kbd> for parallel.'
            : '默认 <strong>Craft 飞行模式</strong>：直接动手。每个任务独立 CLI session，可<strong>同时跑多个</strong>。用 <kbd>Ctrl</kbd>+<kbd>T</kbd> 开新任务。'
        }</p>
      </div>
      <ol>
        <li>${en ? 'Open a project workspace' : '打开项目，给 Grok 一块能「理解」的代码宇宙'}</li>
        <li>${en ? 'CLI green in title bar = online (else <code>grok login</code>)' : '顶栏 CLI 亮绿 = 已上线（否则 <code>grok login</code>）'}</li>
        <li>${en ? '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> send · <kbd>/</kbd> commands · templates pack below' : '当前任务 <kbd>Ctrl</kbd>+<kbd>Enter</kbd> · <kbd>/</kbd> 命令 · 下方模板包'}</li>
      </ol>
      <div class="quick-actions" id="welcomeTemplates">
        ${quick
          .map(
            (t) =>
              `<button type="button" class="quick-btn craft-q" data-tpl="${esc(t.id)}">${esc(
                en ? t.labelEn || t.id : t.labelZh || t.id
              )}</button>`
          )
          .join('')}
        <button type="button" class="quick-btn" data-act="more-tpl">${en ? 'More…' : '更多…'}</button>
      </div>
    </div>`;
  box.querySelectorAll('.quick-btn[data-tpl]').forEach((btn) => {
    btn.onclick = () => {
      const t = quick.find((x) => x.id === btn.dataset.tpl);
      applySessionTemplate(t);
    };
  });
  box.querySelector('[data-act="more-tpl"]')?.addEventListener('click', () => openTemplatesMenu());
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
  $('#btnCloseSettings').onclick = closeSettings;
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnProbeCli').onclick = () => refreshCliStatus();
  $('#btnSend').onclick = sendPrompt;
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


  $('#prompt').addEventListener('keydown', (e) => {
    if (handleAtKeydown(e)) return;
    if (handleSlashKeydown(e)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      // Ctrl+Shift+Enter → one-shot Craft without leaving current mode UI
      if (e.shiftKey) sendPrompt({ forceCraft: true });
      else sendPrompt();
    }
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
      requireProject().selectedDiffPath = (P() && P().currentFile);
      switchTab('diff');
      renderDiffPane();
    }
  });
  $('#btnOpenFromDiff')?.addEventListener('click', () => {
    if ((P() && P().selectedDiffPath)) openFile((P() && P().selectedDiffPath));
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
  $('#filesPanel')?.classList.toggle('collapsed', state.filesCollapsed);
  syncFilesRail();
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
}

function toggleTerm() {
  state.termCollapsed = !state.termCollapsed;
  $('.terminal-wrap').classList.toggle('collapsed', state.termCollapsed);
  persistLayout();
}

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
  state.activeTab = name;
  // 记住每个项目自己的页签
  if (!opts.skipProjectWrite && P()) {
    P().activeTab = name;
  }
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));

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

// ── Work mode Craft / Plan / Ask ────────────────────────
const MODE_HINTS = {
  craft: { zh: '飞行模式 · 直接动手', en: 'Flight mode · act now' },
  plan: { zh: '先方案 · 说「执行」再改代码', en: 'Plan first · say “execute” to act' },
  ask: { zh: '只读问答 · 不改磁盘', en: 'Read-only · no disk writes' },
};

const MODE_SEND = {
  craft: { zh: 'Grok it', en: 'Grok it' },
  plan: { zh: '规划', en: 'Plan' },
  ask: { zh: '提问', en: 'Ask' },
};

const MODE_PLACEHOLDER = {
  craft: {
    zh: 'Craft · 告诉 Grok 要改什么… Ctrl+Enter 起飞',
    en: 'Craft · what should we ship? Ctrl+Enter',
  },
  plan: {
    zh: 'Plan · 描述目标，先拿方案…',
    en: 'Plan · describe the goal, get a plan first…',
  },
  ask: {
    zh: 'Ask · 只读提问，不会改磁盘…',
    en: 'Ask · read-only questions, no disk writes…',
  },
};

const MODE_RUN_STATUS = {
  craft: { zh: 'Craft · 飞行中', en: 'Craft · in flight' },
  plan: { zh: 'Plan · 规划中', en: 'Plan · planning' },
  ask: { zh: 'Ask · 分析中', en: 'Ask · analyzing' },
};

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
  const m = state.workMode || 'craft';
  const s = MODE_SEND[m] || MODE_SEND.craft;
  send.textContent = localeIsEn() ? s.en : s.zh;
}

function applyModePlaceholder() {
  const ta = document.getElementById('prompt');
  if (!ta) return;
  const m = state.workMode || 'craft';
  const p = MODE_PLACEHOLDER[m] || MODE_PLACEHOLDER.craft;
  ta.placeholder = localeIsEn() ? p.en : p.zh;
}

function setWorkMode(mode, opts = {}) {
  const m = ['craft', 'plan', 'ask'].includes(mode) ? mode : 'craft';
  state.workMode = m;
  saveJson(MODE_KEY, m);
  document.body.dataset.workMode = m;
  document.querySelectorAll('.mode-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === m);
  });
  const loc = localeIsEn() ? 'en' : 'zh';
  const hint = MODE_HINTS[m];
  const el = document.getElementById('modeHint');
  if (el && hint) el.textContent = loc === 'en' ? hint.en : hint.zh;
  applySendLabel();
  applyModePlaceholder();
  // status bar mode chip
  let sb = document.getElementById('sbMode');
  if (!sb) {
    const foot = document.querySelector('.statusbar');
    if (foot) {
      sb = document.createElement('span');
      sb.id = 'sbMode';
      sb.className = 'sb-mode';
      sb.setAttribute('role', 'button');
      sb.tabIndex = 0;
      const brand = foot.querySelector('.sb-brand');
      if (brand?.nextSibling) foot.insertBefore(sb, brand.nextSibling);
      else foot.prepend(sb);
    }
  }
  if (sb) {
    sb.textContent = m.toUpperCase();
    sb.dataset.mode = m;
    const tip = hint ? (loc === 'en' ? hint.en : hint.zh) : m;
    sb.title = (loc === 'en' ? 'Click to cycle mode · ' : '点击切换模式 · ') + tip;
  }
  if (opts.toast) {
    toast(loc === 'en' ? `Mode: ${m}` : `模式：${m.toUpperCase()}`, 'ok');
  }
  if (opts.persistRemote !== false) {
    window.grok.setConfig({ workMode: m }).catch(() => {});
  }
}

function cycleWorkMode() {
  const order = ['craft', 'plan', 'ask'];
  const i = order.indexOf(state.workMode || 'craft');
  setWorkMode(order[(i + 1) % order.length], { toast: true });
}

function bindWorkModeUi() {
  document.querySelectorAll('.mode-chip').forEach((btn) => {
    btn.onclick = () => setWorkMode(btn.dataset.mode, { toast: true });
  });
  // Ctrl+1/2/3 → Craft / Plan / Ask
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // Ctrl+Shift+Enter → one-shot Craft (handled on prompt)
    if (e.shiftKey) return;
    if (e.key === '1') {
      e.preventDefault();
      setWorkMode('craft', { toast: true });
    } else if (e.key === '2') {
      e.preventDefault();
      setWorkMode('plan', { toast: true });
    } else if (e.key === '3') {
      e.preventDefault();
      setWorkMode('ask', { toast: true });
    }
  });
  // status badge click cycles mode
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'sbMode') cycleWorkMode();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target?.id === 'sbMode' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      cycleWorkMode();
    }
  });
  setWorkMode(state.workMode || 'craft', { persistRemote: false });
}
window.setWorkMode = setWorkMode;
window.cycleWorkMode = cycleWorkMode;
window.applySendLabel = applySendLabel;
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

async function setModelPreset(id, opts = {}) {
  state.model = id == null ? '' : String(id).trim();
  saveJson(MODEL_KEY, state.model);
  applyModelChip();
  try {
    await window.grok.setConfig({ model: state.model });
    const cfgInput = document.getElementById('cfgModel');
    if (cfgInput) cfgInput.value = state.model;
  } catch {
    /* ignore */
  }
  if (opts.toast !== false) {
    toast(
      localeIsEn()
        ? `Model: ${modelLabel(state.model)}`
        : `模型：${modelLabel(state.model)}`,
      'ok'
    );
  }
  document.getElementById('modelMenu')?.classList.add('hidden');
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
  let menu = document.getElementById('modelMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'modelMenu';
    menu.className = 'model-menu hidden';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
  }
  const openMenu = () => {
    menu.innerHTML = MODEL_PRESETS.map(
      (p) =>
        `<button type="button" class="model-menu-item${(state.model || '') === p.id ? ' active' : ''}" data-id="${esc(p.id)}" role="menuitem">${esc(p.label)}</button>`
    ).join('');
    // custom
    menu.innerHTML += `<button type="button" class="model-menu-item" data-act="custom" role="menuitem">${localeIsEn() ? 'Custom…' : '自定义…'}</button>`;
    const rect = chip.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    menu.classList.remove('hidden');
    menu.querySelectorAll('.model-menu-item').forEach((btn) => {
      btn.onclick = async () => {
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
  };
  chip.onclick = (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else menu.classList.add('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== chip) menu.classList.add('hidden');
  });
  // hydrate from config later in init; local fallback
  const local = loadJson(MODEL_KEY, null);
  if (typeof local === 'string') state.model = local;
  applyModelChip();
}
window.setModelPreset = setModelPreset;
window.getComposerModel = () => state.model || '';
window.navigateDiffFile = navigateDiffFile;
window.markDiffReviewed = markDiffReviewed;

// ── Slash commands in composer ──────────────────────────
const SLASH_COMMANDS = () => [
  { id: 'craft', label: '/craft', desc: localeIsEn() ? 'Switch to Craft' : '切换 Craft 飞行', run: () => setWorkMode('craft', { toast: true }) },
  { id: 'plan', label: '/plan', desc: localeIsEn() ? 'Switch to Plan' : '切换 Plan', run: () => setWorkMode('plan', { toast: true }) },
  { id: 'ask', label: '/ask', desc: localeIsEn() ? 'Switch to Ask' : '切换 Ask', run: () => setWorkMode('ask', { toast: true }) },
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
function pushLiveEvent({ kind, title, sub, running = false, projectId = null }) {
  const proj = projectId ? window.ProjectStore.get(projectId) : P();
  if (proj) {
    if (!Array.isArray(proj.activity)) proj.activity = [];
    proj.activity.push({ kind, title, sub, ts: Date.now() });
    const maxKeep = window.GrokLiveVirtual?.MAX_KEEP || 500;
    if (proj.activity.length > maxKeep) proj.activity = proj.activity.slice(-maxKeep);
  }

  // 仅当前激活项目刷新 DOM
  if (!proj || !P() || proj.id !== P().id) {
    updateLiveStats();
    return;
  }

  // Always rebuild through filter so chips stay consistent
  rebuildLiveTimeline(proj);
  updateLiveStats();
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

function turnKeyOfCheckpoint(cp, fallbackIdx = 0) {
  if (!cp) return null;
  return cp.turnId || `ts-${cp.ts || fallbackIdx}`;
}

/** Scrub all files to checkpoints matching turn key */
function scrubToTurn(turnKey) {
  state.diffScrubTurn = turnKey || null;
  if (!turnKey) {
    for (const [, e] of changesMap()) {
      e.viewCheckpoint = -1;
      e.compareA = null;
      e.compareB = null;
    }
    renderDiffPane();
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
  renderDiffPane();
}

function fileHasTurn(filePath, turnKey) {
  if (!turnKey || !filePath) return true;
  const e = changesMap().get(filePath);
  if (!e) return false;
  return (e.checkpoints || []).some((c, i) => turnKeyOfCheckpoint(c, i) === turnKey);
}

function scrubberHtml(turns) {
  if (!turns.length) return '';
  const en = localeIsEn();
  const cur = state.diffScrubTurn;
  const idx = cur ? turns.findIndex((t) => t.key === cur) : -1;
  return `<div class="diff-scrub-bar" id="diffScrubBar">
    <span class="diff-scrub-label">Turn timeline</span>
    <button type="button" class="diff-cp-chip${!cur ? ' active' : ''}" data-scrub="">${en ? 'All / Live' : '全部 / Live'}</button>
    <input type="range" id="diffScrubRange" min="0" max="${Math.max(0, turns.length - 1)}" value="${idx >= 0 ? idx : turns.length - 1}" ${turns.length < 2 ? 'disabled' : ''} />
    <div class="diff-scrub-ticks">
      ${turns
        .map((t, i) => {
          const label = t.ts ? new Date(t.ts).toLocaleTimeString() : `#${i + 1}`;
          const n = t.files?.size || 0;
          return `<button type="button" class="diff-scrub-tick${cur === t.key ? ' active' : ''}" data-scrub="${esc(t.key)}" title="${esc(t.taskTitle || '')} · ${n} files · ${esc(String(t.prompt || '').slice(0, 80))}">${esc(label)}<small>${n}f</small></button>`;
        })
        .join('')}
    </div>
  </div>`;
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
  const cpBar =
    cps.length > 0
      ? `<div class="diff-cp-bar">
          <span class="diff-cp-label">Checkpoints</span>
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
        </div>`
      : '';

  const viewOps = snap?.ops || cur.ops;
  const bodyHtml =
    viewMode === 'split'
      ? window.DiffUtil.toSideBySideHtml(viewOps, { context: 3, blame })
      : window.DiffUtil.toUnifiedHtml(viewOps, {
          context: 3,
          collapsed: state.diffHunkCollapsed,
          blame,
        });

  // stats reflect current view
  if (snap?.stats && !cur.restored) {
    const bits2 = [
      `<span class="a" style="color:var(--ok)">+${snap.stats.adds}</span> · <span class="d" style="color:var(--danger)">-${snap.stats.dels}</span>`,
    ];
    if (snap.index >= 0) bits2.push(`<span style="color:#fbbf24">· cp#${snap.index + 1}</span>`);
    if (cur.reviewed) bits2.push('<span style="color:#7dd3fc">· 已审阅</span>');
    $('#diffStats').innerHTML = bits2.join(' ');
  }

  const globalTurns = collectGlobalTurns();
  content.innerHTML =
    scrubberHtml(globalTurns) +
    banner +
    cpBar +
    `<div class="diff-hunk-toolbar">
      <button type="button" class="link-btn${viewMode === 'unified' ? ' active-view' : ''}" data-diff-act="unified">Unified</button>
      <button type="button" class="link-btn${viewMode === 'split' ? ' active-view' : ''}" data-diff-act="split">Side-by-side</button>
      ${
        viewMode === 'unified'
          ? `<button type="button" class="link-btn" data-diff-act="expand">全部展开</button>
      <button type="button" class="link-btn" data-diff-act="collapse">全部折叠</button>`
          : ''
      }
      <button type="button" class="link-btn${state.diffHeatLegend ? ' active-view' : ''}" data-diff-act="heat-legend">${localeIsEn() ? 'Heat legend' : '热力图例'}</button>
      <span class="muted" style="font-size:11px"><kbd>j</kbd>/<kbd>k</kbd> 文件 · <kbd>a</kbd> 审阅 · <kbd>s</kbd> 切换视图</span>
    </div>` +
    heatLegendHtml() +
    bodyHtml;

  bindDiffBlameTooltips(content, blame);

  // turn scrubber
  content.querySelectorAll('[data-scrub]').forEach((btn) => {
    btn.onclick = () => scrubToTurn(btn.dataset.scrub || null);
  });
  const range = content.querySelector('#diffScrubRange');
  if (range && globalTurns.length) {
    range.oninput = () => {
      const i = Number(range.value);
      const t = globalTurns[i];
      if (t) scrubToTurn(t.key);
    };
  }
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
  if (state.workMode === 'ask') {
    appendTerm('Ask 模式：已拦截终端命令。请切换到 Craft / Plan。', 'err');
    toast('Ask 模式禁止终端写操作', 'err');
    return;
  }
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

function bindAgentEvents() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [
    window.grok.on('agent:status', (d) => {
      const task = taskFromEvent(d);
      if (!task?.running) return;
      if (isActiveTask(task)) {
        setAgentStatus(d.detail || d.status, true);
        setLivePhase(d.detail || d.status || 'running', `${task.title} · CLI`);
      }
      renderTaskTabs();
    }),
    window.grok.on('agent:text', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      task.streamBuf = d.text ?? task.streamBuf;
      if (d.delta && !d.text) task.streamBuf += d.delta;
      scheduleStreamPaint(task);
    }),
    window.grok.on('agent:thought', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      task.thoughtBuf = d.text ?? task.thoughtBuf;
      if (d.delta && !d.text) task.thoughtBuf += d.delta;
      if (task.thoughtRaf) return;
      task.thoughtRaf = requestAnimationFrame(() => {
        task.thoughtRaf = null;
        upsertThought(task.thoughtBuf, true, task);
      });
      if (isActiveTask(task) && task.running) {
        setLivePhase('thinking…', task.title);
      }
    }),
    window.grok.on('agent:tool_start', (d) => {
      const task = taskFromEvent(d);
      if (!task) return;
      const proj = window.ProjectStore.get(task.projectId);
      appendToolStart(d, task);
      task.toolCount += 1;
      const fpath = window.DiffUtil.extractPathFromTool(d.name, d.args || {});
      const write = window.DiffUtil.isWriteTool(d.name);
      if (write) task.writeCount = (task.writeCount || 0) + 1;
      if (fpath && isActiveTask(task)) cacheFileBefore(fpath);
      pushLiveEvent({
        kind: write ? 'write' : 'tool',
        title: `[${task.title}] ${d.name || 'tool'}`,
        sub: fpath || summarizeToolSub(d.name, d.args),
        running: true,
        projectId: task.projectId,
      });
      if (isActiveTask(task)) {
        setLivePhase(write ? 'writing…' : `${d.name || 'tool'}…`, fpath || task.title);
        if (fpath && state.followAgent) {
          setLiveFocus(fpath, contentCacheMap().get(fpath) || '');
        }
      }
      updateLiveStats();
      renderTaskTabs();
      renderProjectTabs();
    }),
    window.grok.on('agent:tool_end', (d) => {
      const task = taskFromEvent(d);
      appendToolEnd(d, task);
      const fpath = window.DiffUtil.extractPathFromTool(d.name, d.args || {});
      const proj = task ? window.ProjectStore.get(task.projectId) : null;
      if (fpath && window.DiffUtil.isWriteTool(d.name) && proj) {
        recordFileChangeForProject(proj, fpath, { reason: 'write' });
      } else if (fpath && window.DiffUtil.isReadTool(d.name)) {
        if (isActiveTask(task)) {
          cacheFileBefore(fpath).then(() => {
            if (state.followAgent) openFile(fpath, { fromAgent: true, switchToCode: false });
          });
        }
        pushLiveEvent({
          kind: 'tool',
          title: `已读 ${fpath}`,
          sub: task ? task.title : d.name,
          projectId: task?.projectId,
        });
      } else {
        pushLiveEvent({
          kind: 'tool',
          title: `${d.name || 'tool'} 完成`,
          sub: fpath || (d.ok === false ? '可能失败' : 'ok'),
          projectId: task?.projectId,
        });
      }
      if (isActiveTask(task)) scheduleTreeRefresh();
    }),
    window.grok.on('agent:error', (d) => {
      const task = taskFromEvent(d);
      if (task) {
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
      if (d?.sessionId) task.sessionId = d.sessionId;
      flushStreamPaint(task);
      finalizeLiveMessages(task);
      task.running = false;
      const fileCount = proj?.changes?.size || 0;
      pushLiveEvent({
        kind: 'done',
        title: `${task.title} 完成`,
        sub: `${task.toolCount} tools · ${fileCount} files`,
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
          fileCount ? `捕获 ${fileCount} 个文件变更` : '无文件变更'
        );
        if (nRun === 0) setAgentStatus('待命', false);
        scheduleTreeRefresh(true);
      }
      // background / unfocused flight complete signal
      notifyFlightComplete(task, {
        files: fileCount,
        tools: task.toolCount || 0,
        mode: task.turnMode || 'craft',
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

function scheduleStreamPaint(task) {
  task = task || T();
  if (!task) return;
  if (task.streamRaf) return;
  task.streamRaf = requestAnimationFrame(() => {
    task.streamRaf = null;
    upsertAssistant(task.streamBuf, true, task);
  });
}

function flushStreamPaint(task) {
  task = task || T();
  if (!task) return;
  if (task.streamRaf) {
    cancelAnimationFrame(task.streamRaf);
    task.streamRaf = null;
  }
  if (task.thoughtRaf) {
    cancelAnimationFrame(task.thoughtRaf);
    task.thoughtRaf = null;
  }
  if (task.streamBuf) upsertAssistant(task.streamBuf, true, task);
  if (task.thoughtBuf) upsertThought(task.thoughtBuf, false, task);
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

  const modeUsed =
    opts.forceCraft || opts.workMode === 'craft'
      ? 'craft'
      : opts.workMode || state.workMode || cfg.workMode || 'craft';
  if (opts.forceCraft && state.workMode !== 'craft') {
    toast(localeIsEn() ? 'One-shot Craft' : '单次 Craft 起飞', 'ok');
  }

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
  task.turnId = `turn-${Date.now()}`;
  task.streamBuf = '';
  task.thoughtBuf = '';
  task.liveAssistantEl = null;
  task.liveThoughtEl = null;
  task.toolCount = 0;
  task.writeCount = 0;
  task.turnMode = modeUsed;
  task.lastError = null;
  setRunningUi(true);
  {
    const st = MODE_RUN_STATUS[modeUsed] || MODE_RUN_STATUS.craft;
    setAgentStatus(localeIsEn() ? st.en : st.zh, true);
  }
  startElapsed(task);
  ensureLiveAssistant(task);
  renderTaskTabs();

  if (state.followAgent || state.activeTab === 'live') switchTab('live');
  pushLiveEvent({
    kind: 'status',
    title: `${task.title} ${opts.isRetry ? '重试' : modeUsed === 'craft' ? 'Craft' : '开始'}`,
    sub: text.slice(0, 100),
  });
  setLivePhase(
    modeUsed === 'craft' ? (localeIsEn() ? 'Craft flight…' : 'Craft 飞行中…') : 'grokking…',
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
    });
    flushStreamPaint(task);

    const finalText = result?.text || task.streamBuf || '';
    if (result?.sessionId) task.sessionId = result.sessionId;
    if (result?.context) {
      task.context = result.context;
      task.contextTiers = result.contextTiers || result.context.tiers;
    }
    if (result?.resumedFallback) {
      toast(t('chat.resumeFallback'), 'ok');
    }
    if (finalText) {
      task.streamBuf = finalText;
      upsertAssistant(finalText, true, task);
      if (!Array.isArray(task.messages)) task.messages = [];
      task.messages.push({ role: 'assistant', content: finalText, ts: Date.now() });
    } else if (!result?.stopped) {
      upsertAssistant('（无文本输出 — 可能只做了工具操作，请看资源管理器 / Diff）', true, task);
    }
    finalizeLiveMessages(task);
    // Plan：模式标志 或 回复像可执行方案 → 一键执行条
    const wasExec =
      /^(执行|开干|按方案|implement|execute|do it|lgtm|开搞)/i.test(String(text || '').trim());
    if (
      !wasExec &&
      !result?.stopped &&
      finalText &&
      modeUsed !== 'ask' &&
      (modeUsed === 'plan' || looksLikePlan(finalText))
    ) {
      appendPlanExecuteBar(task, {
        autoDetected: modeUsed !== 'plan' && looksLikePlan(finalText),
      });
    }
    // Craft mission summary
    if (modeUsed === 'craft' && !result?.stopped) {
      const filesAfter = P()?.changes?.size || 0;
      const filesDelta = Math.max(0, filesAfter - filesBefore);
      appendCraftMissionBar(task, {
        tools: task.toolCount || 0,
        writes: task.writeCount || 0,
        files: filesDelta || filesAfter,
      });
    }
    // Skills 匹配提示
    showSkillHints(text, task).catch(() => {});
    await refreshTaskContext(task);
    schedulePersist(true);
    if (isActiveTask(task)) renderContextTiers(task);
  } catch (err) {
    const msg = err.message || String(err);
    task.lastError = msg;
    upsertAssistant(t('chat.error', `错误：${msg}`, { msg }), true, task);
    finalizeLiveMessages(task);
    appendRetryBar(task, text, msg);
    if (isActiveTask(task)) {
      setAgentStatus(t('live.phase.error', '出错'), false, true);
      setLivePhase(t('live.phase.error', '出错'), msg);
    }
    toast(msg || t('live.phase.error'), 'err');
  } finally {
    clearInterval(liveTick);
    task.running = false;
    task.liveAssistantEl = null;
    task.liveThoughtEl = null;
    stopElapsed(task);
    schedulePersist(true);
    if (isActiveTask(task)) {
      setRunningUi(false);
      $('#livePulse')?.classList.toggle('on', anyRunning());
      $('#liveBadge')?.classList.toggle('hidden', !anyRunning());
      if (!$('#agentStatus').classList.contains('error')) {
        const idle =
          (state.workMode || 'craft') === 'craft'
            ? localeIsEn()
              ? 'Craft ready'
              : 'Craft 待命'
            : localeIsEn()
              ? 'Ready'
              : '待命';
        setAgentStatus(idle, false);
        if ($('#livePhase')?.textContent !== t('live.phase.error', '出错')) {
          const r = window.TaskStore.countRunning();
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
    renderTaskTabs();
    updateLiveStats();
    scheduleTreeRefresh(true);
  }
}

/** Craft 回合后：任务简报（工具 / 写入 / Diff 文件） */
function appendCraftMissionBar(task, stats = {}) {
  if (!task?.pane) return;
  const tools = Number(stats.tools) || 0;
  const writes = Number(stats.writes) || 0;
  const files = Number(stats.files) || 0;
  if (tools === 0 && writes === 0 && files === 0) return;
  task.pane.querySelectorAll('.craft-mission-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'craft-mission-bar';
  const en = localeIsEn();
  bar.innerHTML = `
    <span class="craft-mission-label">CRAFT</span>
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

/** Plan / 自动识别方案：确认后一键执行 */
function appendPlanExecuteBar(task, opts = {}) {
  if (!task?.pane) return;
  task.pane.querySelectorAll('.plan-exec-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'plan-exec-bar' + (opts.autoDetected ? ' plan-exec-auto' : '');
  const hint = opts.autoDetected
    ? '检测到方案结构 · 确认后切换 Craft 并执行'
    : '方案已就绪 · 确认后切换 Craft 并执行';
  bar.innerHTML = `
    <span class="plan-exec-hint">${hint}</span>
    <div class="retry-actions">
      <button type="button" class="btn small primary" data-act="exec">▶ 执行方案</button>
      <button type="button" class="btn small ghost" data-act="dismiss">稍后</button>
    </div>`;
  bar.querySelector('[data-act="exec"]').onclick = () => {
    bar.remove();
    setWorkMode('craft');
    const prompt = document.getElementById('prompt');
    if (prompt) {
      prompt.value = '执行方案：按你上一条给出的步骤动手实现，保持聚焦，改完做必要检查。';
      autoResizePrompt();
      updateCharCount();
    }
    runTaskPrompt(task, '执行方案：按你上一条给出的步骤动手实现，保持聚焦，改完做必要检查。', {
      fromComposer: false,
      forceCraft: true,
    });
  };
  bar.querySelector('[data-act="dismiss"]').onclick = () => bar.remove();
  task.pane.appendChild(bar);
  scrollMessages(true, task);
}

/** Heuristic: assistant reply looks like an actionable plan */
function looksLikePlan(text) {
  const t = String(text || '');
  if (t.length < 60) return false;
  let score = 0;
  if (/(目标|步骤|涉及文件|风险|实施计划|执行步骤|plan|steps?|risks?|files?\s*(to\s*)?(change|touch)?)/i.test(t)) {
    score += 2;
  }
  const nums = t.match(/(^|\n)\s*(\d+[\.\)、]|[一二三四五六七八九十]+[、\.\)])\s+\S+/g);
  if (nums && nums.length >= 2) score += 3;
  else if (nums && nums.length === 1) score += 1;
  const bullets = t.match(/(^|\n)\s*[-*•]\s+\S+/g);
  if (bullets && bullets.length >= 3) score += 2;
  if (/(接下来|然后|首先|最后|TODO|实施|改动)/i.test(t)) score += 1;
  if (/`[^`]+\.(js|ts|tsx|py|go|rs|java|css|html|md)`/i.test(t) || /[\w./\\-]+\.(js|ts|tsx|py)\b/.test(t)) {
    score += 1;
  }
  // long pure code dump is not a plan
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
  const mode = state.workMode || 'craft';
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

/** 失败后可一键重试 / 清空 session 重试 / 导出诊断 */
function appendRetryBar(task, promptText, errMsg) {
  if (!task?.pane) return;
  task.pane.querySelectorAll('.retry-bar').forEach((el) => el.remove());
  const bar = document.createElement('div');
  bar.className = 'retry-bar';
  bar.innerHTML = `
    <span class="retry-hint">${esc(t('chat.retryHint'))}</span>
    <div class="retry-actions">
      <button type="button" class="btn small primary" data-act="retry">${esc(t('chat.retry'))}</button>
      <button type="button" class="btn small ghost" data-act="fresh">${esc(t('chat.retryFresh'))}</button>
      <button type="button" class="btn small ghost" data-act="diag">${esc(t('chat.exportDiag'))}</button>
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

async function stopAgent() {
  const task = T();
  if (!task) return;
  await window.grok.stopAgent({ projectId: pid(), taskId: task.id });
  task.running = false;
  if (isActiveTask(task)) {
    setAgentStatus('已停止', false);
    setRunningUi(false);
    stopElapsed(task);
  }
  renderTaskTabs();
  toast(t('chat.stopped', `已停止：${task.title}`, { title: task.title }));
}

function setRunningUi(on) {
  // 仅影响当前任务的发送/停止按钮
  const task = T();
  const running = on || Boolean(task?.running);
  $('#btnSend').disabled = Boolean(task?.running);
  $('#btnStop').classList.toggle('hidden', !task?.running);
  applySendLabel();
  document.body.classList.toggle('craft-inflight', Boolean(task?.running && (task.turnMode || state.workMode) === 'craft'));
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
  $('#sbAgent').textContent = text;
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
    el.className = 'msg assistant';
    el.dataset.live = '1';
    if (task.turnId) el.dataset.turn = task.turnId;
    el.innerHTML = `<div class="role">Grok</div><div class="body stream-body"></div>`;
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
  if (streaming) {
    el.dataset.live = '1';
    body.classList.remove('md');
    body.classList.add('stream-body');
    body.textContent = text || '';
  } else {
    body.classList.add('md');
    body.classList.remove('stream-body');
    body.innerHTML = renderMarkdown(text || '');
    delete el.dataset.live;
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
    const text = task.streamBuf || body.textContent || '';
    body.classList.add('md');
    body.classList.remove('stream-body');
    body.innerHTML = renderMarkdown(text);
    delete el.dataset.live;
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
    summary.textContent = 'Thinking…';
    el.classList.add('collapsed');
  } else {
    summary.textContent = `Thinking · ${(text || '').length} 字 · 点击展开`;
    el.classList.add('collapsed');
  }
  scrollMessages(false, task);
}

function appendToolStart(d, task) {
  task = task || T();
  if (!task) return;
  const box = task.pane;
  const div = document.createElement('div');
  div.className = 'msg tool running';
  div.dataset.toolId = d.id;
  if (task.turnId) div.dataset.turn = task.turnId;
  div.innerHTML = `
    <div class="role">Tool</div>
    <div class="body">
      <div class="name">⚙ ${esc(d.name)}</div>
      <div class="args">${esc(JSON.stringify(summarizeArgs(d.name, d.args), null, 0))}</div>
      <div class="result">running…</div>
    </div>`;
  const asst = task.liveAssistantEl;
  if (asst?.parentNode === box) box.insertBefore(div, asst);
  else box.appendChild(div);
  scrollMessages(false, task);
}

function appendToolEnd(d, task) {
  task = task || T();
  const scope = task?.pane || document;
  let div = scope.querySelector?.(`.msg.tool[data-tool-id="${cssEscape(d.id)}"]`);
  if (!div && task) {
    appendToolStart(d, task);
    div = task.pane.querySelector(`.msg.tool[data-tool-id="${cssEscape(d.id)}"]`);
  }
  div?.classList.remove('running');
  const el = div?.querySelector('.result');
  if (el) {
    const full = String(d.result || '');
    const preview = full.slice(0, 500);
    el.textContent = preview + (full.length > 500 ? '…（点击展开）' : '');
    el.title = '点击展开/收起';
    el.onclick = () => {
      el.classList.toggle('expanded');
      if (el.classList.contains('expanded')) el.textContent = full || '（空）';
      else el.textContent = preview + (full.length > 500 ? '…（点击展开）' : '');
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
  $('#settingsModal').classList.remove('hidden');
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
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
  $('#cfgGrokPath').value = cfg.grokPath || '';
  $('#cfgRounds').value = cfg.maxTurns || 30;
  $('#cfgYolo').checked = cfg.alwaysApprove !== false;
  $('#cfgRules').value = cfg.rules || '';

  state.model = cfg.model || '';
  saveJson(MODEL_KEY, state.model);
  applyModelChip();

  window.GrokSettingsExtra?.fillFromConfig?.(cfg);

  if (cfg.workspace) {
    state.workspace = cfg.workspace;
    setWorkspaceLabel(cfg.workspace);
  }
}

async function saveSettings() {
  const partial = {
    model: $('#cfgModel').value.trim(),
    grokPath: $('#cfgGrokPath').value.trim(),
    maxTurns: Number($('#cfgRounds').value) || 30,
    alwaysApprove: $('#cfgYolo').checked,
    rules: $('#cfgRules').value,
    ...(window.GrokSettingsExtra?.collectPartial?.() || {}),
  };
  const key = $('#cfgApiKey').value.trim();
  if (key) partial.apiKey = key;
  await window.grok.setConfig(partial);
  state.model = partial.model || '';
  saveJson(MODEL_KEY, state.model);
  applyModelChip();
  window.refreshRulesChip?.();
  closeSettings();
  await refreshCliStatus();
  toast(t('toast.saved', '设置已保存'), 'ok');
}

const toast = U.toast || window.toast || ((msg) => console.log(msg));
window.toast = toast;

init().catch((err) => {
  console.error(err);
  toast('初始化失败: ' + err.message, 'err');
});
