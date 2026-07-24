/**
 * Auto-update via electron-updater (GitHub Releases)
 * 开发模式 / 未打包时静默跳过
 */
const { app, BrowserWindow } = require('electron');

let autoUpdater = null;
let initialized = false;
let lastStatus = {
  status: 'idle',
  message: '尚未检查',
  currentVersion: null,
  ts: Date.now(),
};

function currentVersion() {
  try {
    return app.getVersion();
  } catch {
    return null;
  }
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function emit(payload) {
  lastStatus = {
    ...lastStatus,
    ...payload,
    currentVersion: currentVersion(),
    ts: Date.now(),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', lastStatus);
  }
}

function isPackaged() {
  try {
    return app.isPackaged;
  } catch {
    return false;
  }
}

function initUpdater(opts = {}) {
  if (initialized) return lastStatus;
  initialized = true;

  lastStatus.currentVersion = currentVersion();

  if (!isPackaged() || process.argv.includes('--dev')) {
    lastStatus = {
      status: 'disabled',
      message: '开发/未打包模式不检查更新',
      currentVersion: currentVersion(),
      packaged: false,
      ts: Date.now(),
    };
    return lastStatus;
  }

  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    lastStatus = {
      status: 'unavailable',
      message: 'electron-updater 未安装: ' + (err.message || err),
      currentVersion: currentVersion(),
      packaged: true,
      ts: Date.now(),
    };
    return lastStatus;
  }

  autoUpdater.autoDownload = opts.autoDownload !== false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Avoid noisy logs in prod; host surfaces status via IPC
  try {
    autoUpdater.logger = null;
  } catch {
    /* ignore */
  }

  autoUpdater.on('checking-for-update', () => {
    emit({ status: 'checking', message: '正在检查更新…', percent: null });
  });
  autoUpdater.on('update-available', (info) => {
    emit({
      status: 'available',
      message: `发现新版本 ${info.version}`,
      version: info.version,
      releaseName: info.releaseName || info.version,
      releaseNotes:
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes.slice(0, 2000)
          : Array.isArray(info.releaseNotes)
            ? info.releaseNotes
                .map((n) => n?.note || n)
                .join('\n')
                .slice(0, 2000)
            : null,
      info,
      autoDownload: Boolean(autoUpdater.autoDownload),
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    emit({
      status: 'none',
      message: `已是最新 ${info?.version || app.getVersion()}`,
      version: info?.version || app.getVersion(),
      percent: null,
    });
  });
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent || 0);
    const tr = formatBytes(p.transferred);
    const tot = formatBytes(p.total);
    emit({
      status: 'downloading',
      message: tot ? `下载中 ${pct}% · ${tr} / ${tot}` : `下载中 ${pct}%`,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({
      status: 'ready',
      message: `已下载 ${info.version}，重启即可安装`,
      version: info.version,
      percent: 100,
      info,
    });
  });
  autoUpdater.on('error', (err) => {
    emit({
      status: 'error',
      message: err?.message || String(err),
      percent: null,
    });
  });

  // 启动后延迟检查
  if (opts.checkOnStart !== false) {
    setTimeout(() => {
      checkForUpdates().catch(() => {});
    }, 8000);
  }

  lastStatus = {
    status: 'idle',
    message: '更新器已就绪',
    currentVersion: currentVersion(),
    packaged: true,
    autoDownload: Boolean(autoUpdater.autoDownload),
    ts: Date.now(),
  };
  return lastStatus;
}

async function checkForUpdates() {
  if (!autoUpdater) {
    initUpdater({ checkOnStart: false });
  }
  if (!autoUpdater) {
    return lastStatus;
  }
  try {
    emit({ status: 'checking', message: '正在检查更新…' });
    const result = await autoUpdater.checkForUpdates();
    return { ...lastStatus, updateInfo: result?.updateInfo };
  } catch (err) {
    emit({ status: 'error', message: err.message || String(err) });
    return lastStatus;
  }
}

async function downloadUpdate() {
  if (!autoUpdater) {
    initUpdater({ checkOnStart: false });
  }
  if (!autoUpdater) return lastStatus;
  try {
    emit({ status: 'downloading', message: '开始下载…', percent: 0 });
    await autoUpdater.downloadUpdate();
    return lastStatus;
  } catch (err) {
    emit({ status: 'error', message: err.message || String(err) });
    return lastStatus;
  }
}

function quitAndInstall() {
  if (!autoUpdater) return false;
  try {
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch {
    return false;
  }
}

function getStatus() {
  return {
    ...lastStatus,
    currentVersion: currentVersion(),
  };
}

/** Public releases page (browser) — works even when auto-update is disabled */
function releasesUrl() {
  return 'https://github.com/sunormesky-max/grok-code/releases';
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getStatus,
  releasesUrl,
  formatBytes,
  isPackaged,
};
