/**
 * Safe external URL open — block file://, javascript:, custom schemes, etc.
 * Renderer only gets http(s) / mailto through openExternal IPC.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isSafeExternalUrl(url) {
  if (url == null) return false;
  const s = String(url).trim();
  if (!s || s.length > 2048) return false;
  // Control chars / CRLF injection into shell handlers
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  const proto = String(parsed.protocol || '').toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(proto)) return false;
  // http(s): require a hostname (blocks weird edge cases)
  if (proto === 'http:' || proto === 'https:') {
    if (!parsed.hostname) return false;
  }
  // mailto: need at least a non-empty path/user
  if (proto === 'mailto:') {
    const addr = (parsed.pathname || parsed.href.replace(/^mailto:/i, '')).trim();
    if (!addr || addr.length > 512) return false;
  }
  return true;
}

/**
 * @param {{ openExternal: (url: string) => Promise<void> }} shell
 * @param {unknown} url
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function openExternalSafe(shell, url) {
  if (!isSafeExternalUrl(url)) {
    return {
      ok: false,
      error: '已拦截不安全链接（仅允许 http / https / mailto）',
    };
  }
  try {
    await shell.openExternal(String(url).trim());
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}

module.exports = {
  isSafeExternalUrl,
  openExternalSafe,
  ALLOWED_PROTOCOLS,
};
