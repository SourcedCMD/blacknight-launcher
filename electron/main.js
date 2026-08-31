'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { createSettings } = require('./services/settings');
const { Auth } = require('./services/auth');
const { Downloader } = require('./services/downloader');
const { Library } = require('./services/library');

const isDev = process.argv.includes('--dev');

let win = null;
let tray = null;
let settings, auth, downloader, library, catalog;
let quitting = false;
let dataDir;

/* -------------------------------------------------------------------- */
/* Services                                                              */

function bootServices() {
  dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'catalog.json'), 'utf8'));

  settings = createSettings(dataDir);
  if (!settings.get('installDir')) {
    settings.set('installDir', path.join(app.getPath('documents'), 'BlackNight Studios', 'Games'));
  }

  auth = new Auth(dataDir);
  downloader = new Downloader(dataDir, settings);
  library = new Library(dataDir, catalog, downloader, settings);

  const forward = (channel) => (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  downloader.on('progress', forward('downloads:progress'));
  downloader.on('changed', forward('downloads:changed'));
  downloader.on('completed', (item) => {
    forward('downloads:completed')(item);
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  });
}

/* -------------------------------------------------------------------- */
/* Window                                                                */

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: Math.min(1440, Math.round(sw * 0.86)),
    height: Math.min(900, Math.round(sh * 0.88)),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#06060a',
    title: 'BlackNight Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  win.once('ready-to-show', () => {
    if (settings.get('startMinimized')) win.minimize();
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  const pushState = () =>
    win.webContents.send('window:state', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      focused: win.isFocused()
    });

  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    win.on(evt, pushState);
  }

  win.on('close', (event) => {
    if (quitting) return;
    if (settings.get('minimizeToTray') && settings.get('closeAction') === 'tray' && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });

  // External links open in the real browser, never inside the launcher shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function buildTray(image) {
  if (tray) return;
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('BlackNight Launcher');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open BlackNight', click: () => { win?.show(); win?.focus(); } },
      { type: 'separator' },
      { label: 'Downloads', click: () => { win?.show(); win?.webContents.send('nav:go', 'downloads'); } },
      { label: 'Settings', click: () => { win?.show(); win?.webContents.send('nav:go', 'settings'); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ])
  );
  tray.on('double-click', () => { win?.show(); win?.focus(); });
}

/* -------------------------------------------------------------------- */
/* IPC                                                                   */

const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

function registerIpc() {
  /* Window chrome ---------------------------------------------------- */
  handle('window:minimize', () => win?.minimize());
  handle('window:maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
    return win.isMaximized();
  });
  handle('window:close', () => win?.close());
  handle('window:state', () => ({
    maximized: !!win?.isMaximized(),
    fullscreen: !!win?.isFullScreen(),
    focused: !!win?.isFocused()
  }));

  /* Auth ------------------------------------------------------------- */
  handle('auth:sign-in', (payload) => auth.signIn(payload));
  handle('auth:sign-up', (payload) => auth.signUp(payload));
  handle('auth:sign-in-offline', () => auth.signInOffline());
  handle('auth:session', () => auth.session());
  handle('auth:sign-out', () => auth.signOut());
  handle('auth:update-profile', (userId, patch) => auth.updateProfile(userId, patch));
  handle('auth:change-password', (userId, payload) => auth.changePassword(userId, payload));
  handle('auth:strength', (password) => auth.passwordStrength(password));

  /* Settings --------------------------------------------------------- */
  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => settings.set(patch));
  handle('settings:reset', () => {
    const data = settings.reset();
    settings.set('installDir', path.join(app.getPath('documents'), 'BlackNight Studios', 'Games'));
    return data;
  });

  /* Catalog + library ------------------------------------------------ */
  handle('catalog:get', () => catalog);
  handle('library:list', () => library.list());
  handle('library:stats', () => library.stats());
  handle('library:acquire', (id) => library.acquire(id));
  handle('library:install', (id) => library.install(id));
  handle('library:uninstall', (id, opts) => library.uninstall(id, opts));
  handle('library:verify', (id) => library.verify(id));
  handle('library:launch', (id) => library.launch(id));
  handle('library:end-session', (id) => library.endSession(id));
  handle('library:favorite', (id, value) => library.setFavorite(id, value));
  handle('library:launch-options', (id, opts) => library.setLaunchOptions(id, opts));

  /* Downloads -------------------------------------------------------- */
  handle('downloads:list', () => downloader.list());
  handle('downloads:pause', (id) => downloader.pause(id));
  handle('downloads:resume', (id) => downloader.resume(id));
  handle('downloads:cancel', (id) => downloader.cancel(id));
  handle('downloads:prioritise', (id) => downloader.prioritise(id));
  handle('downloads:clear-finished', () => downloader.clearFinished());

  /* Shell / system --------------------------------------------------- */
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataDir,
    isPackaged: app.isPackaged
  }));

  handle('app:choose-directory', async (current) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose install location',
      defaultPath: current || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('app:choose-executable', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select game executable',
      filters: [{ name: 'Executables', extensions: ['exe', 'bat', 'lnk'] }],
      properties: ['openFile']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('app:open-path', (target) => (target ? shell.openPath(target) : null));
  handle('app:show-item', (target) => (target ? shell.showItemInFolder(target) : null));

  handle('app:open-external', (url) => {
    if (/^https:\/\//i.test(String(url))) return shell.openExternal(url);
    return null; // http and custom schemes are refused on purpose
  });

  handle('app:set-launch-on-startup', (enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: enabled && settings.get('startMinimized') ? ['--minimized'] : [] });
    return app.getLoginItemSettings().openAtLogin;
  });

  handle('app:relaunch', () => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  });

  handle('app:quit', () => { quitting = true; app.quit(); });

  // The renderer rasterises the BlackNight mark from SVG and hands it back, so
  // the tray and taskbar icons come from the same source as the in-app logo.
  handle('app:register-icon', (dataUrl) => {
    try {
      const image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) return false;
      win?.setIcon(image);
      if (settings.get('minimizeToTray')) buildTray(image);
      return true;
    } catch {
      return false;
    }
  });

  handle('app:set-progress', (value) => {
    win?.setProgressBar(typeof value === 'number' && value >= 0 && value < 1 ? value : -1);
  });
}

/* -------------------------------------------------------------------- */
/* Lifecycle                                                             */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    bootServices();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    downloader?.shutdown();
  });
}
