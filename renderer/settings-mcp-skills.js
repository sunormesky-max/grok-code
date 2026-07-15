/**
 * Settings → MCP / Skills 管理
 * 对接 grok mcp CLI 与 ~/.grok/skills · 文案走 i18n
 */
(function (global) {
  const $ = (s) => document.querySelector(s);

  function toast(msg, type) {
    if (typeof global.toast === 'function') global.toast(msg, type);
    else console.log(msg);
  }

  function t(key, fallback, vars) {
    return global.GrokI18n?.t?.(key, fallback, vars) || fallback || key;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function bindSettingsTabs() {
    document.querySelectorAll('.stab').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.stab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const id = btn.dataset.stab;
        document.querySelectorAll('.settings-pane').forEach((p) => p.classList.add('hidden'));
        $(`#stab-${id}`)?.classList.remove('hidden');
        if (id === 'mcp') refreshMcp();
        if (id === 'skills') refreshSkills();
        if (id === 'plugins') global.GrokPluginsUi?.refreshPlugins?.();
        if (id === 'catalog') global.GrokPluginsUi?.loadCatalog?.();
      };
    });
  }

  // ── MCP ─────────────────────────────────────────────
  async function refreshMcp() {
    const host = $('#mcpList');
    if (!host) return;
    host.innerHTML = `<div class="muted pad">${esc(t('mcp.loading'))}</div>`;
    try {
      const list = await window.grok.mcpList();
      if (!list.length) {
        host.innerHTML = `<div class="muted pad">${t('mcp.empty')
          .split('\n')
          .map(esc)
          .join('<br>')}</div>`;
        return;
      }
      host.innerHTML = list
        .map((s) => {
          const cmd =
            s.url ||
            [s.command, ...(s.args || [])].filter(Boolean).join(' ') ||
            '—';
          const on = s.enabled !== false;
          return `<div class="mgmt-item${on ? '' : ' off'}" data-name="${esc(s.name)}">
            <button type="button" class="toggle${on ? ' on' : ''}" data-toggle="${esc(s.name)}" title="enable/disable"></button>
            <div class="mi-main">
              <div class="mi-name">${esc(s.name)}<span class="mi-scope">${esc(s.scope || 'user')}</span></div>
              <div class="mi-meta">${esc(cmd)}</div>
            </div>
            <div class="mi-actions">
              <button class="btn small ghost" data-doctor="${esc(s.name)}">${esc(t('mcp.doctor'))}</button>
              <button class="btn small ghost" data-timeout="${esc(s.name)}" title="remote MCP">${esc(t('mcp.timeout'))}</button>
              <button class="btn small danger" data-rm="${esc(s.name)}">${esc(t('common.delete'))}</button>
            </div>
          </div>`;
        })
        .join('');

      host.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.onclick = async () => {
          const name = btn.dataset.toggle;
          const next = !btn.classList.contains('on');
          try {
            await window.grok.mcpToggle({ name, enabled: next });
            toast(
              next ? t('mcp.enabled', null, { name }) : t('mcp.disabled', null, { name }),
              'ok'
            );
            refreshMcp();
          } catch (e) {
            toast(e.message || t('mcp.toggleFail'), 'err');
          }
        };
      });
      host.querySelectorAll('[data-rm]').forEach((btn) => {
        btn.onclick = async () => {
          const name = btn.dataset.rm;
          if (!confirm(t('mcp.confirmDelete', null, { name }))) return;
          try {
            await window.grok.mcpRemove({ name });
            toast(t('mcp.deleted', null, { name }), 'ok');
            refreshMcp();
          } catch (e) {
            toast(e.message || t('mcp.deleteFail'), 'err');
          }
        };
      });
      host.querySelectorAll('[data-doctor]').forEach((btn) => {
        btn.onclick = () => runDoctor(btn.dataset.doctor);
      });
      host.querySelectorAll('[data-timeout]').forEach((btn) => {
        btn.onclick = async () => {
          const name = btn.dataset.timeout;
          try {
            await window.grok.mcpSetTimeout({ name, seconds: 120 });
            toast(t('mcp.timeoutOk', null, { name }), 'ok');
          } catch (e) {
            toast(e.message || t('mcp.toggleFail'), 'err');
          }
        };
      });
    } catch (e) {
      host.innerHTML = `<div class="muted pad">${esc(t('mcp.loadFail', null, { msg: e.message }))}</div>`;
    }
  }

  function formatDoctorReport(res, name) {
    if (!res) return '—';
    if (res.raw && !res.servers) return String(res.raw);
    if (res.error && !res.servers) return `Error: ${res.error}`;

    const lines = [];
    const servers = res.servers || (res.name ? [res] : []);
    if (res.sources) {
      lines.push('[sources]');
      for (const s of res.sources) {
        const st = s.status?.status || '?';
        const n = s.status?.server_count;
        lines.push(`  ${s.path}: ${st}${n != null ? ` (${n})` : ''}`);
      }
      lines.push('');
    }
    if (!servers.length) {
      lines.push(name ? `Server not found: ${name}` : 'No MCP servers');
      return lines.join('\n');
    }
    for (const srv of servers) {
      const ok = srv.healthy === true;
      lines.push(`[${srv.name || name || 'server'}] ${ok ? 'OK' : 'FAIL'}`);
      if (srv.transport) lines.push(`  transport: ${srv.transport}`);
      if (srv.target) lines.push(`  target: ${srv.target}`);
      if (srv.source) lines.push(`  source: ${srv.source}`);
      const checks = srv.checks || [];
      for (const c of checks) {
        const mark = c.passed ? '+' : '-';
        lines.push(`  ${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
        if (c.hint) lines.push(`      hint: ${c.hint}`);
      }
      const timedOut = checks.some(
        (c) => !c.passed && /timeout|timed out/i.test(c.label + ' ' + (c.detail || ''))
      );
      if (timedOut) {
        lines.push('');
        lines.push('Tip: use Timeout 120s then re-run Doctor.');
        lines.push('Or set startup_timeout_sec = 120 in ~/.grok/config.toml');
      }
      lines.push('');
    }
    if (res.healthy_count != null) {
      lines.push(`summary: healthy ${res.healthy_count} · failing ${res.failing_count ?? 0}`);
    }
    return lines.join('\n');
  }

  async function runDoctor(name) {
    const log = $('#mcpLog');
    log?.classList.remove('hidden');
    if (log) {
      log.textContent = name
        ? t('mcp.doctor.running', null, { name })
        : t('mcp.doctor.all');
    }
    try {
      const res = await window.grok.mcpDoctor(name ? { name } : {});
      if (log) log.textContent = formatDoctorReport(res, name);
      if (res?.servers) {
        for (const srv of res.servers) {
          const item = document.querySelector(`.mgmt-item[data-name="${CSS.escape(srv.name)}"]`);
          if (!item) continue;
          let badge = item.querySelector('.mi-health');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'mi-health';
            item.querySelector('.mi-name')?.appendChild(badge);
          }
          badge.textContent = srv.healthy
            ? t('mcp.doctor.connected')
            : t('mcp.doctor.disconnected');
          badge.style.color = srv.healthy ? 'var(--ok)' : 'var(--danger)';
        }
      }
    } catch (e) {
      if (log) log.textContent = e.message || String(e);
    }
  }

  function bindMcpForm() {
    $('#btnMcpRefresh')?.addEventListener('click', refreshMcp);
    $('#btnMcpShowAdd')?.addEventListener('click', () => {
      $('#mcpAddForm')?.classList.remove('hidden');
    });
    $('#btnMcpCancel')?.addEventListener('click', () => {
      $('#mcpAddForm')?.classList.add('hidden');
    });
    $('#mcpTransport')?.addEventListener('change', () => {
      const tr = $('#mcpTransport').value;
      const stdio = tr === 'stdio';
      $('#mcpCmdField')?.classList.toggle('hidden', !stdio);
      $('#mcpUrlField')?.classList.toggle('hidden', stdio);
      $('#mcpHeaderField')?.classList.toggle('hidden', stdio);
    });
    $('#btnMcpDoctor')?.addEventListener('click', () => runDoctor());
    $('#btnMcpSave')?.addEventListener('click', async () => {
      const transport = $('#mcpTransport').value;
      const payload = {
        name: $('#mcpName').value.trim(),
        transport,
        command: $('#mcpCommand').value.trim(),
        url: $('#mcpUrl').value.trim(),
        header: $('#mcpHeader').value.trim() || undefined,
        enabled: true,
      };
      try {
        await window.grok.mcpAdd(payload);
        toast(t('mcp.added'), 'ok');
        $('#mcpAddForm')?.classList.add('hidden');
        $('#mcpName').value = '';
        $('#mcpCommand').value = '';
        $('#mcpUrl').value = '';
        $('#mcpHeader').value = '';
        refreshMcp();
      } catch (e) {
        toast(e.message || t('mcp.addFail'), 'err');
      }
    });
  }

  // ── Skills ──────────────────────────────────────────
  let editingSkillFile = null;

  async function refreshSkills() {
    const host = $('#skillsList');
    if (!host) return;
    host.innerHTML = `<div class="muted pad">${esc(t('skill.loading'))}</div>`;
    try {
      const projectPath = global.ProjectStore?.active?.()?.path || null;
      const list = await window.grok.skillsList({ projectPath });
      if (!list.length) {
        host.innerHTML = `<div class="muted pad">${t('skill.empty')
          .split('\n')
          .map(esc)
          .join('<br>')}</div>`;
        return;
      }
      host.innerHTML = list
        .map((s) => {
          const on = s.enabled !== false;
          return `<div class="mgmt-item${on ? '' : ' off'}" data-name="${esc(s.name)}">
            <button type="button" class="toggle${on ? ' on' : ''}" data-stoggle="${esc(s.name)}" title="enable/disable"></button>
            <div class="mi-main">
              <div class="mi-name">${esc(s.name)}<span class="mi-scope">${esc(s.scope || 'user')}</span></div>
              <div class="mi-meta">${esc(s.description || s.path || '')}</div>
            </div>
            <div class="mi-actions">
              <button class="btn small ghost" data-sedit="${esc(s.skillFile || s.path)}">${esc(t('skill.edit'))}</button>
              ${
                s.scope === 'bundled'
                  ? ''
                  : `<button class="btn small danger" data-sdel="${esc(s.path)}">${esc(t('skill.delete'))}</button>`
              }
            </div>
          </div>`;
        })
        .join('');

      host.querySelectorAll('[data-stoggle]').forEach((btn) => {
        btn.onclick = async () => {
          const name = btn.dataset.stoggle;
          const next = !btn.classList.contains('on');
          try {
            await window.grok.skillsToggle({ name, enabled: next });
            toast(
              next ? t('skill.enabled', null, { name }) : t('skill.disabled', null, { name }),
              'ok'
            );
            refreshSkills();
          } catch (e) {
            toast(e.message || t('mcp.toggleFail'), 'err');
          }
        };
      });
      host.querySelectorAll('[data-sedit]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const data = await window.grok.skillsRead({ path: btn.dataset.sedit });
            editingSkillFile = data.path;
            $('#skillEditName').textContent = data.meta?.name || '';
            $('#skillEditRaw').value = data.raw || '';
            $('#skillEditForm')?.classList.remove('hidden');
            $('#skillAddForm')?.classList.add('hidden');
          } catch (e) {
            toast(e.message || t('skill.readFail'), 'err');
          }
        };
      });
      host.querySelectorAll('[data-sdel]').forEach((btn) => {
        btn.onclick = async () => {
          if (!confirm(t('skill.confirmDelete'))) return;
          try {
            await window.grok.skillsDelete({ path: btn.dataset.sdel });
            toast(t('skill.deleted'), 'ok');
            refreshSkills();
          } catch (e) {
            toast(e.message || t('mcp.deleteFail'), 'err');
          }
        };
      });
    } catch (e) {
      host.innerHTML = `<div class="muted pad">${esc(t('skill.loadFail', null, { msg: e.message }))}</div>`;
    }
  }

  function bindSkillsForm() {
    $('#btnSkillsRefresh')?.addEventListener('click', refreshSkills);
    $('#btnSkillsOpenDir')?.addEventListener('click', async () => {
      await window.grok.skillsOpenDir({});
    });
    $('#btnSkillShowAdd')?.addEventListener('click', () => {
      $('#skillAddForm')?.classList.remove('hidden');
      $('#skillEditForm')?.classList.add('hidden');
    });
    $('#btnSkillCancel')?.addEventListener('click', () => {
      $('#skillAddForm')?.classList.add('hidden');
    });
    $('#btnSkillEditCancel')?.addEventListener('click', () => {
      $('#skillEditForm')?.classList.add('hidden');
      editingSkillFile = null;
    });
    $('#btnSkillSave')?.addEventListener('click', async () => {
      const name = $('#skillName').value.trim();
      const description = $('#skillDesc').value.trim();
      const body = $('#skillBody').value;
      const scope = $('#skillScope').value;
      const projectPath = global.ProjectStore?.active?.()?.path || null;
      try {
        await window.grok.skillsCreate({ name, description, body, scope, projectPath });
        toast(t('skill.created'), 'ok');
        $('#skillAddForm')?.classList.add('hidden');
        $('#skillName').value = '';
        $('#skillDesc').value = '';
        $('#skillBody').value = '';
        refreshSkills();
      } catch (e) {
        toast(e.message || t('skill.createFail'), 'err');
      }
    });
    $('#btnSkillEditSave')?.addEventListener('click', async () => {
      if (!editingSkillFile) return;
      try {
        await window.grok.skillsWrite({
          skillFile: editingSkillFile,
          content: $('#skillEditRaw').value,
        });
        toast(t('skill.saved'), 'ok');
        $('#skillEditForm')?.classList.add('hidden');
        editingSkillFile = null;
        refreshSkills();
      } catch (e) {
        toast(e.message || t('skill.saveFail'), 'err');
      }
    });
  }

  function applyStaticI18n() {
    // toolbar hints that are static in HTML
    const mcpHint = document.querySelector('#stab-mcp .mgmt-hint');
    if (mcpHint) mcpHint.innerHTML = esc(t('mcp.hint')).replace(/~\/\.grok\/config\.toml/g, '<code>~/.grok/config.toml</code>').replace(/grok mcp/g, '<code>grok mcp</code>');
    const skillHint = document.querySelector('#stab-skills .mgmt-hint');
    if (skillHint) {
      skillHint.innerHTML = esc(t('skill.hint'))
        .replace(/~\/\.grok\/skills/g, '<code>~/.grok/skills</code>')
        .replace(/\.grok\/skills/g, '<code>.grok/skills</code>');
    }
    const br = $('#btnMcpRefresh');
    if (br) br.textContent = t('mcp.refresh');
    const ba = $('#btnMcpShowAdd');
    if (ba) ba.textContent = t('mcp.add');
    const bd = $('#btnMcpDoctor');
    if (bd) bd.textContent = t('mcp.doctor');
    const sr = $('#btnSkillsRefresh');
    if (sr) sr.textContent = t('skill.refresh');
    const so = $('#btnSkillsOpenDir');
    if (so) so.textContent = t('skill.openDir');
    const sn = $('#btnSkillShowAdd');
    if (sn) sn.textContent = t('skill.new');
  }

  function init() {
    bindSettingsTabs();
    bindMcpForm();
    bindSkillsForm();
    applyStaticI18n();
    window.addEventListener('grok:locale', () => applyStaticI18n());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.GrokMcpSkillsUi = { refreshMcp, refreshSkills, runDoctor };
})(typeof window !== 'undefined' ? window : globalThis);
