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
  constructor(dir, catalog, downloader, settings, { allowSimulated = false } = {}) {
    this.catalog = catalog;
    this.downloader = downloader;
    this.settings = settings;
    // Simulated installs are a development affordance, never a shipped one.
    this.allowSimulated = allowSimulated;
    this.store = new Store(dir, 'library', { entries: {}, recent: [] });
    this.sessions = new Map(); // gameId -> { pid, startedAt }

    this.downloader.on('completed', (item) => this._onDownloadComplete(item));
    this._migrateOwnership();
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
        owned: !!entry?.owned,
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

  /** Backfills the explicit owned flag for entries written by older builds. */
  _migrateOwnership() {
    const entries = this.store.get('entries');
    let changed = false;
    for (const entry of Object.values(entries)) {
      if (entry.owned === undefined) {
        entry.owned = entry.status !== 'not-installed';
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  _entry(gameId) {
    const entries = this.store.get('entries');
    if (!entries[gameId]) {
      entries[gameId] = {
        gameId,
        owned: false,
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
    entry.owned = true;
    if (entry.status === 'not-installed') entry.status = 'owned';
    this.store.save();
    return { ok: true, library: this.list() };
  }

  install(gameId) {
    const game = this.catalog.games.find((g) => g.id === gameId);
    if (!game) return { ok: false, error: 'Unknown title.' };

    // Pre-orders can be pre-loaded: the download runs now and the title stays
    // locked until its release date, so nobody spends launch night waiting on
    // 90 GB. Anything further out than a pre-order has no build to fetch.
    const preload = game.status === 'preorder' && Library.unlockAt(game) !== null;
    if (game.status !== 'released' && !preload)
      return { ok: false, error: `${game.title} has not been released yet.` };
    // Reading the map directly: _entry() would create the record and, before
    // the owned flag existed, that alone counted as owning the game.
    if (preload && !this.store.get('entries')[gameId]?.owned) {
      return { ok: false, error: `Pre-order ${game.title} to pre-load it.` };
    }

    const entry = this._entry(gameId);
    if (entry.status === 'installed') return { ok: false, error: 'Already installed.' };

    // A catalog entry without a downloadUrl falls back to the simulated
    // writer, which produces a real file of the right size - useful while
    // developing, but in a shipped build that is gigabytes of nothing written
    // to someone's drive. Released builds only install titles that have a
    // real artifact behind them.
    if (!game.downloadUrl && !this.allowSimulated) {
      return { ok: false, error: `${game.title} does not have a downloadable build yet.` };
    }

    const dir = this.installDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `Cannot write to install folder: ${err.message}` };
    }

    const free = this._freeSpace(dir);
    if (free !== null && free < game.sizeBytes) {
      // Hand back the numbers and something to uninstall, so the renderer can
      // offer a way out instead of a dead end.
      return {
        ok: false,
        reason: 'no-space',
        error: 'Not enough free space on the selected drive.',
        needBytes: game.sizeBytes,
        freeBytes: free,
        dir,
        reclaimable: this.reclaimable()
      };
    }

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

    const unlock = Library.unlockAt(game);
    if (unlock !== null && Date.now() < unlock) {
      return { ok: false, error: `${game.title} unlocks on ${new Date(unlock).toLocaleString()}.`, lockedUntil: unlock };
    }

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
      const args = this._argsFor(entry).split(' ').filter(Boolean);
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
    this.downloader.setGameRunning?.(true);
    this.onSessionChange?.(gameId, true);
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
    this.downloader.setGameRunning?.(this.sessions.size > 0);
    this.onSessionChange?.(gameId, false);
    return { ok: true, library: this.list() };
  }

  setFavorite(gameId, favorite) {
    const entry = this._entry(gameId);
    entry.favorite = !!favorite;
    this.store.save();
    return { ok: true, library: this.list() };
  }

  setLaunchOptions(gameId, { launchArgs, executable, profiles, activeProfile }) {
    const entry = this._entry(gameId);
    if (launchArgs !== undefined) entry.launchArgs = String(launchArgs).slice(0, 500);
    if (executable !== undefined) entry.executable = executable || null;

    // Named argument sets - "Benchmark", "Modded", "Safe mode" - so switching
    // does not mean retyping a flag string from memory every time.
    if (profiles !== undefined) {
      entry.profiles = (Array.isArray(profiles) ? profiles : [])
        .filter((p) => p && p.name)
        .slice(0, 12)
        .map((p) => ({ name: String(p.name).slice(0, 40), args: String(p.args || '').slice(0, 500) }));
    }
    if (activeProfile !== undefined) entry.activeProfile = activeProfile ? String(activeProfile).slice(0, 40) : null;

    this.store.save();
    return { ok: true, library: this.list() };
  }

  /** Arguments for the profile currently selected, falling back to the plain field. */
  _argsFor(entry) {
    const profile = (entry.profiles || []).find((p) => p.name === entry.activeProfile);
    return (profile ? profile.args : entry.launchArgs) || '';
  }

  /** Release instant for a title that unlocks on a date, or null if it is open. */
  static unlockAt(game) {
    if (!game || game.status !== 'preorder' || !game.releaseDate) return null;
    const at = Date.parse(`${game.releaseDate}T00:00:00`);
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Installed titles ranked by how safe they look to remove: never played
   * first, then longest untouched. Used to turn "not enough space" into a
   * decision the player can actually make.
   */
  reclaimable() {
    const entries = this.store.get('entries');
    return this.catalog.games
      .filter((game) => entries[game.id]?.status === 'installed')
      .map((game) => {
        const entry = entries[game.id];
        return {
          gameId: game.id,
          title: game.title,
          sizeBytes: game.sizeBytes,
          playtimeSeconds: entry.playtimeSeconds || 0,
          lastPlayed: entry.lastPlayed || null,
          idleDays: entry.lastPlayed ? Math.floor((Date.now() - entry.lastPlayed) / 86400000) : null
        };
      })
      .sort((a, b) => {
        if (!a.playtimeSeconds !== !b.playtimeSeconds) return a.playtimeSeconds ? 1 : -1;
        return (b.idleDays ?? 1e9) - (a.idleDays ?? 1e9);
      });
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
