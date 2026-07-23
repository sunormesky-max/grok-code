const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Resolve the Grok Build CLI binary on this machine.
 */
function resolveGrokBinary(configuredPath) {
  const candidates = [];

  if (configuredPath && String(configuredPath).trim()) {
    candidates.push(String(configuredPath).trim());
  }
  if (process.env.GROK_BIN) {
    candidates.push(process.env.GROK_BIN);
  }
  if (process.env.GROK_HOME) {
    candidates.push(
      path.join(process.env.GROK_HOME, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
    );
  }

  const home = os.homedir();
  candidates.push(
    path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
  );

  // PATH lookup
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', ['grok'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) candidates.push(first);
    } else {
      const out = execFileSync('which', ['grok'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const first = out.trim().split(/\n/)[0];
      if (first) candidates.push(first);
    }
  } catch {
    /* not on PATH */
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

function probeGrok(configuredPath) {
  const bin = resolveGrokBinary(configuredPath);
  if (!bin) {
    return { ok: false, binary: null, version: null, error: '未找到 Grok CLI' };
  }
  try {
    const out = execFileSync(bin, ['version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return { ok: true, binary: bin, version: out.trim().split(/\r?\n/)[0], error: null };
  } catch (err) {
    return {
      ok: false,
      binary: bin,
      version: null,
      error: err.message || String(err),
    };
  }
}

/**
 * Parse `grok models` text output (CLI has no --json for this subcommand).
 *
 * Example:
 *   Default model: grok-4.5
 *   Available models:
 *     * grok-4.5 (default)
 *     * grok-4
 *
 * Also accepts ACP ModelState-ish JSON shapes when available.
 */
function parseModelsOutput(raw) {
  const text = String(raw || '');
  // JSON path (future CLI / ACP dump)
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(trimmed);
      return normalizeModelStateJson(j);
    } catch {
      /* fall through to text */
    }
  }

  let defaultId = '';
  const defM = text.match(/Default\s+model\s*:\s*(\S+)/i);
  if (defM) defaultId = defM[1].replace(/[,"']/g, '');

  const models = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  let inList = false;
  for (const line of lines) {
    if (/Available\s+models\s*:/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    // "  * grok-4.5 (default)" or "  - id" or "  • id"
    const m = line.match(/^\s*[*\-•·]\s+(\S+)/);
    if (!m) {
      // blank / footer ends list
      if (/^\s*$/.test(line)) continue;
      if (/^[A-Za-z]/.test(line.trim())) break;
      continue;
    }
    let id = m[1].replace(/[,"']/g, '');
    // strip trailing punctuation from "(default)"
    id = id.replace(/\(.*$/, '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const isDefault =
      /\(default\)/i.test(line) ||
      (defaultId && id === defaultId);
    models.push({
      id,
      name: id,
      isDefault: Boolean(isDefault),
    });
  }

  // Fallback: single default only
  if (!models.length && defaultId) {
    models.push({ id: defaultId, name: defaultId, isDefault: true });
  }
  if (!defaultId && models.length) {
    const d = models.find((x) => x.isDefault);
    if (d) defaultId = d.id;
    else {
      models[0].isDefault = true;
      defaultId = models[0].id;
    }
  }

  return {
    ok: models.length > 0,
    defaultId: defaultId || '',
    models,
    source: 'cli-text',
  };
}

/**
 * Normalize ACP modelState / NewSessionResponse.models shapes.
 * Wire varies: { availableModels: [{modelId,name}], currentModelId }
 * or { current, available: { id: ModelInfo } } etc.
 */
function normalizeModelStateJson(j) {
  if (!j || typeof j !== 'object') {
    return { ok: false, defaultId: '', models: [], source: 'json' };
  }
  // Unwrap common nests
  const root = j.models || j.modelState || j.model_state || j;
  let defaultId =
    root.currentModelId ||
    root.current_model_id ||
    root.currentModel ||
    (typeof root.current === 'string' ? root.current : root.current?.id) ||
    root.defaultModelId ||
    root.default ||
    '';
  if (defaultId && typeof defaultId === 'object') {
    defaultId = defaultId.id || defaultId.modelId || '';
  }
  defaultId = String(defaultId || '');

  const models = [];
  const seen = new Set();
  const push = (id, name, isDefault) => {
    const mid = String(id || '').trim();
    if (!mid || seen.has(mid)) return;
    seen.add(mid);
    models.push({
      id: mid,
      name: String(name || mid),
      isDefault: Boolean(isDefault) || mid === defaultId,
    });
  };

  const avail =
    root.availableModels ||
    root.available_models ||
    root.available ||
    root.models ||
    null;

  if (Array.isArray(avail)) {
    for (const m of avail) {
      if (typeof m === 'string') push(m, m, false);
      else if (m && typeof m === 'object') {
        push(
          m.modelId || m.model_id || m.id || m.name,
          m.name || m.title || m.modelId || m.id,
          m.isDefault || m.default
        );
      }
    }
  } else if (avail && typeof avail === 'object') {
    for (const [k, v] of Object.entries(avail)) {
      if (v && typeof v === 'object') {
        push(v.modelId || v.id || k, v.name || v.title || k, false);
      } else {
        push(k, k, false);
      }
    }
  }

  if (!defaultId && models[0]) {
    models[0].isDefault = true;
    defaultId = models[0].id;
  }
  return {
    ok: models.length > 0,
    defaultId,
    models,
    source: 'json',
  };
}

/**
 * Run `grok models` (open-source CLI) and parse available models.
 * @param {string} [configuredPath]
 * @returns {{ ok: boolean, binary?: string, defaultId: string, models: Array, error?: string, raw?: string }}
 */
function listGrokModels(configuredPath) {
  const bin = resolveGrokBinary(configuredPath);
  if (!bin) {
    return {
      ok: false,
      binary: null,
      defaultId: '',
      models: [],
      error: '未找到 Grok CLI',
    };
  }
  try {
    const out = execFileSync(bin, ['models'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = parseModelsOutput(out);
    return {
      ok: parsed.ok,
      binary: bin,
      defaultId: parsed.defaultId,
      models: parsed.models,
      source: parsed.source,
      raw: String(out || '').slice(0, 4000),
      error: parsed.ok ? null : '未能解析 grok models 输出',
    };
  } catch (err) {
    return {
      ok: false,
      binary: bin,
      defaultId: '',
      models: [],
      error: err.message || String(err),
      stderr: err.stderr ? String(err.stderr).slice(0, 500) : '',
    };
  }
}

module.exports = {
  resolveGrokBinary,
  probeGrok,
  parseModelsOutput,
  normalizeModelStateJson,
  listGrokModels,
};
