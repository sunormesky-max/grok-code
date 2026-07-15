/**
 * 首启向导 + 环境体检
 * 依赖 window.grok / window.toast
 */
(function () {
  const STEPS = ['welcome', 'doctor', 'project', 'done'];

  function $(sel) {
    return document.querySelector(sel);
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function levelClass(level) {
    if (level === 'ok') return 'ok';
    if (level === 'warn') return 'warn';
    return 'bad';
  }

  async function renderDoctor(host) {
    if (!host) return null;
    host.innerHTML = '<div class="muted pad">正在体检…</div>';
    try {
      const report = await window.grok.doctorRun();
      const checks = report.checks || [];
      host.innerHTML = `
        <div class="doctor-summary ${report.ready ? 'ok' : 'bad'}">${esc(report.summary)}</div>
        <div class="doctor-list">
          ${checks
            .map(
              (c) => `
            <div class="doctor-item ${levelClass(c.level)}">
              <div class="di-head">
                <span class="di-dot"></span>
                <strong>${esc(c.name)}</strong>
                <span class="di-level">${esc(c.level)}</span>
              </div>
              <div class="di-detail">${esc(c.detail || '').replace(/\n/g, '<br>')}</div>
              ${c.fix ? `<div class="di-fix">→ ${esc(c.fix)}</div>` : ''}
            </div>`
            )
            .join('')}
        </div>`;
      return report;
    } catch (err) {
      host.innerHTML = `<div class="doctor-summary bad">${esc(err.message || err)}</div>`;
      return null;
    }
  }

  function showStep(name) {
    document.querySelectorAll('.onb-step').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.step !== name);
    });
    document.querySelectorAll('.onb-dot').forEach((el) => {
      el.classList.toggle('active', el.dataset.step === name);
      el.classList.toggle(
        'done',
        STEPS.indexOf(el.dataset.step) < STEPS.indexOf(name)
      );
    });
  }

  async function finish(openSettings) {
    try {
      await window.grok.setConfig({ onboardingDone: true });
    } catch {
      /* ignore */
    }
    $('#onboardingModal')?.classList.add('hidden');
    if (openSettings) {
      document.getElementById('btnSettings')?.click();
    }
    window.toast?.('欢迎使用 GrokCode', 'ok');
  }

  async function maybeShow() {
    const modal = $('#onboardingModal');
    if (!modal || !window.grok) return;
    try {
      const cfg = await window.grok.getConfig();
      // 强制：?onboarding=1 或 CLI 不可用且未完成
      const force =
        /[?&]onboarding=1\b/.test(location.search) ||
        localStorage.getItem('grokcode-force-onboarding') === '1';
      if (cfg.onboardingDone && !force && cfg.cli?.ok) return;
      if (cfg.onboardingDone && cfg.cli?.ok && !force) return;

      modal.classList.remove('hidden');
      showStep('welcome');
      localStorage.removeItem('grokcode-force-onboarding');
    } catch {
      /* ignore */
    }
  }

  function bind() {
    const modal = $('#onboardingModal');
    if (!modal) return;

    $('#onbNextWelcome')?.addEventListener('click', async () => {
      showStep('doctor');
      await renderDoctor($('#onbDoctorHost'));
    });

    $('#onbRedoDoctor')?.addEventListener('click', async () => {
      await renderDoctor($('#onbDoctorHost'));
    });

    $('#onbOpenSettings')?.addEventListener('click', () => finish(true));

    $('#onbNextDoctor')?.addEventListener('click', () => showStep('project'));

    $('#onbPickProject')?.addEventListener('click', async () => {
      try {
        const info = await window.grok.projectOpen();
        if (info) {
          // 由 app.js 监听统一挂载 UI，避免重复 add
          window.dispatchEvent(new CustomEvent('grok:project-opened', { detail: info }));
        }
        showStep('done');
      } catch (err) {
        window.toast?.(err.message || '打开失败', 'err');
      }
    });

    $('#onbSkipProject')?.addEventListener('click', () => showStep('done'));

    $('#onbFinish')?.addEventListener('click', () => finish(false));
    $('#onbSkipAll')?.addEventListener('click', () => finish(false));
  }

  window.GrokOnboarding = {
    maybeShow,
    show: () => {
      $('#onboardingModal')?.classList.remove('hidden');
      showStep('welcome');
    },
    renderDoctor,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
