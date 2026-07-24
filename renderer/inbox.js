/**
 * Global Inbox — cross-task attention queue for parked CLI reverse-requests.
 * Inspired by OpenWorker inbox (approval / question / plan) without a second agent.
 *
 * Host only: items mirror plan_approval + user_question already parked in ACP.
 * First resolve wins; resolving removes the item (task bar handlers also clear).
 */
(function (global) {
  /** @typedef {'plan'|'question'} InboxKind */
  /**
   * @typedef {object} InboxItem
   * @property {string} id
   * @property {InboxKind} kind
   * @property {string} taskId
   * @property {string} [projectId]
   * @property {string|number} requestId
   * @property {string} [taskTitle]
   * @property {string} [projectName]
   * @property {string} title
   * @property {string} [body]
   * @property {object} [meta]
   * @property {number} createdAt
   * @property {'pending'|'resolved'} state
   */

  /** @type {Map<string, InboxItem>} */
  const items = new Map();
  /** @type {Set<function>} */
  const listeners = new Set();

  function t(k, fb) {
    return global.GrokI18n?.t?.(k, fb) || fb || k;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function itemId(kind, taskId, requestId) {
    return `${kind}:${taskId}:${requestId}`;
  }

  function emit() {
    const snap = listPending();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {
        /* ignore */
      }
    }
    try {
      paintBadge();
      if (typeof document !== 'undefined' && isOpen()) renderList();
    } catch {
      /* Node tests / no DOM */
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * @param {Partial<InboxItem> & { kind: InboxKind, taskId: string, requestId: string|number }} raw
   */
  function upsert(raw) {
    if (!raw?.kind || !raw?.taskId || raw.requestId == null) return null;
    const id = raw.id || itemId(raw.kind, raw.taskId, raw.requestId);
    const prev = items.get(id);
    const next = {
      id,
      kind: raw.kind,
      taskId: String(raw.taskId),
      projectId: raw.projectId != null ? String(raw.projectId) : prev?.projectId || '',
      requestId: raw.requestId,
      taskTitle: raw.taskTitle || prev?.taskTitle || '',
      projectName: raw.projectName || prev?.projectName || '',
      title: raw.title || prev?.title || kindDefaultTitle(raw.kind),
      body: raw.body != null ? String(raw.body) : prev?.body || '',
      meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : prev?.meta || {},
      createdAt: prev?.createdAt || Date.now(),
      state: 'pending',
    };
    const isNew = !prev || prev.state !== 'pending';
    items.set(id, next);
    emit();
    if (isNew) {
      try {
        const msg = String(t('inbox.announce', 'Inbox: {n} waiting')).replace(
          '{n}',
          String(count())
        );
        global.GrokA11y?.announce?.(msg, { assertive: true });
      } catch {
        /* optional */
      }
    }
    return next;
  }

  function kindDefaultTitle(kind) {
    if (kind === 'plan') return t('inbox.kind.plan', 'Plan approval');
    if (kind === 'question') return t('inbox.kind.question', 'Agent question');
    return kind;
  }

  function resolve(id) {
    const it = items.get(id);
    if (!it) return false;
    items.delete(id);
    emit();
    return true;
  }

  /**
   * @param {{ kind?: string, taskId?: string, requestId?: string|number }} match
   */
  function removeMatching(match = {}) {
    let n = 0;
    for (const [id, it] of [...items.entries()]) {
      if (match.kind && it.kind !== match.kind) continue;
      if (match.taskId != null && String(it.taskId) !== String(match.taskId)) continue;
      if (match.requestId != null && String(it.requestId) !== String(match.requestId)) continue;
      items.delete(id);
      n += 1;
    }
    if (n) emit();
    return n;
  }

  function listPending() {
    return [...items.values()]
      .filter((i) => i.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function count() {
    return listPending().length;
  }

  function clearAll() {
    if (!items.size) return;
    items.clear();
    emit();
  }

  // ── UI ──────────────────────────────────────────────

  function ensure() {
    let root = document.getElementById('inboxOverlay');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'inboxOverlay';
    root.className = 'inbox-overlay hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'inboxTitle');
    root.innerHTML = `
      <div class="inbox-backdrop" data-close="1"></div>
      <div class="inbox-panel glass" data-a11y-autofocus>
        <div class="inbox-head">
          <div>
            <div class="inbox-kicker">xAI · ATTENTION QUEUE · CLI HOST</div>
            <h2 id="inboxTitle">${esc(t('inbox.title', 'Inbox'))}</h2>
          </div>
          <div class="inbox-head-actions">
            <button type="button" class="icon-btn" id="inboxClose" aria-label="close">✕</button>
          </div>
        </div>
        <p class="inbox-foot muted" id="inboxHint">${esc(
          t(
            'inbox.hint',
            'Parked plan approvals & questions across tasks. Answer here or jump to the task.'
          )
        )}</p>
        <div class="inbox-list" id="inboxList"></div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.inbox-backdrop')?.addEventListener('click', close);
    root.querySelector('#inboxClose')?.addEventListener('click', close);
    return root;
  }

  function paintBadge() {
    if (typeof document === 'undefined') return;
    const n = count();
    const btn = document.getElementById('btnInbox');
    const badge = document.getElementById('inboxBadge');
    if (btn) {
      btn.classList.toggle('has-items', n > 0);
      btn.setAttribute('aria-label', t('inbox.btn', 'Inbox') + (n ? ` (${n})` : ''));
      btn.title = n
        ? String(t('inbox.btn.n', 'Inbox · {n} waiting')).replace('{n}', String(n))
        : t('inbox.btn', 'Inbox');
    }
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', n === 0);
    }
  }

  function renderList() {
    const list = document.getElementById('inboxList');
    if (!list) return;
    const pending = listPending();
    const en = (global.GrokI18n?.getLocale?.() || 'zh') === 'en';
    if (!pending.length) {
      list.innerHTML = `<div class="inbox-empty">${esc(
        t('inbox.empty', 'Nothing waiting — plan & questions appear here while agents run.')
      )}</div>`;
      return;
    }
    list.innerHTML = pending
      .map((it) => {
        const kindLabel =
          it.kind === 'plan'
            ? en
              ? 'PLAN'
              : '计划'
            : en
              ? 'ASK'
              : '提问';
        const where = [it.projectName, it.taskTitle].filter(Boolean).join(' · ') || it.taskId;
        const preview = String(it.body || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220);
        const age = formatAge(it.createdAt, en);
        if (it.kind === 'plan') {
          return `
          <article class="inbox-card" data-id="${esc(it.id)}" data-kind="plan">
            <div class="inbox-card-top">
              <span class="inbox-chip kind-plan">${kindLabel}</span>
              <span class="inbox-where" title="${esc(where)}">${esc(where)}</span>
              <span class="inbox-age">${esc(age)}</span>
            </div>
            <div class="inbox-card-title">${esc(it.title)}</div>
            ${preview ? `<pre class="inbox-preview">${esc(preview)}${it.body && it.body.length > 220 ? '…' : ''}</pre>` : ''}
            <label class="inbox-feedback">
              <span>${esc(en ? 'Feedback (for request changes)' : '修改意见（用于要求修改）')}</span>
              <input type="text" class="inbox-feedback-input" data-id="${esc(it.id)}" placeholder="${esc(en ? 'What should change…' : '希望如何调整…')}" />
            </label>
            <div class="inbox-actions">
              <button type="button" class="btn small primary" data-act="approve" data-id="${esc(it.id)}">✓ ${esc(en ? 'Approve' : '批准')}</button>
              <button type="button" class="btn small ghost" data-act="revise" data-id="${esc(it.id)}">✎ ${esc(en ? 'Revise' : '修改')}</button>
              <button type="button" class="btn small ghost" data-act="quit" data-id="${esc(it.id)}">✕ ${esc(en ? 'Quit' : '放弃')}</button>
              <button type="button" class="btn small ghost" data-act="goto" data-id="${esc(it.id)}">↗ ${esc(en ? 'Task' : '任务')}</button>
            </div>
          </article>`;
        }
        const qn = Array.isArray(it.meta?.questions) ? it.meta.questions.length : 0;
        const qHint = qn
          ? en
            ? `${qn} question(s) · open task to answer`
            : `${qn} 个问题 · 请到任务内回答`
          : en
            ? 'Open task to answer'
            : '请到任务内回答';
        return `
        <article class="inbox-card" data-id="${esc(it.id)}" data-kind="question">
          <div class="inbox-card-top">
            <span class="inbox-chip kind-ask">${kindLabel}</span>
            <span class="inbox-where" title="${esc(where)}">${esc(where)}</span>
            <span class="inbox-age">${esc(age)}</span>
          </div>
          <div class="inbox-card-title">${esc(it.title)}</div>
          ${preview ? `<div class="inbox-preview-text">${esc(preview)}</div>` : ''}
          <p class="inbox-qhint muted">${esc(qHint)}</p>
          <div class="inbox-actions">
            <button type="button" class="btn small primary" data-act="goto" data-id="${esc(it.id)}">↗ ${esc(en ? 'Open & answer' : '打开并回答')}</button>
            <button type="button" class="btn small ghost" data-act="dismiss-q" data-id="${esc(it.id)}">✕ ${esc(en ? 'Cancel ask' : '取消提问')}</button>
          </div>
        </article>`;
      })
      .join('');

    list.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onCardAction(btn.dataset.act, btn.dataset.id));
    });
  }

  function formatAge(ts, en) {
    const sec = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
    if (sec < 60) return en ? `${sec}s` : `${sec}秒`;
    const m = Math.floor(sec / 60);
    if (m < 60) return en ? `${m}m` : `${m}分`;
    const h = Math.floor(m / 60);
    return en ? `${h}h` : `${h}时`;
  }

  async function onCardAction(act, id) {
    const it = items.get(id);
    if (!it) return;
    const handlers = global.GrokInboxHandlers || {};

    if (act === 'goto') {
      try {
        await handlers.gotoTask?.(it);
      } catch (e) {
        global.toast?.(e.message || String(e), 'err');
      }
      return;
    }

    if (it.kind === 'plan') {
      const root = document.getElementById('inboxList');
      let feedback = '';
      root?.querySelectorAll?.('.inbox-feedback-input')?.forEach((inp) => {
        if (inp.dataset.id === id) feedback = inp.value?.trim() || '';
      });
      let outcome = 'cancelled';
      if (act === 'approve') outcome = 'approved';
      else if (act === 'quit') outcome = 'abandoned';
      else if (act === 'revise') outcome = 'cancelled';
      else return;
      try {
        const r = await handlers.replyPlan?.(it, outcome, outcome === 'cancelled' ? feedback : '');
        if (r && r.ok === false) {
          global.toast?.(r.error || 'plan reply failed', 'err');
          return;
        }
        resolve(id);
        // Remove in-pane bar if present
        try {
          handlers.onPlanResolved?.(it, outcome);
        } catch {
          /* optional */
        }
        const en = (global.GrokI18n?.getLocale?.() || 'zh') === 'en';
        global.toast?.(
          outcome === 'approved'
            ? en
              ? 'Plan approved'
              : '已批准计划'
            : outcome === 'abandoned'
              ? en
                ? 'Plan abandoned'
                : '已放弃计划'
              : en
                ? 'Requested plan changes'
                : '已要求修改计划',
          'ok'
        );
      } catch (e) {
        global.toast?.(e.message || String(e), 'err');
      }
      return;
    }

    if (it.kind === 'question' && act === 'dismiss-q') {
      try {
        const r = await handlers.replyQuestion?.(it, { outcome: 'cancelled' });
        if (r && r.ok === false) {
          global.toast?.(r.error || 'cancel failed', 'err');
          return;
        }
        resolve(id);
        try {
          handlers.onQuestionResolved?.(it, 'cancelled');
        } catch {
          /* optional */
        }
        global.toast?.(t('inbox.q.cancelled', '已取消提问'), 'ok');
      } catch (e) {
        global.toast?.(e.message || String(e), 'err');
      }
    }
  }

  function open() {
    ensure();
    renderList();
    const root = document.getElementById('inboxOverlay');
    root?.classList.remove('hidden');
    const panel = root?.querySelector('.inbox-panel');
    try {
      global.GrokA11y?.trapFocus?.(panel || root);
    } catch {
      /* optional */
    }
  }

  function close() {
    document.getElementById('inboxOverlay')?.classList.add('hidden');
    try {
      global.GrokA11y?.releaseTrap?.();
    } catch {
      /* optional */
    }
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  function isOpen() {
    if (typeof document === 'undefined') return false;
    const el = document.getElementById('inboxOverlay');
    return Boolean(el && !el.classList.contains('hidden'));
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        e.preventDefault();
        close();
      }
      // Ctrl+Shift+I — open inbox
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
        const tag = (e.target && e.target.tagName) || '';
        if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target?.isContentEditable) return;
        e.preventDefault();
        toggle();
      }
    });

    // Re-paint ages periodically while open
    setInterval(() => {
      if (isOpen() && count() > 0) renderList();
    }, 15000);
  }

  const api = {
    itemId,
    upsert,
    resolve,
    removeMatching,
    listPending,
    count,
    clearAll,
    onChange,
    open,
    close,
    toggle,
    isOpen,
    paintBadge,
    ensure,
  };

  global.GrokInbox = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
