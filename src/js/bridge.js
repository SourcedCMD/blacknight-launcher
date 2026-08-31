/* =========================================================================
   Backend bridge.

   In Electron this is a thin pass-through to `window.blacknight` (the preload
   bridge). In a plain browser - `npm run web` - it swaps in a mock backend
   backed by localStorage so the entire UI, including installs and download
   progress, is fully explorable without packaging the app.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  if (window.blacknight?.isElectron) {
    BN.api = window.blacknight;
    BN.api.mode = 'electron';
    return;
  }

  /* --------------------------------------------------------------------- */
  /* Mock backend (browser preview only)                                    */

  const KEY = 'blacknight.mock.v1';
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  };
  const db = Object.assign(
    { users: [], session: null, settings: {}, entries: {}, downloads: [], recent: [] },
    load()
  );
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch { /* private mode - state simply will not persist */ }
  };

  const SETTINGS_DEFAULTS = {
    accent: 'moonlight', reduceMotion: false, backgroundFx: 'full', uiScale: 100,
    uiSounds: true, soundVolume: 45,
    installDir: 'C:\\Users\\You\\Documents\\BlackNight Studios\\Games',
    concurrentDownloads: 1, bandwidthLimitMbps: 0, pauseOnMetered: true, autoUpdateGames: true,
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, closeAction: 'tray',
    exitOnGameLaunch: false, showPlaytime: true,
    rememberMe: true, richPresence: true, diagnosticLogs: true, backupSaves: true, saveBackupsKept: 5,
    libraryFolders: [], locale: 'auto', onboarded: false
  };
  db.settings = { ...SETTINGS_DEFAULTS, ...db.settings };

  let catalog = { games: [], news: [] };
  const catalogReady = fetch('../electron/data/catalog.json')
    .then((r) => r.json())
    .then((data) => { catalog = data; return data; })
    .catch(() => catalog);

  const listeners = { progress: [], changed: [], completed: [], nav: [], winState: [] };
  const fire = (key, payload) => listeners[key].forEach((fn) => fn(payload));

  /* Auth ---------------------------------------------------------------- */

  // Deliberately weak: the mock never handles a real credential, and its only
  // job is to keep sign-in flows explorable in a browser tab.
  const weakHash = (s) => `mock:${BN.util.hashString(String(s))}`;
  const publicUser = (u) => u && { id: u.id, handle: u.handle, email: u.email, displayName: u.displayName, avatarSeed: u.avatarSeed, tier: u.tier, createdAt: u.createdAt, lastLogin: u.lastLogin, offline: !!u.offline };

  const strength = (p = '') => {
    let s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    return Math.min(s, 5);
  };

  /* Downloads ----------------------------------------------------------- */

  let ticker = null;

  const decorate = (d) => ({
    ...d,
    speedBps: d.status === 'downloading' ? d._speed || 0 : 0,
    etaSeconds: d.status === 'downloading' && d._speed ? Math.round((d.totalBytes - d.receivedBytes) / d._speed) : null,
    progress: d.totalBytes ? d.receivedBytes / d.totalBytes : 0
  });

  const listDownloads = () => db.downloads.map(decorate);

  function pump() {
    const anyActive = db.downloads.some((d) => d.status === 'downloading');
    const limit = Math.max(1, db.settings.concurrentDownloads);
    let running = db.downloads.filter((d) => d.status === 'downloading').length;
    for (const d of db.downloads) {
      if (running >= limit) break;
      if (d.status === 'queued') {
        d.status = 'downloading';
        d._speed = 18e6 + Math.random() * 22e6;
        running++;
      }
    }
    if (!ticker && db.downloads.some((d) => d.status === 'downloading')) {
      ticker = setInterval(tick, 250);
    } else if (ticker && !db.downloads.some((d) => d.status === 'downloading')) {
      clearInterval(ticker);
      ticker = null;
    }
    if (!anyActive) fire('changed', listDownloads());
  }

  function tick() {
    const cap = db.settings.bandwidthLimitMbps > 0 ? (db.settings.bandwidthLimitMbps * 1e6) / 8 : Infinity;
    for (const d of db.downloads) {
      if (d.status !== 'downloading') continue;
      d._speed = Math.min(cap, Math.max(4e6, (d._speed || 20e6) * (0.94 + Math.random() * 0.12)));
      // The preview runs the clock fast so a full install can be watched end
      // to end, while still leaving progress readable rather than instant.
      d.receivedBytes = Math.min(d.totalBytes, d.receivedBytes + d._speed * 0.25 * 25);
      if (d.receivedBytes >= d.totalBytes) {
        d.status = 'completed';
        d.completedAt = Date.now();
        const entry = entryFor(d.gameId);
        entry.status = 'installed';
        entry.version = d.version;
        entry.path = `${db.settings.installDir}\\${d.gameId}`;
        entry.installedAt = Date.now();
        fire('completed', decorate(d));
      }
    }
    save();
    fire('progress', listDownloads());
    pump();
  }

  function entryFor(gameId) {
    if (!db.entries[gameId]) {
      db.entries[gameId] = {
        gameId, owned: false, status: 'not-installed', version: null, path: null, installedAt: null,
        playtimeSeconds: 0, lastPlayed: null, favorite: false, launchArgs: '', addedAt: Date.now()
      };
    }
    return db.entries[gameId];
  }

  const sessions = new Map();

  function libraryList() {
    const downloads = listDownloads();
    return catalog.games.map((game) => {
      const entry = db.entries[game.id] || null;
      const download = downloads.find((d) => d.gameId === game.id && d.status !== 'completed') || null;
      return {
        ...game,
        owned: !!entry?.owned,
        installed: entry?.status === 'installed',
        installState: entry?.status || 'not-installed',
        installPath: entry?.path || null,
        installedVersion: entry?.version || null,
        installedAt: entry?.installedAt || null,
        playtimeSeconds: entry?.playtimeSeconds || 0,
        lastPlayed: entry?.lastPlayed || null,
        favorite: !!entry?.favorite,
        running: sessions.has(game.id),
        download
      };
    });
  }

  const ok = (extra = {}) => ({ ok: true, library: libraryList(), ...extra });

  /* Exposed API --------------------------------------------------------- */

  BN.api = {
    isElectron: false,
    mode: 'mock',

    window: {
      minimize: async () => {},
      maximize: async () => false,
      close: async () => {},
      state: async () => ({ maximized: false, fullscreen: false, focused: true }),
      onState: (fn) => { listeners.winState.push(fn); return () => {}; }
    },

    auth: {
      async signUp({ email, handle, password, displayName }) {
        email = String(email || '').trim().toLowerCase();
        handle = String(handle || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
        if (!/^[A-Za-z0-9_]{3,20}$/.test(handle)) return { ok: false, error: 'Handle must be 3-20 characters: letters, numbers or underscore.' };
        if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
        if (strength(password) < 3) return { ok: false, error: 'Password is too weak. Mix upper/lowercase, numbers or symbols.' };
        if (db.users.some((u) => u.email === email)) return { ok: false, error: 'That email is already registered.' };
        if (db.users.some((u) => u.handle.toLowerCase() === handle.toLowerCase())) return { ok: false, error: 'That handle is taken.' };
        const user = {
          id: `u_${Date.now().toString(36)}`, email, handle,
          displayName: displayName || handle, avatarSeed: Math.random().toString(16).slice(2, 10),
          tier: 'standard', hash: weakHash(password), createdAt: Date.now(), lastLogin: Date.now()
        };
        db.users.push(user);
        db.session = { userId: user.id, remember: true, expiresAt: Date.now() + 2592000000 };
        save();
        return { ok: true, user: publicUser(user) };
      },

      async signIn({ identifier, password, remember = true }) {
        const id = String(identifier || '').trim().toLowerCase();
        const user = db.users.find((u) => u.email === id || u.handle.toLowerCase() === id);
        if (!user || user.hash !== weakHash(password))
          return { ok: false, error: 'Incorrect credentials. Check your email/handle and password.' };
        user.lastLogin = Date.now();
        db.session = { userId: user.id, remember, expiresAt: Date.now() + 2592000000 };
        save();
        return { ok: true, user: publicUser(user) };
      },

      async signInOffline() {
        const user = { id: 'offline', handle: 'OfflinePlayer', email: '', displayName: 'Offline Player', avatarSeed: 'offline', tier: 'standard', createdAt: Date.now(), lastLogin: Date.now(), offline: true };
        db.session = { userId: 'offline', offline: true, remember: false, expiresAt: Date.now() + 86400000 };
        save();
        return { ok: true, user: publicUser(user) };
      },

      async session() {
        const s = db.session;
        if (!s || s.expiresAt < Date.now()) return { ok: false };
        if (s.offline) return BN.api.auth.signInOffline();
        if (!s.remember) return { ok: false };
        const user = db.users.find((u) => u.id === s.userId);
        return user ? { ok: true, user: publicUser(user) } : { ok: false };
      },

      async signOut() { db.session = null; save(); return { ok: true }; },

      async updateProfile(userId, patch) {
        const user = db.users.find((u) => u.id === userId);
        if (!user) return { ok: false, error: 'Account not found.' };
        Object.assign(user, patch);
        save();
        return { ok: true, user: publicUser(user) };
      },

      async changePassword(userId, { current, next }) {
        const user = db.users.find((u) => u.id === userId);
        if (!user) return { ok: false, error: 'Account not found.' };
        if (user.hash !== weakHash(current)) return { ok: false, error: 'Current password is incorrect.' };
        if (strength(next) < 3) return { ok: false, error: 'New password is too weak.' };
        user.hash = weakHash(next);
        save();
        return { ok: true };
      },

      async strength(p) { return strength(p); }
    },

    settings: {
      async get() { return { ...db.settings }; },
      async set(patch) { Object.assign(db.settings, patch); save(); return { ...db.settings }; },
      async reset() { db.settings = { ...SETTINGS_DEFAULTS }; save(); return { ...db.settings }; }
    },

    catalog: {
      // The preview always serves the bundled copy.
      async refresh() { return { ok: false, reason: 'not-configured', source: 'bundled' }; },
      onChanged: () => () => {},
      async get() { await catalogReady; return catalog; }
    },

    library: {
      // The browser preview has one notional folder and no real disk.
      async folders() {
        return [{ dir: 'Browser preview', primary: true, installed: 0, usedBytes: 0, freeBytes: null }];
      },
      async addFolder() { return { ok: false, error: 'Not available in the browser preview.' }; },
      async removeFolder() { return { ok: false, error: 'Not available in the browser preview.' }; },
      async outdated() { return []; },
      async updateAll() { return { ok: true, started: [], pending: [] }; },
      async saveBackups() { return []; },
      async backupSaves() { return { ok: false, reason: 'no-saves' }; },
      async restoreSave() { return { ok: false, error: 'Not available in the browser preview.' }; },
      async reclaimable() {
        return Object.values(db.entries)
          .filter((e) => e.status === 'installed')
          .map((e) => {
            const game = catalog.games.find((g) => g.id === e.gameId) || {};
            return {
              gameId: e.gameId, title: game.title || e.gameId, sizeBytes: game.sizeBytes || 0,
              playtimeSeconds: e.playtimeSeconds || 0, lastPlayed: e.lastPlayed || null,
              idleDays: e.lastPlayed ? Math.floor((Date.now() - e.lastPlayed) / 86400000) : null
            };
          });
      },
      async list() { await catalogReady; return libraryList(); },
      async stats() {
        const entries = Object.values(db.entries);
        return {
          owned: entries.length,
          installed: entries.filter((e) => e.status === 'installed').length,
          totalPlaytimeSeconds: entries.reduce((s, e) => s + (e.playtimeSeconds || 0), 0),
          diskUsedBytes: entries
            .filter((e) => e.status === 'installed')
            .reduce((s, e) => s + (catalog.games.find((g) => g.id === e.gameId)?.sizeBytes || 0), 0),
          recent: db.recent
        };
      },
      async acquire(id) {
        const entry = entryFor(id);
        entry.owned = true;
        if (entry.status === 'not-installed') entry.status = 'owned';
        save();
        return ok();
      },
      async install(id) {
        const game = catalog.games.find((g) => g.id === id);
        if (!game) return { ok: false, error: 'Unknown title.' };
        if (game.status !== 'released') return { ok: false, error: `${game.title} has not been released yet.` };
        const entry = entryFor(id);
        if (entry.status === 'installed') return { ok: false, error: 'Already installed.' };
        if (db.downloads.some((d) => d.gameId === id && d.status !== 'completed')) return { ok: false, error: 'Already downloading.' };
        entry.status = 'downloading';
        db.downloads.push({
          id: `dl_${id}_${Date.now().toString(36)}`, gameId: id, title: game.title, kind: 'install',
          version: '1.0.0', simulated: true, dest: `${db.settings.installDir}\\${id}`,
          totalBytes: game.sizeBytes, receivedBytes: 0, status: 'queued', addedAt: Date.now(), completedAt: null, error: null
        });
        save();
        pump();
        return ok();
      },
      async uninstall(id) {
        const entry = db.entries[id];
        if (!entry) return { ok: false, error: 'Not installed.' };
        entry.status = 'owned';
        entry.path = null;
        entry.version = null;
        entry.installedAt = null;
        save();
        return ok();
      },
      async verify() { return { ok: true, message: 'All files verified.', library: libraryList() }; },
      async launch(id) {
        const entry = db.entries[id];
        if (entry?.status !== 'installed') return { ok: false, error: 'That title is not installed.' };
        sessions.set(id, { startedAt: Date.now() });
        entry.lastPlayed = Date.now();
        db.recent = [id, ...db.recent.filter((x) => x !== id)].slice(0, 10);
        save();
        return ok({ simulated: true, message: 'Launched in preview mode - no process is started in the browser.' });
      },
      async endSession(id) {
        const s = sessions.get(id);
        if (!s) return { ok: false };
        sessions.delete(id);
        const entry = entryFor(id);
        entry.playtimeSeconds += Math.round((Date.now() - s.startedAt) / 1000);
        save();
        return ok();
      },
      async setFavorite(id, value) { entryFor(id).favorite = !!value; save(); return ok(); },
      async setLaunchOptions(id, opts) { Object.assign(entryFor(id), opts); save(); return ok(); }
    },

    downloads: {
      async list() { return listDownloads(); },
      async pause(id) {
        const d = db.downloads.find((x) => x.id === id);
        if (d && ['downloading', 'queued'].includes(d.status)) d.status = 'paused';
        save(); pump(); fire('changed', listDownloads());
        return listDownloads();
      },
      async resume(id) {
        const d = db.downloads.find((x) => x.id === id);
        if (d && ['paused', 'failed'].includes(d.status)) d.status = 'queued';
        save(); pump(); fire('changed', listDownloads());
        return listDownloads();
      },
      async cancel(id) {
        const d = db.downloads.find((x) => x.id === id);
        if (d && db.entries[d.gameId]?.status === 'downloading') db.entries[d.gameId].status = 'owned';
        db.downloads = db.downloads.filter((x) => x.id !== id);
        save(); pump(); fire('changed', listDownloads());
        return listDownloads();
      },
      async prioritise(id) {
        const i = db.downloads.findIndex((x) => x.id === id);
        if (i > 0) db.downloads.unshift(db.downloads.splice(i, 1)[0]);
        save(); fire('changed', listDownloads());
        return listDownloads();
      },
      async clearFinished() {
        db.downloads = db.downloads.filter((d) => d.status !== 'completed');
        save(); fire('changed', listDownloads());
        return listDownloads();
      },
      onProgress: (fn) => { listeners.progress.push(fn); return () => {}; },
      onChanged: (fn) => { listeners.changed.push(fn); return () => {}; },
      onCompleted: (fn) => { listeners.completed.push(fn); return () => {}; }
    },

    // A browser cannot see the real machine, so the requirements check
    // reports 'unknown' rather than inventing a verdict.
    hardware: {
      async probe() {
        return { os: 'Browser preview', platform: 'web', arch: 'n/a', cpu: null, cpuCores: navigator.hardwareConcurrency || null, ramBytes: null, gpu: null, freeBytes: null };
      },
      async check() { return { level: 'unknown', minimum: null, recommended: null }; }
    },

    // Diagnostics go to the browser console rather than a file.
    log: {
      async write(level, scope, message, detail) {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(`[${scope}] ${message}`, detail ?? '');
        return true;
      },
      async location() { return { dir: 'browser console', file: 'browser console' }; },
      async open() { return null; }
    },

    presence: {
      async status() { return { state: 'unconfigured' }; },
      async setEnabled() { return { state: 'unconfigured' }; }
    },

    // The browser preview has nothing to update, so the panel reports the
    // same 'unsupported' state a development Electron run would.
    updates: {
      async get() { return { status: 'unsupported', version: null, progress: 0, error: null }; },
      async check() { return { status: 'unsupported', version: null, progress: 0, error: null }; },
      async download() { return { status: 'unsupported', version: null, progress: 0, error: null }; },
      async install() { return { ok: false, error: 'Updates are unavailable in the browser preview.' }; },
      onState: () => () => {}
    },

    app: {
      async info() {
        return {
          version: '1.0.0', electron: 'n/a (browser preview)', chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || 'n/a',
          node: 'n/a', platform: 'web', arch: 'n/a', dataDir: 'localStorage', isPackaged: false
        };
      },
      async chooseDirectory() { return null; },
      async chooseExecutable() { return null; },
      async openPath() { return null; },
      async showItem() { return null; },
      async openExternal(url) { if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener'); },
      async setLaunchOnStartup(v) { return !!v; },
      async registerIcon() { return false; },
      async setProgress() {},
      async relaunch() { location.reload(); },
      async quit() {},
      onNavigate: (fn) => { listeners.nav.push(fn); return () => {}; },
      onDeepLink: () => () => {}
    }
  };

  // Anything caught mid-flight by a page reload comes back paused.
  for (const d of db.downloads) if (d.status === 'downloading') d.status = 'paused';
  save();
})();
