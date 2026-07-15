/**
 * Settings → MCP / Skills 管理
 * 对接 grok mcp CLI 与 ~/.grok/skills
 */
(function (global) {
  const $ = (s) => document.querySelector(s);

  function toast(msg, type) {
    if (typeof global.toast === 'function') global.toast(msg, type);
    else console.log(msg);
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
    host.innerHTML = '<div class="muted pad">加载中…</div>';
    try {
      const list = await window.grok.mcpList();
      if (!list.length) {
        host.innerHTML =
          '<div class="muted pad">暂无 MCP Server<br>可添加 filesystem / github / 远程 HTTP 等</div>';
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
            <button type="button" class="toggle${on ? ' on' : ''}" data-toggle="${esc(s.name)}" title="启用/禁用"></button>
            <div class="mi-main">
              <div class="mi-name">${esc(s.name)}<span class="mi-scope">${esc(s.scope || 'user')}</span></div>
              <div class="mi-meta">${esc(cmd)}</div>
            </div>
            <div class="mi-actions">
              <button class="btn small ghost" data-doctor="${esc(s.name)}">诊断</button>
              <button class="btn small ghost" data-timeout="${esc(s.name)}" title="远程 MCP 建议">超时120s</button>
              <button class="btn small danger" data-rm="${esc(s.name)}">删除</button>
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
            toast(next ? `已启用 ${name}` : `已禁用 ${name}`, 'ok');
            refreshMcp();
          } catch (e) {
            toast(e.message || '切换失败', 'err');
          }
        };
      });
      host.querySelectorAll('[data-rm]').forEach((btn) => {
        btn.onclick = async () => {
          const name = btn.dataset.rm;
          if (!confirm(`删除 MCP「${name}」？`)) return;
          try {
            await window.grok.mcpRemove({ name });
            toast(`已删除 ${name}`, 'ok');
            refreshMcp();
          } catch (e) {
            toast(e.message || '删除失败', 'err');
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
            toast(`已将 ${name} 启动超时设为 120s，请再点诊断`, 'ok');
          } catch (e) {
            toast(e.message || '设置失败', 'err');
          }
        };
      });
    } catch (e) {
      host.innerHTML = `<div class="muted pad">加载失败：${esc(e.message)}</div>`;
    }
  }

  function formatDoctorReport(res, name) {
    if (!res) return '无结果';
    if (res.raw && !res.servers) return String(res.raw);
    if (res.error && !res.servers) return `错误：${res.error}`;

    const lines = [];
    const servers = res.servers || (res.name ? [res] : []);
    if (res.sources) {
      lines.push('【配置源】');
      for (const s of res.sources) {
        const st = s.status?.status || '?';
        const n = s.status?.server_count;
        lines.push(`  ${s.path}: ${st}${n != null ? ` (${n})` : ''}`);
      }
      lines.push('');
    }
    if (!servers.length) {
      lines.push(name ? `未找到服务器 ${name}` : '未发现 MCP 服务器');
      return lines.join('\n');
    }
    for (const srv of servers) {
      const ok = srv.healthy === true;
      lines.push(`【${srv.name || name || 'server'}】 ${ok ? '✓ 健康' : '✗ 未就绪'}`);
      if (srv.transport) lines.push(`  传输: ${srv.transport}`);
      if (srv.target) lines.push(`  目标: ${srv.target}`);
      if (srv.source) lines.push(`  来源: ${srv.source}`);
      const checks = srv.checks || [];
      for (const c of checks) {
        const mark = c.passed ? '✓' : '✗';
        lines.push(`  ${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
        if (c.hint) lines.push(`      提示: ${c.hint}`);
      }
      // 超时失败时给出可操作建议
      const timedOut = checks.some(
        (c) => !c.passed && /timeout|timed out/i.test(c.label + ' ' + (c.detail || ''))
      );
      if (timedOut) {
        lines.push('');
        lines.push('建议: 远程 MCP 启动较慢，可点列表中的「超时120s」后重试诊断。');
        lines.push('或在 ~/.grok/config.toml 该 server 下设置 startup_timeout_sec = 120');
      }
      lines.push('');
    }
    if (res.healthy_count != null) {
      lines.push(`汇总: 健康 ${res.healthy_count} · 失败 ${res.failing_count ?? 0}`);
    }
    return lines.join('\n');
  }

  async function runDoctor(name) {
    const log = $('#mcpLog');
    log?.classList.remove('hidden');
    if (log) {
      log.textContent = name
        ? `正在诊断 ${name}（远程 MCP 可能需 30–120 秒）…`
        : '正在诊断全部 MCP…';
    }
    try {
      const res = await window.grok.mcpDoctor(name ? { name } : {});
      if (log) log.textContent = formatDoctorReport(res, name);
      // 列表项上显示状态徽章
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
          badge.textContent = srv.healthy ? ' · 已连接' : ' · 未连接';
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
      const t = $('#mcpTransport').value;
      const stdio = t === 'stdio';
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
        toast('MCP 已添加', 'ok');
        $('#mcpAddForm')?.classList.add('hidden');
        $('#mcpName').value = '';
        $('#mcpCommand').value = '';
        $('#mcpUrl').value = '';
        $('#mcpHeader').value = '';
        refreshMcp();
      } catch (e) {
        toast(e.message || '添加失败', 'err');
      }
    });
  }

  // ── Skills ──────────────────────────────────────────
  let editingSkillFile = null;

  async function refreshSkills() {
    const host = $('#skillsList');
    if (!host) return;
    host.innerHTML = '<div class="muted pad">加载中…</div>';
    try {
      const projectPath = global.ProjectStore?.active?.()?.path || null;
      const list = await window.grok.skillsList({ projectPath });
      if (!list.length) {
        host.innerHTML = '<div class="muted pad">未发现技能<br>可新建或放入 ~/.grok/skills</div>';
        return;
      }
      host.innerHTML = list
        .map((s) => {
          const on = s.enabled !== false;
          return `<div class="mgmt-item${on ? '' : ' off'}" data-name="${esc(s.name)}">
            <button type="button" class="toggle${on ? ' on' : ''}" data-stoggle="${esc(s.name)}" title="启用/禁用"></button>
            <div class="mi-main">
              <div class="mi-name">${esc(s.name)}<span class="mi-scope">${esc(s.scope || 'user')}</span></div>
              <div class="mi-meta">${esc(s.description || s.path || '')}</div>
            </div>
            <div class="mi-actions">
              <button class="btn small ghost" data-sedit="${esc(s.skillFile || s.path)}">编辑</button>
              ${
                s.scope === 'bundled'
                  ? ''
                  : `<button class="btn small danger" data-sdel="${esc(s.path)}">删除</button>`
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
            toast(next ? `已启用 ${name}` : `已禁用 ${name}`, 'ok');
            refreshSkills();
          } catch (e) {
            toast(e.message || '切换失败', 'err');
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
            toast(e.message || '读取失败', 'err');
          }
        };
      });
      host.querySelectorAll('[data-sdel]').forEach((btn) => {
        btn.onclick = async () => {
          if (!confirm('删除此技能目录？')) return;
          try {
            await window.grok.skillsDelete({ path: btn.dataset.sdel });
            toast('已删除', 'ok');
            refreshSkills();
          } catch (e) {
            toast(e.message || '删除失败', 'err');
          }
        };
      });
    } catch (e) {
      host.innerHTML = `<div class="muted pad">加载失败：${esc(e.message)}</div>`;
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
        toast('技能已创建', 'ok');
        $('#skillAddForm')?.classList.add('hidden');
        $('#skillName').value = '';
        $('#skillDesc').value = '';
        $('#skillBody').value = '';
        refreshSkills();
      } catch (e) {
        toast(e.message || '创建失败', 'err');
      }
    });
    $('#btnSkillEditSave')?.addEventListener('click', async () => {
      if (!editingSkillFile) return;
      try {
        await window.grok.skillsWrite({
          skillFile: editingSkillFile,
          content: $('#skillEditRaw').value,
        });
        toast('已保存 SKILL.md', 'ok');
        $('#skillEditForm')?.classList.add('hidden');
        editingSkillFile = null;
        refreshSkills();
      } catch (e) {
        toast(e.message || '保存失败', 'err');
      }
    });
  }

  function init() {
    bindSettingsTabs();
    bindMcpForm();
    bindSkillsForm();
  }

  // expose for openSettings refresh
  global.SettingsMcpSkills = {
    init,
    refreshMcp,
    refreshSkills,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
