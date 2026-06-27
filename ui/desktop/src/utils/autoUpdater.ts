// Electron's native (Squirrel-backed) auto-updater. For packaged Squirrel installs it
// does silent check → download → install → relaunch via update.electronjs.org (free for
// public GitHub repos). For portable/ZIP installs or dev (where native Squirrel update
// is unavailable) it gracefully falls back to the GitHub Releases ZIP updater.
import { autoUpdater } from 'electron';
import {
  BrowserWindow,
  ipcMain,
  nativeImage,
  Tray,
  shell,
  app,
  dialog,
  Menu,
  MenuItemConstructorOptions,
  Notification,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import log from './logger';
import { githubUpdater } from './githubUpdater';
import { loadRecentDirs } from './recentDirs';
import { errorMessage } from './conversionUtils';
import {
  trackUpdateCheckStarted,
  trackUpdateCheckCompleted,
  trackUpdateDownloadStarted,
  trackUpdateDownloadProgress,
  trackUpdateDownloadCompleted,
  trackUpdateInstallInitiated,
} from './analytics';

let updateAvailable = false;
let trayRef: Tray | null = null;
let isUsingGitHubFallback = false;
let githubUpdateInfo: {
  latestVersion?: string;
  downloadUrl?: string;
  releaseUrl?: string;
  downloadPath?: string;
  extractedPath?: string;
} = {};

let lastUpdateState: { updateAvailable: boolean; latestVersion?: string } | null = null;
let lastReportedProgress = 0;
let ipcUpdateHandlersRegistered = false;
let autoDownloadDisabled = false;

// True once Electron's native (Squirrel) updater feed is set — only possible for packaged
// Squirrel installs. On portable/ZIP or dev it stays false and we use the GitHub fallback.
let nativeUpdaterReady = false;

export function setAutoDownloadDisabled(disabled: boolean) {
  autoDownloadDisabled = disabled;
  log.info(`Auto-download ${disabled ? 'disabled' : 'enabled'}`);
}

export function getAutoDownloadDisabled(): boolean {
  return autoDownloadDisabled;
}

function nativeFeedUrl(): string {
  const owner = process.env.GITHUB_OWNER || 'aecomseadigital';
  const repo = process.env.GITHUB_REPO || 'caros';
  return `https://update.electronjs.org/${owner}/${repo}/${process.platform}-${process.arch}/${app.getVersion()}`;
}

// Point Electron's native autoUpdater at update.electronjs.org. Returns false (→ GitHub
// fallback) when this isn't a Squirrel install (setFeedURL throws on non-Squirrel/dev).
function tryInitNativeUpdater(): boolean {
  if (!app.isPackaged && process.env.ENABLE_DEV_UPDATES !== 'true') {
    log.info('Native autoUpdater skipped (not packaged)');
    return false;
  }
  try {
    autoUpdater.setFeedURL({
      url: nativeFeedUrl(),
      headers: { 'User-Agent': `Caros/${app.getVersion()} (${process.platform}: ${process.arch})` },
      ...(process.platform === 'darwin' ? { serverType: 'json' as const } : {}),
    });
    nativeUpdaterReady = true;
    log.info(`Native autoUpdater feed set: ${autoUpdater.getFeedURL()}`);
    return true;
  } catch (e) {
    nativeUpdaterReady = false;
    log.warn(
      'Native autoUpdater unavailable (not a Squirrel install?) — using GitHub fallback:',
      errorMessage(e, 'unknown')
    );
    return false;
  }
}

// GitHub Releases ZIP fallback check — used when native Squirrel update is unavailable or errors.
async function runGitHubFallbackCheck(
  context: string
): Promise<{ updateInfo: null; error: string | null }> {
  const currentVersion = app.getVersion();
  isUsingGitHubFallback = true;
  try {
    const result = await githubUpdater.checkForUpdates();
    if (result.error) {
      trackUpdateCheckCompleted('error', currentVersion, {
        usingFallback: true,
        errorType: result.error,
      });
      return { updateInfo: null, error: result.error };
    }

    if (result.updateAvailable) {
      githubUpdateInfo = {
        latestVersion: result.latestVersion,
        downloadUrl: result.downloadUrl,
        releaseUrl: result.releaseUrl,
      };
      trackUpdateCheckCompleted('available', currentVersion, {
        latestVersion: result.latestVersion,
        usingFallback: true,
      });
      updateAvailable = true;
      lastUpdateState = { updateAvailable: true, latestVersion: result.latestVersion };
      updateTrayIcon(true);
      sendStatusToWindow('update-available', { version: result.latestVersion });

      if (!autoDownloadDisabled) {
        await githubAutoDownload(result.downloadUrl!, result.latestVersion!, context);
      } else {
        log.info('Auto-download disabled — skipping GitHub fallback download');
      }
    } else {
      trackUpdateCheckCompleted('not_available', currentVersion, {
        latestVersion: result.latestVersion,
        usingFallback: true,
      });
      updateAvailable = false;
      lastUpdateState = { updateAvailable: false };
      updateTrayIcon(false);
      sendStatusToWindow('update-not-available', { version: currentVersion });
    }
    return { updateInfo: null, error: null };
  } catch (fallbackError) {
    log.error(`GitHub fallback check failed (${context}):`, fallbackError);
    trackUpdateCheckCompleted('error', currentVersion, {
      usingFallback: true,
      errorType: 'github_fallback_failed',
    });
    return {
      updateInfo: null,
      error: 'Unable to check for updates. Please check your internet connection.',
    };
  }
}

// Register IPC handlers (only once)
export function registerUpdateIpcHandlers() {
  if (ipcUpdateHandlersRegistered) {
    return;
  }
  log.info('Registering update IPC handlers...');
  ipcUpdateHandlersRegistered = true;

  ipcMain.handle('check-for-updates', async () => {
    const currentVersion = app.getVersion();
    log.info('=== MANUAL UPDATE CHECK INITIATED ===');
    trackUpdateCheckStarted('manual', currentVersion);

    // Reset state for new check
    isUsingGitHubFallback = false;
    githubUpdateInfo = {};
    lastReportedProgress = 0;

    // Prefer Electron's native (Squirrel) updater; on any failure use the GitHub fallback.
    if (nativeUpdaterReady) {
      try {
        autoUpdater.checkForUpdates(); // event-driven; results arrive via the autoUpdater events
        return { updateInfo: null, error: null };
      } catch (e) {
        log.warn('Native checkForUpdates threw — using GitHub fallback:', errorMessage(e, 'unknown'));
      }
    }
    return await runGitHubFallbackCheck('manual check');
  });

  ipcMain.handle('download-update', async () => {
    try {
      if (isUsingGitHubFallback && githubUpdateInfo.downloadUrl && githubUpdateInfo.latestVersion) {
        lastReportedProgress = 0;
        trackUpdateDownloadStarted(githubUpdateInfo.latestVersion, 'github-fallback');
        const result = await githubUpdater.downloadUpdate(
          githubUpdateInfo.downloadUrl,
          githubUpdateInfo.latestVersion,
          (percent) => {
            if (percent > lastReportedProgress) {
              lastReportedProgress = percent;
              trackUpdateDownloadProgress(percent);
              sendStatusToWindow('download-progress', { percent });
            }
          }
        );
        if (result.success && result.downloadPath) {
          githubUpdateInfo.downloadPath = result.downloadPath;
          githubUpdateInfo.extractedPath = result.extractedPath;
          trackUpdateDownloadCompleted(true, githubUpdateInfo.latestVersion, 'github-fallback');
          sendStatusToWindow('update-downloaded', { version: githubUpdateInfo.latestVersion });
          return { success: true, error: null };
        }
        throw new Error(result.error || 'Download failed');
      }

      // Native (Squirrel) auto-downloads right after 'update-available'; there's nothing to
      // trigger here. The 'update-downloaded' event fires when it's ready to install.
      return { success: true, error: null };
    } catch (error) {
      log.error('Error downloading update:', error);
      const version = githubUpdateInfo.latestVersion || lastUpdateState?.latestVersion || 'unknown';
      trackUpdateDownloadCompleted(
        false,
        version,
        isUsingGitHubFallback ? 'github-fallback' : 'electron-updater',
        errorMessage(error, 'unknown')
      );
      return { success: false, error: errorMessage(error, 'Unknown error') };
    }
  });

  ipcMain.handle('install-update', async () => {
    if (isUsingGitHubFallback) {
      // Manual replace flow (portable/ZIP installs).
      log.info('Installing update from GitHub fallback...');
      try {
        const updatePath = githubUpdateInfo.extractedPath || githubUpdateInfo.downloadPath;
        if (!updatePath) {
          throw new Error('Update file path not found. Please download the update first.');
        }
        try {
          await fs.access(updatePath);
        } catch {
          throw new Error('Update file not found. Please download the update first.');
        }

        // (githubUpdater downloads the release ZIP to Downloads — it is NOT auto-extracted.)
        const detail =
          process.platform === 'win32'
            ? `Caros ${githubUpdateInfo.latestVersion} was downloaded to your Downloads folder.\n\nTo finish updating:\n1. Click "Open Folder" below.\n2. Quit Caros (this window will close).\n3. Unzip the downloaded file and replace your existing Caros folder with the new one.\n\nCaros will be updated the next time you launch it.`
            : `Caros ${githubUpdateInfo.latestVersion} was downloaded to your Downloads folder.\n\nTo finish updating:\n1. Click "Open Folder" below.\n2. Quit Caros (this window will close).\n3. Unzip it and drag the new Caros.app into your Applications folder, replacing the old one.\n\nCaros will be updated the next time you launch it.`;
        const dialogResult = (await dialog.showMessageBox({
          type: 'info',
          title: 'Update Ready to Install',
          message: `Version ${githubUpdateInfo.latestVersion} is ready to install.`,
          detail,
          buttons: ['Open Folder & Quit', 'Open Folder Only', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        })) as unknown as { response: number };

        if (dialogResult.response === 0) {
          trackUpdateInstallInitiated(
            githubUpdateInfo.latestVersion || 'unknown',
            'github-fallback',
            'open_folder_and_quit'
          );
          shell.showItemInFolder(updatePath);
          setTimeout(() => app.quit(), 1500);
        } else if (dialogResult.response === 1) {
          trackUpdateInstallInitiated(
            githubUpdateInfo.latestVersion || 'unknown',
            'github-fallback',
            'open_folder_only'
          );
          shell.showItemInFolder(updatePath);
        }
      } catch (error) {
        log.error('Error installing GitHub update:', error);
        throw error;
      }
    } else {
      // Electron native (Squirrel): silent in-place install + relaunch.
      trackUpdateInstallInitiated(
        lastUpdateState?.latestVersion || 'unknown',
        'electron-updater',
        'quit_and_install'
      );
      autoUpdater.quitAndInstall();
    }
  });

  ipcMain.handle('get-current-version', () => app.getVersion());
  ipcMain.handle('get-update-state', () => lastUpdateState);
  ipcMain.handle('is-using-github-fallback', () => isUsingGitHubFallback);
  ipcMain.handle('get-auto-download-disabled', () => autoDownloadDisabled);
}

// Configure Electron's native auto-updater (Squirrel) + wire its events to the renderer.
export function setupAutoUpdater(tray?: Tray) {
  if (tray) {
    trayRef = tray;
  }

  log.info('Setting up auto-updater...');
  log.info(
    `Current app version: ${app.getVersion()}, Platform: ${process.platform}, Arch: ${process.arch}, Packaged: ${app.isPackaged}`
  );

  const envDisabled =
    process.env.GOOSE_DISABLE_AUTO_DOWNLOAD === '1' ||
    process.env.GOOSE_DISABLE_AUTO_DOWNLOAD === 'true';
  if (envDisabled) {
    autoDownloadDisabled = true;
    log.info('Auto-download disabled via GOOSE_DISABLE_AUTO_DOWNLOAD environment variable');
  }

  // Native (Squirrel) updater events — fire only for Squirrel installs.
  autoUpdater.on('checking-for-update', () => {
    log.info('Native autoUpdater: checking for update...');
    sendStatusToWindow('checking-for-update');
  });

  autoUpdater.on('update-available', () => {
    log.info('Native autoUpdater: update available (Squirrel is downloading it)...');
    trackUpdateCheckCompleted('available', app.getVersion(), { usingFallback: false });
    updateAvailable = true;
    lastUpdateState = { updateAvailable: true };
    updateTrayIcon(true);
    sendStatusToWindow('update-available', {});
  });

  autoUpdater.on('update-not-available', () => {
    log.info('Native autoUpdater: no update available');
    trackUpdateCheckCompleted('not_available', app.getVersion(), { usingFallback: false });
    updateAvailable = false;
    lastUpdateState = { updateAvailable: false };
    updateTrayIcon(false);
    sendStatusToWindow('update-not-available', { version: app.getVersion() });
  });

  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    log.info(`Native autoUpdater: update downloaded (${releaseName})`);
    lastUpdateState = { updateAvailable: true, latestVersion: releaseName };
    trackUpdateDownloadCompleted(true, releaseName || 'unknown', 'electron-updater');
    sendStatusToWindow('update-downloaded', { version: releaseName });

    const notification = new Notification({
      title: 'Update Ready',
      body: 'A new version of Caros will be installed when you quit. Click to install now.',
    });
    notification.show();
    notification.on('click', () => {
      trackUpdateInstallInitiated(releaseName || 'unknown', 'electron-updater', 'quit_and_install');
      autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    log.error('Native autoUpdater error — falling back to GitHub check:', errorMessage(err, 'unknown'));
    // Squirrel/native unavailable (e.g., not installed via Setup.exe, or no Squirrel release
    // published yet): use the GitHub Releases fallback so the user still gets an answer.
    runGitHubFallbackCheck('native-error').catch((e) =>
      log.error('Fallback after native error failed:', e)
    );
  });

  const nativeOk = tryInitNativeUpdater();

  // Check for updates shortly after startup.
  setTimeout(() => {
    log.info('=== STARTUP UPDATE CHECK ===');
    trackUpdateCheckStarted('startup', app.getVersion());
    if (nativeUpdaterReady) {
      try {
        autoUpdater.checkForUpdates();
      } catch (e) {
        log.warn('Native startup check threw — GitHub fallback:', errorMessage(e, 'unknown'));
        runGitHubFallbackCheck('startup').catch(() => {});
      }
    } else {
      runGitHubFallbackCheck('startup').catch(() => {});
    }
  }, 5000);

  log.info(`Auto-updater setup complete (native ${nativeOk ? 'enabled' : 'unavailable → GitHub fallback'})`);
}

interface UpdaterEvent {
  event: string;
  data?: unknown;
}

function sendStatusToWindow(event: string, data?: unknown) {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    win.webContents.send('updater-event', { event, data } as UpdaterEvent);
  });
}

// Centralized GitHub fallback auto-download logic.
async function githubAutoDownload(
  downloadUrl: string,
  latestVersion: string,
  contextLabel = ''
): Promise<void> {
  lastReportedProgress = 0;
  trackUpdateDownloadStarted(latestVersion, 'github-fallback');

  try {
    const downloadResult = await githubUpdater.downloadUpdate(
      downloadUrl,
      latestVersion,
      (percent) => {
        if (percent > lastReportedProgress) {
          lastReportedProgress = percent;
          trackUpdateDownloadProgress(percent);
          sendStatusToWindow('download-progress', { percent });
        }
      }
    );

    if (downloadResult.success && downloadResult.downloadPath) {
      githubUpdateInfo.downloadPath = downloadResult.downloadPath;
      githubUpdateInfo.extractedPath = downloadResult.extractedPath;
      trackUpdateDownloadCompleted(true, latestVersion, 'github-fallback');
      sendStatusToWindow('update-downloaded', { version: latestVersion });
    } else {
      trackUpdateDownloadCompleted(false, latestVersion, 'github-fallback', downloadResult.error);
      log.error(
        `GitHub auto-download failed${contextLabel ? ` (${contextLabel})` : ''}:`,
        downloadResult.error
      );
    }
  } catch (downloadError) {
    trackUpdateDownloadCompleted(
      false,
      latestVersion,
      'github-fallback',
      errorMessage(downloadError, 'unknown')
    );
    log.error(
      `Error during GitHub auto-download${contextLabel ? ` (${contextLabel})` : ''}:`,
      downloadError
    );
  }
}

function updateTrayIcon(hasUpdate: boolean) {
  if (!trayRef) return;

  if (process.env.GOOSE_VERSION) {
    hasUpdate = false;
  }

  const isDev = !app.isPackaged;
  let iconPath: string;

  if (hasUpdate) {
    if (isDev) {
      iconPath = path.join(process.cwd(), 'src', 'images', 'iconTemplateUpdate.png');
    } else {
      iconPath = path.join(process.resourcesPath, 'images', 'iconTemplateUpdate.png');
    }
    trayRef.setToolTip('Caros - Update Available');
  } else {
    if (isDev) {
      iconPath = path.join(process.cwd(), 'src', 'images', 'iconTemplate.png');
    } else {
      iconPath = path.join(process.resourcesPath, 'images', 'iconTemplate.png');
    }
    trayRef.setToolTip('Caros');
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }
  trayRef.setImage(icon);

  updateTrayMenu(hasUpdate);
}

// Function to open settings and scroll to update section
function openUpdateSettings() {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    const mainWindow = windows[0];
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('set-view', 'settings', 'update');
  }
}

// Export function to update tray menu
export function updateTrayMenu(hasUpdate: boolean) {
  if (!trayRef) return;

  const menuItems: MenuItemConstructorOptions[] = [];

  if (hasUpdate) {
    menuItems.push({
      label: 'Update Available...',
      click: openUpdateSettings,
    });
  }

  menuItems.push(
    {
      label: 'Show Window',
      click: async () => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length === 0) {
          log.info('No windows are open, creating a new one...');
          const recentDirs = loadRecentDirs();
          const openDir = recentDirs.length > 0 ? recentDirs[0] : null;
          ipcMain.emit('create-chat-window', {}, undefined, openDir);
          return;
        }

        const initialOffsetX = 30;
        const initialOffsetY = 30;

        windows.forEach((win: BrowserWindow, index: number) => {
          const currentBounds = win.getBounds();
          const newX = currentBounds.x + initialOffsetX * index;
          const newY = currentBounds.y + initialOffsetY * index;

          win.setBounds({
            x: newX,
            y: newY,
            width: currentBounds.width,
            height: currentBounds.height,
          });

          if (!win.isVisible()) {
            win.show();
          }

          win.focus();
        });
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  trayRef.setContextMenu(contextMenu);
}

// Export functions to manage tray reference
export function setTrayRef(tray: Tray) {
  trayRef = tray;
  updateTrayIcon(updateAvailable);
}

export function getUpdateAvailable(): boolean {
  return updateAvailable;
}
