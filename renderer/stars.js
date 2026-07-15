/* Grok 深空星尘 — 轻量 canvas，低 CPU */
(function initStarfield() {
  const canvas = document.getElementById('starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  let w = 0;
  let h = 0;
  let stars = [];
  let meteors = [];
  let raf = 0;
  let last = 0;
  let reduced = false;

  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    /* ignore */
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    spawnStars();
  }

  function spawnStars() {
    const count = Math.min(180, Math.floor((w * h) / 14000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random(),
      r: Math.random() * 1.4 + 0.2,
      tw: Math.random() * Math.PI * 2,
      sp: 0.4 + Math.random() * 1.2,
      warm: Math.random() > 0.85,
    }));
  }

  function spawnMeteor() {
    if (meteors.length > 2) return;
    meteors.push({
      x: Math.random() * w * 0.8 + w * 0.1,
      y: Math.random() * h * 0.35,
      len: 60 + Math.random() * 90,
      speed: 8 + Math.random() * 10,
      life: 1,
      angle: Math.PI / 4 + (Math.random() - 0.5) * 0.2,
    });
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(40, t - last || 16);
    last = t;

    ctx.clearRect(0, 0, w, h);

    // soft vignette void
    const g = ctx.createRadialGradient(w * 0.5, h * 0.2, 0, w * 0.5, h * 0.4, Math.max(w, h) * 0.7);
    g.addColorStop(0, 'rgba(20, 28, 48, 0.15)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    for (const s of stars) {
      s.tw += 0.02 * s.sp * (dt / 16);
      const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(s.tw)) * (0.4 + s.z * 0.6);
      const r = s.r * (0.7 + s.z * 0.6);
      if (s.warm) {
        ctx.fillStyle = `rgba(251, 146, 60, ${a * 0.85})`;
      } else {
        ctx.fillStyle = `rgba(186, 230, 253, ${a})`;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();

      // slow drift
      s.y += 0.015 * s.sp * (dt / 16);
      if (s.y > h + 2) {
        s.y = -2;
        s.x = Math.random() * w;
      }
    }

    // meteors
    if (!reduced && Math.random() < 0.004) spawnMeteor();
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.x += Math.cos(m.angle) * m.speed * (dt / 16);
      m.y += Math.sin(m.angle) * m.speed * (dt / 16);
      m.life -= 0.012 * (dt / 16);
      if (m.life <= 0 || m.x > w || m.y > h) {
        meteors.splice(i, 1);
        continue;
      }
      const tx = m.x - Math.cos(m.angle) * m.len;
      const ty = m.y - Math.sin(m.angle) * m.len;
      const grad = ctx.createLinearGradient(tx, ty, m.x, m.y);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.6, `rgba(125, 211, 252, ${0.35 * m.life})`);
      grad.addColorStop(1, `rgba(255,255,255, ${0.9 * m.life})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
    }
  }

  window.addEventListener('resize', () => {
    clearTimeout(resize._t);
    resize._t = setTimeout(resize, 120);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  resize();
  if (!reduced) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  } else {
    // static stars only
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      ctx.fillStyle = s.warm ? 'rgba(251,146,60,0.5)' : 'rgba(186,230,253,0.55)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
})();
