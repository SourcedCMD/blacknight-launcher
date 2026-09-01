'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu, screen, Notification, globalShortcut, clipboard } = require('electron');
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
const { Overlay } = require('./services/overlay');
const { Handoff } = require('./services/handoff');

const PROTOCOL = 'blacknight';

const isDev = process.argv.includes('--dev');

// A dev run keeps its own accounts, library and download queue, so testing
// never writes over the state of an installed copy.
if (isDev) app.setPath('userData', `${app.getPath('userData')} (dev)`);

// The smoke run gets a throwaway profile so it never touches a real library,
// and so every run starts from identical state.
if (process.env.BN_USER_DATA) app.setPath('userData', process.env.BN_USER_DATA);

let win = null;
let tray = null;
let settings, auth, downloader, library, catalog, catalogStore, updates, hardware, presence, peers, achievements, overlay, handoff, log;
let appIconImage = null;
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
/**
 * Reports a crash, if and only if the user has turned it on and an endpoint is
 * configured. Used by the process handlers and by renderer errors alike.
 */
function reportCrash(err, extra) {
  return log?.report(err, {
    endpoint: settings?.get('crashReportUrl'),
    enabled: settings?.get('sendCrashReports') === true,
    version: app.getVersion(),
    extra
  });
}

function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    log?.error('main', 'Uncaught exception', err);
    reportCrash(err, { scope: 'main' });
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
    reportCrash(reason, { scope: 'main-rejection' });
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
  // Attached rather than constructor-injected so the Library keeps working
  // untouched in tests, where nothing should be beating at anything.
  library.presenceCount = new (require('./services/presence-count').PresenceCount)(settings, log);
  updates = new Updates({
    packaged: app.isPackaged,
    autoCheck: settings.get('autoCheckUpdates') !== false,
    betaChannel: settings.get('betaChannel') === true
  });
  hardware = new Hardware(app, settings);
  presence = new Presence({ enabled: settings.get('richPresence') !== false });

  achievements = new Achievements(dataDir, library);
  overlay = new Overlay(settings, log);
  handoff = new Handoff(dataDir, settings, library, log);
  peers = new Peers(settings, log, { library });
  // The library asks before every install whether a machine on this network
  // already has the build.
  library.findPeer = (gameId, version) => peers.find(gameId, version)?.url || null;

  // Rich presence follows the play session the library already tracks. The
  // tagline is the interesting half - "Playing Eclipse Protocol" says less
  // than what the game is actually about.
  library.onSessionChange = (gameId, running) => {
    const game = catalog.games.find((g) => g.id === gameId);
    overlay.setPlaying(running ? game : null, Date.now());
    peers.setPlaying(running ? game : null, Date.now());

    if (!running) {
      presence.clear();
      // A finished session is exactly when a new achievement becomes true.
      setTimeout(() => announceAchievements(), 1200);
      return;
    }
    presence.setActivity({
      title: game?.title || 'a BlackNight title',
      details: game?.tagline || undefined,
      startedAt: Date.now(),
      // Only multiplayer titles advertise a joinable party.
      party: game?.tags?.some((t) => /multiplayer|co-op|pvp/i.test(t))
        ? { id: `bn-${gameId}-${Date.now().toString(36)}`, size: 1, max: 4, joinable: false }
        : null,
      link: `https://github.com/SourcedCMD/blacknight-launcher`
    });
  };
  presence.connect();
  if (settings.get('lanSharing')) peers.start();
  if (settings.get('overlayEnabled')) overlay.start();

  const forward = (channel) => (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  updates.on('state', forward('updates:state'));
  // Data usage is recorded from the engine rather than guessed at in the UI.
  downloader.on('transferred', ({ bytes, source }) => library.recordTransfer(bytes, { source }));
  downloader.on('reused', ({ bytes }) => library.recordTransfer(bytes, { source: 'reused' }));

  downloader.on('progress', forward('downloads:progress'));
  downloader.on('changed', () => refreshThumbar());
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
/* Windows shell integration                                             */

/**
 * Recent games on the taskbar icon's right-click menu.
 *
 * The library already keeps a recent list; this is the same information where
 * Windows users expect to find it, so a game can be started without the
 * launcher window ever being opened.
 */
function refreshJumpList() {
  if (process.platform !== 'win32') return;
  try {
    const recent = (library.store.get('recent') || [])
      .map((id) => library.list().find((g) => g.id === id))
      .filter((game) => game && game.installed)
      .slice(0, 6);

    if (!recent.length) {
      app.setJumpList(null);
      return;
    }

    app.setJumpList([
      {
        type: 'custom',
        name: 'Recently played',
        items: recent.map((game) => ({
          type: 'task',
          title: game.title,
          description: `Play ${game.title}`,
          program: process.execPath,
          args: `--launch ${game.id}`,
          iconPath: process.execPath,
          iconIndex: 0
        }))
      }
    ]);
  } catch (err) {
    log?.debug('shell', 'Could not set the jump list', err);
  }
}

/**
 * Pause and resume on the taskbar thumbnail preview.
 *
 * Hovering the taskbar icon during a download should let you deal with it
 * there, rather than restoring a window to press one button.
 */
function refreshThumbar() {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  try {
    const active = downloader.list().filter((d) => ['downloading', 'queued', 'paused'].includes(d.status));
    if (!active.length) {
      win.setThumbarButtons([]);
      return;
    }

    if (!appIconImage) return;

    const paused = active.every((d) => d.status === 'paused');
    win.setThumbarButtons([
      {
        tooltip: paused ? 'Resume downloads' : 'Pause downloads',
        icon: appIconImage,
        click: () => {
          for (const item of active) {
            if (paused) downloader.resume(item.id);
            else downloader.pause(item.id);
          }
        }
      }
    ]);
  } catch (err) {
    log?.debug('shell', 'Could not set thumbnail buttons', err);
  }
}

/**
 * A hotkey that reaches the launcher from inside a game or any other window.
 *
 * The command palette already is a quick launcher; it just could not be
 * reached without alt-tabbing first. Registration can fail when another
 * application owns the combination, which is reported rather than swallowed.
 */
function registerGlobalHotkey() {
  const accelerator = settings.get('globalHotkey') || 'Control+Shift+Space';
  try {
    globalShortcut.unregisterAll();
    if (settings.get('globalHotkeyEnabled') === false) return { ok: true, enabled: false };

    const ok = globalShortcut.register(accelerator, () => {
      if (!win || win.isDestroyed()) return;
      if (!win.isVisible()) win.show();
      win.focus();
      win.webContents.send('quick-launch');
    });

    if (!ok) log?.warn('shell', `Another application already owns ${accelerator}`);
    return { ok, enabled: true, accelerator };
  } catch (err) {
    log?.warn('shell', 'Could not register the global hotkey', err);
    return { ok: false, error: err.message };
  }
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
    // Mica tints the window with the desktop behind it - the material Explorer
    // and Settings use. It is what stops a frameless dark window reading as
    // "an Electron app" rather than a Windows one. Ignored below Windows 11,
    // where the solid colour below is what shows.
    backgroundMaterial: settings.get('windowMaterial') || 'mica',
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

  const smoke = process.argv.includes('--smoke-test') || process.env.BN_SMOKE === '1';
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Told over IPC rather than a query string: loadFile's query does not survive
  // to `location.search` here, and a message the renderer already knows how to
  // receive is one fewer mechanism than a URL nobody else reads.
  if (smoke) {
    win.webContents.once('did-finish-load', () => {
      // A beat after load so boot() has finished wiring everything up.
      setTimeout(() => win.webContents.send('smoke:run'), 2500);
    });
  }

  // Console output from the renderer has to be forwarded, or the smoke run's
  // verdict never reaches the process watching for it.


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

  /* Handoff -------------------------------------------------------------- */
  handle('handoff:start', () => handoff.start());
  handle('handoff:stop', () => {
    handoff.stop();
    return { ok: true };
  });
  handle('handoff:status', () => handoff.status());
  handle('handoff:receive', async (details) => {
    try {
      return await handoff.receive(details);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* Streaming ------------------------------------------------------------ */
  handle('overlay:status', () => ({ enabled: overlay.enabled, url: overlay.url() }));
  handle('overlay:set-enabled', (on) => overlay.setEnabled(on));

  /* Windows shell -------------------------------------------------------- */
  handle('shell:hotkey', () => registerGlobalHotkey());
  handle('shell:refresh-jumplist', () => {
    refreshJumpList();
    return true;
  });

  /* Achievements --------------------------------------------------------- */
  handle('achievements:list', () => achievements.list());
  handle('achievements:progress', () => achievements.progress());
  handle('achievements:evaluate', () => achievements.evaluate());

  /* Journal, habits and the year in review ------------------------------ */
  handle('library:journal', (gameId, options) => library.journal(gameId, options || {}));
  handle('library:journal-note', (id, note) => library.setJournalNote(id, note));
  handle('library:insights', (gameId) => library.sessionInsights(gameId));
  handle('library:year-in-review', (year) => library.yearInReview(year));
  /**
   * Games other launchers installed.
   *
   * Gated on the setting rather than trusting the renderer to ask only when
   * it should: this reads directories outside anything the launcher owns, and
   * the check belongs on the side that does the reading.
   */
  const remoteAccounts = new (require('./services/accounts-remote').RemoteAccounts)(settings, log);
  handle('account:passkey-challenge', (userId) => remoteAccounts.passkeyChallenge(userId));
  handle('account:passkey-register', (payload) => remoteAccounts.passkeyRegister(payload));

  handle('library:foreign', () => {
    if (settings.get('detectOtherLaunchers') !== true) {
      return { games: [], errors: [], scannedAt: Date.now(), reason: 'not-enabled' };
    }
    return require('./services/foreign').scan();
  });

  handle('library:play-map', (options) => library.playMap(options));
  handle('library:ghost', (gameId) => library.ghost(gameId));

  /* LAN sharing --------------------------------------------------------- */
  handle('peers:list', () => peers.list());
  handle('peers:now-playing', () => peers.nowPlaying());
  handle('peers:read-range', (id, version, offset, length) => peers.readRange(id, version, offset, length));
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

  /**
   * Writes a text file the user picked a location for.
   *
   * The dialog is the authorisation: nothing is written anywhere the user did
   * not choose, and the extension is fixed so this cannot be talked into
   * dropping a .bat or a .ps1 somewhere convenient.
   */
  /** The same as save-text, fixed to .json. */
  handle('app:save-json', async (text, suggested) => {
    try {
      const safe = String(suggested || 'blacknight.json').replace(/[^\w.-]/g, '_');
      const picked = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('documents'), safe.endsWith('.json') ? safe : `${safe}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      if (path.extname(picked.filePath).toLowerCase() !== '.json') {
        return { ok: false, error: 'That needs to be saved as a .json file.' };
      }
      fs.writeFileSync(picked.filePath, String(text), 'utf8');
      return { ok: true, path: picked.filePath };
    } catch (err) {
      log.warn('transfer', 'Could not save', err);
      return { ok: false, error: err.message };
    }
  });

  /**
   * Reads one JSON file the user picked.
   *
   * The dialog is the authorisation, and the size cap is there because this
   * hands the contents to the renderer: a settings export is a few kilobytes,
   * and anything claiming to be one that is megabytes long is not one.
   */
  handle('app:open-json', async () => {
    try {
      const picked = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (picked.canceled || !picked.filePaths?.length) return { ok: false, cancelled: true };

      const file = picked.filePaths[0];
      const { size } = fs.statSync(file);
      if (size > 512 * 1024) return { ok: false, error: 'That file is far too large to be a settings export.' };

      return { ok: true, text: fs.readFileSync(file, 'utf8'), path: file };
    } catch (err) {
      log.warn('transfer', 'Could not read', err);
      return { ok: false, error: err.message };
    }
  });

  /**
   * The changelog that shipped with this build.
   *
   * Read from disk rather than compiled into the renderer so there is one copy
   * of it, and a release cannot ship a stale in-app copy of its own notes.
   */
  /**
   * The smoke run reporting a line.
   *
   * Straight to stdout, where the process that started the app is watching.
   * Reported over IPC rather than scraped from console output: the console
   * event's shape has changed between Electron versions, and a test harness
   * that silently stops reporting is worse than no harness.
   */
  handle('app:smoke-report', (line) => {
    process.stdout.write(`SMOKE: ${String(line).slice(0, 500)}
`);
    return { ok: true };
  });

  handle('app:changelog', () => {
    for (const candidate of [
      path.join(__dirname, '..', 'CHANGELOG.md'),
      path.join(process.resourcesPath || '', 'CHANGELOG.md')
    ]) {
      try {
        return { ok: true, text: fs.readFileSync(candidate, 'utf8').slice(0, 200000) };
      } catch { /* try the next */ }
    }
    return { ok: false, error: 'not-found' };
  });

  handle('app:save-text', async (text, suggested) => {
    try {
      const safe = String(suggested || 'blacknight.html').replace(/[^\w.-]/g, '_');
      const picked = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('documents'), safe.endsWith('.html') ? safe : `${safe}.html`),
        filters: [{ name: 'Web page', extensions: ['html'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      if (path.extname(picked.filePath).toLowerCase() !== '.html') {
        return { ok: false, error: 'That needs to be saved as an .html file.' };
      }
      fs.writeFileSync(picked.filePath, String(text), 'utf8');
      return { ok: true, path: picked.filePath };
    } catch (err) {
      log.warn('share', 'Could not save the page', err);
      return { ok: false, error: err.message };
    }
  });

  handle('app:save-video', async (dataUrl, suggested) => {
    try {
      const picked = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('videos'), suggested || 'BlackNight.webm'),
        filters: [{ name: 'WebM video', extensions: ['webm'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      const base64 = String(dataUrl).replace(/^data:video\/webm;base64,/, '');
      fs.writeFileSync(picked.filePath, Buffer.from(base64, 'base64'));
      return { ok: true, path: picked.filePath };
    } catch (err) {
      log.warn('reel', 'Could not save the reel', err);
      return { ok: false, error: err.message };
    }
  });

  /* Diagnostics -------------------------------------------------------- */
  handle('log:write', (level, scope, message, detail) => {
    // The renderer reports its own failures through here, so a broken view
    // leaves the same trail a broken service does.
    const chosen = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    log.log(chosen, scope || 'renderer', message, detail);
    if (chosen === 'error') reportCrash({ message, stack: detail?.stack }, { scope: scope || 'renderer' });
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

  handle('app:copy', (text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  handle('app:open-path', (target) => (target ? shell.openPath(target) : null));
  handle('app:show-item', (target) => (target ? shell.showItemInFolder(target) : null));

  handle('app:open-external', (url) => {
    if (/^https:\/\//i.test(String(url))) return shell.openExternal(url);
    return null; // http and custom schemes are refused on purpose
  });

  /**
   * Hands a game back to the launcher that owns it.
   *
   * The whitelist lives in the foreign scanner so it can be tested on its own.
   */
  handle('app:open-launcher', (url) => {
    const target = String(url || '');
    if (!require('./services/foreign').isLauncherUrl(target)) {
      log.warn('shell', `Refused to open an unrecognised launcher URL: ${target.slice(0, 80)}`);
      return { ok: false, error: 'That is not a launcher URL this app will open.' };
    }
    shell.openExternal(target);
    return { ok: true };
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
      // Kept so the thumbnail toolbar has something to draw; Windows refuses
      // an empty image and silently drops the whole button set.
      appIconImage = image;
      win?.setIcon(image);
      refreshThumbar();
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

    /**
     * Actions, as opposed to navigation.
     *
     * A link that installs or launches something is a link that does work on
     * the machine, so these carry an intent the renderer has to confirm before
     * acting. Parsing it here and confirming there keeps the decision in the
     * one place that can actually show somebody what they are agreeing to.
     */
    if ((action === 'install' || action === 'play') && rest) {
      return { type: 'intent', intent: action, gameId: rest };
    }
    if (action === 'handoff') {
      return {
        type: 'handoff',
        host: parsed.searchParams.get('host'),
        port: Number(parsed.searchParams.get('port')),
        code: parsed.searchParams.get('code')
      };
    }
    if (['games', 'store', 'plus', 'downloads', 'settings', 'profile', 'journal', 'achievements'].includes(action)) {
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
    refreshJumpList();
    refreshThumbar();
    registerGlobalHotkey();
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
    globalShortcut.unregisterAll();
    downloader?.shutdown();
    presence?.disconnect();
    library?.presenceCount?.stopAll();
    peers?.stop();
    overlay?.stop();
    handoff?.stop();
  });
}
