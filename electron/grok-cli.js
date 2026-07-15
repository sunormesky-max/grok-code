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

module.exports = { resolveGrokBinary, probeGrok };
