const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'renderer', 'app.js');
let s = fs.readFileSync(p, 'utf8');

const marker = `function anyRunning() {
  return window.TaskStore.countRunning() > 0;
}`;

const helpers = `function anyRunning() {
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
`;

if (!s.includes('function anyRunning()')) {
  console.error('anyRunning not found');
  process.exit(1);
}
s = s.replace(marker, helpers);

// API rewrites — only if not already patched
if (!s.includes('window.grok.listFiles(pid()')) {
  s = s.replace(/window\.grok\.listFiles\(/g, 'window.grok.listFiles(pid(), ');
  s = s.replace(/window\.grok\.readFile\(/g, 'window.grok.readFile(pid(), ');
  s = s.replace(/window\.grok\.exists\(/g, 'window.grok.exists(pid(), ');
  s = s.replace(/window\.grok\.statFile\(/g, 'window.grok.statFile(pid(), ');
  s = s.replace(/window\.grok\.runTerminal\(/g, 'window.grok.runTerminal(pid(), ');
  s = s.replace(/window\.grok\.writeFile\(/g, 'window.grok.writeFile(pid(), ');
  s = s.replace(/window\.grok\.deleteFile\(/g, 'window.grok.deleteFile(pid(), ');
}

// Map state fields onto active project
s = s.replace(/state\.changes\b/g, 'changesMap()');
s = s.replace(/state\.contentCache\b/g, 'contentCacheMap()');

// currentFile / dirty / selectedDiffPath — use get/set helpers later; do careful replace
// Replace reads of state.currentFile first with getCurFile(), etc.

// Simpler: inject property accessors on a proxy object - too heavy.
// Manual: replace state.currentFile with getCurrentFile() and setCurrentFile

function replaceAssignments(src, prop, getter, setter) {
  // assignments: state.prop = 
  const reAssign = new RegExp(`state\\.${prop}\\s*=`, 'g');
  src = src.replace(reAssign, `${setter} =`);
  // remaining reads
  const reRead = new RegExp(`state\\.${prop}\\b`, 'g');
  src = src.replace(reRead, getter);
  return src;
}

// Use P().field for both — assignments: P().currentFile =
// But P() might be null — use requireProject() for writes

s = s.replace(/state\.currentFile\s*=/g, 'requireProject().currentFile =');
s = s.replace(/state\.dirty\s*=/g, 'requireProject().dirty =');
s = s.replace(/state\.selectedDiffPath\s*=/g, 'requireProject().selectedDiffPath =');
s = s.replace(/state\.currentFile\b/g, '(P() && P().currentFile)');
s = s.replace(/state\.dirty\b/g, '(P() && P().dirty)');
s = s.replace(/state\.selectedDiffPath\b/g, '(P() && P().selectedDiffPath)');

// runAgent must include projectId
s = s.replace(
  /window\.grok\.runAgent\(\{\s*message:\s*text,\s*taskId:\s*task\.id,\s*sessionId:\s*task\.sessionId,\s*\}\)/,
  `window.grok.runAgent({
      message: text,
      projectId: pid(),
      taskId: task.id,
      sessionId: task.sessionId,
    })`
);

s = s.replace(
  /window\.grok\.stopAgent\(\{\s*taskId:\s*task\.id\s*\}\)/g,
  'window.grok.stopAgent({ projectId: pid(), taskId: task.id })'
);

s = s.replace(
  /window\.grok\.clearSession\(\{\s*taskId:\s*t\.id\s*\}\)/g,
  'window.grok.clearSession({ projectId: pid(), taskId: t.id })'
);

s = s.replace(
  /window\.grok\.clearSession\(\{\s*taskId:\s*task\.id\s*\}\)/g,
  'window.grok.clearSession({ projectId: pid(), taskId: task.id })'
);

fs.writeFileSync(p, s);
console.log('patched projects bulk', p);
