'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('./store');

/**
 * Owns per-title install records: what is on disk, how long it has been played,
 * and how to start it. The download engine reports bytes; this decides what an
 * install actually means.
 */
class Library {
  constructor(dir, catalog, downloader, settings) {
    this.catalog = catalog;
    this.downloader = downloader;
    this.settings = settings;
    this.store = new Store(dir, 'library', { entries: {}, recent: [] });
    this.sessions = new Map(); // gameId -> { pid, startedAt }

    this.downloader.on('completed', (item) => this._onDownloadComplete(item));
  }

  installDir() {
    const configured = this.settings.get('installDir');
    if (configured) return configured;
    const fallback = path.join(require('electron').app.getPath('documents'), 'BlackNight Studios', 'Games');
    return fallback;
  }

  /** Catalog entry + install state + live download state, merged for the UI. */
  list() {
    const entries = this.store.get('entries');
    const downloads = this.downloader.list();
    return this.catalog.games.map((game) => {
      const entry = entries[game.id] || null;
      const download = downloads.find((d) => d.gameId === game.id && d.status !== 'completed') || null;
      return {
        ...game,
        owned: !!entry,
        installed: entry?.status === 'installed',
        installState: entry?.status || 'not-installed',
        installPath: entry?.path || null,
        installedVersion: entry?.version || null,
        installedAt: entry?.installedAt || null,
        playtimeSeconds: entry?.playtimeSeconds || 0,
        lastPlayed: entry?.lastPlayed || null,
        favorite: !!entry?.favorite,
        running: this.sessions.has(game.id),
        download
      };
    });
  }

  get(gameId) {
    return this.list().find((g) => g.id === gameId) || null;
  }

  _entry(gameId) {
    const entries = this.store.get('entries');
    if (!entries[gameId]) {
      entries[gameId] = {
        gameId,
        status: 'not-installed',
        version: null,
        path: null,
        installedAt: null,
        playtimeSeconds: 0,
        lastPlayed: null,
        favorite: false,
        launchArgs: '',
        addedAt: Date.now()
      };
    }
    return entries[gameId];
  }

  /** Adds a title to the account without downloading it (buy / claim / preorder). */
  acquire(gameId) {
    const game = this.catalog.games.find((g) => g.id === gameId);
    if (!game) return { ok: false, error: 'Unknown title.' };
    const entry = this._entry(gameId);
    if (entry.status === 'not-installed') entry.status = 'owned';
    this.store.save();
    return { ok: true, library: this.list() };
  }

  install(gameId) {
    const game = this.catalog.games.find((g) => g.id === gameId);
    if (!game) return { ok: false, error: 'Unknown title.' };
    if (game.status !== 'released')
      return { ok: false, error: `${game.title} has not been released yet.` };

    const entry = this._entry(gameId);
    if (entry.status === 'installed') return { ok: false, error: 'Already installed.' };

    const dir = this.installDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `Cannot write to install folder: ${err.message}` };
    }

    const free = this._freeSpace(dir);
    if (free !== null && free < game.sizeBytes)
      return { ok: false, error: 'Not enough free space on the selected drive.' };

    entry.status = 'downloading';
    entry.path = path.join(dir, gameId);
    this.store.save();

    this.downloader.enqueue({
      gameId,
      title: game.title,
      totalBytes: game.sizeBytes,
      url: game.downloadUrl || null,
      installDir: dir,
      version: game.version || '1.0.0'
    });
    return { ok: true, library: this.list() };
  }

  _onDownloadComplete(item) {
    const entry = this._entry(item.gameId);
    entry.status = 'installed';
    entry.version = item.version;
    entry.path = item.dest;
    entry.installedAt = Date.now();
    this.store.save();
    this._writeManifest(entry, item);
  }

  /** A small on-disk record so an install survives the launcher being reset. */
  _writeManifest(entry, item) {
    try {
      fs.writeFileSync(
        path.join(entry.path, 'blacknight.manifest.json'),
        JSON.stringify(
          { gameId: entry.gameId, title: item.title, version: entry.version, installedAt: entry.installedAt, sizeBytes: item.totalBytes },
          null,
          2
        ),
        'utf8'
      );
    } catch { /* manifest is a nicety, not a requirement */ }
  }

  uninstall(gameId, { keepSaves = true } = {}) {
    const entries = this.store.get('entries');
    const entry = entries[gameId];
    if (!entry) return { ok: false, error: 'Not installed.' };
    if (this.sessions.has(gameId)) return { ok: false, error: 'Close the game before uninstalling.' };

    try {
      if (entry.path && fs.existsSync(entry.path)) fs.rmSync(entry.path, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `Could not remove files: ${err.message}` };
    }

    entry.status = 'owned';
    entry.path = null;
    entry.version = null;
    entry.installedAt = null;
    if (!keepSaves) entry.playtimeSeconds = 0;
    this.store.save();
    return { ok: true, library: this.list() };
  }

  /** Re-checks the install on disk against its manifest. */
  verify(gameId) {
    const entry = this.store.get('entries')[gameId];
    if (!entry?.path) return { ok: false, error: 'Nothing to verify.' };
    const manifestPath = path.join(entry.path, 'blacknight.manifest.json');
    if (!fs.existsSync(manifestPath)) {
      entry.status = 'owned';
      entry.path = null;
      this.store.save();
      return { ok: false, error: 'Install files are missing. Marked for reinstall.', library: this.list() };
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const pak = path.join(entry.path, `${gameId}.pak`);
      const size = fs.existsSync(pak) ? fs.statSync(pak).size : 0;
      const complete = size >= manifest.sizeBytes;
      if (!complete) {
        entry.status = 'owned';
        this.store.save();
        return { ok: false, error: 'Files are incomplete. Reinstall required.', library: this.list() };
      }
      return { ok: true, message: 'All files verified.', library: this.list() };
    } catch (err) {
      return { ok: false, error: `Verification failed: ${err.message}` };
    }
  }

  launch(gameId) {
    const entry = this.store.get('entries')[gameId];
    const game = this.catalog.games.find((g) => g.id === gameId);
    if (!entry || entry.status !== 'installed') return { ok: false, error: 'That title is not installed.' };
    if (this.sessions.has(gameId)) return { ok: false, error: 'Already running.' };

    const exe = entry.executable || path.join(entry.path, `${gameId}.exe`);
    if (!fs.existsSync(exe)) {
      // The demo ships as data only until a real build is dropped in; record
      // the session anyway so playtime and Recently Played stay honest.
      this._beginSession(gameId, null);
      return {
        ok: true,
        simulated: true,
        message: `${game.title} launched. No executable found at ${exe} - drop the game build there to start the real process.`,
        library: this.list()
      };
    }

    try {
      const args = (entry.launchArgs || '').split(' ').filter(Boolean);
      const child = spawn(exe, args, { cwd: entry.path, detached: true, stdio: 'ignore' });
      child.unref();
      this._beginSession(gameId, child.pid);
      child.on?.('exit', () => this.endSession(gameId));
      return { ok: true, pid: child.pid, library: this.list() };
    } catch (err) {
      return { ok: false, error: `Launch failed: ${err.message}` };
    }
  }

  _beginSession(gameId, pid) {
    this.sessions.set(gameId, { pid, startedAt: Date.now() });
    const entry = this._entry(gameId);
    entry.lastPlayed = Date.now();
    const recent = this.store.get('recent').filter((id) => id !== gameId);
    recent.unshift(gameId);
    this.store.set('recent', recent.slice(0, 10));
  }

  endSession(gameId) {
    const session = this.sessions.get(gameId);
    if (!session) return { ok: false };
    this.sessions.delete(gameId);
    const entry = this._entry(gameId);
    entry.playtimeSeconds += Math.round((Date.now() - session.startedAt) / 1000);
    this.store.save();
    return { ok: true, library: this.list() };
  }

  setFavorite(gameId, favorite) {
    const entry = this._entry(gameId);
    entry.favorite = !!favorite;
    this.store.save();
    return { ok: true, library: this.list() };
  }

  setLaunchOptions(gameId, { launchArgs, executable }) {
    const entry = this._entry(gameId);
    if (launchArgs !== undefined) entry.launchArgs = String(launchArgs).slice(0, 500);
    if (executable !== undefined) entry.executable = executable || null;
    this.store.save();
    return { ok: true, library: this.list() };
  }

  stats() {
    const entries = Object.values(this.store.get('entries'));
    const totalSeconds = entries.reduce((sum, e) => sum + (e.playtimeSeconds || 0), 0);
    const installed = entries.filter((e) => e.status === 'installed');
    return {
      owned: entries.length,
      installed: installed.length,
      totalPlaytimeSeconds: totalSeconds,
      diskUsedBytes: installed.reduce((sum, e) => {
        const game = this.catalog.games.find((g) => g.id === e.gameId);
        return sum + (game?.sizeBytes || 0);
      }, 0),
      recent: this.store.get('recent')
    };
  }

  _freeSpace(dir) {
    try {
      const stats = fs.statfsSync(dir);
      return stats.bavail * stats.bsize;
    } catch {
      return null; // statfs is unavailable on some volumes; skip the check
    }
  }
}

module.exports = { Library };
