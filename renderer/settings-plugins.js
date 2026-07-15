/**
 * Settings → Plugins marketplace bridge + Catalog + Profiles UI
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

  function matchQ(obj, q) {
    if (!q) return true;
    const hay = `${obj.name || ''} ${obj.description || ''} ${obj.source || ''} ${obj.marketplace || ''} ${obj.version || ''}`.toLowerCase();
    return hay.includes(q);
  }

  function renderFromCache() {
    const host = $('#pluginList');
    if (!host || !cache) return;
    const q = ($('#pluginFilter')?.value || '').trim().toLowerCase();
    const inst = (cache.inst || []).filter((p) => matchQ(p, q));
    const avail = (cache.avail || []).filter((p) => matchQ(p, q));
    const marketsList = cache.markets || [];

    let html = '';
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
              <div class="mi-name">${esc(p.name)} ${p.version ? `<span class="mi-ver">${esc(p.version)}</span>` : ''}</div>
              <div class="mi-meta">${esc(p.description || p.source || '')}</div>
            </div>
            <div class="mi-actions">
              <button type="button" class="toggle ${p.enabled ? 'on' : ''}" data-act="toggle" title="enable/disable" aria-label="toggle"></button>
              <button type="button" class="btn small ghost" data-act="details">详情</button>
              <button type="button" class="btn small danger ghost" data-act="rm">卸载</button>
            </div>
          </div>`
        )
        .join('');
    }

    html += `<div class="mgmt-section-title">${esc(
      t('plugin.markets', `市场源 (${marketsList.length})`, { n: marketsList.length })
    )}</div>`;
    if (cache.text && !marketsList.length) {
      html += `<pre class="mgmt-log">${esc(String(cache.text).slice(0, 800))}</pre>`;
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
              <button type="button" class="btn small danger ghost" data-act="rm-market" data-name="${esc(name)}">移除</button>
            </div>
          </div>`;
      })
      .join('');

    if ((cache.avail || []).length) {
      html += `<div class="mgmt-section-title">${esc(
        t('plugin.available', `可安装 (${avail.length})`, { n: avail.length })
      )}</div>`;
      if (!avail.length) {
        html += `<div class="muted pad">${esc(t('plugin.noneMatch'))}</div>`;
      } else {
        html += avail
          .slice(0, 80)
          .map(
            (p) => `
          <div class="mgmt-item">
            <div class="mi-main">
              <div class="mi-name">${esc(p.name)}</div>
              <div class="mi-meta">${esc(p.description || p.source || p.marketplace || '')}</div>
            </div>
            <div class="mi-actions">
              <button type="button" class="btn small primary" data-act="install" data-source="${esc(
                p.source || p.name
              )}">安装</button>
            </div>
          </div>`
          )
          .join('');
      }
    }

    host.innerHTML = html;
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
        toast(r.ok ? (on ? '已禁用' : '已启用') : r.error || '失败', r.ok ? 'ok' : 'err');
        refreshPlugins();
      });
      row.querySelector('[data-act="rm"]')?.addEventListener('click', async () => {
        if (!confirm(`卸载插件 ${name}？`)) return;
        const r = await window.grok.pluginUninstall({ name });
        toast(r.ok ? '已卸载' : r.error || '失败', r.ok ? 'ok' : 'err');
        refreshPlugins();
      });
      row.querySelector('[data-act="details"]')?.addEventListener('click', async () => {
        const r = await window.grok.pluginDetails({ name });
        const log = $('#pluginLog');
        if (log) {
          log.classList.remove('hidden');
          log.textContent =
            typeof r.details === 'string' ? r.details : JSON.stringify(r.details || r.text, null, 2);
        }
      });
      row.querySelector('[data-act="rm-market"]')?.addEventListener('click', async (e) => {
        const n = e.currentTarget.dataset.name;
        if (!confirm(`移除市场源 ${n}？`)) return;
        const r = await window.grok.pluginMarketplaceRemove({ name: n });
        toast(r.ok ? '已移除' : r.error || '失败', r.ok ? 'ok' : 'err');
        refreshPlugins();
      });
      row.querySelector('[data-act="install"]')?.addEventListener('click', async (e) => {
        const source = e.currentTarget.dataset.source;
        toast('安装中…');
        const r = await window.grok.pluginInstall({ source, trust: true });
        toast(r.ok ? '安装成功' : r.error || r.stderr || '安装失败', r.ok ? 'ok' : 'err');
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

  function bind() {
    $('#btnPluginRefresh')?.addEventListener('click', () => refreshPlugins());
    $('#btnPluginUpdateMarkets')?.addEventListener('click', async () => {
      toast('刷新市场…');
      const r = await window.grok.pluginMarketplaceUpdate();
      toast(r.ok ? '市场已更新' : r.error || '失败', r.ok ? 'ok' : 'err');
      refreshPlugins();
    });
    $('#btnPluginInstall')?.addEventListener('click', async () => {
      const source = $('#pluginSource')?.value?.trim();
      if (!source) return toast('请填写 git URL 或 GitHub shorthand', 'err');
      toast('安装中…');
      const r = await window.grok.pluginInstall({ source, trust: true });
      toast(r.ok ? '安装成功' : r.error || '失败', r.ok ? 'ok' : 'err');
      refreshPlugins();
    });
    $('#btnMarketplaceAdd')?.addEventListener('click', async () => {
      const source = $('#marketplaceSource')?.value?.trim();
      if (!source) return toast('请填写市场源 URL', 'err');
      const r = await window.grok.pluginMarketplaceAdd({ source });
      toast(r.ok ? '已添加' : r.error || '失败', r.ok ? 'ok' : 'err');
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

  window.GrokPluginsUi = { refreshPlugins, loadCatalog, renderCatalog };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
