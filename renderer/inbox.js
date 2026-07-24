/**
 * Global Inbox — cross-task attention queue for parked CLI reverse-requests.
 * Inspired by OpenWorker inbox (approval / question / plan) without a second agent.
 *
 * Host only: items mirror plan/ask/permission already parked in ACP.
 * First resolve wins; resolving removes the item (task bar handlers also clear).
 *
 * Durable rehydrate: localStorage snapshot is **display-only after restart**
 * (stale=true) — no reply without live ACP (refuse second SM).
 */
(function (global) {
  /** @typedef {'plan'|'question'|'permission'} InboxKind */
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
   * @property {boolean} [stale] true = restored after restart, dismiss only
   */

  const STORAGE_KEY = 'grokcode.inbox.v1';
  const MAX_PERSIST = 40;

  /** @type {Map<string, InboxItem>} */
  const items = new Map();
  /** @type {Set<function>} */
  const listeners = new Set();
  /** In-flight resolve ids — blocks Inbox + in-pane double RPC (first wins). */
  const inflight = new Set();

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
      persist();
    } catch {
      /* Node tests / no DOM */
    }
  }

  function persist() {
    if (typeof localStorage === 'undefined') return;
    try {
      const list = listPending()
        .slice(0, MAX_PERSIST)
        .map((it) => ({
          id: it.id,
          kind: it.kind,
          taskId: it.taskId,
          projectId: it.projectId || '',
          requestId: it.requestId,
          taskTitle: it.taskTitle || '',
          projectName: it.projectName || '',
          title: it.title || '',
          body: String(it.body || '').slice(0, 2000),
          meta: {
            options: Array.isArray(it.meta?.options) ? it.meta.options : undefined,
            toolName: it.meta?.toolName,
            density: it.meta?.density,
          },
          createdAt: it.createdAt,
          // Always mark persisted snapshot as potentially stale after reload
          stale: true,
        }));
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: 1, items: list, savedAt: Date.now() })
      );
    } catch {
      /* quota / private mode */
    }
  }

  /**
   * Load snapshot after restart — **stale only** (dismiss, no RPC).
   * Live parks overwrite via upsert({ stale: false }).
   * @returns {number} restored count
   */
  function restoreStale() {
    if (typeof localStorage === 'undefined') return 0;
    let n = 0;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      const list = Array.isArray(data?.items) ? data.items : [];
      for (const it of list) {
        if (!it?.kind || !it?.taskId || it.requestId == null) continue;
        const id = it.id || itemId(it.kind, it.taskId, it.requestId);
        const live = items.get(id);
        if (live && !live.stale) continue;
        items.set(id, {
          id,
          kind: it.kind,
          taskId: String(it.taskId),
          projectId: it.projectId != null ? String(it.projectId) : '',
          requestId: it.requestId,
          taskTitle: it.taskTitle || '',
          projectName: it.projectName || '',
          title: it.title || kindDefaultTitle(it.kind),
          body: String(it.body || ''),
          meta: it.meta && typeof it.meta === 'object' ? it.meta : {},
          createdAt: Number(it.createdAt) || Date.now(),
          state: 'pending',
          stale: true,
        });
        n += 1;
      }
      if (n) emit();
    } catch {
      return 0;
    }
    return n;
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
    // Live parks omit stale or pass false; restoreStale passes true only
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
      stale: raw.stale === true,
    };
    const isNew = !prev || prev.state !== 'pending' || (prev.stale && !next.stale);
    items.set(id, next);
    emit();
    if (isNew && !next.stale) {
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
    if (kind === 'permission') return t('inbox.kind.permission', 'Tool permission');
    return kind;
  }

  function resolve(id) {
    const it = items.get(id);
    if (!it) return false;
    items.delete(id);
    inflight.delete(id);
    emit();
    return true;
  }

  /**
   * Claim exclusive resolve for this item (Inbox or in-pane bar).
   * Returns false if already resolving or item missing.
   * @param {string} id
   */
  function tryBeginResolve(id) {
    if (!id || !items.has(id) || inflight.has(id)) return false;
    inflight.add(id);
    return true;
  }

  /** Release claim without deleting (e.g. RPC failed — user may retry). */
  function endResolve(id) {
    if (id) inflight.delete(id);
  }

  function isResolving(id) {
    return Boolean(id && inflight.has(id));
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
      inflight.delete(id);
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

  function countStale() {
    return listPending().filter((i) => i.stale).length;
  }

  function countLive() {
    return listPending().filter((i) => !i.stale).length;
  }

  /** Remove only restart-orphaned (stale) items — no CLI RPC. */
  function clearStale() {
    let n = 0;
    for (const [id, it] of [...items.entries()]) {
      if (it.stale) {
        items.delete(id);
        inflight.delete(id);
        n += 1;
      }
    }
    if (n) emit();
    return n;
  }

  function clearAll() {
    if (!items.size) return;
    items.clear();
    inflight.clear();
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
            <button type="button" class="btn small ghost hidden" id="inboxClearStale" aria-label="${esc(
              t('inbox.clearStale', 'Clear stale')
            )}">${esc(t('inbox.clearStale', '清除过期'))}</button>
            <button type="button" class="icon-btn" id="inboxClose" aria-label="${esc(
              t('inbox.close', 'Close')
            )}">✕</button>
          </div>
        </div>
        <p class="inbox-foot muted" id="inboxHint">${esc(
          t(
            'inbox.hint',
            'Parked plan approvals & questions across tasks. Answer here or jump to the task.'
          )
        )}</p>
        <div class="inbox-list" id="inboxList" role="list" aria-label="${esc(
          t('inbox.title', 'Inbox')
        )}"></div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.inbox-backdrop')?.addEventListener('click', close);
    root.querySelector('#inboxClose')?.addEventListener('click', close);
    root.querySelector('#inboxClearStale')?.addEventListener('click', () => {
      const n = clearStale();
      if (n > 0) {
        global.toast?.(
          String(t('inbox.clearStale.done', '已清除 {n} 条过期项')).replace('{n}', String(n)),
          'ok'
        );
        try {
          global.GrokA11y?.announce?.(
            String(t('inbox.clearStale.done', 'Cleared {n} stale')).replace('{n}', String(n)),
            { assertive: false }
          );
        } catch {
          /* optional */
        }
      }
    });
    return root;
  }

  function paintBadge() {
    if (typeof document === 'undefined') return;
    const n = count();
    const live = countLive();
    const stale = countStale();
    const btn = document.getElementById('btnInbox');
    const badge = document.getElementById('inboxBadge');
    if (btn) {
      btn.classList.toggle('has-items', n > 0);
      btn.classList.toggle('has-live', live > 0);
      btn.classList.toggle('has-stale-only', n > 0 && live === 0);
      const labelParts = [t('inbox.btn', 'Inbox')];
      if (live) labelParts.push(`${live} live`);
      if (stale) labelParts.push(`${stale} stale`);
      btn.setAttribute('aria-label', labelParts.join(', '));
      btn.title = n
        ? String(t('inbox.btn.n', 'Inbox · {n} waiting'))
            .replace('{n}', String(n))
            .concat(stale ? ` (${stale} stale)` : '')
        : t('inbox.btn', 'Inbox');
    }
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', n === 0);
      badge.classList.toggle('stale-only', n > 0 && live === 0);
    }
    // Clear-stale control visibility when panel exists
    const clearBtn = document.getElementById('inboxClearStale');
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', stale === 0);
      clearBtn.textContent = t('inbox.clearStale', '清除过期');
      clearBtn.setAttribute(
        'aria-label',
        String(t('inbox.clearStale.n', 'Clear {n} stale')).replace('{n}', String(stale))
      );
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
            : it.kind === 'permission'
              ? en
                ? 'PERM'
                : '授权'
              : en
                ? 'ASK'
                : '提问';
        const where = [it.projectName, it.taskTitle].filter(Boolean).join(' · ') || it.taskId;
        const preview = String(it.body || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220);
        const age = formatAge(it.createdAt, en);
        const staleBanner = it.stale
          ? `<p class="inbox-stale-banner" role="status">${esc(
              en
                ? 'Session lost after restart — cannot reply to CLI. Dismiss only.'
                : '重启后会话已断 · 无法再回复 CLI，仅可关闭此条。'
            )}</p>`
          : '';
        if (it.stale) {
          return `
          <article class="inbox-card inbox-stale" role="listitem" data-id="${esc(it.id)}" data-kind="${esc(it.kind)}" aria-label="${esc((en ? 'Stale' : '过期') + ': ' + (it.title || kindLabel))}">
            <div class="inbox-card-top">
              <span class="inbox-chip kind-stale">${en ? 'STALE' : '过期'}</span>
              <span class="inbox-chip kind-${it.kind === 'plan' ? 'plan' : it.kind === 'permission' ? 'perm' : 'ask'}">${kindLabel}</span>
              <span class="inbox-where" title="${esc(where)}">${esc(where)}</span>
              <span class="inbox-age">${esc(age)}</span>
            </div>
            <div class="inbox-card-title">${esc(it.title)}</div>
            ${staleBanner}
            ${preview ? `<div class="inbox-preview-text">${esc(preview)}</div>` : ''}
            <div class="inbox-actions">
              <button type="button" class="btn small ghost" data-act="dismiss-stale" data-id="${esc(it.id)}" aria-label="${esc(en ? 'Dismiss stale item' : '关闭过期项')}">✕ ${esc(en ? 'Dismiss' : '关闭')}</button>
            </div>
          </article>`;
        }
        if (it.kind === 'plan') {
          return `
          <article class="inbox-card" role="listitem" data-id="${esc(it.id)}" data-kind="plan" aria-label="${esc(it.title || kindLabel)}">
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
              <button type="button" class="btn small primary" data-act="approve-yolo" data-id="${esc(it.id)}">✓ ${esc(en ? 'YOLO' : 'YOLO')}</button>
              <button type="button" class="btn small ghost" data-act="approve-ask" data-id="${esc(it.id)}">✓ ${esc(en ? 'Ask tools' : '逐次确认')}</button>
              <button type="button" class="btn small ghost" data-act="revise" data-id="${esc(it.id)}">✎ ${esc(en ? 'Revise' : '修改')}</button>
              <button type="button" class="btn small ghost" data-act="quit" data-id="${esc(it.id)}">✕ ${esc(en ? 'Quit' : '放弃')}</button>
              <button type="button" class="btn small ghost" data-act="goto" data-id="${esc(it.id)}">↗ ${esc(en ? 'Task' : '任务')}</button>
            </div>
          </article>`;
        }
        if (it.kind === 'permission') {
          const opts = Array.isArray(it.meta?.options) ? it.meta.options : [];
          const optHtml = opts
            .map(
              (o) =>
                `<button type="button" class="btn small ${/allow|approve/i.test(String(o.optionId) + o.name) ? 'primary' : 'ghost'}" data-act="perm-opt" data-id="${esc(it.id)}" data-opt="${esc(o.optionId || '')}">${esc(o.name || o.optionId || '?')}</button>`
            )
            .join('');
          return `
          <article class="inbox-card" role="listitem" data-id="${esc(it.id)}" data-kind="permission" aria-label="${esc(it.title || kindLabel)}">
            <div class="inbox-card-top">
              <span class="inbox-chip kind-perm">${kindLabel}</span>
              <span class="inbox-where" title="${esc(where)}">${esc(where)}</span>
              <span class="inbox-age">${esc(age)}</span>
            </div>
            <div class="inbox-card-title">${esc(it.title)}</div>
            ${preview ? `<div class="inbox-preview-text">${esc(preview)}</div>` : ''}
            <label class="inbox-remember">
              <input type="checkbox" class="inbox-remember-cb" data-id="${esc(it.id)}" checked />
              <span>${esc(en ? 'Remember for this flight' : '本回合记住')}</span>
            </label>
            <div class="inbox-actions">
              ${optHtml}
              <button type="button" class="btn small ghost" data-act="perm-cancel" data-id="${esc(it.id)}">✕ ${esc(en ? 'Cancel' : '取消')}</button>
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
        <article class="inbox-card" role="listitem" data-id="${esc(it.id)}" data-kind="question" aria-label="${esc(it.title || kindLabel)}">
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
      btn.addEventListener('click', () =>
        onCardAction(btn.dataset.act, btn.dataset.id, { optionId: btn.dataset.opt })
      );
    });
    paintBadge();
  }

  function formatAge(ts, en) {
    const sec = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
    if (sec < 60) return en ? `${sec}s` : `${sec}秒`;
    const m = Math.floor(sec / 60);
    if (m < 60) return en ? `${m}m` : `${m}分`;
    const h = Math.floor(m / 60);
    return en ? `${h}h` : `${h}时`;
  }

  async function onCardAction(act, id, extra = {}) {
    const it = items.get(id);
    if (!it) return;
    const handlers = global.GrokInboxHandlers || {};

    // Stale after restart: display-only, never RPC
    if (it.stale || act === 'dismiss-stale') {
      resolve(id);
      global.toast?.(t('inbox.stale.dismissed', '已关闭过期项'), 'ok');
      return;
    }

    if (act === 'goto') {
      try {
        await handlers.gotoTask?.(it);
      } catch (e) {
        global.toast?.(e.message || String(e), 'err');
      }
      return;
    }

    if (it.kind === 'permission') {
      if (act === 'perm-cancel') {
        if (!tryBeginResolve(id)) {
          global.toast?.(t('inbox.busy', '正在处理，请勿重复点击'), 'err');
          return;
        }
        try {
          const r = await handlers.replyPermission?.(it, { cancelled: true });
          if (r && r.ok === false) {
            endResolve(id);
            global.toast?.(r.error || 'permission failed', 'err');
            return;
          }
          resolve(id);
          try {
            handlers.onPermissionResolved?.(it);
          } catch {
            /* optional */
          }
          global.toast?.(t('inbox.perm.cancelled', '已取消授权'), 'ok');
        } catch (e) {
          endResolve(id);
          global.toast?.(e.message || String(e), 'err');
        }
        return;
      }
      if (act === 'perm-opt' && extra.optionId) {
        if (!tryBeginResolve(id)) {
          global.toast?.(t('inbox.busy', '正在处理，请勿重复点击'), 'err');
          return;
        }
        let remember = true;
        document.querySelectorAll?.('.inbox-remember-cb')?.forEach((cb) => {
          if (cb.dataset.id === id) remember = Boolean(cb.checked);
        });
        try {
          const r = await handlers.replyPermission?.(it, {
            optionId: extra.optionId,
            remember,
          });
          if (r && r.ok === false) {
            endResolve(id);
            global.toast?.(r.error || 'permission failed', 'err');
            return;
          }
          resolve(id);
          try {
            handlers.onPermissionResolved?.(it);
          } catch {
            /* optional */
          }
          const mem = r?.remembered || remember ? ` · ${t('inbox.perm.mem', '已记住')}` : '';
          global.toast?.(`${t('inbox.perm.ok', '已允许')} · ${extra.optionId}${mem}`, 'ok');
        } catch (e) {
          endResolve(id);
          global.toast?.(e.message || String(e), 'err');
        }
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
      let execTier = '';
      if (act === 'approve' || act === 'approve-yolo') {
        outcome = 'approved';
        execTier = 'yolo';
      } else if (act === 'approve-ask') {
        outcome = 'approved';
        execTier = 'ask';
      } else if (act === 'quit') outcome = 'abandoned';
      else if (act === 'revise') outcome = 'cancelled';
      else return;
      if (!tryBeginResolve(id)) {
        global.toast?.(t('inbox.busy', '正在处理，请勿重复点击'), 'err');
        return;
      }
      try {
        const r = await handlers.replyPlan?.(
          it,
          outcome,
          outcome === 'cancelled' ? feedback : '',
          execTier || undefined
        );
        if (r && r.ok === false) {
          endResolve(id);
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
              ? `Plan approved${execTier === 'ask' ? ' · ask tools' : ' · YOLO'}`
              : `已批准计划${execTier === 'ask' ? ' · 逐次确认' : ' · YOLO'}`
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
        endResolve(id);
        global.toast?.(e.message || String(e), 'err');
      }
      return;
    }

    if (it.kind === 'question' && act === 'dismiss-q') {
      if (!tryBeginResolve(id)) {
        global.toast?.(t('inbox.busy', '正在处理，请勿重复点击'), 'err');
        return;
      }
      try {
        const r = await handlers.replyQuestion?.(it, { outcome: 'cancelled' });
        if (r && r.ok === false) {
          endResolve(id);
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
        endResolve(id);
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
    tryBeginResolve,
    endResolve,
    isResolving,
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
    persist,
    restoreStale,
    clearStale,
    countStale,
    countLive,
    STORAGE_KEY,
  };

  global.GrokInbox = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
