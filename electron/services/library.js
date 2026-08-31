'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Store } = require('./store');

/**
 * Owns per-title install records: what is on disk, how long it has been played,
 * and how to start it. The download engine reports bytes; this decides what an
 * install actually means.
 */
class Library {
  constructor(dir, catalog, downloader, settings, { allowSimulated = false } = {}) {
    this.dir = dir;
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

  /**
   * Every folder games may be installed into.
   *
   * A small SSD and a large HDD is the normal PC, so one path was never
   * enough. `installDir` stays the primary and always leads the list, which
   * keeps every existing install and setting valid.
   */
  libraryFolders() {
    const primary = this.installDir();
    const extra = this.settings.get('libraryFolders') || [];
    const seen = new Set();
    return [primary, ...extra].filter((dir) => {
      if (!dir || seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
  }

  addLibraryFolder(dir) {
    if (!dir) return { ok: false, error: 'No folder given.' };
    if (this.libraryFolders().includes(dir)) return { ok: false, error: 'That folder is already in the list.' };
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `Cannot use that folder: ${err.message}` };
    }
    this.settings.set('libraryFolders', [...(this.settings.get('libraryFolders') || []), dir]);
    return { ok: true, folders: this.folderStats() };
  }

  removeLibraryFolder(dir) {
    if (dir === this.installDir()) return { ok: false, error: 'The primary folder cannot be removed.' };
    // Anything installed there would be orphaned by dropping the folder.
    const used = Object.values(this.store.get('entries')).some((e) => e.path && e.path.startsWith(dir));
    if (used) return { ok: false, error: 'Titles are still installed in that folder.' };
    this.settings.set('libraryFolders', (this.settings.get('libraryFolders') || []).filter((d) => d !== dir));
    return { ok: true, folders: this.folderStats() };
  }

  /** Each folder with how much it holds and how much room is left. */
  folderStats() {
    const entries = Object.values(this.store.get('entries'));
    return this.libraryFolders().map((dir) => {
      const installed = entries.filter((e) => e.status === 'installed' && e.path && e.path.startsWith(dir));
      const usedBytes = installed.reduce((sum, e) => {
        const game = this.catalog.games.find((g) => g.id === e.gameId);
        return sum + (game?.sizeBytes || 0);
      }, 0);
      return {
        dir,
        primary: dir === this.installDir(),
        installed: installed.length,
        usedBytes,
        freeBytes: this._freeSpace(dir)
      };
    });
  }

  installDir() {
    const configured = this.settings.get('installDir');
    if (configured) return configured;
    // Matches defaultInstallDir() in main.js: never a cloud-synced folder.
    const base =
      process.platform === 'win32'
        ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        : os.homedir();
    return path.join(base, 'BlackNight Studios', 'Games');
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

  install(gameId, { folder = null, kind = 'install' } = {}) {
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
    if (entry.status === 'installed' && kind !== 'update') return { ok: false, error: 'Already installed.' };

    // A catalog entry without a downloadUrl falls back to the simulated
    // writer, which produces a real file of the right size - useful while
    // developing, but in a shipped build that is gigabytes of nothing written
    // to someone's drive. Released builds only install titles that have a
    // real artifact behind them.
    if (!game.downloadUrl && !this.allowSimulated) {
      return { ok: false, error: `${game.title} does not have a downloadable build yet.` };
    }

    // An explicit folder wins, but only if it is one the user actually added.
    const dir = folder && this.libraryFolders().includes(folder) ? folder : this.installDir();
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
        folders: this.folderStats(),
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
      version: game.version || '1.0.0',
      sha256: game.sha256 || null,
      kind
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
          {
            gameId: entry.gameId,
            title: item.title,
            version: entry.version,
            installedAt: entry.installedAt,
            sizeBytes: item.totalBytes,
            // Whatever the download engine actually hashed, so a later verify
            // compares like for like rather than trusting the catalog again.
            sha256: item.verifiedSha256 || item.sha256 || null
          },
          null,
          2
        ),
        'utf8'
      );
    } catch { /* manifest is a nicety, not a requirement */ }
  }

  /* --- Saves ---------------------------------------------------------- */

  /** Where a title keeps its save data, by convention inside its install. */
  savePath(entry) {
    return entry?.path ? path.join(entry.path, 'saves') : null;
  }

  /** Snapshots live outside the install, so uninstalling cannot take them. */
  backupRoot(gameId) {
    return path.join(this.dir, 'saves', gameId);
  }

  /**
   * Copies the save folder aside when a session ends.
   *
   * Cloud saves need a server; keeping the last few local versions does not,
   * and it covers the case people actually lose sleep over - a corrupt save
   * or an uninstall that took more than it should have.
   */
  backupSaves(gameId, { keep = 5 } = {}) {
    const entry = this.store.get('entries')[gameId];
    const source = this.savePath(entry);
    if (!source || !fs.existsSync(source)) return { ok: false, reason: 'no-saves' };

    try {
      const root = this.backupRoot(gameId);
      fs.mkdirSync(root, { recursive: true });
      // Epoch milliseconds: sorts correctly as a string and parses back
      // without a format to get wrong.
      const stamp = String(Date.now());
      fs.cpSync(source, path.join(root, stamp), { recursive: true });

      // Keep the most recent few; older ones are noise on someone's drive.
      const snapshots = fs.readdirSync(root).sort();
      for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
        fs.rmSync(path.join(root, old), { recursive: true, force: true });
      }
      return { ok: true, at: stamp, kept: Math.min(snapshots.length, keep) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Snapshots available for a title, newest first. */
  saveBackups(gameId) {
    const root = this.backupRoot(gameId);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .sort()
      .reverse()
      .map((name) => {
        const dir = path.join(root, name);
        let bytes = 0;
        try {
          for (const file of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
            if (file.isFile()) bytes += fs.statSync(path.join(file.parentPath || file.path, file.name)).size;
          }
        } catch { /* a partial snapshot still lists */ }
        return { id: name, at: Number(name) || null, bytes };
      });
  }

  restoreSave(gameId, snapshotId) {
    const entry = this.store.get('entries')[gameId];
    const target = this.savePath(entry);
    if (!target) return { ok: false, error: 'That title is not installed.' };
    if (this.sessions.has(gameId)) return { ok: false, error: 'Close the game before restoring a save.' };

    const source = path.join(this.backupRoot(gameId), path.basename(snapshotId || ''));
    if (!fs.existsSync(source)) return { ok: false, error: 'That snapshot no longer exists.' };

    try {
      // Take one more snapshot first: restoring is itself a destructive act.
      this.backupSaves(gameId);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Could not restore: ${err.message}` };
    }
  }

  uninstall(gameId, { keepSaves = true } = {}) {
    const entries = this.store.get('entries');
    const entry = entries[gameId];
    if (!entry) return { ok: false, error: 'Not installed.' };
    if (this.sessions.has(gameId)) return { ok: false, error: 'Close the game before uninstalling.' };

    // Saves live inside the install folder, so they have to be copied out
    // before it is deleted - otherwise "keep my saves" quietly means nothing.
    let savedAside = false;
    if (keepSaves) savedAside = this.backupSaves(gameId).ok;

    try {
      if (entry.path && fs.existsSync(entry.path)) fs.rmSync(entry.path, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `Could not remove files: ${err.message}` };
    }

    if (!keepSaves) {
      try {
        fs.rmSync(this.backupRoot(gameId), { recursive: true, force: true });
      } catch { /* nothing to discard */ }
    }

    entry.status = 'owned';
    entry.path = null;
    entry.version = null;
    entry.installedAt = null;
    this.store.save();
    return { ok: true, savesKept: keepSaves && savedAside, library: this.list() };
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

      // Only a checksum can actually verify anything. Without one this is a
      // length check, and saying so beats claiming a guarantee it cannot make.
      if (!manifest.sha256) {
        return {
          ok: true,
          checked: 'size',
          message: 'Install looks complete. This build ships no checksum, so only file sizes were checked.',
          library: this.list()
        };
      }

      const actual = require('./downloader').Downloader.hashFile(pak);
      if (actual !== manifest.sha256) {
        entry.status = 'owned';
        this.store.save();
        return {
          ok: false,
          checked: 'checksum',
          error: 'Files are corrupt: the checksum does not match. Reinstall required.',
          library: this.list()
        };
      }

      return { ok: true, checked: 'checksum', message: 'All files verified against their checksum.', library: this.list() };
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
      // A game that dies on startup used to look exactly like a game someone
      // quit. Keep the exit code so the launcher can say something useful.
      child.on?.('exit', (code, signal) => this.endSession(gameId, { code, signal }));
      child.on?.('error', (err) => this.endSession(gameId, { code: null, error: err.message }));
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

  endSession(gameId, exit = null) {
    const session = this.sessions.get(gameId);
    if (!session) return { ok: false };
    this.sessions.delete(gameId);
    const entry = this._entry(gameId);
    const seconds = Math.round((Date.now() - session.startedAt) / 1000);
    entry.playtimeSeconds += seconds;

    // A non-zero code, a signal, or a death inside the first few seconds all
    // point at a broken install rather than someone deciding to stop playing.
    const crashed =
      !!exit && ((typeof exit.code === 'number' && exit.code !== 0) || !!exit.signal || !!exit.error);
    entry.lastExit = exit
      ? { code: exit.code ?? null, signal: exit.signal || null, error: exit.error || null, at: Date.now(), seconds }
      : null;

    this.store.save();
    this.downloader.setGameRunning?.(this.sessions.size > 0);
    if (this.settings.get('backupSaves') !== false) {
      this.backupSaves(gameId, { keep: Number(this.settings.get('saveBackupsKept')) || 5 });
    }
    this.onSessionChange?.(gameId, false);

    return { ok: true, crashed, exit: entry.lastExit, seconds, library: this.list() };
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
   * Installed titles whose catalog version has moved past what is on disk.
   *
   * The catalog is the only source of truth for what the current build is, so
   * an update is simply a version mismatch - no separate patch feed to keep in
   * step with it.
   */
  outdated() {
    const entries = this.store.get('entries');
    return this.catalog.games
      .filter((game) => {
        const entry = entries[game.id];
        if (!entry || entry.status !== 'installed') return false;
        const current = game.version || '1.0.0';
        return entry.version && entry.version !== current;
      })
      .map((game) => ({
        gameId: game.id,
        title: game.title,
        installedVersion: entries[game.id].version,
        availableVersion: game.version || '1.0.0',
        sizeBytes: game.sizeBytes
      }));
  }

  /**
   * Queues updates for everything out of date.
   *
   * `auto` reflects the autoUpdateGames setting: when it is off the list is
   * still reported so the UI can offer the update, it just is not started.
   */
  updateAll({ auto = false } = {}) {
    const pending = this.outdated();
    if (auto && this.settings.get('autoUpdateGames') === false) {
      return { ok: true, started: [], pending };
    }

    const started = [];
    for (const item of pending) {
      const entry = this.store.get('entries')[item.gameId];
      const folder = entry?.path ? path.dirname(entry.path) : null;
      const result = this.install(item.gameId, { folder, kind: 'update' });
      if (result.ok) started.push(item.gameId);
    }
    return { ok: true, started, pending };
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
