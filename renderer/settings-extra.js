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
    const loc = $('#cfgLocale');
    if (loc) loc.value = window.GrokI18n?.getLocale?.() || cfg.locale || 'zh';
    const th = $('#cfgTheme');
    if (th) th.value = window.GrokThemes?.getTheme?.() || cfg.theme || 'grok';
    const dens = $('#cfgDensity');
    if (dens) dens.value = window.GrokDensity?.getDensity?.() || 'comfortable';
    const fx = $('#cfgFx');
    if (fx) fx.value = window.GrokFx?.getFx?.() || 'normal';
    const rm = $('#cfgReduceMotion');
    if (rm) rm.checked = Boolean(window.GrokFx?.getReduceMotion?.());
    const ci = $('#cfgCinematicIdle');
    if (ci) ci.checked = Boolean(window.GrokFx?.getCinematicIdle?.());
    const st = $('#cfgStylePack');
    if (st) st.value = cfg.stylePack || 'default';
    const pp = $('#cfgPersonalProtect');
    if (pp) pp.value = cfg.personalProtect || 'standard';
    const tr = $('#cfgTrashOnDelete');
    if (tr) tr.checked = cfg.trashOnDelete !== false;
    const sk = $('#cfgInjectSkills');
    if (sk) sk.checked = cfg.injectSkillsIndex !== false;
    const tel = $('#cfgTelemetry');
    if (tel) tel.checked = Boolean(cfg.telemetryEnabled);
    const telEp = $('#cfgTelemetryEndpoint');
    if (telEp) telEp.value = cfg.telemetryEndpoint || '';
  }

  function collectPartial() {
    const partial = {};
    const mode = $('#cfgContextMode');
    if (mode) partial.contextMode = mode.value === 'llm' ? 'llm' : 'heuristic';
    const ed = $('#cfgPreferredEditor');
    if (ed) partial.preferredEditor = ed.value || 'auto';
    const au = $('#cfgAutoUpdate');
    if (au) partial.autoUpdate = au.checked;
    const loc = $('#cfgLocale');
    if (loc) partial.locale = loc.value === 'en' ? 'en' : 'zh';
    const th = $('#cfgTheme');
    if (th) partial.theme = th.value || 'grok';
    const st = $('#cfgStylePack');
    if (st) partial.stylePack = st.value || 'default';
    const pp = $('#cfgPersonalProtect');
    if (pp) partial.personalProtect = pp.value || 'standard';
    const tr = $('#cfgTrashOnDelete');
    if (tr) partial.trashOnDelete = tr.checked;
    const sk = $('#cfgInjectSkills');
    if (sk) partial.injectSkillsIndex = sk.checked;
    const tel = $('#cfgTelemetry');
    if (tel) partial.telemetryEnabled = tel.checked;
    const telEp = $('#cfgTelemetryEndpoint');
    if (telEp) partial.telemetryEndpoint = telEp.value.trim();
    return partial;
  }

  async function runDoctorUi(opts = {}) {
    const host = $('#doctorResults');
    if (!host) return;
    const probeEl = $('#cfgDoctorProbe');
    const probePrompt =
      opts.probePrompt === true ||
      (probeEl ? Boolean(probeEl.checked) : false);
    host.innerHTML = probePrompt
      ? '<div class="muted pad">体检中…（含 grok -p 探测，可能需数十秒）</div>'
      : '<div class="muted pad">体检中…</div>';
    try {
      const report = await window.grok.doctorRun({ probePrompt });
      host.innerHTML = `
        <div class="doctor-summary ${report.ready ? 'ok' : 'bad'}">${esc(report.summary)}</div>
        ${(report.checks || [])
          .map(
            (c) => `
          <div class="doctor-item ${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'bad'}">
            <div class="di-head"><strong>${esc(c.name)}</strong> · ${esc(c.level)}${c.skipped ? ' · skip' : ''}</div>
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

  async function openPatchesFolder() {
    try {
      const r = await window.grok.doctorOpenPatches();
      if (r?.ok) {
        window.toast?.(
          r.dir
            ? `已打开：${r.dir}`
            : '已打开补丁目录',
          'ok'
        );
        return;
      }
      // Fallback: open GitHub in browser
      const url =
        r?.github ||
        'https://github.com/sunormesky-max/grok-code/tree/main/patches/grok-build';
      await window.grok.openExternal?.(url);
      window.toast?.(
        r?.error ? `${r.error} · 已打开 GitHub` : '已打开 GitHub 补丁页',
        'ok'
      );
    } catch (err) {
      window.toast?.(err.message || String(err), 'err');
    }
  }

  async function copyUpstreamFeedback() {
    try {
      const help = await window.grok.doctorPatchHelp();
      const text =
        help?.feedback?.text ||
        help?.readme?.text ||
        '';
      if (!text) {
        await window.grok.openExternal?.(
          help?.github ||
            'https://github.com/sunormesky-max/grok-code/tree/main/patches/grok-build'
        );
        window.toast?.('本地无 FEEDBACK.md，已打开 GitHub', 'err');
        return;
      }
      await navigator.clipboard.writeText(text);
      window.toast?.(
        '已复制 FEEDBACK.md — 在终端 grok 中执行 /feedback 粘贴',
        'ok'
      );
    } catch (err) {
      window.toast?.(err.message || String(err), 'err');
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

  async function saveAppearance() {
    const partial = collectPartial();
    if (partial.locale) {
      window.GrokI18n?.setLocale?.(partial.locale);
      window.toast?.(window.GrokI18n?.t?.('toast.lang') || '语言已切换', 'ok');
    }
    if (partial.theme) {
      window.GrokThemes?.setTheme?.(partial.theme);
      window.toast?.(window.GrokI18n?.t?.('toast.theme') || '主题已切换', 'ok');
    }
    const dens = $('#cfgDensity')?.value;
    if (dens) window.GrokDensity?.setDensity?.(dens);
    const fx = $('#cfgFx')?.value;
    if (fx) window.GrokFx?.setFx?.(fx);
    const rm = $('#cfgReduceMotion');
    if (rm) window.GrokFx?.setReduceMotion?.(rm.checked);
    const ci = $('#cfgCinematicIdle');
    if (ci) window.GrokFx?.setCinematicIdle?.(ci.checked);
    await window.grok.setConfig({
      locale: partial.locale,
      theme: partial.theme,
      stylePack: partial.stylePack,
      personalProtect: partial.personalProtect,
      trashOnDelete: partial.trashOnDelete,
      injectSkillsIndex: partial.injectSkillsIndex,
      telemetryEnabled: partial.telemetryEnabled,
      telemetryEndpoint: partial.telemetryEndpoint,
    });
    window.toast?.(window.GrokI18n?.t?.('toast.saved') || '设置已保存', 'ok');
  }

  function bind() {
    $('#btnRunDoctor')?.addEventListener('click', () => runDoctorUi());
    $('#btnExportDiag')?.addEventListener('click', () => exportDiag());
    $('#btnOpenPatches')?.addEventListener('click', () => openPatchesFolder());
    $('#btnCopyFeedback')?.addEventListener('click', () => copyUpstreamFeedback());
    $('#btnCheckUpdate')?.addEventListener('click', () => checkUpdate());
    $('#btnUpdateInstall')?.addEventListener('click', async () => {
      const ok = await window.grok.updateInstall();
      if (!ok) window.toast?.('当前无法安装更新（开发模式或未下载）', 'err');
    });
    $('#btnShowOnboarding')?.addEventListener('click', () => {
      window.GrokOnboarding?.show();
    });
    $('#btnSaveAppearance')?.addEventListener('click', () => saveAppearance());
    $('#cfgLocale')?.addEventListener('change', (e) => {
      window.GrokI18n?.setLocale?.(e.target.value);
    });
    $('#cfgTheme')?.addEventListener('change', (e) => {
      window.GrokThemes?.setTheme?.(e.target.value);
    });
    $('#cfgDensity')?.addEventListener('change', (e) => {
      window.GrokDensity?.setDensity?.(e.target.value);
      window.toast?.(
        window.GrokI18n?.t?.('toast.density', null, { mode: e.target.value }) || e.target.value,
        'ok'
      );
    });
    $('#cfgFx')?.addEventListener('change', (e) => {
      const mode = window.GrokFx?.setFx?.(e.target.value) || e.target.value;
      window.toast?.(
        window.GrokI18n?.t?.('toast.fx', null, { mode }) || `FX: ${mode}`,
        'ok'
      );
    });
    $('#cfgReduceMotion')?.addEventListener('change', (e) => {
      const on = window.GrokFx?.setReduceMotion?.(e.target.checked);
      window.toast?.(
        window.GrokI18n?.t?.('toast.motion', null, {
          mode: on ? 'on' : 'off',
        }) || (on ? '减少动效：开' : '减少动效：关'),
        'ok'
      );
    });
    $('#cfgCinematicIdle')?.addEventListener('change', (e) => {
      const on = window.GrokFx?.setCinematicIdle?.(e.target.checked);
      window.toast?.(
        window.GrokI18n?.t?.('toast.idle', null, {
          mode: on ? 'on' : 'off',
        }) || (on ? '电影级待机：开' : '电影级待机：关'),
        'ok'
      );
    });
    $('#btnOpenCrashDir')?.addEventListener('click', () => window.grok.telemetryOpenDir());

    // Theme pack import
    const drop = $('#themeDropZone');
    const fileInput = $('#themeFileInput');
    const applyThemeFile = async (file) => {
      if (!file) return;
      try {
        const text = await file.text();
        const pack = JSON.parse(text);
        if (!pack.vars || typeof pack.vars !== 'object') {
          window.toast?.(window.GrokI18n?.t?.('theme.import.err') || 'Invalid theme pack', 'err');
          return;
        }
        window.GrokThemes?.applyCustomPack?.(pack);
        window.toast?.(
          window.GrokI18n?.t?.('theme.import.ok', null, { name: pack.name || pack.id || file.name }) ||
            'Theme applied',
          'ok'
        );
      } catch (err) {
        window.toast?.(err.message || 'Import failed', 'err');
      }
    };
    $('#btnThemePick')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      applyThemeFile(f);
      fileInput.value = '';
    });
    if (drop) {
      ['dragenter', 'dragover'].forEach((ev) => {
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach((ev) => {
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.remove('dragover');
        });
      });
      drop.addEventListener('drop', (e) => {
        const f = e.dataTransfer?.files?.[0];
        applyThemeFile(f);
      });
      drop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput?.click();
        }
      });
    }

    $('#btnProfileExport')?.addEventListener('click', async () => {
      try {
        const proj = window.ProjectStore?.active?.();
        if (!proj) return window.toast?.('请先打开项目', 'err');
        const r = await window.grok.profileExport({ projectId: proj.id });
        window.toast?.(r.ok ? `已导出：${r.file}` : '导出失败', r.ok ? 'ok' : 'err');
      } catch (err) {
        window.toast?.(err.message, 'err');
      }
    });
    $('#btnProfileImport')?.addEventListener('click', async () => {
      try {
        const r = await window.grok.profileImport();
        if (!r) return;
        window.toast?.(`已导入配置「${r.name}」— 请查看设置中的规则/模型`, 'ok');
        // refresh settings fields
        const cfg = await window.grok.getConfig();
        fillFromConfig(cfg);
        if (cfg.rules && document.querySelector('#cfgRules')) {
          document.querySelector('#cfgRules').value = cfg.rules;
        }
      } catch (err) {
        window.toast?.(err.message, 'err');
      }
    });

    if (window.grok?.on) {
      window.grok.on('update:status', (st) => renderUpdateStatus(st));
    }

    // 初始状态
    window.grok?.updateStatus?.().then(renderUpdateStatus).catch(() => {});
    // i18n first paint
    try {
      window.GrokI18n?.applyDom?.();
    } catch {
      /* ignore */
    }
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
