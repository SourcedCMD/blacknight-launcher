'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const { createSettings } = require('./services/settings');
const { Auth } = require('./services/auth');
const { Downloader } = require('./services/downloader');
const { Library } = require('./services/library');
const { Updates } = require('./services/updates');
const { Hardware } = require('./services/hardware');
const { Presence } = require('./services/presence');
const { check: checkRequirements } = require('./services/requirements');
const { Logger } = require('./services/logger');
const { Catalog } = require('./services/catalog');
const { Peers } = require('./services/peers');
const { Achievements } = require('./services/achievements');

const PROTOCOL = 'blacknight';

const isDev = process.argv.includes('--dev');

// A dev run keeps its own accounts, library and download queue, so testing
// never writes over the state of an installed copy.
if (isDev) app.setPath('userData', `${app.getPath('userData')} (dev)`);

let win = null;
let tray = null;
let settings, auth, downloader, library, catalog, catalogStore, updates, hardware, presence, peers, achievements, log;
let quitting = false;
let dataDir;

/* -------------------------------------------------------------------- */
/* Services                                                              */

/**
 * Tells the player when something they wishlisted actually comes out.
 *
 * The wishlist was a list that never did anything. A catalog refresh is the
 * moment a status changes, so it is the moment worth speaking up.
 */
function announceWishlistReleases(before, after) {
  try {
    if (!before?.games?.length) return;
    const wasReleased = new Set(before.games.filter((g) => g.status === 'released').map((g) => g.id));
    const entries = library.store.get('entries');

    for (const game of after.games) {
      if (game.status !== 'released' || wasReleased.has(game.id)) continue;
      const entry = entries[game.id];
      if (!entry?.favorite) continue;

      log.info('wishlist', `${game.title} is out`);
      notify('Out now', `${game.title} is available to install.`, { route: 'store' });
    }
  } catch (err) {
    log?.warn('wishlist', 'Could not check for releases', err);
  }
}

/**
 * Announces anything newly earned. Achievements are evaluated after a session
 * ends and shortly after startup, both of which are quiet moments.
 */
function announceAchievements() {
  try {
    for (const earned of achievements.evaluate()) {
      log.info('achievements', `Earned ${earned.name}`);
      notify(`Achievement: ${earned.name}`, earned.description, { route: 'profile' });
      if (win && !win.isDestroyed()) win.webContents.send('achievement', earned);
    }
  } catch (err) {
    log?.warn('achievements', 'Could not evaluate achievements', err);
  }
}

/**
 * Verifies one installed title at a time while nothing is playing.
 *
 * Bit-rot is silent until someone hits it mid-session; a slow rolling check
 * finds it earlier without ever being something anyone waits on.
 */
function scheduleBackgroundVerify() {
  const SIX_HOURS = 6 * 3600 * 1000;
  const tick = () => {
    try {
      const result = library.verifyOldest();
      if (result.ok && result.result && !result.result.ok) {
        log.warn('verify', `${result.gameId} failed a background check`, result.result.error);
        notify('A game needs repairing', `${result.gameId} failed its file check.`, { route: 'games' });
      }
    } catch (err) {
      log?.warn('verify', 'Background verification failed', err);
    }
  };

  // First pass well after startup, so it never competes with the boot.
  const first = setTimeout(tick, 5 * 60 * 1000);
  const repeat = setInterval(tick, SIX_HOURS);
  first.unref?.();
  repeat.unref?.();
}

/**
 * A desktop notification, but only when the launcher is not already in front
 * of the user - two notices for one event is worse than none.
 */
function notify(title, body, { route = null } = {}) {
  try {
    if (!Notification.isSupported()) return;
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;

    const note = new Notification({ title, body, silent: false });
    note.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (!win.isVisible()) win.show();
      win.focus();
      if (route) win.webContents.send('nav:go', route);
    });
    note.show();
  } catch (err) {
    log?.warn('notify', 'Could not show a notification', err);
  }
}

/**
 * Last-resort handlers.
 *
 * An unhandled throw in the main process would otherwise take the launcher
 * down with nothing written anywhere. The process still exits on a genuine
 * crash - this only makes sure there is a record of why.
 */
function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    log?.error('main', 'Uncaught exception', err);
    if (app.isReady() && !quitting) {
      dialog.showErrorBox(
        'BlackNight Launcher hit a problem',
        `${err.message}

Details were written to the log file, which you can open from Settings > Privacy.`
      );
    }
  });

  process.on('unhandledRejection', (reason) => {
    log?.error('main', 'Unhandled promise rejection', reason);
  });
}

/**
 * Where games install by default.
 *
 * Deliberately not Documents: Windows redirects that into OneDrive on any
 * machine with Known Folder Move enabled - the default on most Windows 11
 * installs - which would sync every multi-gigabyte game to the user's cloud
 * storage and burn through their quota. LOCALAPPDATA is never redirected.
 */
function defaultInstallDir() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
      : app.getPath('home');
  return path.join(base, 'BlackNight Studios', 'Games');
}

/**
 * Moves the install folder off a cloud-synced path.
 *
 * Builds before 1.0.0 defaulted to Documents, which OneDrive usually owns.
 * Re-pointing the setting is only safe while nothing is installed there - if a
 * previous version already put games on that path, leave it be and let the
 * user move them deliberately rather than silently orphaning an install.
 */
function migrateInstallDir() {
  const current = settings.get('installDir');
  if (!current) return;

  const documents = app.getPath('documents');
  const synced = current.startsWith(documents) || /[\\/](OneDrive|Dropbox|Google Drive)[\\/]/i.test(current);
  if (!synced) return;

  const installed = fs.existsSync(current) && fs.readdirSync(current).length > 0;
  if (installed) return;

  settings.set('installDir', defaultInstallDir());
}

function bootServices() {
  dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  settings = createSettings(dataDir);

  log = new Logger(dataDir, {
    level: isDev ? 'debug' : 'info',
    includeSystemInfo: settings.get('diagnosticLogs') !== false
  });
  log.header(app);
  installCrashHandlers();

  // Remote if configured and reachable, then the last good fetch, then the
  // copy that shipped. Always correct offline, current whenever it can be.
  catalogStore = new Catalog(dataDir, path.join(__dirname, 'data', 'catalog.json'), settings, log);
  catalog = catalogStore.data;
  log.info('catalog', `Loaded ${catalog.games.length} titles from the ${catalogStore.source} catalog`);
  if (!settings.get('installDir')) settings.set('installDir', defaultInstallDir());

  migrateInstallDir();

  auth = new Auth(dataDir);
  downloader = new Downloader(dataDir, settings);
  library = new Library(dataDir, catalog, downloader, settings, { allowSimulated: !app.isPackaged });
  updates = new Updates({ packaged: app.isPackaged, autoCheck: settings.get('autoCheckUpdates') !== false });
  hardware = new Hardware(app, settings);
  presence = new Presence({ enabled: settings.get('richPresence') !== false });

  achievements = new Achievements(dataDir, library);
  peers = new Peers(settings, log, { library });
  // The library asks before every install whether a machine on this network
  // already has the build.
  library.findPeer = (gameId, version) => peers.find(gameId, version)?.url || null;

  // Rich presence follows the play session the library already tracks. The
  // tagline is the interesting half - "Playing Eclipse Protocol" says less
  // than what the game is actually about.
  library.onSessionChange = (gameId, running) => {
    const game = catalog.games.find((g) => g.id === gameId);
    if (!running) {
      presence.clear();
      // A finished session is exactly when a new achievement becomes true.
      setTimeout(() => announceAchievements(), 1200);
      return;
    }
    presence.setActivity({
      title: game?.title || 'a BlackNight title',
      details: game?.tagline || undefined,
      startedAt: Date.now()
    });
  };
  presence.connect();
  if (settings.get('lanSharing')) peers.start();

  const forward = (channel) => (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  updates.on('state', forward('updates:state'));
  // Data usage is recorded from the engine rather than guessed at in the UI.
  downloader.on('transferred', ({ bytes, source }) => library.recordTransfer(bytes, { source }));
  downloader.on('reused', ({ bytes }) => library.recordTransfer(bytes, { source: 'reused' }));

  downloader.on('progress', forward('downloads:progress'));
  downloader.on('changed', forward('downloads:changed'));
  downloader.on('completed', (item) => {
    forward('downloads:completed')(item);
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
    log.info('downloads', `${item.kind === 'update' ? 'Updated' : 'Installed'} ${item.title}`);
    // minimizeToTray is the default, so the common case for a finished
    // download is a hidden window - where an in-app toast reaches nobody.
    notify(
      item.kind === 'update' ? 'Update installed' : 'Install complete',
      `${item.title} is ready to play.`,
      { route: 'downloads' }
    );
  });
}

/* -------------------------------------------------------------------- */
/* Window                                                                */

/**
 * Last window position, but only if it still lands on a connected display -
 * otherwise a window saved on a monitor that has since been unplugged would
 * reopen off-screen.
 */
function restoreBounds() {
  const saved = settings.get('windowBounds');
  if (!saved || typeof saved.x !== 'number') return null;
  const visible = screen.getAllDisplays().some((display) => {
    const a = display.workArea;
    return (
      saved.x < a.x + a.width &&
      saved.x + saved.width > a.x &&
      saved.y < a.y + a.height &&
      saved.y + saved.height > a.y
    );
  });
  return visible ? saved : null;
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const saved = restoreBounds();

  win = new BrowserWindow({
    width: saved?.width || Math.min(1440, Math.round(sw * 0.86)),
    height: saved?.height || Math.min(900, Math.round(sh * 0.88)),
    ...(saved ? { x: saved.x, y: saved.y } : {}),
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
    if (settings.get('windowMaximized')) win.maximize();
    if (settings.get('startMinimized')) win.minimize();
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Only the restored geometry is worth saving - storing a maximised or
  // minimised frame would reopen the window at screen size with no way back.
  let saveTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      settings.set('windowMaximized', win.isMaximized());
      if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
        settings.set('windowBounds', win.getNormalBounds());
      }
    }, 400);
  };
  for (const evt of ['resize', 'move', 'maximize', 'unmaximize']) win.on(evt, rememberBounds);

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
    clearTimeout(saveTimer);
    if (!win.isDestroyed()) {
      settings.set('windowMaximized', win.isMaximized());
      if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
        settings.set('windowBounds', win.getNormalBounds());
      }
    }
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
    settings.set('installDir', defaultInstallDir());
    return data;
  });

  /* Catalog + library ------------------------------------------------ */
  handle('catalog:get', () => catalog);
  handle('catalog:refresh', async () => {
    const result = await catalogStore.refresh();
    if (result.ok) {
      // The library reads the catalog by reference, so both have to be
      // repointed at the new document rather than only this module's copy.
      catalog = catalogStore.data;
      library.catalog = catalog;
      if (win && !win.isDestroyed()) win.webContents.send('catalog:changed', catalog);
    }
    return result;
  });
  handle('library:list', () => library.list());
  handle('library:stats', () => library.stats());
  handle('library:reclaimable', () => library.reclaimable());
  handle('library:acquire', (id) => library.acquire(id));
  handle('library:install', (id, options) => library.install(id, options || {}));
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
  /* Channels, rollback and recovery -------------------------------------- */
  handle('library:channels', (id) => library.channelsFor(id));
  handle('library:channel', (id) => library.channelOf(id));
  handle('library:set-channel', (id, channelId) =>
    library.setChannel(id, channelId, { tier: auth.session()?.user?.tier || 'standard' })
  );
  handle('library:rollback-available', (id) => library.rollbackAvailable(id));
  handle('library:rollback', (id) => library.rollback(id));
  handle('library:scan', () => library.scanForInstalls());
  handle('library:adopt', (id) => library.adoptInstall(id));
  handle('library:data-usage', () => library.dataUsage());

  /* Achievements --------------------------------------------------------- */
  handle('achievements:list', () => achievements.list());
  handle('achievements:progress', () => achievements.progress());
  handle('achievements:evaluate', () => achievements.evaluate());

  /* Journal, habits and the year in review ------------------------------ */
  handle('library:journal', (gameId, options) => library.journal(gameId, options || {}));
  handle('library:journal-note', (id, note) => library.setJournalNote(id, note));
  handle('library:insights', (gameId) => library.sessionInsights(gameId));
  handle('library:year-in-review', (year) => library.yearInReview(year));

  /* LAN sharing --------------------------------------------------------- */
  handle('peers:list', () => peers.list());
  handle('peers:status', () => ({ enabled: peers.enabled, port: peers.port, peers: peers.list().length }));
  handle('peers:set-enabled', (on) => peers.setEnabled(on));

  /* The tray icon carries download progress ----------------------------- */
  handle('app:set-tray-icon', (dataUrl) => {
    try {
      if (!tray) return false;
      tray.setImage(nativeImage.createFromDataURL(dataUrl));
      return true;
    } catch (err) {
      log.debug('tray', 'Could not update the tray icon', err);
      return false;
    }
  });

  /* Year-in-review poster ----------------------------------------------- */
  handle('app:save-poster', async (dataUrl, suggested) => {
    try {
      const picked = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('pictures'), suggested || 'BlackNight.png'),
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(picked.filePath, Buffer.from(base64, 'base64'));
      return { ok: true, path: picked.filePath };
    } catch (err) {
      log.warn('review', 'Could not save the poster', err);
      return { ok: false, error: err.message };
    }
  });

  /* Diagnostics -------------------------------------------------------- */
  handle('log:write', (level, scope, message, detail) => {
    // The renderer reports its own failures through here, so a broken view
    // leaves the same trail a broken service does.
    log.log(['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info', scope || 'renderer', message, detail);
    return true;
  });
  handle('log:location', () => log.location());
  handle('log:open', () => shell.openPath(log.location().dir));

  /* Library folders ---------------------------------------------------- */
  handle('library:folders', () => library.folderStats());
  handle('library:add-folder', async () => {
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    return library.addLibraryFolder(picked.filePaths[0]);
  });
  handle('library:remove-folder', (dir) => library.removeLibraryFolder(dir));

  /* Game updates ------------------------------------------------------- */
  handle('library:outdated', () => library.outdated());
  handle('library:update-all', () => library.updateAll());

  /* Saves --------------------------------------------------------------- */
  handle('library:save-backups', (id) => library.saveBackups(id));
  handle('library:backup-saves', (id) => library.backupSaves(id, { keep: settings.get('saveBackupsKept') || 5 }));
  handle('library:restore-save', (id, snapshot) => library.restoreSave(id, snapshot));

  /* Hardware + requirements ------------------------------------------ */
  handle('hardware:probe', () => hardware.probe());
  handle('hardware:check', async (gameId) => {
    const game = catalog.games.find((g) => g.id === gameId);
    if (!game?.requirements) return { level: 'unknown', minimum: null, recommended: null };
    return checkRequirements(game.requirements, await hardware.probe());
  });

  /* Rich presence ----------------------------------------------------- */
  handle('presence:status', () => presence.status());
  handle('presence:set-enabled', (enabled) => {
    settings.set('richPresence', !!enabled);
    return presence.setEnabled(enabled);
  });

  /* Launcher updates ------------------------------------------------- */
  handle('updates:get', () => updates.get());
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:install', () => updates.install());

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
      defaultPath: current || defaultInstallDir(),
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

/**
 * Command line, for scripting and for the studio's own QA.
 *
 *   BlackNightLauncher.exe --install eclipse-protocol
 *   BlackNightLauncher.exe --launch eclipse-protocol
 *   BlackNightLauncher.exe --list
 *
 * Reuses the deep-link routing rather than inventing a second way in, and is
 * deliberately limited to things that are safe to trigger without a window:
 * nothing here can buy, uninstall or sign anything out.
 */
function parseCli(argv) {
  const take = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] || true : null;
  };

  if (argv.includes('--list')) return { type: 'list' };
  const install = take('--install');
  if (install && install !== true) return { type: 'install', gameId: install };
  const launch = take('--launch');
  if (launch && launch !== true) return { type: 'launch', gameId: launch };
  return null;
}

/**
 * Runs a command that does not need the window, and reports whether the
 * process should simply exit afterwards.
 */
function runCli(command) {
  if (!command) return false;

  if (command.type === 'list') {
    for (const game of library.list()) {
      const state = game.installed ? 'installed' : game.owned ? 'owned' : game.status;
      process.stdout.write(`${game.id.padEnd(20)} ${state.padEnd(14)} ${game.title}\n`);
    }
    return true;
  }

  if (command.type === 'install') {
    const result = library.install(command.gameId);
    process.stdout.write(
      result.ok
        ? `queued ${command.gameId}\n`
        : `could not install ${command.gameId}: ${result.error}\n`
    );
    // The download needs the process to stay alive, so the window still opens.
    return false;
  }

  if (command.type === 'launch') {
    const result = library.launch(command.gameId);
    process.stdout.write(
      result.ok ? `launched ${command.gameId}\n` : `could not launch ${command.gameId}: ${result.error}\n`
    );
    return true;
  }

  return false;
}

/**
 * Deep links: blacknight://game/eclipse-protocol, blacknight://store, ...
 *
 * Lets the studio site and a Discord message open straight into the launcher
 * instead of asking people to go and find the title themselves.
 */
function registerProtocol() {
  if (process.defaultApp) {
    // An unpackaged run has to register the electron binary plus this script,
    // otherwise Windows points the protocol at electron.exe with no project.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** Turns a blacknight:// URL into something the renderer understands. */
function parseDeepLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL}:`) return null;
    // blacknight://game/<id> parses host="game", pathname="/<id>".
    const action = parsed.hostname || '';
    const rest = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '');

    if (action === 'game' && rest) return { type: 'game', gameId: rest };
    if (['games', 'store', 'plus', 'downloads', 'settings', 'profile'].includes(action)) {
      return { type: 'route', route: action };
    }
    return null;
  } catch {
    return null;
  }
}

function handleDeepLink(url) {
  const target = parseDeepLink(url);
  if (!target) return;
  log?.info('deeplink', `Opening ${url}`);

  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.send('deeplink', target);
  } else {
    pendingDeepLink = target;
  }
}

/** Windows passes the URL as an argv entry rather than an event. */
const deepLinkFromArgv = (argv) => (argv || []).find((arg) => arg.startsWith(`${PROTOCOL}://`));

let pendingDeepLink = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
    const url = deepLinkFromArgv(argv);
    if (url) handleDeepLink(url);
  });

  // macOS delivers the URL as an event instead.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(() => {
    bootServices();

    // A command that finishes on its own never needs a window.
    const command = parseCli(process.argv.slice(1));
    if (runCli(command)) {
      app.quit();
      return;
    }

    registerIpc();
    registerProtocol();
    createWindow();
    updates.start();
    catalogStore.refresh().then((result) => {
      if (!result.ok) return;
      const previous = catalog;
      catalog = catalogStore.data;
      library.catalog = catalog;
      announceWishlistReleases(previous, catalog);
      if (win && !win.isDestroyed()) win.webContents.send('catalog:changed', catalog);
    });

    scheduleBackgroundVerify();
    // Achievements are re-checked once the library has settled.
    setTimeout(() => announceAchievements(), 8000);

    // A link that started the launcher waits for the window to be ready.
    const startupLink = deepLinkFromArgv(process.argv);
    if (startupLink) {
      pendingDeepLink = parseDeepLink(startupLink);
      log.info('deeplink', `Started from ${startupLink}`, pendingDeepLink || 'unrecognised link');
    }
    if (pendingDeepLink) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('deeplink', pendingDeepLink);
        log.info('deeplink', 'Delivered to the renderer', pendingDeepLink);
        pendingDeepLink = null;
      });
    }

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
    presence?.disconnect();
    peers?.stop();
  });
}
