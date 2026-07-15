/**
 * Virtualized Live timeline — only render visible window of events
 */
(function (global) {
  const ROW_EST = 72;
  const OVERSCAN = 8;
  const MAX_KEEP = 500;

  /**
   * @param {HTMLElement} box
   * @param {Array<{kind?:string,title?:string,sub?:string,ts?:number}>} events
   * @param {{ esc?: Function }} opts
   */
  function renderVirtualTimeline(box, events, opts = {}) {
    if (!box) return;
    const esc =
      opts.esc ||
      ((s) =>
        String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;'));

    const list = Array.isArray(events) ? events.slice(-MAX_KEEP) : [];
    if (!list.length) {
      box.innerHTML = '';
      box._virt = null;
      return false;
    }

    // Small lists: plain render is fine
    if (list.length <= 40) {
      box.innerHTML = list.map((ev) => rowHtml(ev, esc)).join('');
      box.scrollTop = box.scrollHeight;
      box._virt = null;
      return true;
    }

    const state = {
      events: list,
      scrollTop: box.scrollTop,
      height: box.clientHeight || 400,
    };

    function paint() {
      const h = box.clientHeight || state.height;
      state.height = h;
      const total = state.events.length;
      const totalH = total * ROW_EST;
      const st = box.scrollTop;
      let start = Math.max(0, Math.floor(st / ROW_EST) - OVERSCAN);
      let end = Math.min(total, Math.ceil((st + h) / ROW_EST) + OVERSCAN);
      if (end <= start) end = Math.min(total, start + 20);

      const slice = state.events.slice(start, end);
      const padTop = start * ROW_EST;
      const padBottom = Math.max(0, totalH - end * ROW_EST);

      box.innerHTML =
        `<div class="virt-spacer" style="height:${padTop}px"></div>` +
        slice.map((ev) => rowHtml(ev, esc)).join('') +
        `<div class="virt-spacer" style="height:${padBottom}px"></div>`;
    }

    if (!box._virtBound) {
      box._virtBound = true;
      box.addEventListener(
        'scroll',
        () => {
          if (!box._virt) return;
          // rAF throttle
          if (box._virtRaf) return;
          box._virtRaf = requestAnimationFrame(() => {
            box._virtRaf = null;
            if (box._virt) box._virt.paint();
          });
        },
        { passive: true }
      );
    }

    box._virt = { state, paint };
    // stick to bottom if was near bottom
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    paint();
    if (nearBottom || opts.forceBottom) {
      box.scrollTop = box.scrollHeight;
      paint();
    }
    return true;
  }

  function rowHtml(ev, esc) {
    const ts = ev.ts ? new Date(ev.ts) : new Date();
    const t = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(
      ts.getSeconds()
    ).padStart(2, '0')}`;
    return `<div class="live-event ${esc(ev.kind || 'status')}">
      <div class="t">${t}</div>
      <div class="dot"></div>
      <div class="card">
        <div class="kind">${esc(ev.kind || 'status')}</div>
        <div class="title">${esc(ev.title || '')}</div>
        ${ev.sub ? `<div class="sub">${esc(ev.sub)}</div>` : ''}
      </div>
    </div>`;
  }

  /**
   * Append single event efficiently (invalidate virtual window)
   */
  function appendEvent(box, ev, opts = {}) {
    const esc = opts.esc || ((s) => String(s ?? ''));
    if (box._virt) {
      box._virt.state.events.push(ev);
      if (box._virt.state.events.length > MAX_KEEP) {
        box._virt.state.events = box._virt.state.events.slice(-MAX_KEEP);
      }
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
      box._virt.paint();
      if (nearBottom) {
        box.scrollTop = box.scrollHeight;
        box._virt.paint();
      }
      return;
    }
    // non-virtual path: let caller handle, or simple append
    const wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(ev, esc);
    const row = wrap.firstElementChild;
    if (row) {
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    }
  }

  global.GrokLiveVirtual = {
    renderVirtualTimeline,
    appendEvent,
    MAX_KEEP,
    ROW_EST,
  };
})(typeof window !== 'undefined' ? window : globalThis);
