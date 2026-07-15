/**
 * 设置扩展：上下文模式、编辑器、更新、诊断
 * 与 app.js 的 refreshConfigUi / saveSettings 协作
 */
(function () {
  function $(sel) {
    return document.querySelector(sel);
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function fillFromConfig(cfg) {
    if (!cfg) return;
    const mode = $('#cfgContextMode');
    if (mode) mode.value = cfg.contextMode === 'llm' ? 'llm' : 'heuristic';
    const ed = $('#cfgPreferredEditor');
    if (ed) ed.value = cfg.preferredEditor || 'auto';
    const au = $('#cfgAutoUpdate');
    if (au) au.checked = cfg.autoUpdate !== false;
    const ver = $('#appVersionLabel');
    if (ver) ver.textContent = cfg.appVersion ? `v${cfg.appVersion}` : '';
  }

  function collectPartial() {
    const partial = {};
    const mode = $('#cfgContextMode');
    if (mode) partial.contextMode = mode.value === 'llm' ? 'llm' : 'heuristic';
    const ed = $('#cfgPreferredEditor');
    if (ed) partial.preferredEditor = ed.value || 'auto';
    const au = $('#cfgAutoUpdate');
    if (au) partial.autoUpdate = au.checked;
    return partial;
  }

  async function runDoctorUi() {
    const host = $('#doctorResults');
    if (!host) return;
    host.innerHTML = '<div class="muted pad">体检中…</div>';
    try {
      const report = await window.grok.doctorRun();
      host.innerHTML = `
        <div class="doctor-summary ${report.ready ? 'ok' : 'bad'}">${esc(report.summary)}</div>
        ${(report.checks || [])
          .map(
            (c) => `
          <div class="doctor-item ${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'bad'}">
            <div class="di-head"><strong>${esc(c.name)}</strong> · ${esc(c.level)}</div>
            <div class="di-detail">${esc(c.detail || '').replace(/\n/g, '<br>')}</div>
            ${c.fix ? `<div class="di-fix">→ ${esc(c.fix)}</div>` : ''}
          </div>`
          )
          .join('')}`;
      // 同步顶栏 CLI
      const cli = report.checks?.find((c) => c.id === 'cli');
      if (cli && window.setCliLabelFromProbe) {
        window.setCliLabelFromProbe({
          ok: cli.ok,
          version: cli.version,
          binary: cli.binary,
          error: cli.ok ? null : cli.detail,
        });
      }
      window.toast?.(report.summary, report.ready ? 'ok' : 'err');
    } catch (err) {
      host.innerHTML = `<div class="doctor-summary bad">${esc(err.message)}</div>`;
    }
  }

  async function exportDiag() {
    try {
      const r = await window.grok.doctorExport();
      if (r.ok) {
        window.toast?.(`诊断包已导出：${r.dir}`, 'ok');
      } else {
        window.toast?.(r.error || '导出失败', 'err');
      }
    } catch (err) {
      window.toast?.(err.message || '导出失败', 'err');
    }
  }

  function renderUpdateStatus(st) {
    const el = $('#updateStatusText');
    if (!el || !st) return;
    el.textContent = st.message || st.status || '—';
    el.dataset.status = st.status || '';
    const installBtn = $('#btnUpdateInstall');
    if (installBtn) {
      installBtn.classList.toggle('hidden', st.status !== 'ready');
    }
  }

  async function checkUpdate() {
    renderUpdateStatus({ status: 'checking', message: '检查中…' });
    try {
      const st = await window.grok.updateCheck();
      renderUpdateStatus(st);
      window.toast?.(st.message || '检查完成', st.status === 'error' ? 'err' : 'ok');
    } catch (err) {
      renderUpdateStatus({ status: 'error', message: err.message });
    }
  }

  function bind() {
    $('#btnRunDoctor')?.addEventListener('click', () => runDoctorUi());
    $('#btnExportDiag')?.addEventListener('click', () => exportDiag());
    $('#btnCheckUpdate')?.addEventListener('click', () => checkUpdate());
    $('#btnUpdateInstall')?.addEventListener('click', async () => {
      const ok = await window.grok.updateInstall();
      if (!ok) window.toast?.('当前无法安装更新（开发模式或未下载）', 'err');
    });
    $('#btnShowOnboarding')?.addEventListener('click', () => {
      window.GrokOnboarding?.show();
    });

    if (window.grok?.on) {
      window.grok.on('update:status', (st) => renderUpdateStatus(st));
    }

    // 初始状态
    window.grok?.updateStatus?.().then(renderUpdateStatus).catch(() => {});
  }

  window.GrokSettingsExtra = {
    fillFromConfig,
    collectPartial,
    runDoctorUi,
    exportDiag,
    checkUpdate,
    renderUpdateStatus,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
