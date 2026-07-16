/**
 * GrokCode 启动序列 — 舰桥上电
 * 可点击 / Esc / 任意键跳过
 */
(function () {
  const LINES = [
    { t: 0, text: '> GROKCODE BIOS v1.5 — xAI FLIGHT DECK' },
    { t: 140, text: '> POWER RAIL · ICE CYAN / MARS ORANGE ONLINE' },
    { t: 280, text: '> INITIALIZING NEURAL BUS…' },
    { t: 420, text: '> LINKING LOCAL GROK CLI DRIVER…' },
    { t: 560, text: '> MOUNTING MULTI-PROJECT SANDBOX…' },
    { t: 700, text: '> CONTEXT L0–L3 · AGENT THREADS READY' },
    { t: 840, text: '> HUD CALIBRATION · LAYOUT AGENT/PILOT/REVIEW' },
    { t: 980, text: '> STARFIELD + HOLO BEAM RENDER ONLINE' },
    { t: 1120, text: '> DIFF FILMSTRIP · STORYBOARD PACK ARMED' },
    { t: 1280, text: '> MAXIMUM TRUTH-SEEKING PROTOCOL: ENABLED' },
    { t: 1460, text: '> SYSTEMS NOMINAL. WELCOME ABOARD, COMMANDER.' },
  ];

  const root = document.getElementById('bootScreen');
  if (!root) return;

  const logEl = document.getElementById('bootLog');
  const barEl = document.getElementById('bootBarFill');
  const pctEl = document.getElementById('bootPct');
  const skipEl = document.getElementById('bootSkip');

  let done = false;
  let timers = [];

  function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers = [];
  }

  function finish() {
    if (done) return;
    done = true;
    clearTimers();
    root.classList.add('boot-out');
    document.body.classList.add('booted');
    setTimeout(() => {
      root.remove();
      window.dispatchEvent(new CustomEvent('grok:booted'));
    }, 700);
  }

  function setProgress(p) {
    const v = Math.max(0, Math.min(100, p));
    if (barEl) barEl.style.width = v + '%';
    if (pctEl) pctEl.textContent = Math.round(v) + '%';
  }

  function appendLine(text, final) {
    if (!logEl) return;
    const row = document.createElement('div');
    row.className = 'boot-line' + (final ? ' final' : '');
    row.textContent = text;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // 逐行启动日志
  LINES.forEach((line, i) => {
    timers.push(
      setTimeout(() => {
        appendLine(line.text, i === LINES.length - 1);
        setProgress(((i + 1) / LINES.length) * 92);
      }, line.t)
    );
  });

  // 进度条补满 + 退场
  timers.push(
    setTimeout(() => {
      setProgress(100);
    }, 1650)
  );
  timers.push(setTimeout(finish, 2400));

  // 跳过
  function skip(e) {
    if (e) e.preventDefault();
    setProgress(100);
    appendLine('> SKIP — MANUAL OVERRIDE', true);
    finish();
  }
  root.addEventListener('click', skip);
  skipEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    skip(e);
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!done && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) skip(e);
    },
    { once: true }
  );

  // 减少动效偏好：几乎立刻结束
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(100);
      appendLine('> SYSTEMS READY', true);
      setTimeout(finish, 200);
    }
  } catch {
    /* ignore */
  }

  window.GrokBoot = { finish, skip };
})();
