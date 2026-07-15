/**
 * 在外部编辑器中打开文件（VS Code / Cursor / 系统默认）
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

function which(cmd) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [cmd], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
    }
    const out = execFileSync('which', [cmd], { encoding: 'utf8', timeout: 3000 });
    return out.trim().split(/\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * @param {'auto'|'code'|'cursor'|'system'} preferred
 */
function resolveEditorBinary(preferred = 'auto') {
  if (preferred === 'system') return { kind: 'system', bin: null };
  if (preferred === 'code') {
    const b = which('code') || which('code-insiders');
    return b ? { kind: 'code', bin: b } : { kind: 'system', bin: null };
  }
  if (preferred === 'cursor') {
    const b = which('cursor');
    return b ? { kind: 'cursor', bin: b } : { kind: 'system', bin: null };
  }
  // auto: Cursor > VS Code > system
  const cursor = which('cursor');
  if (cursor) return { kind: 'cursor', bin: cursor };
  const code = which('code') || which('code-insiders');
  if (code) return { kind: 'code', bin: code };
  return { kind: 'system', bin: null };
}

/**
 * @param {string} absPath 绝对路径
 * @param {{ line?: number, column?: number, preferred?: string, workspaceRoot?: string }} opts
 */
function openInExternalEditor(absPath, opts = {}) {
  if (!absPath) throw new Error('缺少文件路径');
  const resolved = path.resolve(absPath);
  if (!fs.existsSync(resolved)) {
    // 允许打开不存在的路径时用父目录
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) throw new Error('路径不存在: ' + resolved);
  }

  const line = opts.line > 0 ? Number(opts.line) : null;
  const col = opts.column > 0 ? Number(opts.column) : 1;
  const editor = resolveEditorBinary(opts.preferred || 'auto');

  if (editor.kind === 'system' || !editor.bin) {
    // 系统默认；若提供 workspace 可打开文件夹
    const target = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
    shell.openPath(target);
    return { ok: true, method: 'system', path: target };
  }

  // code / cursor: -g file:line:col  以及可选 workspace
  const goto = line ? `${resolved}:${line}:${col}` : resolved;
  const args = [];
  if (opts.workspaceRoot && fs.existsSync(opts.workspaceRoot)) {
    args.push(opts.workspaceRoot);
  }
  args.push('-g', goto);

  try {
    const child = spawn(editor.bin, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.unref();
    return { ok: true, method: editor.kind, binary: editor.bin, path: resolved, line };
  } catch (err) {
    shell.openPath(resolved);
    return { ok: true, method: 'system-fallback', error: err.message, path: resolved };
  }
}

module.exports = { openInExternalEditor, resolveEditorBinary, which };
