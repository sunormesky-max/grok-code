/**
 * Diff / Code → 外部编辑器
 */
(function () {
  function $(sel) {
    return document.querySelector(sel);
  }

  async function openPath(relPath, opts = {}) {
    if (!relPath) {
      window.toast?.('没有选中文件', 'err');
      return;
    }
    const proj = window.ProjectStore?.active?.();
    if (!proj) {
      window.toast?.('请先打开项目', 'err');
      return;
    }
    try {
      const result = await window.grok.openInEditor({
        projectId: proj.id,
        relPath,
        line: opts.line,
        column: opts.column,
        workspaceRoot: proj.path,
      });
      const how = result?.method || 'editor';
      window.toast?.(`已在 ${how} 打开 ${relPath.split(/[/\\]/).pop()}`, 'ok');
    } catch (err) {
      window.toast?.(err.message || '打开失败', 'err');
    }
  }

  function bind() {
    $('#btnOpenExternal')?.addEventListener('click', () => {
      const p = window.ProjectStore?.active?.();
      const path = p?.selectedDiffPath || p?.currentFile;
      openPath(path);
    });
    $('#btnOpenExternalCode')?.addEventListener('click', () => {
      const p = window.ProjectStore?.active?.();
      openPath(p?.currentFile);
    });
  }

  window.GrokExternalEditor = { openPath };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
