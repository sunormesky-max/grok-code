/**
 * Settings → Plugins marketplace bridge + Catalog + Profiles UI
 * Filters / actions align with `grok plugin` TUI:
 * list [--json] [--available] · install [--trust] · update [NAME]
 * enable/disable · uninstall · details · validate [PATH]
 * marketplace list/add/remove/update
 */
(function () {
  function $(sel) {
    return document.querySelector(sel);
  }
  function esc(s) {
    return (window.GrokUtils?.esc || ((x) => String(x ?? '')))(s);
  }
  function toast(m, ty) {
    (window.toast || console.log)(m, ty);
  }
  function t(k, fb, v) {
    return window.GrokI18n?.t?.(k, fb, v) || fb || k;
  }

  /** @type {{ inst: any[], avail: any[], markets: any[], text?: string } | null} */
  let cache = null;

  /** @type {{ scope: string, status: string, marketplace: string }} */
  const filters = {
    scope: 'all',
    status: 'all',
    marketplace: '',
  };

  function matchQ(obj, q) {
    if (!q) return true;
    const hay = `${obj.name || ''} ${obj.description || ''} ${obj.source || ''} ${obj.marketplace || ''} ${obj.version || ''}`.toLowerCase();
    return hay.includes(q);
  }

  function filterList(list, q, { status = true } = {}) {
    return (list || []).filter((p) => {
      if (!matchQ(p, q)) return false;
      if (status) {
        if (filters.status === 'enabled' && !p.enabled) return false;
        if (filters.status === 'disabled' && p.enabled) return false;
      }
      if (filters.marketplace) {
        const m = String(p.marketplace || p.market || '').toLowerCase();
        if (m !== filters.marketplace.toLowerCase()) return false;
      }
      return true;
    });
  }

  function fillMarketSelect() {
    const sel = $('#pluginMarketFilter');
    if (!sel || !cache) return;
    const cur = filters.marketplace;
    const names = new Set();
    for (const p of [...(cache.inst || []), ...(cache.avail || [])]) {
      if (p.marketplace || p.market) names.add(String(p.marketplace || p.market));
    }
    for (const m of cache.markets || []) {
      const n = m.name || m.id;
      if (n) names.add(String(n));
    }
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    sel.innerHTML =
      `<option value="">${esc(t('plugin.market.all', '全部市场'))}</option>` +
      sorted.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if (cur && sorted.includes(cur)) sel.value = cur;
    else {
      sel.value = '';
      filters.marketplace = '';
    }
  }

  function showLog(text) {
    const log = $('#pluginLog');
    if (!log) return;
    log.classList.remove('hidden');
    log.textContent = String(text || '').slice(0, 12000);
  }

  function renderFromCache() {
    const host = $('#pluginList');
    if (!host || !cache) return;
    const q = ($('#pluginFilter')?.value || '').trim().toLowerCase();
    const scope = filters.scope;
    const showInst = scope === 'all' || scope === 'installed';
    const showAvail = scope === 'all' || scope === 'available';
    const showMarkets = scope === 'all' || scope === 'markets';

    const inst = filterList(cache.inst, q, { status: true });
    const avail = filterList(cache.avail, q, { status: false });
    const marketsList = (cache.markets || []).filter((m) => {
      if (!q) return true;
      const hay = `${m.name || ''} ${m.id || ''} ${m.url || ''} ${m.source || ''}`.toLowerCase();
      return hay.includes(q);
    });

    let html = '';

    if (showInst) {
      html += `<div class="mgmt-section-title">${esc(t('plugin.installed', `已安装 (${inst.length})`, { n: inst.length }))}</div>`;
      if (!(cache.inst || []).length) {
        html += `<div class="muted pad">${esc(t('plugin.empty'))}</div>`;
      } else if (!inst.length) {
        html += `<div class="muted pad">${esc(t('plugin.noneMatch'))}</div>`;
      } else {
        html += inst
          .map(
            (p) => `
          <div class="mgmt-item" data-name="${esc(p.name)}">
            <div class="mi-main">
              <div class="mi-name">${esc(p.name)} ${p.version ? `<span class="mi-ver">${esc(p.version)}</span>` : ''}
                <span class="mi-badge ${p.enabled ? 'on' : 'off'}">${p.enabled ? esc(t('plugin.badge.on', 'ON')) : esc(t('plugin.badge.off', 'OFF'))}</span>
                ${p.marketplace ? `<span class="mi-ver">${esc(p.marketplace)}</span>` : ''}
              </div>
              <div class="mi-meta">${esc(p.description || p.source || '')}</div>
            </div>
            <div class="mi-actions">
              <button type="button" class="toggle ${p.enabled ? 'on' : ''}" data-act="toggle" title="enable/disable" aria-label="toggle"></button>
              <button type="button" class="btn small ghost" data-act="update" title="grok plugin update">${esc(t('plugin.update', '更新'))}</button>
              <button type="button" class="btn small ghost" data-act="details">${esc(t('plugin.details', '详情'))}</button>
              <button type="button" class="btn small danger ghost" data-act="rm">${esc(t('plugin.uninstall', '卸载'))}</button>
            </div>
          </div>`
          )
          .join('');
      }
    }

    if (showMarkets) {
      html += `<div class="mgmt-section-title">${esc(
        t('plugin.markets', `市场源 (${marketsList.length})`, { n: marketsList.length })
      )}</div>`;
      if (cache.text && !marketsList.length) {
        html += `<pre class="mgmt-log">${esc(String(cache.text).slice(0, 800))}</pre>`;
      }
      if (!marketsList.length && !cache.text) {
        html += `<div class="muted pad">${esc(t('plugin.noMarkets', '暂无市场源'))}</div>`;
      }
      html += marketsList
        .map((m) => {
          const name = m.name || m.id || m.url || 'source';
          const url = m.url || m.source || m.repository || '';
          return `<div class="mgmt-item">
            <div class="mi-main">
              <div class="mi-name">${esc(name)}</div>
              <div class="mi-meta">${esc(url)}</div>
            </div>
            <div class="mi-actions">
              <button type="button" class="btn small danger ghost" data-act="rm-market" data-name="${esc(name)}">${esc(t('plugin.removeMarket', '移除'))}</button>
            </div>
          </div>`;
        })
        .join('');
    }

    if (showAvail && (cache.avail || []).length) {
      html += `<div class="mgmt-section-title">${esc(
        t('plugin.available', `可安装 (${avail.length})`, { n: avail.length })
      )}</div>`;
      if (!avail.length) {
        html += `<div class="muted pad">${esc(t('plugin.noneMatch'))}</div>`;
      } else {
        html += avail
          .slice(0, 120)
          .map(
            (p) => `
          <div class="mgmt-item">
            <div class="mi-main">
              <div class="mi-name">${esc(p.name)} ${p.marketplace ? `<span class="mi-ver">${esc(p.marketplace)}</span>` : ''}</div>
              <div class="mi-meta">${esc(p.description || p.source || p.marketplace || '')}</div>
            </div>
            <div class="mi-actions">
              <button type="button" class="btn small primary" data-act="install" data-source="${esc(
                p.source || p.name
              )}">${esc(t('plugin.install', '安装'))}</button>
            </div>
          </div>`
          )
          .join('');
      }
    } else if (showAvail && !(cache.avail || []).length && scope === 'available') {
      html += `<div class="mgmt-section-title">${esc(t('plugin.available', '可安装 (0)', { n: 0 }))}</div>`;
      html += `<div class="muted pad">${esc(t('plugin.noAvailable', '市场无可用插件 · 先添加/更新市场源'))}</div>`;
    }

    host.innerHTML = html || `<div class="muted pad">${esc(t('plugin.noneMatch'))}</div>`;
    bindRowActions(host);
  }

  function bindRowActions(host) {
    host.querySelectorAll('.mgmt-item').forEach((row) => {
      const name = row.dataset.name;
      row.querySelector('[data-act="toggle"]')?.addEventListener('click', async (e) => {
        const on = e.currentTarget.classList.contains('on');
        const r = on
          ? await window.grok.pluginDisable({ name })
          : await window.grok.pluginEnable({ name });
        toast(r.ok ? (on ? t('plugin.toast.disabled', '已禁用') : t('plugin.toast.enabled', '已启用')) : r.error || '失败', r.ok ? 'ok' : 'err');
        refreshPlugins();
      });
      row.querySelector('[data-act="update"]')?.addEventListener('click', async () => {
        toast(t('plugin.toast.updating', '更新中…'));
        const r = await window.grok.pluginUpdate({ name });
        toast(r.ok ? t('plugin.toast.updated', '已更新') : r.error || r.stderr || '失败', r.ok ? 'ok' : 'err');
        if (r.stdout || r.stderr) showLog([r.stdout, r.stderr].filter(Boolean).join('\n'));
        refreshPlugins();
      });
      row.querySelector('[data-act="rm"]')?.addEventListener('click', async () => {
        if (!confirm(t('plugin.confirm.uninstall', `卸载插件 ${name}？`, { name }))) return;
        const r = await window.grok.pluginUninstall({ name });
        toast(r.ok ? t('plugin.toast.uninstalled', '已卸载') : r.error || '失败', r.ok ? 'ok' : 'err');
        refreshPlugins();
      });
      row.querySelector('[data-act="details"]')?.addEventListener('click', async () => {
        const r = await window.grok.pluginDetails({ name });
        showLog(
          typeof r.details === 'string' ? r.details : JSON.stringify(r.details || r.text, null, 2)
        );
      });
      row.querySelector('[data-act="rm-market"]')?.addEventListener('click', async (e) => {
        const n = e.currentTarget.dataset.name;
        if (!confirm(t('plugin.confirm.rmMarket', `移除市场源 ${n}？`, { name: n }))) return;
        const r = await window.grok.pluginMarketplaceRemove({ name: n });
        toast(r.ok ? t('plugin.toast.rmMarket', '已移除') : r.error || '失败', r.ok ? 'ok' : 'err');
        refreshPlugins();
      });
      row.querySelector('[data-act="install"]')?.addEventListener('click', async (e) => {
        const source = e.currentTarget.dataset.source;
        const trust = $('#pluginTrust')?.checked !== false;
        toast(t('plugin.toast.installing', '安装中…'));
        const r = await window.grok.pluginInstall({ source, trust });
        toast(r.ok ? t('plugin.toast.installed', '安装成功') : r.error || r.stderr || '安装失败', r.ok ? 'ok' : 'err');
        if (r.stdout || r.stderr) showLog([r.stdout, r.stderr].filter(Boolean).join('\n'));
        refreshPlugins();
      });
    });
  }

  async function refreshPlugins() {
    const host = $('#pluginList');
    if (!host) return;
    host.innerHTML = `<div class="muted pad">${esc(t('plugin.loading'))}</div>`;
    try {
      const [installed, markets, available] = await Promise.all([
        window.grok.pluginList(),
        window.grok.pluginMarketplaces(),
        window.grok.pluginAvailable().catch(() => ({ plugins: [] })),
      ]);
      cache = {
        inst: installed.plugins || [],
        avail: available.plugins || [],
        markets: markets.marketplaces || [],
        text: markets.text,
      };
      fillMarketSelect();
      renderFromCache();
    } catch (err) {
      host.innerHTML = `<div class="muted pad">${esc(err.message)}</div>`;
    }
  }

  async function loadCatalog() {
    const host = $('#catalogList');
    if (!host) return;
    try {
      const res = await fetch('catalog-data.json');
      const data = await res.json();
      window.__grokCatalog = data;
      renderCatalog(data);
    } catch (err) {
      host.innerHTML = `<div class="muted pad">目录加载失败：${esc(err.message)}。运行 npm run catalog 生成。</div>`;
    }
  }

  function renderCatalog(data) {
    const host = $('#catalogList');
    if (!host || !data) return;
    const q = ($('#catalogFilter')?.value || '').trim().toLowerCase();
    const mcp = (data.mcp || []).filter(
      (x) => !q || `${x.name} ${x.description}`.toLowerCase().includes(q)
    );
    const skills = (data.skills || []).filter(
      (x) => !q || `${x.name} ${x.description}`.toLowerCase().includes(q)
    );
    const plugins = (data.plugins || []).filter(
      (x) => !q || `${x.name} ${x.description}`.toLowerCase().includes(q)
    );

    let html = '';
    html += `<div class="mgmt-section-title">MCP 模板 (${mcp.length})</div>`;
    html += mcp
      .map(
        (m) => `
      <div class="mgmt-item">
        <div class="mi-main">
          <div class="mi-name">${esc(m.name)} <span class="mi-ver">${esc(m.transport || '')}</span></div>
          <div class="mi-meta">${esc(m.description)}</div>
          <div class="mi-meta mono">${esc(m.command || m.url || m.path)}</div>
        </div>
        <div class="mi-actions">
          <button type="button" class="btn small primary" data-kind="mcp" data-id="${esc(m.id)}">应用到 MCP</button>
        </div>
      </div>`
      )
      .join('');

    html += `<div class="mgmt-section-title">Skill 示例 (${skills.length})</div>`;
    html += skills
      .map(
        (s) => `
      <div class="mgmt-item">
        <div class="mi-main">
          <div class="mi-name">${esc(s.name)}</div>
          <div class="mi-meta">${esc(s.description)}</div>
        </div>
        <div class="mi-actions">
          <button type="button" class="btn small primary" data-kind="skill" data-id="${esc(s.id)}">安装为用户 Skill</button>
        </div>
      </div>`
      )
      .join('');

    html += `<div class="mgmt-section-title">插件市场源 (${plugins.length})</div>`;
    html += plugins
      .map(
        (p) => `
      <div class="mgmt-item">
        <div class="mi-main">
          <div class="mi-name">${esc(p.name)}</div>
          <div class="mi-meta">${esc(p.description)}</div>
          <div class="mi-meta mono">${esc(p.source)}</div>
        </div>
        <div class="mi-actions">
          <button type="button" class="btn small primary" data-kind="market" data-source="${esc(p.source)}">添加源</button>
        </div>
      </div>`
      )
      .join('');

    host.innerHTML = html || '<div class="muted pad">无匹配项</div>';

    host.querySelectorAll('button[data-kind="mcp"]').forEach((btn) => {
      btn.onclick = async () => {
        const item = (data.mcp || []).find((x) => x.id === btn.dataset.id);
        if (!item?.template) return;
        const tmpl = item.template;
        try {
          const r = await window.grok.mcpAdd({
            name: tmpl.name,
            transport: tmpl.transport || 'stdio',
            command: tmpl.command,
            url: tmpl.url,
          });
          toast(r?.ok !== false ? `已添加 MCP ${tmpl.name}` : r?.error || '失败', 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
    host.querySelectorAll('button[data-kind="skill"]').forEach((btn) => {
      btn.onclick = async () => {
        const item = (data.skills || []).find((x) => x.id === btn.dataset.id);
        if (!item) return;
        try {
          const r = await window.grok.skillsCreate({
            name: item.name,
            description: item.description,
            body: item.bodyPreview || '# ' + item.name,
            scope: 'user',
          });
          toast(r?.ok !== false ? `已创建 Skill ${item.name}` : r?.error || '失败', 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
    host.querySelectorAll('button[data-kind="market"]').forEach((btn) => {
      btn.onclick = async () => {
        const r = await window.grok.pluginMarketplaceAdd({ source: btn.dataset.source });
        toast(r.ok ? '已添加市场源' : r.error || '失败', r.ok ? 'ok' : 'err');
      };
    });
  }

  function bindFilters() {
    document.querySelectorAll('#pluginFilters .plugin-chip-row').forEach((row) => {
      const key = row.dataset.filter;
      row.querySelectorAll('.plugin-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          row.querySelectorAll('.plugin-chip').forEach((c) => c.classList.remove('active'));
          chip.classList.add('active');
          filters[key] = chip.dataset.val || 'all';
          renderFromCache();
        });
      });
    });
    $('#pluginMarketFilter')?.addEventListener('change', (e) => {
      filters.marketplace = e.target.value || '';
      renderFromCache();
    });
  }

  function bind() {
    bindFilters();
    $('#btnPluginRefresh')?.addEventListener('click', () => refreshPlugins());
    $('#btnPluginUpdateMarkets')?.addEventListener('click', async () => {
      toast(t('plugin.toast.marketsUpdating', '刷新市场…'));
      const r = await window.grok.pluginMarketplaceUpdate();
      toast(r.ok ? t('plugin.toast.marketsUpdated', '市场已更新') : r.error || '失败', r.ok ? 'ok' : 'err');
      if (r.stdout || r.stderr) showLog([r.stdout, r.stderr].filter(Boolean).join('\n'));
      refreshPlugins();
    });
    $('#btnPluginUpdateAll')?.addEventListener('click', async () => {
      toast(t('plugin.toast.updating', '更新中…'));
      const r = await window.grok.pluginUpdate({});
      toast(r.ok ? t('plugin.toast.updatedAll', '全部插件已更新') : r.error || r.stderr || '失败', r.ok ? 'ok' : 'err');
      if (r.stdout || r.stderr) showLog([r.stdout, r.stderr].filter(Boolean).join('\n'));
      refreshPlugins();
    });
    $('#btnPluginInstall')?.addEventListener('click', async () => {
      const source = $('#pluginSource')?.value?.trim();
      if (!source) return toast(t('plugin.err.source', '请填写 git URL 或 GitHub shorthand'), 'err');
      const trust = $('#pluginTrust')?.checked !== false;
      toast(t('plugin.toast.installing', '安装中…'));
      const r = await window.grok.pluginInstall({ source, trust });
      toast(r.ok ? t('plugin.toast.installed', '安装成功') : r.error || '失败', r.ok ? 'ok' : 'err');
      if (r.stdout || r.stderr) showLog([r.stdout, r.stderr].filter(Boolean).join('\n'));
      refreshPlugins();
    });
    $('#btnPluginValidate')?.addEventListener('click', async () => {
      const path = $('#pluginValidatePath')?.value?.trim() || '.';
      toast(t('plugin.toast.validating', '校验中…'));
      const r = await window.grok.pluginValidate({ path });
      toast(r.ok ? t('plugin.toast.validOk', '校验通过') : r.error || r.stderr || '校验失败', r.ok ? 'ok' : 'err');
      showLog([r.stdout, r.stderr, r.error].filter(Boolean).join('\n') || (r.ok ? 'OK' : 'failed'));
    });
    $('#btnMarketplaceAdd')?.addEventListener('click', async () => {
      const source = $('#marketplaceSource')?.value?.trim();
      if (!source) return toast(t('plugin.err.market', '请填写市场源 URL'), 'err');
      const r = await window.grok.pluginMarketplaceAdd({ source });
      toast(r.ok ? t('plugin.toast.added', '已添加') : r.error || '失败', r.ok ? 'ok' : 'err');
      refreshPlugins();
    });
    $('#btnCatalogRefresh')?.addEventListener('click', () => loadCatalog());
    $('#catalogFilter')?.addEventListener('input', () => {
      if (window.__grokCatalog) renderCatalog(window.__grokCatalog);
    });
    $('#pluginFilter')?.addEventListener('input', () => renderFromCache());

    document.getElementById('settingsTabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.stab');
      if (!btn) return;
      if (btn.dataset.stab === 'plugins') refreshPlugins();
      if (btn.dataset.stab === 'catalog') loadCatalog();
    });
  }

  window.GrokPluginsUi = { refreshPlugins, loadCatalog, renderCatalog, filters };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
