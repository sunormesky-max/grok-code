const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grok', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  probeCli: () => ipcRenderer.invoke('cli:probe'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  listModes: () => ipcRenderer.invoke('modes:list'),
  projectRulesGet: (payload) => ipcRenderer.invoke('projectRules:get', payload || {}),
  projectRulesSet: (payload) => ipcRenderer.invoke('projectRules:set', payload || {}),
  pasteSaveImage: (payload) => ipcRenderer.invoke('paste:saveImage', payload || {}),

  // 多项目
  projectList: () => ipcRenderer.invoke('project:list'),
  projectOpen: () => ipcRenderer.invoke('project:open'),
  projectOpenPath: (dirPath) => ipcRenderer.invoke('project:openPath', dirPath),
  projectClose: (projectId) => ipcRenderer.invoke('project:close', projectId),
  projectOpenInNewWindow: () => ipcRenderer.invoke('project:openInNewWindow'),

  // 兼容：打开 = 加入项目列表
  openWorkspace: () => ipcRenderer.invoke('project:open'),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),

  listFiles: (projectId, relPath = '.') =>
    ipcRenderer.invoke('fs:list', { projectId, relPath }),
  readFile: (projectId, relPath) =>
    ipcRenderer.invoke('fs:read', { projectId, relPath: relPath }),
  writeFile: (projectId, relPath, content) =>
    ipcRenderer.invoke('fs:write', { projectId, relPath, content }),
  deleteFile: (projectId, relPath) =>
    ipcRenderer.invoke('fs:delete', { projectId, relPath }),
  exists: (projectId, relPath) =>
    ipcRenderer.invoke('fs:exists', { projectId, relPath }),
  statFile: (projectId, relPath) =>
    ipcRenderer.invoke('fs:stat', { projectId, relPath }),
  searchContent: (projectId, query, opts = {}) =>
    ipcRenderer.invoke('fs:search', {
      projectId,
      query,
      hint: opts.hint || '',
      maxHits: opts.maxHits || 60,
    }),
  searchPaths: (projectId, query, opts = {}) =>
    ipcRenderer.invoke('fs:searchPaths', {
      projectId,
      query,
      maxHits: opts.maxHits || 80,
    }),

  runTerminal: (projectId, command) =>
    ipcRenderer.invoke('terminal:run', { projectId, command }),

  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),
  stopAgent: (payload) => ipcRenderer.invoke('agent:stop', payload || {}),
  clearSession: (payload) => ipcRenderer.invoke('agent:clearSession', payload || {}),
  listRunningAgents: () => ipcRenderer.invoke('agent:running'),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // 上下文继承 / 持久化
  persistSave: (snapshot) => ipcRenderer.invoke('persist:save', snapshot),
  persistLoad: (projectPath) => ipcRenderer.invoke('persist:load', projectPath),
  persistList: () => ipcRenderer.invoke('persist:list'),
  persistDelete: (projectPath) => ipcRenderer.invoke('persist:delete', projectPath),
  persistRoot: () => ipcRenderer.invoke('persist:root'),
  compressContext: (payload) => ipcRenderer.invoke('context:compress', payload),

  // 体检 / 诊断
  doctorRun: () => ipcRenderer.invoke('doctor:run'),
  doctorExport: () => ipcRenderer.invoke('doctor:export'),

  // 外部编辑器
  openInEditor: (payload) => ipcRenderer.invoke('editor:open', payload || {}),
  resolveEditor: () => ipcRenderer.invoke('editor:resolve'),

  // 更新
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),

  // Plugins marketplace
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  pluginAvailable: () => ipcRenderer.invoke('plugin:available'),
  pluginMarketplaces: () => ipcRenderer.invoke('plugin:marketplaces'),
  pluginMarketplaceAdd: (payload) => ipcRenderer.invoke('plugin:marketplaceAdd', payload || {}),
  pluginMarketplaceRemove: (payload) =>
    ipcRenderer.invoke('plugin:marketplaceRemove', payload || {}),
  pluginMarketplaceUpdate: () => ipcRenderer.invoke('plugin:marketplaceUpdate'),
  pluginInstall: (payload) => ipcRenderer.invoke('plugin:install', payload || {}),
  pluginUninstall: (payload) => ipcRenderer.invoke('plugin:uninstall', payload || {}),
  pluginEnable: (payload) => ipcRenderer.invoke('plugin:enable', payload || {}),
  pluginDisable: (payload) => ipcRenderer.invoke('plugin:disable', payload || {}),
  pluginDetails: (payload) => ipcRenderer.invoke('plugin:details', payload || {}),

  // Project profiles
  profileExport: (payload) => ipcRenderer.invoke('profile:export', payload || {}),
  profileImport: () => ipcRenderer.invoke('profile:import'),
  profileList: () => ipcRenderer.invoke('profile:list'),
  profileDir: () => ipcRenderer.invoke('profile:dir'),

  // Session share card
  sessionExportShare: (payload) => ipcRenderer.invoke('session:exportShare', payload || {}),

  // Telemetry
  telemetryReport: (payload) => ipcRenderer.invoke('telemetry:report', payload || {}),
  telemetryList: () => ipcRenderer.invoke('telemetry:list'),
  telemetryOpenDir: () => ipcRenderer.invoke('telemetry:openDir'),

  // MCP
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpAdd: (payload) => ipcRenderer.invoke('mcp:add', payload),
  mcpRemove: (payload) => ipcRenderer.invoke('mcp:remove', payload),
  mcpToggle: (payload) => ipcRenderer.invoke('mcp:toggle', payload),
  mcpDoctor: (payload) => ipcRenderer.invoke('mcp:doctor', payload),
  mcpSetTimeout: (payload) => ipcRenderer.invoke('mcp:setTimeout', payload),

  // Skills
  skillsList: (payload) => ipcRenderer.invoke('skills:list', payload || {}),
  skillsToggle: (payload) => ipcRenderer.invoke('skills:toggle', payload),
  skillsCreate: (payload) => ipcRenderer.invoke('skills:create', payload),
  skillsRead: (payload) => ipcRenderer.invoke('skills:read', payload),
  skillsWrite: (payload) => ipcRenderer.invoke('skills:write', payload),
  skillsDelete: (payload) => ipcRenderer.invoke('skills:delete', payload),
  skillsOpenDir: (payload) => ipcRenderer.invoke('skills:openDir', payload || {}),
  grokHome: () => ipcRenderer.invoke('paths:grokHome'),

  on: (channel, callback) => {
    const allowed = [
      'agent:status',
      'agent:text',
      'agent:thought',
      'agent:tool_start',
      'agent:tool_end',
      'agent:error',
      'agent:done',
      'agent:cli',
      'fs:changed',
      'window:maximized',
      'update:status',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
