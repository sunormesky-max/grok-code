/**
 * Chat message virtualization for long threads.
 * Strategy: keep full DOM for last TAIL messages (streaming-friendly);
 * older messages collapse into a "load earlier" summary + optional expand window.
 */
(function (global) {
  const TAIL = 40;
  const PAGE = 30;

  /**
   * @param {HTMLElement} pane
   * @param {Array<{role:string,content:string,ts?:number}>} messages
   * @param {{
   *   renderOne: (m: object, idx: number) => HTMLElement,
   *   showWelcome?: () => void,
   *   offset?: number
   * }} opts
   */
  function rebuildVirtual(pane, messages, opts) {
    if (!pane) return;
    const msgs = Array.isArray(messages) ? messages : [];
    pane.innerHTML = '';
    pane._chatVirt = {
      messages: msgs,
      offset: opts.offset != null ? opts.offset : Math.max(0, msgs.length - TAIL),
      renderOne: opts.renderOne,
    };

    if (!msgs.length) {
      opts.showWelcome?.();
      return;
    }

    const start = pane._chatVirt.offset;
    if (start > 0) {
      const bar = document.createElement('div');
      bar.className = 'chat-virt-bar';
      bar.innerHTML = `<button type="button" class="btn small ghost chat-virt-more">↑ 更早 ${start} 条消息</button>`;
      bar.querySelector('button').onclick = () => {
        const next = Math.max(0, pane._chatVirt.offset - PAGE);
        pane._chatVirt.offset = next;
        const prevH = pane.scrollHeight;
        rebuildVirtual(pane, pane._chatVirt.messages, {
          ...opts,
          offset: next,
        });
        // preserve scroll position when prepending
        pane.scrollTop = pane.scrollHeight - prevH;
      };
      pane.appendChild(bar);
    }

    for (let i = start; i < msgs.length; i++) {
      const el = opts.renderOne(msgs[i], i);
      if (el) pane.appendChild(el);
    }
  }

  /**
   * After live stream settles, if DOM grew huge, re-virtualize from task.messages
   */
  function maybeCompact(pane, messages, opts) {
    if (!pane || !messages) return false;
    const kids = pane.querySelectorAll('.msg').length;
    if (kids <= TAIL + 10) return false;
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
    rebuildVirtual(pane, messages, opts);
    if (nearBottom) pane.scrollTop = pane.scrollHeight;
    return true;
  }

  function makeMessageEl(m, { renderMarkdown, esc }) {
    const div = document.createElement('div');
    const role = m.role || 'assistant';
    const roleLabel = role === 'user' ? 'You' : role === 'tool' ? 'Tool' : 'Grok';
    div.className = `msg ${role}`;
    div.innerHTML = `<div class="role">${roleLabel}</div><div class="body${
      role === 'assistant' ? ' md' : ''
    }"></div>`;
    const body = div.querySelector('.body');
    if (role === 'assistant' && renderMarkdown) body.innerHTML = renderMarkdown(m.content || '');
    else body.textContent = m.content || '';
    return div;
  }

  global.GrokChatVirtual = {
    rebuildVirtual,
    maybeCompact,
    makeMessageEl,
    TAIL,
    PAGE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
