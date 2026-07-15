const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grok', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  probeCli: () => ipcRenderer.invoke('cli:probe'),

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
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
