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
const { openExternalSafe } = require('./shell-safe');

const persist = createPersist();

app.setName('GrokCode');
Menu.setApplicationMenu(null);

/**
 * Windows PowerShell `Set-Content -Encoding UTF8` writes a UTF-8 BOM.
 * electron-store / conf use JSON.parse which rejects BOM → app won't start.
 * Strip EF BB BF from known config paths before opening the store.
 */
function stripUtf8BomFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      fs.writeFileSync(filePath, buf.subarray(3));
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function sanitizeStoreConfigs() {
  const name = 'grok-code-config.json';
  const dirs = new Set();
  try {
    if (app.isReady?.() || app.getPath) {
      dirs.add(app.getPath('userData'));
    }
  } catch {
    /* app path not ready */
  }
  if (process.env.APPDATA) {
    dirs.add(path.join(process.env.APPDATA, 'GrokCode'));
    dirs.add(path.join(process.env.APPDATA, 'grok-code'));
    dirs.add(path.join(process.env.APPDATA, 'grokcode'));
    dirs.add(path.join(process.env.APPDATA, 'Electron'));
  }
  for (const dir of dirs) {
    if (dir) stripUtf8BomFile(path.join(dir, name));
  }
}

sanitizeStoreConfigs();

const store = new Store({
  name: 'grok-code-config',
  defaults: {
    apiKey: process.env.XAI_API_KEY || '',
    model: '',
    /** low | medium | high | xhigh | '' (CLI default) — session/set_model meta + --reasoning-effort */
    reasoningEffort: '',
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
    /** cli (CLI-native) | legacy craft|plan|ask|goal when GROKCODE_CLI_NATIVE=0 */
    workMode: 'cli',
    /** default | pragmatic | teaching | warm | blunt */
    stylePack: 'default',
    /** off | standard | strict — personal dir caution for UI ops */
    personalProtect: 'standard',
    /** UI delete → recycle bin when possible */
    trashOnDelete: true,
    /** inject skill name+description index into agent prompt */
    injectSkillsIndex: true,
    /**
     * Agent transport (host over open-source grok CLI):
     * auto — ACP first, headless on Build 403
     * acp — always grok agent stdio
     * headless — always streaming-json (like grok -p)
     */
    agentTransport: 'auto',
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
  const workMode = modes.normalizeWorkMode(store.get('workMode'));
  const stylePack = modes.STYLES[store.get('stylePack')]
    ? store.get('stylePack')
    : 'default';
  return {
    apiKey: store.get('apiKey'),
    model: store.get('model'),
    reasoningEffort: store.get('reasoningEffort') || '',
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

/**
 * Context compress for agent prompt.
 * Always builds heuristic immediately. LLM enrich (if enabled) is budgeted so a
 * slow/walled xAI call cannot hold spawn for the full TIMEOUT_MS.
 *
 * @param {object} [opts.onProgress] (phase, detail) => void
 * @param {number} [opts.llmBudgetMs] max wait for LLM enrich (default 3500)
 */
async function compressWithMode(messages, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  onProgress?.('compress', '启发式压缩…');
  let context = compressContext(messages, {
    prev: opts.prevContext || {},
    projectName: opts.projectName || '',
    taskTitle: opts.taskTitle || '',
    workMode: opts.workMode || '',
    turns: opts.turns || [],
    changedFiles: opts.changedFiles || [],
    lastStopped: Boolean(opts.lastStopped),
  });
  const mode = opts.contextMode || store.get('contextMode') || 'heuristic';
  if (mode === 'llm') {
    const cfg = getConfig();
    const budget = Math.max(800, Number(opts.llmBudgetMs) || 3500);
    onProgress?.('compress', `LLM 摘要（≤${Math.round(budget / 1000)}s）…`);
    try {
      const enriched = await Promise.race([
        enrichContextWithLlm(context, {
          apiKey: cfg.apiKey,
          model: opts.llmModel || cfg.model || undefined,
          projectName: opts.projectName,
          taskTitle: opts.taskTitle,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`LLM 摘要超时 ${budget}ms`)), budget)
        ),
      ]);
      context = enriched;
    } catch (err) {
      // Keep heuristic prompt so agent can start; mark why LLM was skipped
      context = {
        ...context,
        mode: 'heuristic',
        llm: {
          used: false,
          reason: err?.message || String(err),
          budgetMs: budget,
        },
      };
    }
  } else {
    context.mode = 'heuristic';
  }
  onProgress?.('compress', '压缩完成');
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
  // 停掉该项目所有 agent + 清 orphan grok 树
  try {
    p.agent.stop();
  } catch {
    /* ignore */
  }
  try {
    p.agent.reapTracked?.();
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
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  // Windows：用系统 titleBarOverlay 绘制 ─□✕（自定义按钮在部分 Electron/Windows 组合下点不动）
  // macOS：hiddenInset 交通灯；Linux：frameless + 自定义按钮
  const winOpts = {
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#000000',
    title: 'GrokCode',
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  };
  if (isWin) {
    winOpts.frame = false;
    winOpts.titleBarStyle = 'hidden';
    // 半透明叠在暗色 topbar 上，避免一块实心黑条违和
    winOpts.titleBarOverlay = {
      color: '#00000000',
      symbolColor: '#a8b0bc',
      height: 52,
    };
  } else if (isMac) {
    winOpts.frame = false;
    winOpts.titleBarStyle = 'hiddenInset';
    winOpts.trafficLightPosition = { x: 14, y: 16 };
  } else {
    winOpts.frame = false;
  }
  const win = new BrowserWindow(winOpts);

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

/**
 * Rehydrate recent project list from disk sessions when electron-store lost it.
 * Data lives in ~/.grok-code/sessions — never depend on in-memory projects alone.
 */
function seedRecentProjectsFromDisk() {
  let recent = (store.get('recentProjects') || []).filter(
    (p) => typeof p === 'string' && p && fs.existsSync(p)
  );
  // Legacy single workspace field
  const legacy = store.get('workspace');
  if (legacy && typeof legacy === 'string' && fs.existsSync(legacy)) {
    if (!recent.some((p) => path.resolve(p) === path.resolve(legacy))) {
      recent.unshift(legacy);
    }
  }
  // If still empty (or thin), merge persist index / session files
  try {
    const snaps = persist.listSnapshots() || [];
    for (const s of snaps) {
      if (!s?.path || !fs.existsSync(s.path)) continue;
      const abs = path.resolve(s.path);
      if (!recent.some((p) => path.resolve(p) === abs)) recent.push(abs);
    }
  } catch (e) {
    console.warn('seedRecent from persist', e);
  }
  recent = recent.slice(0, 12);
  store.set('recentProjects', recent);
  // Open up to 8 so multi-project tabs come back after restart
  for (const dir of recent.slice(0, 8)) {
    try {
      openProject(dir);
    } catch (e) {
      console.warn('seed openProject', dir, e?.message || e);
    }
  }
  return recent;
}

app.whenReady().then(() => {
  // Restore project list BEFORE first paint IPC so renderer projectList() is non-empty
  try {
    seedRecentProjectsFromDisk();
  } catch (e) {
    console.warn('seedRecentProjectsFromDisk', e);
  }
  createWindow();

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

/** Ensure every spawned grok tree dies with the app (no orphan CLI zombies). */
app.on('before-quit', () => {
  for (const id of [...projects.keys()]) {
    try {
      closeProject(id);
    } catch {
      /* ignore */
    }
  }
});

// ── Config ──────────────────────────────────────────────
ipcMain.handle('config:get', () => {
  const probe = probeGrok(store.get('grokPath'));
  return {
    apiKey: store.get('apiKey') ? '••••••••' + String(store.get('apiKey')).slice(-4) : '',
    hasApiKey: Boolean(store.get('apiKey') || process.env.XAI_API_KEY),
    model: store.get('model') || '',
    reasoningEffort: store.get('reasoningEffort') || '',
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
    agentTransport: getConfig().agentTransport || 'auto',
    modes: modes.listModes(),
    styles: modes.listStyles(),
  };
});

ipcMain.handle('config:set', (_e, partial) => {
  if (partial.apiKey !== undefined && !String(partial.apiKey).startsWith('••••')) {
    store.set('apiKey', String(partial.apiKey).trim());
  }
  if (partial.model !== undefined) store.set('model', String(partial.model).trim());
  if (partial.reasoningEffort !== undefined) {
    const { normalizeReasoningEffort } = require('./acp-client');
    store.set(
      'reasoningEffort',
      normalizeReasoningEffort(partial.reasoningEffort)
    );
  }
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
  if (partial.agentTransport !== undefined) {
    const t = String(partial.agentTransport || 'auto').toLowerCase();
    store.set(
      'agentTransport',
      ['auto', 'acp', 'headless'].includes(t) ? t : 'auto'
    );
  }
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
    store.set('workMode', modes.normalizeWorkMode(partial.workMode));
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

/** Project-scoped session templates: `.grok/templates.json` */
function resolveProjectPath(payload = {}) {
  let projectPath = payload.projectPath || null;
  if (!projectPath && payload.projectId) {
    const p = projects.get(payload.projectId);
    projectPath = p?.path || null;
  }
  return projectPath;
}

ipcMain.handle('projectTemplates:get', (_e, payload = {}) => {
  const projectPath = resolveProjectPath(payload);
  if (!projectPath) return { templates: [], file: null, exists: false };
  const file = path.join(projectPath, '.grok', 'templates.json');
  if (!fs.existsSync(file)) return { templates: [], file, exists: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data.templates || [];
    const templates = list
      .filter((t) => t && (t.prompt || t.promptZh || t.promptEn))
      .map((t, i) => ({
        id: String(t.id || `proj-${i}`).slice(0, 64),
        labelZh: t.labelZh || t.label || t.labelEn || t.id || `项目模板 ${i + 1}`,
        labelEn: t.labelEn || t.label || t.labelZh || t.id || `Project ${i + 1}`,
        promptZh: t.promptZh || t.prompt || t.promptEn || '',
        promptEn: t.promptEn || t.prompt || t.promptZh || '',
        tags: Array.isArray(t.tags) ? t.tags : [],
      }));
    return { templates, file, exists: true };
  } catch (err) {
    return { templates: [], file, exists: true, error: err.message };
  }
});

ipcMain.handle('projectTemplates:set', (_e, payload = {}) => {
  const projectPath = resolveProjectPath(payload);
  if (!projectPath) throw new Error('需要打开项目');
  const dir = path.join(projectPath, '.grok');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'templates.json');
  const templates = Array.isArray(payload.templates) ? payload.templates : [];
  const pack = {
    format: 'grokcode-templates-v1',
    scope: 'project',
    updatedAt: new Date().toISOString(),
    templates,
  };
  fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8');
  return { ok: true, file };
});

/** Save base64 image into workspace `.grok/paste/` */
ipcMain.handle('paste:saveImage', (_e, payload = {}) => {
  const p = payload.projectId ? projects.get(payload.projectId) : null;
  const projectPath = payload.projectPath || p?.path;
  if (!projectPath) throw new Error('需要打开项目');
  const b64 = String(payload.base64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) throw new Error('无效图片数据');
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('base64 解码失败');
  }
  if (buf.length > 5_000_000) throw new Error('图片过大（>5MB）');
  const extRaw = String(payload.ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const dir = path.join(projectPath, '.grok', 'paste');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = String(payload.name || 'paste')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '-')
    .slice(0, 40);
  const fileName = `${safeName}-${stamp}.${extRaw}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, buf);
  const relPath = path.join('.grok', 'paste', fileName).replace(/\\/g, '/');
  return { ok: true, relPath, file: abs, bytes: buf.length };
});

ipcMain.handle('cli:probe', () => probeGrok(store.get('grokPath')));

// ── 体检 / 诊断 / 首启 ──────────────────────────────────
ipcMain.handle('doctor:run', (_e, payload = {}) => {
  return runDoctor(getConfig(), {
    probePrompt: Boolean(payload?.probePrompt),
  });
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
  const mode = modes.normalizeWorkMode(store.get('workMode'));
  if (mode === 'ask') {
    throw new Error(
      `当前为 Ask 模式（只读），已拦截「${action}」。请切换到 Craft、Plan 或 Goal 后再操作。`
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

  const workMode = modes.normalizeWorkMode(
    payload?.workMode != null ? payload.workMode : getConfig().workMode
  );
  const stylePack = modes.STYLES[payload?.stylePack]
    ? payload.stylePack
    : getConfig().stylePack;
  const goalState =
    payload?.goal && typeof payload.goal === 'object' && payload.goal.title
      ? {
          title: String(payload.goal.title).slice(0, 200),
          status: String(payload.goal.status || 'active').slice(0, 32),
          progress:
            typeof payload.goal.progress === 'number'
              ? Math.max(0, Math.min(100, payload.goal.progress))
              : undefined,
          next: payload.goal.next ? String(payload.goal.next).slice(0, 160) : undefined,
        }
      : null;

  const changedFiles = Array.isArray(payload?.changedFiles)
    ? payload.changedFiles
    : p.changes
      ? [...(p.changes.keys?.() || [])]
      : [];
  // Renderer passes changes; main project map may not hold Diff — prefer payload
  const turns = Array.isArray(payload?.turns) ? payload.turns : [];
  const lastStopped = Boolean(payload?.lastStopped || payload?.isContinue);

  // Immediate UI feedback — before compress / spawn (eliminates silent wait)
  const tRun0 = Date.now();
  const emitPrep = (phase, detail) => {
    try {
      emit('agent:phase', { phase, detail, taskId: tid, projectId });
      emit('agent:status', { status: phase, detail, taskId: tid, projectId });
    } catch {
      /* ignore */
    }
  };
  emitPrep('boot', '准备上下文…');

  let context;
  try {
    context = await compressWithMode(history, {
      prevContext: prevContext || {},
      projectName: p.name,
      taskTitle: taskTitle || tid,
      contextMode: payload?.contextMode || store.get('contextMode'),
      workMode,
      turns,
      changedFiles,
      lastStopped,
      // Never block spawn for full LLM timeout (default 25s) — budget ~3.5s
      llmBudgetMs: 3500,
      onProgress: (phase, detail) => emitPrep(phase || 'compress', detail || ''),
    });
  } catch (err) {
    context = compressContext(history, {
      prev: prevContext || {},
      projectName: p.name,
      taskTitle: taskTitle || tid,
      workMode,
      turns,
      changedFiles,
      lastStopped,
    });
    context.llm = { used: false, reason: err.message || String(err) };
  }

  // CLI_NATIVE: no Craft/Plan/Ask/Goal prompt prefixes — session mode is CLI-owned
  const modePrefix = modes.modePromptPrefix(workMode, message, { goal: goalState });
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
    workMode,
    continueFrom: Boolean(payload?.isContinue),
    lastStopped,
  });
  const fullPrompt = modePrefix + skillsIndex + basePrompt;

  // Rules for CLI --rules: user settings + project .grok/rules only (no fake modes)
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

  // Permission / turns: settings only — not per GrokCode "Ask vs Craft"
  let alwaysOverride;
  let maxTurnsOverride;
  if (!modes.CLI_NATIVE) {
    const planExec =
      workMode === 'plan' && modes.isPlanExecutePhrase(message);
    if (workMode === 'ask') {
      alwaysOverride = false;
      maxTurnsOverride = Math.min(Number(store.get('maxTurns') || 30), 12);
    } else if (workMode === 'plan' && !planExec) {
      maxTurnsOverride = Math.min(Number(store.get('maxTurns') || 30), 16);
    } else if (
      workMode === 'craft' ||
      workMode === 'goal' ||
      planExec ||
      payload?.forceCraft
    ) {
      alwaysOverride = undefined;
      const base = Number(store.get('maxTurns') || 30);
      if (store.get('alwaysApprove') !== false && base < 24) {
        maxTurnsOverride = 24;
      }
      if ((planExec || payload?.fromPlanExecute) && base < 28) {
        maxTurnsOverride = Math.max(maxTurnsOverride || 0, 28);
      }
      if (workMode === 'goal' && base < 28) {
        maxTurnsOverride = Math.max(maxTurnsOverride || 0, 28);
      }
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

  emitPrep(
    'boot',
    `启动 Agent…（准备 ${Date.now() - tRun0}ms）`
  );

  try {
    const result = await p.agent.run({
      message: fullPrompt,
      sessionId: effectiveSession,
      signal: ac.signal,
      taskId: tid,
      prepMs: Date.now() - tRun0,
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
  } catch (err) {
    // electron IPC often surfaces only err.message — ensure 403/auth is human-readable
    const { humanizeAgentError } = require('./agent');
    const friendly =
      typeof humanizeAgentError === 'function'
        ? humanizeAgentError(err)
        : err?.message || String(err);
    const e = new Error(friendly);
    e.cause = err;
    throw e;
  } finally {
    p._configOverride = null;
    if (p.aborts.get(tid) === ac) p.aborts.delete(tid);
  }
});

/** Reply to parked x.ai/exit_plan_mode reverse-request */
ipcMain.handle('agent:plan_reply', (_e, payload = {}) => {
  const { projectId, taskId, requestId, outcome, feedback } = payload || {};
  if (!projectId || !taskId || requestId == null) {
    return { ok: false, error: 'projectId, taskId, requestId required' };
  }
  const p = projects.get(projectId);
  if (!p?.agent?.replyPlanApproval) {
    return { ok: false, error: 'project not open' };
  }
  return p.agent.replyPlanApproval(taskId, requestId, {
    outcome: outcome || 'cancelled',
    feedback,
  });
});

/** Reply to parked x.ai/ask_user_question reverse-request */
ipcMain.handle('agent:user_question_reply', (_e, payload = {}) => {
  const { projectId, taskId, requestId, result } = payload || {};
  if (!projectId || !taskId || requestId == null) {
    return { ok: false, error: 'projectId, taskId, requestId required' };
  }
  const p = projects.get(projectId);
  if (!p?.agent?.replyUserQuestion) {
    return { ok: false, error: 'project not open' };
  }
  return p.agent.replyUserQuestion(taskId, requestId, result || { outcome: 'cancelled' });
});

/** ACP session/set_mode — default | plan | ask (open-source SessionMode) */
ipcMain.handle('agent:set_mode', async (_e, payload = {}) => {
  const { projectId, taskId, modeId, sessionId } = payload || {};
  if (!projectId || !taskId || !modeId) {
    return { ok: false, error: 'projectId, taskId, modeId required' };
  }
  const p = projects.get(projectId);
  if (!p?.agent?.setSessionMode) {
    return { ok: false, error: 'project not open' };
  }
  return p.agent.setSessionMode(taskId, modeId, sessionId);
});

/** ACP session/set_model — live model switch on warm session */
ipcMain.handle('agent:set_model', async (_e, payload = {}) => {
  const { projectId, taskId, modelId, sessionId, reasoningEffort } = payload || {};
  if (!projectId || !taskId) {
    return { ok: false, error: 'projectId, taskId required' };
  }
  const p = projects.get(projectId);
  if (!p?.agent?.setSessionModel) {
    return { ok: false, error: 'project not open' };
  }
  return p.agent.setSessionModel(taskId, modelId, {
    sessionId,
    reasoningEffort,
  });
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

ipcMain.handle('shell:openExternal', async (_e, url) => {
  const result = await openExternalSafe(shell, url);
  if (!result.ok) {
    throw new Error(result.error || '无法打开链接');
  }
  return true;
});

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
    workMode: payload.workMode || '',
    turns: payload.turns || [],
    changedFiles: payload.changedFiles || [],
    lastStopped: Boolean(payload.lastStopped),
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
ipcMain.handle('plugin:update', (_e, payload = {}) =>
  plugins.updatePlugin(payload.name, store.get('grokPath'))
);
ipcMain.handle('plugin:validate', (_e, payload = {}) =>
  plugins.validatePlugin(payload.path, store.get('grokPath'))
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
    reasoningEffort: cfg.reasoningEffort || '',
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
  if (c.reasoningEffort !== undefined) {
    const { normalizeReasoningEffort } = require('./acp-client');
    store.set('reasoningEffort', normalizeReasoningEffort(c.reasoningEffort));
  }
  if (c.maxTurns !== undefined) store.set('maxTurns', c.maxTurns);
  if (c.alwaysApprove !== undefined) store.set('alwaysApprove', c.alwaysApprove);
  if (c.contextMode !== undefined) store.set('contextMode', c.contextMode);
  if (c.preferredEditor !== undefined) store.set('preferredEditor', c.preferredEditor);
  return result;
});

ipcMain.handle('profile:list', () => profiles.listProfiles());
ipcMain.handle('profile:dir', () => profiles.profilesDir());

// ── Template pack import / export / local sync ──────────
ipcMain.handle('template:exportPack', async (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const json = String(payload.json || '[]');
  const defaultName = String(payload.defaultName || 'grok-templates.json').replace(
    /[<>:"|?*]/g,
    '-'
  );
  const save = await dialog.showSaveDialog(win, {
    title: payload.title || '导出 GrokCode 模板包',
    defaultPath: path.join(osHomedir(), defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(save.filePath, json, 'utf8');
    return { ok: true, file: save.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('template:importPack', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const open = await dialog.showOpenDialog(win, {
    title: '导入 GrokCode 模板包',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (open.canceled || !open.filePaths[0]) return { ok: false, canceled: true };
  try {
    const raw = fs.readFileSync(open.filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    if (data?.format === 'grokcode-templates-aes-v1') {
      return {
        ok: false,
        error: '这是加密包，请用「导入加密包」',
        encrypted: true,
        file: open.filePaths[0],
      };
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.templates) ? data.templates : null;
    if (!list) return { ok: false, error: 'JSON 需为数组或 { templates: [] }' };
    const normalized = list
      .filter((t) => t && (t.prompt || t.promptZh || t.promptEn))
      .map((t, i) => ({
        id: String(t.id || `import-${Date.now()}-${i}`).slice(0, 64),
        labelZh: t.labelZh || t.label || t.labelEn || t.id || `模板 ${i + 1}`,
        labelEn: t.labelEn || t.label || t.labelZh || t.id || `Template ${i + 1}`,
        promptZh: t.promptZh || t.prompt || t.promptEn || '',
        promptEn: t.promptEn || t.prompt || t.promptZh || '',
        tags: Array.isArray(t.tags) ? t.tags : [],
      }));
    return { ok: true, templates: normalized, file: open.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('template:importRaw', async (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const storyboard = !!payload.storyboard;
  const open = await dialog.showOpenDialog(win, {
    title: storyboard
      ? '导入 Storyboard 审阅包（JSON / HTML / 加密）'
      : '导入 GrokCode 模板包（支持加密）',
    properties: ['openFile'],
    filters: storyboard
      ? [
          { name: 'Storyboard pack', extensions: ['json', 'html', 'htm'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'All', extensions: ['*'] },
        ]
      : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (open.canceled || !open.filePaths[0]) return { ok: false, canceled: true };
  try {
    const file = open.filePaths[0];
    const text = fs.readFileSync(file, 'utf8');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain HTML or other text — renderer may parse */
    }
    return { ok: true, data, text, file };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('template:pickSyncDir', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const open = await dialog.showOpenDialog(win, {
    title: '选择模板同步目录（本地 / 网盘文件夹）',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (open.canceled || !open.filePaths[0]) return { ok: false, canceled: true };
  store.set('templateSyncDir', open.filePaths[0]);
  return { ok: true, dir: open.filePaths[0] };
});

ipcMain.handle('template:getSyncDir', () => store.get('templateSyncDir') || '');

ipcMain.handle('template:syncPush', (_e, payload = {}) => {
  const dir = payload.dir || store.get('templateSyncDir');
  if (!dir) return { ok: false, error: '未设置同步目录' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'grok-templates-sync.json');
    const pack = {
      format: 'grokcode-templates-v1',
      exportedAt: new Date().toISOString(),
      templates: Array.isArray(payload.templates) ? payload.templates : [],
    };
    fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('template:syncPull', (_e, payload = {}) => {
  const dir = payload.dir || store.get('templateSyncDir');
  if (!dir) return { ok: false, error: '未设置同步目录' };
  const file = path.join(dir, 'grok-templates-sync.json');
  if (!fs.existsSync(file)) return { ok: false, error: '同步文件不存在' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data.templates || [];
    return { ok: true, templates: list, file, exportedAt: data.exportedAt || null };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ── Session share export ────────────────────────────────
ipcMain.handle('session:exportShare', async (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const markdown = String(payload.markdown || '');
  const json = String(payload.json || '');
  const html = String(payload.html || '');
  const defaultName = String(payload.defaultName || 'grok-session.md').replace(/[<>:"|?*]/g, '-');
  const filters = [
    { name: 'Markdown', extensions: ['md'] },
    { name: 'HTML review pack', extensions: ['html', 'htm'] },
    { name: 'JSON', extensions: ['json'] },
    { name: 'All', extensions: ['*'] },
  ];
  const save = await dialog.showSaveDialog(win, {
    title: payload.title || '导出 GrokCode 会话',
    defaultPath: path.join(osHomedir(), defaultName),
    filters,
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  try {
    const fp = save.filePath.toLowerCase();
    let out = markdown || html || json;
    if (fp.endsWith('.json')) out = json || markdown || html;
    else if (fp.endsWith('.html') || fp.endsWith('.htm')) out = html || markdown || json;
    else out = markdown || html || json;
    fs.writeFileSync(save.filePath, out, 'utf8');
    return { ok: true, file: save.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/** Export a review folder: html + md + json + optional png */
ipcMain.handle('review:exportFolder', async (e, payload = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const open = await dialog.showOpenDialog(win, {
    title: '选择审阅包输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (open.canceled || !open.filePaths[0]) return { ok: false, canceled: true };
  const root = open.filePaths[0];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const folderName = String(payload.folderName || `grok-review-${stamp}`).replace(/[<>:"|?*]/g, '-');
  const dir = path.join(root, folderName);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const written = [];
    const write = (name, content) => {
      if (content == null || content === '') return;
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, content, typeof content === 'string' ? 'utf8' : undefined);
      written.push(fp);
    };
    if (payload.html) write('storyboard.html', String(payload.html));
    if (payload.markdown) write('storyboard.md', String(payload.markdown));
    if (payload.json) write('storyboard.json', String(payload.json));
    if (payload.pngBase64) {
      const b64 = String(payload.pngBase64).replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(dir, 'storyboard.png'), Buffer.from(b64, 'base64'));
      written.push(path.join(dir, 'storyboard.png'));
    }
    // open folder
    shell.openPath(dir);
    return { ok: true, dir, files: written };
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
  return (
    BrowserWindow.fromWebContents(e.sender) ||
    BrowserWindow.getFocusedWindow() ||
    mainWindow ||
    null
  );
}

ipcMain.handle('window:minimize', (e) => {
  const win = winFromEvent(e);
  if (!win || win.isDestroyed()) return false;
  win.minimize();
  return true;
});
ipcMain.handle('window:maximize', (e) => {
  const win = winFromEvent(e);
  if (!win || win.isDestroyed()) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', (e) => {
  const win = winFromEvent(e);
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
});
ipcMain.handle('window:isMaximized', (e) => {
  const win = winFromEvent(e);
  return Boolean(win && !win.isDestroyed() && win.isMaximized());
});
