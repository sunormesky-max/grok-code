/**
 * 多任务 — 绑定到当前 ProjectStore 活跃项目
 * 每个项目有自己的 tasks[] / activeTaskId / 消息 pane
 */
(function (global) {
  function project() {
    return global.ProjectStore?.active?.() || null;
  }

  function uid() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function ensureProjectTasks(p) {
    if (!p.tasks) p.tasks = [];
    return p.tasks;
  }

  function create(opts = {}) {
    const p = project();
    if (!p) throw new Error('没有活跃项目');
    p.taskSeq = (p.taskSeq || 0) + 1;
    const id = opts.id || uid();
    const host = document.getElementById('messagesHost');
    const pane = document.createElement('div');
    pane.className = 'messages';
    pane.dataset.taskId = id;
    pane.dataset.projectId = p.id;
    pane.hidden = true;
    host.appendChild(pane);

    const task = {
      id,
      projectId: p.id,
      title: opts.title || `任务 ${p.taskSeq}`,
      sessionId: opts.sessionId || null,
      running: false,
      streamBuf: '',
      thoughtBuf: '',
      streamRaf: null,
      thoughtRaf: null,
      toolCount: 0,
      turnId: null,
      liveAssistantEl: null,
      liveThoughtEl: null,
      elapsedStart: 0,
      elapsedTimer: null,
      pane,
      createdAt: opts.createdAt || Date.now(),
      pinned: Boolean(opts.pinned),
      /** 完整对话日志（持久化 / 压缩用） */
      messages: Array.isArray(opts.messages) ? opts.messages.slice() : [],
      /** 四档上下文 */
      context: opts.context || null,
      contextTiers: opts.contextTiers || null,
    };
    ensureProjectTasks(p).push(task);
    return task;
  }

  function list() {
    const p = project();
    if (!p) return [];
    // pinned first, preserve relative order within each group
    const tasks = ensureProjectTasks(p).slice();
    const pinned = tasks.filter((t) => t.pinned);
    const rest = tasks.filter((t) => !t.pinned);
    return pinned.concat(rest);
  }

  function togglePin(id) {
    const t = get(id);
    if (!t) return null;
    t.pinned = !t.pinned;
    return t;
  }

  /** Reorder within project tasks array (0-based target index in full array) */
  function move(id, toIndex) {
    const p = project();
    if (!p) return false;
    const tasks = ensureProjectTasks(p);
    const from = tasks.findIndex((t) => t.id === id);
    if (from < 0) return false;
    const [item] = tasks.splice(from, 1);
    const idx = Math.max(0, Math.min(Number(toIndex) || 0, tasks.length));
    tasks.splice(idx, 0, item);
    return true;
  }

  function get(id) {
    // 全局查找（事件路由可能跨项目）
    for (const p of global.ProjectStore.list()) {
      const t = (p.tasks || []).find((x) => x.id === id);
      if (t) return t;
    }
    return null;
  }

  function active() {
    const p = project();
    if (!p) return null;
    const tasks = ensureProjectTasks(p);
    return tasks.find((t) => t.id === p.activeTaskId) || tasks[0] || null;
  }

  function setActive(id) {
    const p = project();
    if (!p) return null;
    const t = (p.tasks || []).find((x) => x.id === id);
    if (!t) return null;
    p.activeTaskId = id;
    // 只显示当前项目 + 当前任务的 pane
    document.querySelectorAll('#messagesHost .messages').forEach((pane) => {
      const show = pane.dataset.projectId === p.id && pane.dataset.taskId === id;
      pane.hidden = !show;
    });
    return t;
  }

  function remove(id) {
    const p = project();
    if (!p) return null;
    const tasks = ensureProjectTasks(p);
    if (tasks.length <= 1) return null;
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const [t] = tasks.splice(idx, 1);
    t.pane?.remove();
    if (p.activeTaskId === id) {
      const next = tasks[Math.max(0, idx - 1)];
      setActive(next.id);
    }
    return t;
  }

  function countRunning() {
    return list().filter((t) => t.running).length;
  }

  function countRunningAll() {
    let n = 0;
    for (const p of global.ProjectStore.list()) {
      n += (p.tasks || []).filter((t) => t.running).length;
    }
    return n;
  }

  function titleFromPrompt(text) {
    const s = String(text || '').trim().replace(/\s+/g, ' ');
    if (!s) return null;
    return s.length > 16 ? s.slice(0, 16) + '…' : s;
  }

  /** 切换项目时刷新 pane 可见性 */
  function onProjectSwitch() {
    const p = project();
    if (!p) {
      document.querySelectorAll('#messagesHost .messages').forEach((pane) => {
        pane.hidden = true;
      });
      return;
    }
    const tasks = ensureProjectTasks(p);
    if (!tasks.length) return;
    if (!p.activeTaskId || !tasks.find((t) => t.id === p.activeTaskId)) {
      p.activeTaskId = tasks[0].id;
    }
    setActive(p.activeTaskId);
  }

  /** 隐藏非当前项目的 panes */
  function hideOtherProjects() {
    const p = project();
    document.querySelectorAll('#messagesHost .messages').forEach((pane) => {
      if (!p || pane.dataset.projectId !== p.id) pane.hidden = true;
    });
  }

  global.TaskStore = {
    create,
    get,
    active,
    list,
    setActive,
    remove,
    move,
    togglePin,
    countRunning,
    countRunningAll,
    titleFromPrompt,
    onProjectSwitch,
    hideOtherProjects,
    get activeId() {
      return project()?.activeTaskId || null;
    },
  };
})(window);
