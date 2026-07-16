const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { createAgent } = require('./agent');
const { createTools } = require('./tools');
const { resolveGrokBinary, probeGrok } = require('./grok-cli');
const { createPersist } = require('./persist');
const { compressContext, buildContextPrompt } = require('./context-compress');
const { enrichContextWithLlm } = require('./context-llm');
const { runDoctor, exportDiagnostics } = require('./diagnostics');
const { openInExternalEditor, resolveEditorBinary } = require('./external-editor');
const updater = require('./updater');
const mcpSkills = require('./mcp-skills');
const plugins = require('./plugins');
const profiles = require('./profiles');
const telemetry = require('./telemetry');
const modes = require('./modes');

const persist = createPersist();

app.setName('GrokCode');
Menu.setApplicationMenu(null);

const store = new Store({
  name: 'grok-code-config',
  defaults: {
    apiKey: process.env.XAI_API_KEY || '',
    model: '',
    grokPath: '',
    /** @type {string[]} 最近打开的项目路径 */
    recentProjects: [],
    alwaysApprove: true,
    maxTurns: 30,
    rules: '你是 Grok：锐利、直接、有态度。优先中文回复。改动聚焦需求，改完做必要检查。少废话、多干活。',
    sessions: {},
    /** projectPath -> { taskId: sessionId } */
    taskSessions: {},
    /** 首启向导是否完成 */
    onboardingDone: false,
    /** heuristic | llm — L1/L2 压缩模式 */
    contextMode: 'heuristic',
    /** auto | code | cursor | system */
    preferredEditor: 'auto',
    /** 是否允许自动检查更新 */
    autoUpdate: true,
    /** UI locale hint (renderer owns localStorage; mirrored for export) */
    locale: 'zh',
    /** theme id */
    theme: 'grok',
    /** opt-in crash telemetry */
    telemetryEnabled: false,
    telemetryEndpoint: '',
    /** craft | plan | ask */
    workMode: 'craft',
    /** default | pragmatic | teaching | warm | blunt */
    stylePack: 'default',
    /** off | standard | strict — personal dir caution for UI ops */
    personalProtect: 'standard',
    /** UI delete → recycle bin when possible */
    trashOnDelete: true,
    /** inject skill name+description index into agent prompt */
    injectSkillsIndex: true,
  },
});

let mainWindow = null;

/**
 * 多项目运行时容器
 * projectId -> {
 *   id, path, name,
 *   tools, agent,
 *   watcher,
 *   aborts: Map<taskId, AbortController>
 * }
 */
const projects = new Map();

const WATCH_IGNORE =
  /(?:^|[\\/])(?:node_modules|\.git|dist|build|\.next|__pycache__|\.venv|venv|target|coverage|\.cache)(?:[\\/]|$)/i;

function emit(event, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload);
  }
}

function getConfig() {
  const workMode = ['craft', 'plan', 'ask'].includes(store.get('workMode'))
    ? store.get('workMode')
    : 'craft';
  const stylePack = modes.STYLES[store.get('stylePack')]
    ? store.get('stylePack')
    : 'default';
  return {
    apiKey: store.get('apiKey'),
    model: store.get('model'),
    grokPath: store.get('grokPath'),
    alwaysApprove: store.get('alwaysApprove'),
    maxTurns: store.get('maxTurns'),
    rules: store.get('rules'),
    contextMode: store.get('contextMode') || 'heuristic',
    preferredEditor: store.get('preferredEditor') || 'auto',
    autoUpdate: store.get('autoUpdate') !== false,
    locale: store.get('locale') || 'zh',
    theme: store.get('theme') || 'grok',
    telemetryEnabled: Boolean(store.get('telemetryEnabled')),
    telemetryEndpoint: store.get('telemetryEndpoint') || '',
    workMode,
    stylePack,
    personalProtect: store.get('personalProtect') || 'standard',
    trashOnDelete: store.get('trashOnDelete') !== false,
    injectSkillsIndex: store.get('injectSkillsIndex') !== false,
  };
}

function reportIfEnabled(err, extra) {
  try {
    return telemetry.reportCrash(err, {
      enabled: Boolean(store.get('telemetryEnabled')),
      endpoint: store.get('telemetryEndpoint') || '',
      extra,
    });
  } catch {
    return { ok: false };
  }
}

async function compressWithMode(messages, opts = {}) {
  let context = compressContext(messages, {
    prev: opts.prevContext || {},
    projectName: opts.projectName || '',
  });
  const mode = opts.contextMode || store.get('contextMode') || 'heuristic';
  if (mode === 'llm') {
    const cfg = getConfig();
    context = await enrichContextWithLlm(context, {
      apiKey: cfg.apiKey,
      model: opts.llmModel || cfg.model || undefined,
      projectName: opts.projectName,
      taskTitle: opts.taskTitle,
    });
  } else {
    context.mode = 'heuristic';
  }
  return context;
}

function basename(p) {
  return path.basename(p.replace(/[\\/]+$/, '')) || p;
}

function makeProjectId() {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function publicProject(p) {
  return { id: p.id, path: p.path, name: p.name };
}

function findByPath(dirPath) {
  const norm = path.resolve(dirPath);
  for (const p of projects.values()) {
    if (path.resolve(p.path) === norm) return p;
  }
  return null;
}

function stopWatcher(p) {
  if (p?.watcher) {
    try {
      p.watcher.close();
    } catch {
      /* ignore */
    }
    p.watcher = null;
  }
}

function startWatcher(project) {
  stopWatcher(project);
  try {
    project.watcher = fs.watch(project.path, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (WATCH_IGNORE.test(rel) || rel.startsWith('.')) return;
      if (/\.(lock|png|jpg|jpeg|gif|webp|ico|woff2?|mp4|zip|exe|dll)$/i.test(rel)) return;
      emit('fs:changed', {
        projectId: project.id,
        path: rel,
        eventType: _eventType || 'change',
        ts: Date.now(),
      });
    });
    project.watcher.on('error', () => {});
  } catch {
    project.watcher = null;
  }
}

function openProject(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    throw new Error('路径不存在');
  }
  const existing = findByPath(dirPath);
  if (existing) return publicProject(existing);

  const id = makeProjectId();
  const tools = createTools(dirPath);
  const project = {
    id,
    path: path.resolve(dirPath),
    name: basename(dirPath),
    tools,
    agent: null,
    watcher: null,
    aborts: new Map(),
    _configOverride: null,
  };
  project.agent = createAgent({
    getConfig: () => ({ ...getConfig(), ...(project._configOverride || {}) }),
    workspaceRoot: dirPath,
    emit: (event, payload) => emit(event, { ...payload, projectId: id }),
  });
  startWatcher(project);
  projects.set(id, project);

  // 最近项目
  const recent = (store.get('recentProjects') || []).filter(
    (p) => path.resolve(p) !== project.path
  );
  recent.unshift(project.path);
  store.set('recentProjects', recent.slice(0, 12));

  return publicProject(project);
}

function closeProject(projectId) {
  const p = projects.get(projectId);
  if (!p) return false;
  // 停掉该项目所有 agent
  try {
    p.agent.stop();
  } catch {
    /* ignore */
  }
  for (const ac of p.aborts.values()) {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }
  p.aborts.clear();
  stopWatcher(p);
  projects.delete(projectId);
  return true;
}

function requireProject(projectId) {
  const p = projects.get(projectId);
  if (!p) throw new Error('项目未打开或不存在');
  return p;
}

function createWindow(opts = {}) {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#000000',
    title: 'GrokCode',
    frame: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  if (!mainWindow) mainWindow = win;

  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('GrokCode');
  });

  const sendMaxState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximized', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: opts.projectId ? { projectId: opts.projectId } : {},
  });

  win.once('ready-to-show', () => {
    win.setTitle('GrokCode');
    win.setMenuBarVisibility(false);
    win.show();
    sendMaxState();
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('closed', () => {
    if (mainWindow === win) {
      const others = BrowserWindow.getAllWindows().filter((w) => w !== win);
      mainWindow = others[0] || null;
    }
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  // 恢复最近一个项目（若存在）
  const recent = store.get('recentProjects') || [];
  if (recent[0] && fs.existsSync(recent[0])) {
    try {
      openProject(recent[0]);
    } catch {
      /* ignore */
    }
  }

  // 自动更新（仅打包后）
  if (store.get('autoUpdate') !== false) {
    try {
      updater.initUpdater({ checkOnStart: true, autoDownload: true });
    } catch (e) {
      console.warn('updater init', e);
    }
  }

  process.on('uncaughtException', (err) => {
    console.error('uncaughtException', err);
    reportIfEnabled(err, { kind: 'uncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection', reason);
    reportIfEnabled(reason instanceof Error ? reason : String(reason), {
      kind: 'unhandledRejection',
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const id of [...projects.keys()]) closeProject(id);
  if (process.platform !== 'darwin') app.quit();
});

// ── Config ──────────────────────────────────────────────
ipcMain.handle('config:get', () => {
  const probe = probeGrok(store.get('grokPath'));
  return {
    apiKey: store.get('apiKey') ? '••••••••' + String(store.get('apiKey')).slice(-4) : '',
    hasApiKey: Boolean(store.get('apiKey') || process.env.XAI_API_KEY),
    model: store.get('model') || '',
    grokPath: store.get('grokPath') || '',
    alwaysApprove: store.get('alwaysApprove') !== false,
    maxTurns: store.get('maxTurns') || 30,
    rules: store.get('rules') || '',
    recentProjects: store.get('recentProjects') || [],
    cli: probe,
    resolvedGrok: resolveGrokBinary(store.get('grokPath')),
    onboardingDone: Boolean(store.get('onboardingDone')),
    contextMode: store.get('contextMode') || 'heuristic',
    preferredEditor: store.get('preferredEditor') || 'auto',
    autoUpdate: store.get('autoUpdate') !== false,
    appVersion: app.getVersion(),
    locale: store.get('locale') || 'zh',
    theme: store.get('theme') || 'grok',
    telemetryEnabled: Boolean(store.get('telemetryEnabled')),
    telemetryEndpoint: store.get('telemetryEndpoint') || '',
    workMode: getConfig().workMode,
    stylePack: getConfig().stylePack,
    personalProtect: getConfig().personalProtect,
    trashOnDelete: getConfig().trashOnDelete,
    injectSkillsIndex: getConfig().injectSkillsIndex,
    modes: modes.listModes(),
    styles: modes.listStyles(),
  };
});

ipcMain.handle('config:set', (_e, partial) => {
  if (partial.apiKey !== undefined && !String(partial.apiKey).startsWith('••••')) {
    store.set('apiKey', String(partial.apiKey).trim());
  }
  if (partial.model !== undefined) store.set('model', String(partial.model).trim());
  if (partial.grokPath !== undefined) store.set('grokPath', String(partial.grokPath).trim());
  if (partial.alwaysApprove !== undefined) store.set('alwaysApprove', Boolean(partial.alwaysApprove));
  if (partial.maxTurns !== undefined) store.set('maxTurns', Number(partial.maxTurns) || 30);
  if (partial.rules !== undefined) store.set('rules', String(partial.rules));
  if (partial.onboardingDone !== undefined) store.set('onboardingDone', Boolean(partial.onboardingDone));
  if (partial.contextMode !== undefined) {
    const m = String(partial.contextMode) === 'llm' ? 'llm' : 'heuristic';
    store.set('contextMode', m);
  }
  if (partial.preferredEditor !== undefined) {
    const pe = String(partial.preferredEditor);
    store.set(
      'preferredEditor',
      ['auto', 'code', 'cursor', 'system'].includes(pe) ? pe : 'auto'
    );
  }
  if (partial.autoUpdate !== undefined) store.set('autoUpdate', Boolean(partial.autoUpdate));
  if (partial.locale !== undefined) {
    store.set('locale', String(partial.locale) === 'en' ? 'en' : 'zh');
  }
  if (partial.theme !== undefined) store.set('theme', String(partial.theme || 'grok'));
  if (partial.telemetryEnabled !== undefined) {
    store.set('telemetryEnabled', Boolean(partial.telemetryEnabled));
  }
  if (partial.telemetryEndpoint !== undefined) {
    store.set('telemetryEndpoint', String(partial.telemetryEndpoint || '').trim());
  }
  if (partial.workMode !== undefined) {
    const m = String(partial.workMode);
    store.set('workMode', ['craft', 'plan', 'ask'].includes(m) ? m : 'craft');
  }
  if (partial.stylePack !== undefined) {
    const s = String(partial.stylePack);
    store.set('stylePack', modes.STYLES[s] ? s : 'default');
  }
  if (partial.personalProtect !== undefined) {
    const pp = String(partial.personalProtect);
    store.set('personalProtect', ['off', 'standard', 'strict'].includes(pp) ? pp : 'standard');
  }
  if (partial.trashOnDelete !== undefined) {
    store.set('trashOnDelete', Boolean(partial.trashOnDelete));
  }
  if (partial.injectSkillsIndex !== undefined) {
    store.set('injectSkillsIndex', Boolean(partial.injectSkillsIndex));
  }
  return true;
});

ipcMain.handle('modes:list', () => ({
  modes: modes.listModes(),
  styles: modes.listStyles(),
}));

ipcMain.handle('projectRules:get', (_e, payload = {}) => {
  let projectPath = payload.projectPath || null;
  if (!projectPath && payload.projectId) {
    const p = projects.get(payload.projectId);
    projectPath = p?.path || null;
  }
  if (!projectPath) return { text: '', file: null, exists: false };
  const r = modes.readProjectRulesFile(projectPath);
  return { text: r.text || '', file: r.file, exists: Boolean(r.file) };
});

ipcMain.handle('projectRules:set', (_e, payload = {}) => {
  let projectPath = payload.projectPath || null;
  if (!projectPath && payload.projectId) {
    const p = projects.get(payload.projectId);
    projectPath = p?.path || null;
  }
  if (!projectPath) throw new Error('需要打开项目');
  return modes.writeProjectRulesFile(projectPath, payload.content ?? '');
});

ipcMain.handle('cli:probe', () => probeGrok(store.get('grokPath')));

// ── 体检 / 诊断 / 首启 ──────────────────────────────────
ipcMain.handle('doctor:run', () => {
  return runDoctor(getConfig());
});

ipcMain.handle('doctor:export', async (e) => {
  const running = [];
  for (const p of projects.values()) {
    for (const tid of p.agent.listRunning()) {
      running.push({ projectId: p.id, taskId: tid, projectName: p.name });
    }
  }
  const result = exportDiagnostics(getConfig(), {
    recentProjects: store.get('recentProjects') || [],
    runningAgents: running,
  });
  if (result.ok && result.dir) {
    try {
      shell.openPath(result.dir);
    } catch {
      /* ignore */
    }
  }
  return result;
});

ipcMain.handle('app:getVersion', () => app.getVersion());

// ── 外部编辑器 ──────────────────────────────────────────
ipcMain.handle('editor:open', (_e, payload = {}) => {
  const preferred = payload.preferred || store.get('preferredEditor') || 'auto';
  let abs = payload.absPath || payload.path;
  if (!abs && payload.projectId && payload.relPath) {
    const p = projects.get(payload.projectId);
    if (p) abs = path.join(p.path, payload.relPath);
  }
  if (!abs) throw new Error('缺少路径');
  let workspaceRoot = payload.workspaceRoot;
  if (!workspaceRoot && payload.projectId) {
    workspaceRoot = projects.get(payload.projectId)?.path;
  }
  return openInExternalEditor(abs, {
    line: payload.line,
    column: payload.column,
    preferred,
    workspaceRoot,
  });
});

ipcMain.handle('editor:resolve', () => resolveEditorBinary(store.get('preferredEditor') || 'auto'));

// ── 自动更新 ────────────────────────────────────────────
ipcMain.handle('update:status', () => updater.getStatus());
ipcMain.handle('update:check', () => updater.checkForUpdates());
ipcMain.handle('update:download', () => updater.downloadUpdate());
ipcMain.handle('update:install', () => updater.quitAndInstall());

// ── Projects（多项目并行） ──────────────────────────────
ipcMain.handle('project:list', () => [...projects.values()].map(publicProject));

ipcMain.handle('project:open', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '打开项目（可多开，并行开发）',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return openProject(result.filePaths[0]);
});

ipcMain.handle('project:openPath', (_e, dirPath) => {
  if (!dirPath) throw new Error('缺少路径');
  return openProject(dirPath);
});

ipcMain.handle('project:close', (_e, projectId) => closeProject(projectId));

/** 在新窗口打开项目 — 真正并排开发 */
ipcMain.handle('project:openInNewWindow', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '在新窗口打开项目',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const info = openProject(result.filePaths[0]);
  createWindow({ projectId: info.id });
  return info;
});

// 兼容旧 API
ipcMain.handle('workspace:open', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '打开项目',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return openProject(result.filePaths[0]);
});

ipcMain.handle('workspace:get', () => {
  const first = projects.values().next().value;
  return first ? first.path : null;
});

// ── Filesystem（按 projectId） ──────────────────────────
function resolveProjectId(payload, fallback) {
  if (typeof payload === 'string') return payload; // legacy: only path
  return payload?.projectId || fallback;
}

/** Ask 模式：UI 层禁止写/删/跑命令（硬拦，不只靠 prompt） */
function assertMutationsAllowed(action = 'write') {
  const mode = store.get('workMode') || 'craft';
  if (mode === 'ask') {
    throw new Error(
      `当前为 Ask 模式（只读），已拦截「${action}」。请切换到 Craft 或 Plan 后再操作。`
    );
  }
}

/** 个人目录保护：对越界绝对路径的提示（工作区工具已 resolveSafe，主要拦 terminal） */
function assertTerminalSafe(command) {
  assertMutationsAllowed('terminal');
  const mode = store.get('workMode') || 'craft';
  const protect = store.get('personalProtect') || 'standard';
  if (protect === 'off' || mode === 'ask') return;
  const cmd = String(command || '');
  // destructive patterns outside workspace
  if (
    protect === 'strict' &&
    /(rm\s+-rf|del\s+\/s|rd\s+\/s|Remove-Item\s+-Recurse|Format-Volume)/i.test(cmd)
  ) {
    throw new Error(
      '个人目录保护（严格）：已拦截疑似高危删除/格式化命令。请改写为更具体、更安全的命令。'
    );
  }
  if (
    protect === 'standard' &&
    /(Desktop|Downloads|Documents|桌面|下载|文档).{0,40}(rm\s+-rf|del\s+\/s|Remove-Item\s+-Recurse)/i.test(
      cmd
    )
  ) {
    throw new Error(
      '个人目录保护：检测到针对桌面/下载/文档的危险删除命令，已拦截。'
    );
  }
}

ipcMain.handle('fs:list', async (_e, payload = {}) => {
  const projectId = typeof payload === 'string' ? null : payload.projectId;
  const relPath = typeof payload === 'string' ? payload : payload.relPath || '.';
  // 兼容：无 projectId 时用第一个项目
  const p = projectId
    ? requireProject(projectId)
    : projects.values().next().value;
  if (!p) throw new Error('尚未打开项目');
  return p.tools.listTree(relPath || '.', 4);
});

ipcMain.handle('fs:read', async (_e, payload) => {
  const projectId = payload?.projectId;
  const relPath = payload?.relPath ?? payload?.path ?? payload;
  const p = projectId ? requireProject(projectId) : projects.values().next().value;
  if (!p) throw new Error('尚未打开项目');
  if (typeof relPath !== 'string') throw new Error('缺少路径');
  return p.tools.readFile(relPath);
});

ipcMain.handle('fs:write', async (_e, payload) => {
  assertMutationsAllowed('write');
  const p = requireProject(payload.projectId);
  return p.tools.writeFile(payload.relPath ?? payload.path, payload.content);
});

ipcMain.handle('fs:delete', async (_e, payload) => {
  assertMutationsAllowed('delete');
  const p = requireProject(payload.projectId);
  const trash = payload.trash !== undefined ? Boolean(payload.trash) : store.get('trashOnDelete') !== false;
  return p.tools.deleteFile(payload.relPath ?? payload.path, { trash });
});

ipcMain.handle('fs:exists', async (_e, payload) => {
  const projectId = payload?.projectId;
  const relPath = payload?.relPath ?? payload?.path ?? payload;
  const p = projectId ? projects.get(projectId) : projects.values().next().value;
  if (!p) return false;
  return p.tools.exists(typeof relPath === 'string' ? relPath : '');
});

ipcMain.handle('fs:stat', async (_e, payload) => {
  const p = requireProject(payload.projectId);
  return p.tools.statFile(payload.relPath ?? payload.path);
});

/** Content search in workspace */
ipcMain.handle('fs:search', async (_e, payload = {}) => {
  const p = payload.projectId ? requireProject(payload.projectId) : projects.values().next().value;
  if (!p) throw new Error('尚未打开项目');
  return p.tools.searchFiles(payload.query || '', payload.hint || '', payload.maxHits || 60);
});

/** Filename / path quick open */
ipcMain.handle('fs:searchPaths', async (_e, payload = {}) => {
  const p = payload.projectId ? requireProject(payload.projectId) : projects.values().next().value;
  if (!p) throw new Error('尚未打开项目');
  return p.tools.searchPaths(payload.query || '', payload.maxHits || 80);
});

// ── Terminal ────────────────────────────────────────────
ipcMain.handle('terminal:run', async (_e, payload) => {
  const command = typeof payload === 'string' ? payload : payload.command;
  const projectId = typeof payload === 'string' ? null : payload.projectId;
  const p = projectId ? requireProject(projectId) : projects.values().next().value;
  if (!p) throw new Error('尚未打开项目');
  assertTerminalSafe(command);
  return p.tools.runCommand(command, { timeoutMs: 60000 });
});

// ── Agent（项目 × 任务 二维并行） ───────────────────────
function getTaskSession(workspacePath, taskId) {
  const all = store.get('taskSessions') || {};
  return (all[workspacePath] || {})[taskId] || null;
}

function setTaskSession(workspacePath, taskId, sessionId) {
  const all = store.get('taskSessions') || {};
  if (!all[workspacePath]) all[workspacePath] = {};
  if (sessionId) all[workspacePath][taskId] = sessionId;
  else delete all[workspacePath][taskId];
  store.set('taskSessions', all);
}

/** abort key: `${projectId}::${taskId}` */
function abortKey(projectId, taskId) {
  return `${projectId}::${taskId}`;
}

ipcMain.handle('agent:run', async (_e, payload) => {
  const {
    message,
    taskId,
    resetSession,
    sessionId: clientSession,
    projectId,
    messages = [],
    prevContext = null,
    taskTitle = '',
  } = payload || {};
  if (!projectId) throw new Error('缺少 projectId');
  const p = requireProject(projectId);

  const probe = probeGrok(store.get('grokPath'));
  if (!probe.ok) {
    throw new Error(probe.error || 'Grok CLI 不可用，请检查安装或设置中的路径');
  }

  const tid = taskId || 'default';
  const sessionId = resetSession
    ? null
    : clientSession || getTaskSession(p.path, tid) || null;

  // 四档压缩 + 拼装继承提示（即使 CLI session 失效也能续上下文）
  const history = Array.isArray(messages) ? messages.slice() : [];
  // 当前句尚未进 history 时补上
  if (message && !history.length) {
    history.push({ role: 'user', content: message, ts: Date.now() });
  } else if (message) {
    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== message) {
      history.push({ role: 'user', content: message, ts: Date.now() });
    }
  }

  const skipResume = Boolean(payload?.skipResume);
  const effectiveSession = skipResume ? null : sessionId;

  let context;
  try {
    context = await compressWithMode(history, {
      prevContext: prevContext || {},
      projectName: p.name,
      taskTitle: taskTitle || tid,
      contextMode: payload?.contextMode || store.get('contextMode'),
    });
  } catch (err) {
    context = compressContext(history, { prev: prevContext || {}, projectName: p.name });
    context.llm = { used: false, reason: err.message || String(err) };
  }

  const workMode = ['craft', 'plan', 'ask'].includes(payload?.workMode)
    ? payload.workMode
    : getConfig().workMode;
  const stylePack = modes.STYLES[payload?.stylePack]
    ? payload.stylePack
    : getConfig().stylePack;

  const modePrefix = modes.modePromptPrefix(workMode, message);
  let skillsIndex = '';
  try {
    if (store.get('injectSkillsIndex') !== false) {
      skillsIndex = mcpSkills.buildSkillsIndexPrompt(p.path, { maxItems: 20 });
      if (skillsIndex) skillsIndex += '\n\n';
    }
  } catch {
    /* ignore */
  }
  const basePrompt = buildContextPrompt(context, message, {
    projectName: p.name,
    taskTitle: taskTitle || tid,
  });
  const fullPrompt = modePrefix + skillsIndex + basePrompt;

  // merged rules for CLI (global + project .grok/rules + style + mode)
  let projectRulesText = '';
  try {
    projectRulesText = modes.readProjectRulesFile(p.path).text || '';
  } catch {
    projectRulesText = '';
  }
  const mergedRules = modes.buildRules({
    baseRules: store.get('rules') || '',
    projectRules: projectRulesText,
    workMode,
    stylePack,
  });

  // Ask: never auto-approve tools; Plan: fewer turns while planning;
  // Craft: flight mode — full throttle (user always-approve + maxTurns as configured)
  let alwaysOverride;
  let maxTurnsOverride;
  if (workMode === 'ask') {
    alwaysOverride = false;
    maxTurnsOverride = Math.min(Number(store.get('maxTurns') || 30), 12);
  } else if (workMode === 'plan') {
    const exec =
      /^(执行|开干|按方案|implement|execute|do it|lgtm|开搞)/i.test(String(message || '').trim());
    if (!exec) {
      // planning turn: fewer tool turns preferred
      maxTurnsOverride = Math.min(Number(store.get('maxTurns') || 30), 16);
    }
  } else if (workMode === 'craft') {
    // Prefer finishing the job; do not artificially cap below user setting
    alwaysOverride = undefined; // keep user always-approve
    const base = Number(store.get('maxTurns') || 30);
    if (store.get('alwaysApprove') !== false && base < 24) {
      maxTurnsOverride = 24;
    }
  }

  if (p.aborts.has(tid)) {
    try {
      p.aborts.get(tid).abort();
    } catch {
      /* ignore */
    }
    p.aborts.delete(tid);
  }

  const ac = new AbortController();
  p.aborts.set(tid, ac);

  p._configOverride = {
    _rulesOverride: mergedRules,
    _alwaysApproveOverride: alwaysOverride,
    _maxTurnsOverride: maxTurnsOverride,
  };

  try {
    const result = await p.agent.run({
      message: fullPrompt,
      sessionId: effectiveSession,
      signal: ac.signal,
      taskId: tid,
    });
    if (result?.resumedFallback) {
      setTaskSession(p.path, tid, null);
    }
    if (result?.sessionId) {
      setTaskSession(p.path, tid, result.sessionId);
    }
    return {
      ...result,
      taskId: tid,
      projectId,
      context,
      contextTiers: context.tiers,
      contextMode: context.mode || store.get('contextMode'),
      workMode,
      stylePack,
    };
  } finally {
    p._configOverride = null;
    if (p.aborts.get(tid) === ac) p.aborts.delete(tid);
  }
});

ipcMain.handle('agent:stop', (_e, payload = {}) => {
  const { projectId, taskId } = payload;
  if (projectId) {
    const p = projects.get(projectId);
    if (!p) return false;
    if (taskId) {
      p.agent.stop(taskId);
      const ac = p.aborts.get(taskId);
      if (ac) {
        ac.abort();
        p.aborts.delete(taskId);
      }
    } else {
      p.agent.stop();
      for (const ac of p.aborts.values()) {
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
      }
      p.aborts.clear();
    }
    return true;
  }
  // 停所有项目
  for (const p of projects.values()) {
    p.agent.stop();
    for (const ac of p.aborts.values()) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    p.aborts.clear();
  }
  return true;
});

ipcMain.handle('agent:clearSession', (_e, payload = {}) => {
  const { projectId, taskId } = payload;
  if (!projectId) return false;
  const p = projects.get(projectId);
  if (!p) return false;
  if (taskId) {
    setTaskSession(p.path, taskId, null);
  } else {
    const all = store.get('taskSessions') || {};
    delete all[p.path];
    store.set('taskSessions', all);
  }
  return true;
});

ipcMain.handle('agent:running', () => {
  const out = [];
  for (const p of projects.values()) {
    for (const tid of p.agent.listRunning()) {
      out.push({ projectId: p.id, taskId: tid, projectName: p.name });
    }
  }
  return out;
});

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

// ── 持久化 & 四档上下文 ─────────────────────────────────
ipcMain.handle('persist:save', (_e, snapshot) => {
  return persist.saveProjectSnapshot(snapshot);
});

ipcMain.handle('persist:load', (_e, projectPath) => {
  return persist.loadProjectSnapshot(projectPath);
});

ipcMain.handle('persist:list', () => persist.listSnapshots());

ipcMain.handle('persist:delete', (_e, projectPath) => persist.deleteSnapshot(projectPath));

ipcMain.handle('persist:root', () => persist.root);

ipcMain.handle('context:compress', async (_e, payload = {}) => {
  return compressWithMode(payload.messages || [], {
    prevContext: payload.prevContext || {},
    projectName: payload.projectName || '',
    taskTitle: payload.taskTitle || '',
    contextMode: payload.contextMode || store.get('contextMode'),
  });
});

// ── MCP / Skills（对接 ~/.grok 与 grok CLI） ─────────────
ipcMain.handle('mcp:list', async () => {
  return mcpSkills.listMcp(store.get('grokPath'));
});

ipcMain.handle('mcp:add', async (_e, payload) => {
  return mcpSkills.addMcp(payload || {}, store.get('grokPath'));
});

ipcMain.handle('mcp:remove', async (_e, payload = {}) => {
  return mcpSkills.removeMcp(payload.name, store.get('grokPath'), payload.scope);
});

ipcMain.handle('mcp:toggle', async (_e, payload = {}) => {
  return mcpSkills.setMcpEnabled(payload.name, Boolean(payload.enabled));
});

ipcMain.handle('mcp:doctor', async (_e, payload = {}) => {
  return mcpSkills.doctorMcp(payload.name, store.get('grokPath'));
});

ipcMain.handle('mcp:setTimeout', async (_e, payload = {}) => {
  return mcpSkills.setMcpStartupTimeout(payload.name, payload.seconds || 120);
});

ipcMain.handle('skills:list', async (_e, payload = {}) => {
  return mcpSkills.listSkills(payload.projectPath || null);
});

ipcMain.handle('skills:toggle', async (_e, payload = {}) => {
  return mcpSkills.setSkillEnabled(payload.name, Boolean(payload.enabled));
});

ipcMain.handle('skills:create', async (_e, payload = {}) => {
  return mcpSkills.createSkill(payload);
});

ipcMain.handle('skills:read', async (_e, payload = {}) => {
  return mcpSkills.readSkill(payload.path || payload.skillFile);
});

ipcMain.handle('skills:write', async (_e, payload = {}) => {
  return mcpSkills.writeSkill(payload.skillFile || payload.path, payload.content);
});

ipcMain.handle('skills:delete', async (_e, payload = {}) => {
  return mcpSkills.deleteSkill(payload.path);
});

ipcMain.handle('skills:openDir', async (_e, payload = {}) => {
  const dir = payload.path || mcpSkills.USER_SKILLS;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return true;
});

ipcMain.handle('paths:grokHome', () => mcpSkills.GROK_HOME);

// ── Plugins marketplace ─────────────────────────────────
ipcMain.handle('plugin:list', () => plugins.listInstalled(store.get('grokPath')));
ipcMain.handle('plugin:available', () => plugins.listAvailable(store.get('grokPath')));
ipcMain.handle('plugin:marketplaces', () => plugins.listMarketplaces(store.get('grokPath')));
ipcMain.handle('plugin:marketplaceAdd', (_e, payload = {}) =>
  plugins.addMarketplace(payload.source, store.get('grokPath'))
);
ipcMain.handle('plugin:marketplaceRemove', (_e, payload = {}) =>
  plugins.removeMarketplace(payload.name, store.get('grokPath'))
);
ipcMain.handle('plugin:marketplaceUpdate', () => plugins.updateMarketplaces(store.get('grokPath')));
ipcMain.handle('plugin:install', (_e, payload = {}) =>
  plugins.installPlugin(payload.source, store.get('grokPath'), { trust: payload.trust !== false })
);
ipcMain.handle('plugin:uninstall', (_e, payload = {}) =>
  plugins.uninstallPlugin(payload.name, store.get('grokPath'))
);
ipcMain.handle('plugin:enable', (_e, payload = {}) =>
  plugins.enablePlugin(payload.name, store.get('grokPath'))
);
ipcMain.handle('plugin:disable', (_e, payload = {}) =>
  plugins.disablePlugin(payload.name, store.get('grokPath'))
);
ipcMain.handle('plugin:details', (_e, payload = {}) =>
  plugins.pluginDetails(payload.name, store.get('grokPath'))
);

// ── Project profiles ────────────────────────────────────
ipcMain.handle('profile:export', async (e, payload = {}) => {
  const projectId = payload.projectId;
  const p = projectId ? projects.get(projectId) : projects.values().next().value;
  if (!p) throw new Error('请先打开项目');
  const cfg = getConfig();
  const result = profiles.exportProfile({
    projectPath: p.path,
    name: payload.name || p.name,
    rules: cfg.rules,
    model: cfg.model,
    maxTurns: cfg.maxTurns,
    alwaysApprove: cfg.alwaysApprove,
    contextMode: cfg.contextMode,
    preferredEditor: cfg.preferredEditor,
    includeSession: payload.includeSession !== false,
  });
  // offer save dialog copy
  const win = BrowserWindow.fromWebContents(e.sender);
  const save = await dialog.showSaveDialog(win, {
    title: '导出 GrokCode 项目配置',
    defaultPath: path.join(osHomedir(), `${p.name}.grokcode.json`),
    filters: [{ name: 'GrokCode Profile', extensions: ['json'] }],
  });
  if (!save.canceled && save.filePath) {
    fs.copyFileSync(result.file, save.filePath);
    result.file = save.filePath;
  }
  return result;
});

ipcMain.handle('profile:import', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const open = await dialog.showOpenDialog(win, {
    title: '导入 GrokCode 项目配置',
    properties: ['openFile'],
    filters: [{ name: 'GrokCode Profile', extensions: ['json'] }],
  });
  if (open.canceled || !open.filePaths[0]) return null;
  const result = profiles.importProfile(open.filePaths[0]);
  // apply config fields
  const c = result.config || {};
  if (c.rules !== undefined) store.set('rules', c.rules);
  if (c.model !== undefined) store.set('model', c.model);
  if (c.maxTurns !== undefined) store.set('maxTurns', c.maxTurns);
  if (c.alwaysApprove !== undefined) store.set('alwaysApprove', c.alwaysApprove);
  if (c.contextMode !== undefined) store.set('contextMode', c.contextMode);
  if (c.preferredEditor !== undefined) store.set('preferredEditor', c.preferredEditor);
  return result;
});

ipcMain.handle('profile:list', () => profiles.listProfiles());
ipcMain.handle('profile:dir', () => profiles.profilesDir());

// ── Session share export ────────────────────────────────
ipcMain.handle('session:exportShare', async (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const markdown = String(payload.markdown || '');
  const json = String(payload.json || '');
  const defaultName = String(payload.defaultName || 'grok-session.md').replace(/[<>:"|?*]/g, '-');
  const save = await dialog.showSaveDialog(win, {
    title: '导出 GrokCode 会话',
    defaultPath: path.join(osHomedir(), defaultName),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  try {
    const out = save.filePath.toLowerCase().endsWith('.json') ? json || markdown : markdown || json;
    fs.writeFileSync(save.filePath, out, 'utf8');
    return { ok: true, file: save.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ── Telemetry ───────────────────────────────────────────
ipcMain.handle('telemetry:report', (_e, payload = {}) => {
  return reportIfEnabled(payload.message || payload.error || 'renderer-error', {
    kind: payload.kind || 'renderer',
    ...payload.extra,
  });
});
ipcMain.handle('telemetry:list', () => telemetry.listCrashLogs());
ipcMain.handle('telemetry:openDir', () => {
  const dir = telemetry.logDir();
  shell.openPath(dir);
  return true;
});

function osHomedir() {
  return require('os').homedir();
}

// ── 无边框窗口控制 ──────────────────────────────────────
function winFromEvent(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

ipcMain.handle('window:minimize', (e) => {
  winFromEvent(e)?.minimize();
  return true;
});
ipcMain.handle('window:maximize', (e) => {
  const win = winFromEvent(e);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', (e) => {
  winFromEvent(e)?.close();
  return true;
});
ipcMain.handle('window:isMaximized', (e) => {
  const win = winFromEvent(e);
  return Boolean(win && win.isMaximized());
});
