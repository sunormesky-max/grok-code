/**
 * Opt-in crash / error telemetry — OFF by default.
 * Only records local crash logs; optional HTTPS endpoint if user enables + sets URL.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { app } = require('electron');

function logDir() {
  const dir = path.join(os.homedir(), '.grok-code', 'crashes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function redact(obj) {
  const s = JSON.stringify(obj);
  return s
    .replace(/xai-[A-Za-z0-9_-]+/g, 'xai-***')
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}

/**
 * @param {Error|string} err
 * @param {{ enabled?: boolean, endpoint?: string, extra?: object }} opts
 */
function reportCrash(err, opts = {}) {
  if (!opts.enabled) {
    return { ok: false, skipped: true, reason: 'telemetry_disabled' };
  }

  let appVersion = 'unknown';
  try {
    appVersion = app.getVersion();
  } catch {
    /* ignore */
  }

  const payload = {
    type: 'crash',
    ts: new Date().toISOString(),
    message: typeof err === 'string' ? err : err?.message || String(err),
    stack: typeof err === 'object' && err?.stack ? String(err.stack).slice(0, 4000) : undefined,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    appVersion,
    extra: opts.extra || {},
  };

  const text = redact(payload);
  const file = path.join(logDir(), `crash-${Date.now()}.json`);
  try {
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const endpoint = String(opts.endpoint || '').trim();
  if (!endpoint) {
    return { ok: true, file, uploaded: false };
  }

  // fire-and-forget upload
  uploadJson(endpoint, text).catch(() => {});
  return { ok: true, file, uploaded: true, endpoint };
}

function uploadJson(url, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'GrokCode-Telemetry/1',
          },
          timeout: 8000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function listCrashLogs(limit = 20) {
  const dir = logDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const file = path.join(dir, n);
        const st = fs.statSync(file);
        return { name: n, file, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { reportCrash, listCrashLogs, logDir };
