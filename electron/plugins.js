/**
 * Grok plugin marketplace bridge — wraps `grok plugin` CLI
 */
const { execFile } = require('child_process');
const { resolveGrokBinary } = require('./grok-cli');

function runGrok(args, grokPath, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const bin = resolveGrokBinary(grokPath);
    if (!bin) {
      resolve({ ok: false, error: '未找到 Grok CLI', stdout: '', stderr: '', data: null });
      return;
    }
    execFile(
      bin,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errText = String(stderr || '');
        if (err) {
          resolve({
            ok: false,
            error: err.message || errText || 'command failed',
            stdout: out,
            stderr: errText,
            data: tryParseJson(out) || tryParseJson(errText),
          });
          return;
        }
        resolve({
          ok: true,
          error: null,
          stdout: out,
          stderr: errText,
          data: tryParseJson(out),
        });
      }
    );
  });
}

function tryParseJson(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // sometimes CLI prints trailing logs
    const m = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function listInstalled(grokPath) {
  const r = await runGrok(['plugin', 'list', '--json'], grokPath);
  return {
    ok: r.ok,
    error: r.error,
    plugins: normalizePluginList(r.data) || parsePluginListText(r.stdout),
    raw: r.stdout,
  };
}

async function listAvailable(grokPath) {
  const r = await runGrok(['plugin', 'list', '--json', '--available'], grokPath, 90000);
  return {
    ok: r.ok,
    error: r.error,
    plugins: normalizePluginList(r.data) || [],
    raw: r.stdout,
  };
}

async function listMarketplaces(grokPath) {
  const r = await runGrok(['plugin', 'marketplace', 'list', '--json'], grokPath, 90000);
  return {
    ok: r.ok,
    error: r.error,
    marketplaces: normalizeMarketplaces(r.data),
    text: r.stdout,
    raw: r.stdout,
  };
}

async function addMarketplace(source, grokPath) {
  if (!source) return { ok: false, error: '缺少 marketplace 源' };
  return runGrok(['plugin', 'marketplace', 'add', String(source)], grokPath, 120000);
}

async function removeMarketplace(name, grokPath) {
  if (!name) return { ok: false, error: '缺少名称' };
  return runGrok(['plugin', 'marketplace', 'remove', String(name)], grokPath, 60000);
}

async function updateMarketplaces(grokPath) {
  return runGrok(['plugin', 'marketplace', 'update'], grokPath, 180000);
}

async function installPlugin(source, grokPath, { trust = true } = {}) {
  if (!source) return { ok: false, error: '缺少插件源' };
  const args = ['plugin', 'install', String(source)];
  if (trust) args.push('--trust');
  return runGrok(args, grokPath, 180000);
}

async function uninstallPlugin(name, grokPath) {
  if (!name) return { ok: false, error: '缺少插件名' };
  return runGrok(['plugin', 'uninstall', String(name)], grokPath, 60000);
}

async function enablePlugin(name, grokPath) {
  return runGrok(['plugin', 'enable', String(name)], grokPath);
}

async function disablePlugin(name, grokPath) {
  return runGrok(['plugin', 'disable', String(name)], grokPath);
}

async function pluginDetails(name, grokPath) {
  const r = await runGrok(['plugin', 'details', String(name), '--json'], grokPath);
  if (!r.ok) {
    // fallback without --json
    const r2 = await runGrok(['plugin', 'details', String(name)], grokPath);
    return { ok: r2.ok, error: r2.error, details: r2.data || r2.stdout, text: r2.stdout };
  }
  return { ok: true, details: r.data || r.stdout, text: r.stdout };
}

function normalizePluginList(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    return data.map(normalizePlugin);
  }
  if (Array.isArray(data.plugins)) return data.plugins.map(normalizePlugin);
  if (Array.isArray(data.installed)) return data.installed.map(normalizePlugin);
  if (typeof data === 'object') {
    // map name -> meta
    return Object.entries(data).map(([name, meta]) =>
      normalizePlugin(typeof meta === 'object' ? { name, ...meta } : { name, status: meta })
    );
  }
  return null;
}

function normalizePlugin(p) {
  if (!p) return { name: 'unknown' };
  if (typeof p === 'string') return { name: p, enabled: true };
  return {
    name: p.name || p.id || p.plugin || 'unknown',
    version: p.version || p.ver || '',
    enabled: p.enabled !== false && p.status !== 'disabled',
    source: p.source || p.url || p.repo || '',
    description: p.description || p.desc || '',
    available: Boolean(p.available),
    marketplace: p.marketplace || p.market || '',
    raw: p,
  };
}

function normalizeMarketplaces(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.marketplaces)) return data.marketplaces;
  if (Array.isArray(data.sources)) return data.sources;
  if (typeof data === 'object') {
    return Object.entries(data).map(([name, meta]) => ({
      name,
      ...(typeof meta === 'object' ? meta : { url: meta }),
    }));
  }
  return [];
}

function parsePluginListText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || /no plugins/i.test(text)) return [];
  const out = [];
  for (const line of lines) {
    if (/^usage:|^commands:|^options:/i.test(line)) continue;
    const m = line.match(/^([a-zA-Z0-9._@/-]+)\s*(.*)$/);
    if (m) out.push({ name: m[1], description: m[2] || '', enabled: true });
  }
  return out;
}

module.exports = {
  listInstalled,
  listAvailable,
  listMarketplaces,
  addMarketplace,
  removeMarketplace,
  updateMarketplaces,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  pluginDetails,
};
