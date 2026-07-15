/**
 * 多项目管理 — 每个项目独立路径、任务、变更、编辑器状态
 * 可同时挂载多个项目，Agent 按 projectId 并行。
 */
(function (global) {
  /** @type {Array<Project>} */
  const projects = [];
  let activeId = null;

  /**
   * @typedef {object} Project
   * @property {string} id
   * @property {string} path
   * @property {string} name
   * @property {string|null} currentFile
   * @property {boolean} dirty
   * @property {string} editorContent
   * @property {Map} changes
   * @property {Map} contentCache
   * @property {Array} activity
   * @property {string|null} selectedDiffPath
   * @property {string} activeTab
   * @property {object|null} activeTask  // 当前任务快照由 TaskStore 按项目隔离
   * @property {HTMLElement|null} messagesHost  // 可选：每项目消息容器
   * @property {Array} tasks
   * @property {string|null} activeTaskId
   * @property {number} taskSeq
   */

  function createLocal(info) {
    return {
      id: info.id,
      path: info.path,
      name: info.name || info.path.split(/[\\/]/).pop(),
      currentFile: null,
      dirty: false,
      editorContent: '',
      changes: new Map(),
      contentCache: new Map(),
      activity: [],
      selectedDiffPath: null,
      activeTab: 'live',
      // Live 面板按项目隔离
      livePhase: '待命',
      liveDetail: '丢一个任务给 Grok，这里会变成任务驾驶舱',
      focusPath: null,
      focusSnippet: '',
      tasks: [],
      activeTaskId: null,
      taskSeq: 0,
      termHistory: [],
    };
  }

  function list() {
    return projects.slice();
  }

  function get(id) {
    return projects.find((p) => p.id === id) || null;
  }

  function active() {
    return get(activeId) || projects[0] || null;
  }

  function setActive(id) {
    const p = get(id);
    if (!p) return null;
    activeId = id;
    return p;
  }

  function add(info) {
    const existing = projects.find((p) => p.path === info.path || p.id === info.id);
    if (existing) {
      // 合并服务端 id
      existing.id = info.id;
      existing.name = info.name || existing.name;
      setActive(existing.id);
      return existing;
    }
    const p = createLocal(info);
    projects.push(p);
    setActive(p.id);
    return p;
  }

  function remove(id) {
    const idx = projects.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const [p] = projects.splice(idx, 1);
    if (activeId === id) {
      activeId = projects[Math.max(0, idx - 1)]?.id || null;
    }
    return p;
  }

  function count() {
    return projects.length;
  }

  global.ProjectStore = {
    list,
    get,
    active,
    setActive,
    add,
    remove,
    count,
    get activeId() {
      return activeId;
    },
  };
})(window);
