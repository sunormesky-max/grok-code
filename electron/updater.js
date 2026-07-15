/**
 * Auto-update via electron-updater (GitHub Releases)
 * 开发模式 / 未打包时静默跳过
 */
const { app, BrowserWindow } = require('electron');

let autoUpdater = null;
let initialized = false;
let lastStatus = { status: 'idle', message: '尚未检查' };

function emit(payload) {
  lastStatus = { ...lastStatus, ...payload, ts: Date.now() };
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

  if (!isPackaged() || process.argv.includes('--dev')) {
    lastStatus = {
      status: 'disabled',
      message: '开发/未打包模式不检查更新',
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
      ts: Date.now(),
    };
    return lastStatus;
  }

  autoUpdater.autoDownload = opts.autoDownload !== false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    emit({ status: 'checking', message: '正在检查更新…' });
  });
  autoUpdater.on('update-available', (info) => {
    emit({
      status: 'available',
      message: `发现新版本 ${info.version}`,
      version: info.version,
      info,
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    emit({
      status: 'none',
      message: `已是最新 ${info?.version || app.getVersion()}`,
      version: info?.version,
    });
  });
  autoUpdater.on('download-progress', (p) => {
    emit({
      status: 'downloading',
      message: `下载中 ${Math.round(p.percent || 0)}%`,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({
      status: 'ready',
      message: `已下载 ${info.version}，重启即可安装`,
      version: info.version,
      info,
    });
  });
  autoUpdater.on('error', (err) => {
    emit({
      status: 'error',
      message: err?.message || String(err),
    });
  });

  // 启动后延迟检查
  if (opts.checkOnStart !== false) {
    setTimeout(() => {
      checkForUpdates().catch(() => {});
    }, 8000);
  }

  lastStatus = { status: 'idle', message: '更新器已就绪', ts: Date.now() };
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
    const result = await autoUpdater.checkForUpdates();
    return { ...lastStatus, updateInfo: result?.updateInfo };
  } catch (err) {
    emit({ status: 'error', message: err.message || String(err) });
    return lastStatus;
  }
}

async function downloadUpdate() {
  if (!autoUpdater) return lastStatus;
  try {
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
  return lastStatus;
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getStatus,
};
