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

    // A payload kept from a previous uninstall turns this into a checksum
    // pass rather than another full transfer.
    if (kind === 'install') {
      const reused = this.restoreKept(gameId, dir);
      if (reused.ok) return { ok: true, reused: true, bytes: reused.bytes, library: this.list() };
    }

    this.downloader.enqueue({
      gameId,
      title: game.title,
      totalBytes: game.sizeBytes,
      url: game.downloadUrl || null,
      installDir: dir,
      version: game.version || '1.0.0',
      sha256: game.sha256 || null,
      // An update over an existing build only needs the blocks that changed.
      chunkManifest: kind === 'update' ? game.chunkManifest || null : null,
      previousFile: kind === 'update' && entry.path ? path.join(entry.path, `${gameId}.pak`) : null,
      // Filled in by main.js when a machine on this network has the build.
      peerUrl: this.findPeer?.(gameId, game.version || '1.0.0') || null,
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

  /* --- Finding installs the launcher has forgotten ---------------------- */

  /**
   * Looks through the library folders for builds with no library entry.
   *
   * Every install writes a manifest, and until now nothing read it except
   * verify(). Reinstalling the launcher, restoring a backup or moving a drive
   * all leave perfectly good builds on disk that the launcher would otherwise
   * offer to download again.
   */
  scanForInstalls() {
    const entries = this.store.get('entries');
    const found = [];

    for (const folder of this.libraryFolders()) {
      let children = [];
      try {
        children = fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue; // a folder that has gone away is not an error
      }

      for (const dir of children) {
        const gameId = dir.name;
        // Already tracked as installed: nothing to recover.
        if (entries[gameId]?.status === 'installed') continue;
        if (!this.catalog.games.some((g) => g.id === gameId)) continue;

        const base = path.join(folder, gameId);
        try {
          const manifestPath = path.join(base, 'blacknight.manifest.json');
          const pak = path.join(base, gameId + '.pak');
          if (!fs.existsSync(manifestPath) || !fs.existsSync(pak)) continue;

          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const size = fs.statSync(pak).size;
          if (manifest.sizeBytes && size < manifest.sizeBytes) continue; // a partial download

          found.push({
            gameId,
            title: manifest.title || gameId,
            version: manifest.version || null,
            path: base,
            sizeBytes: size,
            hasChecksum: !!manifest.sha256
          });
        } catch {
          continue;
        }
      }
    }

    return found;
  }

  /**
   * Adopts a build found on disk.
   *
   * Verified first when the manifest carries a digest - claiming an install is
   * good on the strength of a filename would be worse than not finding it.
   */
  adoptInstall(gameId, { verify = true } = {}) {
    const candidate = this.scanForInstalls().find((f) => f.gameId === gameId);
    if (!candidate) return { ok: false, error: 'Nothing to adopt for that title.' };

    if (verify && candidate.hasChecksum) {
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate.path, 'blacknight.manifest.json'), 'utf8'));
      const { Downloader } = require('./downloader');
      if (Downloader.hashFile(path.join(candidate.path, gameId + '.pak')) !== manifest.sha256) {
        return { ok: false, error: 'Those files did not match their checksum.' };
      }
    }

    const entry = this._entry(gameId);
    entry.owned = true;
    entry.status = 'installed';
    entry.version = candidate.version;
    entry.path = candidate.path;
    entry.installedAt = entry.installedAt || Date.now();
    this.store.save();
    return { ok: true, adopted: candidate, library: this.list() };
  }

  /* --- Background verification ------------------------------------------ */

  /**
   * Verifies one installed title, oldest check first.
   *
   * Bit-rot on a multi-gigabyte file is silent until someone hits it mid
   * session. Checking one title at a time, only while nothing is playing,
   * finds it earlier without ever being something the player waits on.
   */
  verifyOldest() {
    if (this.sessions.size) return { ok: false, reason: 'playing' };
    if (this.settings.get('backgroundVerify') === false) return { ok: false, reason: 'off' };

    const entries = this.store.get('entries');
    const due = Object.values(entries)
      .filter((e) => e.status === 'installed')
      .sort((a, b) => (a.verifiedAt || 0) - (b.verifiedAt || 0))[0];
    if (!due) return { ok: false, reason: 'nothing-installed' };

    // A week between checks is often enough to catch rot, rarely enough to
    // stay invisible.
    const WEEK = 7 * 86400000;
    if (due.verifiedAt && Date.now() - due.verifiedAt < WEEK) return { ok: false, reason: 'not-due' };

    const result = this.verify(due.gameId);
    due.verifiedAt = Date.now();
    this.store.save();
    return { ok: true, gameId: due.gameId, result };
  }

  /* --- Data usage -------------------------------------------------------- */

  _usage() {
    if (!this._usageStore) this._usageStore = new Store(this.dir, 'usage', { months: {} });
    return this._usageStore;
  }

  /** Records transferred bytes against the current month. */
  recordTransfer(bytes, { source = 'origin' } = {}) {
    if (!bytes || bytes <= 0) return;
    const store = this._usage();
    const months = store.get('months');
    const key = new Date().toISOString().slice(0, 7);
    const month = months[key] || { origin: 0, peer: 0, reused: 0 };
    month[source] = (month[source] || 0) + bytes;
    months[key] = month;
    store.set('months', months);
  }

  /**
   * What has actually crossed the connection, by month.
   *
   * The launcher throttles, schedules and yields bandwidth but never showed a
   * number - which is the one thing someone on a metered line wants.
   */
  dataUsage({ months = 6 } = {}) {
    const all = this._usage().get('months');
    return Object.keys(all)
      .sort()
      .reverse()
      .slice(0, months)
      .map((key) => ({ month: key, ...all[key], total: (all[key].origin || 0) + (all[key].peer || 0) }));
  }

  /* --- Channels --------------------------------------------------------- */

  /**
   * Which build of a title this machine should be on.
   *
   * BlackNight+ sells guaranteed playtest entry, so the launcher has to have
   * somewhere to put a playtest build. A catalog entry may carry `channels`,
   * each with its own version, size and digest; `stable` is what everyone gets
   * unless they have opted a title into something else and are entitled to it.
   */
  channelsFor(gameId) {
    const game = this.catalog.games.find((g) => g.id === gameId);
    if (!game) return [];

    const stable = {
      id: 'stable',
      label: 'Stable',
      version: game.version || '1.0.0',
      sizeBytes: game.sizeBytes,
      sha256: game.sha256 || null,
      downloadUrl: game.downloadUrl || null,
      requiresPlus: false
    };

    const extra = (game.channels || []).map((c) => ({
      id: c.id,
      label: c.label || c.id,
      version: c.version || stable.version,
      sizeBytes: c.sizeBytes || game.sizeBytes,
      sha256: c.sha256 || null,
      downloadUrl: c.downloadUrl || null,
      requiresPlus: c.requiresPlus !== false,
      notes: c.notes || null
    }));

    return [stable, ...extra];
  }

  /** The channel a title is set to, falling back to stable. */
  channelOf(gameId) {
    const channels = this.channelsFor(gameId);
    const wanted = this.store.get('entries')[gameId]?.channel || 'stable';
    return channels.find((c) => c.id === wanted) || channels[0] || null;
  }

  /**
   * Moves a title onto another channel.
   *
   * Entitlement is checked here rather than in the renderer, because a paid
   * perk enforced only in the UI is not enforced at all.
   */
  setChannel(gameId, channelId, { tier = 'standard' } = {}) {
    const channel = this.channelsFor(gameId).find((c) => c.id === channelId);
    if (!channel) return { ok: false, error: 'No such channel.' };
    if (channel.requiresPlus && tier !== 'plus') {
      return { ok: false, error: 'That channel is reserved for BlackNight+ members.', requiresPlus: true };
    }

    const entry = this._entry(gameId);
    const previous = entry.channel || 'stable';
    entry.channel = channelId;
    this.store.save();

    // Switching channels means the installed build is now the wrong one.
    const needsSwap = entry.status === 'installed' && entry.version !== channel.version;
    return { ok: true, channel, changed: previous !== channelId, needsSwap, library: this.list() };
  }

  /* --- Rollback ---------------------------------------------------------- */

  /** Where the build being replaced waits, in case the new one is worse. */
  rollbackRoot(gameId) {
    return path.join(this.dir, 'rollback', gameId);
  }

  /**
   * Sets the current build aside before an update overwrites it.
   *
   * A patch that breaks a game is otherwise a full re-download of the previous
   * version, assuming it is even still published. Keeping one version back
   * turns that into a thirty-second revert.
   */
  stashForRollback(gameId) {
    const entry = this.store.get('entries')[gameId];
    if (!entry || !entry.path || this.settings.get('keepRollback') === false) {
      return { ok: false, reason: 'off' };
    }

    try {
      const pak = path.join(entry.path, gameId + '.pak');
      const manifest = path.join(entry.path, 'blacknight.manifest.json');
      if (!fs.existsSync(pak) || !fs.existsSync(manifest)) return { ok: false, reason: 'nothing-to-keep' };

      const target = this.rollbackRoot(gameId);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(pak, path.join(target, gameId + '.pak'));
      fs.copyFileSync(manifest, path.join(target, 'blacknight.manifest.json'));

      return { ok: true, version: entry.version };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** The build available to roll back to, if any. */
  rollbackAvailable(gameId) {
    try {
      const manifestPath = path.join(this.rollbackRoot(gameId), 'blacknight.manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Nothing to offer if it is what is already installed.
      if (this.store.get('entries')[gameId]?.version === manifest.version) return null;
      return { version: manifest.version, sizeBytes: manifest.sizeBytes, at: manifest.installedAt || null };
    } catch {
      return null;
    }
  }

  /** Puts the previous build back, checking it before trusting it. */
  rollback(gameId) {
    const entry = this.store.get('entries')[gameId];
    if (!entry || !entry.path) return { ok: false, error: 'That title is not installed.' };
    if (this.sessions.has(gameId)) return { ok: false, error: 'Close the game before rolling back.' };

    const root = this.rollbackRoot(gameId);
    const pak = path.join(root, gameId + '.pak');
    const manifestPath = path.join(root, 'blacknight.manifest.json');
    if (!fs.existsSync(pak) || !fs.existsSync(manifestPath)) return { ok: false, error: 'No previous build kept.' };

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const { Downloader } = require('./downloader');
      if (manifest.sha256 && Downloader.hashFile(pak) !== manifest.sha256) {
        fs.rmSync(root, { recursive: true, force: true });
        return { ok: false, error: 'The kept build is corrupt and has been discarded.' };
      }

      // Read the kept build into memory *before* stashing the current one:
      // stashForRollback writes into this very directory, so reading after it
      // would copy the build being replaced straight back over itself.
      const keptPayload = fs.readFileSync(pak);
      const keptManifest = fs.readFileSync(manifestPath);

      // Swap, keeping the build being replaced so the revert is reversible.
      const current = this.stashForRollback(gameId);
      fs.writeFileSync(path.join(entry.path, gameId + '.pak'), keptPayload);
      fs.writeFileSync(path.join(entry.path, 'blacknight.manifest.json'), keptManifest);

      entry.version = manifest.version;
      this.store.save();
      return { ok: true, version: manifest.version, canRedo: current.ok, library: this.list() };
    } catch (err) {
      return { ok: false, error: 'Could not roll back: ' + err.message };
    }
  }

  /* --- Keeping a verified payload -------------------------------------- */

  /** Where an uninstalled-but-kept build waits for its reinstall. */
  stashRoot() {
    return path.join(this.dir, 'kept');
  }

  /**
   * Moves the installed payload aside on uninstall.
   *
   * A rename when it is on the same volume, a copy when it is not; either way
   * the manifest goes with it so the digest can be checked before reuse.
   */
  _stashPak(gameId, entry) {
    try {
      const pak = path.join(entry.path, `${gameId}.pak`);
      const manifest = path.join(entry.path, 'blacknight.manifest.json');
      if (!fs.existsSync(pak) || !fs.existsSync(manifest)) return null;

      const target = path.join(this.stashRoot(), gameId);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });

      for (const [from, name] of [[pak, `${gameId}.pak`], [manifest, 'blacknight.manifest.json']]) {
        try {
          fs.renameSync(from, path.join(target, name));
        } catch {
          fs.copyFileSync(from, path.join(target, name));
        }
      }
      return { dir: target, version: entry.version, at: Date.now() };
    } catch (err) {
      this.log?.warn?.('library', `Could not keep the payload for ${gameId}`, err);
      return null;
    }
  }

  /**
   * A kept payload that still matches the build being installed.
   *
   * Verified against its own manifest before it is trusted - a file that has
   * rotted on disk since it was stashed must not be silently reinstalled.
   */
  keptPayload(gameId, version) {
    try {
      const dir = path.join(this.stashRoot(), gameId);
      const manifestPath = path.join(dir, 'blacknight.manifest.json');
      const pak = path.join(dir, `${gameId}.pak`);
      if (!fs.existsSync(manifestPath) || !fs.existsSync(pak)) return null;

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (version && manifest.version !== version) return null;
      if (!manifest.sha256) return null;

      const { Downloader } = require('./downloader');
      if (Downloader.hashFile(pak) !== manifest.sha256) {
        fs.rmSync(dir, { recursive: true, force: true });
        return null;
      }
      return { dir, pak, manifest };
    } catch {
      return null;
    }
  }

  /** Puts a kept payload back, skipping the download entirely. */
  restoreKept(gameId, targetDir) {
    const game = this.catalog.games.find((g) => g.id === gameId);
    const kept = this.keptPayload(gameId, game?.version || '1.0.0');
    if (!kept) return { ok: false, reason: 'none' };

    try {
      const dest = path.join(targetDir, gameId);
      fs.mkdirSync(dest, { recursive: true });
      for (const name of [`${gameId}.pak`, 'blacknight.manifest.json']) {
        try {
          fs.renameSync(path.join(kept.dir, name), path.join(dest, name));
        } catch {
          fs.copyFileSync(path.join(kept.dir, name), path.join(dest, name));
        }
      }
      fs.rmSync(kept.dir, { recursive: true, force: true });

      const entry = this._entry(gameId);
      entry.status = 'installed';
      entry.version = kept.manifest.version;
      entry.path = dest;
      entry.installedAt = Date.now();
      entry.keptPak = null;
      this.store.save();
      return { ok: true, bytes: kept.manifest.sizeBytes, library: this.list() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* --- Journal and habits ---------------------------------------------- */

  /**
   * One line per session, written automatically.
   *
   * Kept in its own store so a long history never bloats the library file that
   * is read on every list().
   */
  _journal() {
    if (!this._journalStore) {
      this._journalStore = new Store(this.dir, 'journal', { entries: [] });
    }
    return this._journalStore;
  }

  addJournalEntry(entry) {
    const store = this._journal();
    const entries = store.get('entries');
    entries.unshift({ id: `j_${Date.now().toString(36)}`, at: Date.now(), note: '', ...entry });
    // A couple of thousand sessions is a decade of play; past that, drop the
    // oldest rather than growing without limit.
    store.set('entries', entries.slice(0, 2000));
    return entries[0];
  }

  journal(gameId = null, { limit = 200 } = {}) {
    const entries = this._journal().get('entries');
    return (gameId ? entries.filter((e) => e.gameId === gameId) : entries).slice(0, limit);
  }

  setJournalNote(id, note) {
    const store = this._journal();
    const entries = store.get('entries');
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'No such entry.' };
    entry.note = String(note || '').slice(0, 2000);
    store.set('entries', entries);
    return { ok: true, entry };
  }

  /**
   * What this player's sessions actually look like, from their own history.
   *
   * Used for "your sessions on this run about 90 minutes" and for the
   * end-of-year summary. Nothing leaves the machine.
   */
  sessionInsights(gameId = null) {
    const entries = this.journal(gameId, { limit: 2000 }).filter((e) => e.seconds > 60);
    if (!entries.length) return null;

    const durations = entries.map((e) => e.seconds).sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const total = durations.reduce((sum, s) => sum + s, 0);

    // Which hour of the day play usually starts, and when it usually ends.
    const startHours = new Array(24).fill(0);
    const endHours = new Array(24).fill(0);
    for (const entry of entries) {
      startHours[new Date(entry.at - entry.seconds * 1000).getHours()]++;
      endHours[new Date(entry.at).getHours()]++;
    }
    const peak = (buckets) => buckets.indexOf(Math.max(...buckets));

    return {
      sessions: entries.length,
      totalSeconds: total,
      medianSeconds: median,
      longestSeconds: durations[durations.length - 1],
      usualStartHour: peak(startHours),
      usualEndHour: peak(endHours),
      lastPlayed: entries[0].at
    };
  }

  /**
   * Everything the end-of-year poster needs, computed locally.
   */
  yearInReview(year = new Date().getFullYear()) {
    const from = new Date(year, 0, 1).getTime();
    const to = new Date(year + 1, 0, 1).getTime();
    const entries = this.journal(null, { limit: 2000 }).filter((e) => e.at >= from && e.at < to);
    if (!entries.length) return { year, sessions: 0, totalSeconds: 0, titles: [] };

    const byGame = new Map();
    const hours = new Array(24).fill(0);
    let longest = entries[0];

    for (const entry of entries) {
      const bucket = byGame.get(entry.gameId) || { gameId: entry.gameId, title: entry.title, seconds: 0, sessions: 0 };
      bucket.seconds += entry.seconds;
      bucket.sessions++;
      byGame.set(entry.gameId, bucket);
      hours[new Date(entry.at).getHours()]++;
      if (entry.seconds > longest.seconds) longest = entry;
    }

    const titles = [...byGame.values()].sort((a, b) => b.seconds - a.seconds);
    return {
      year,
      sessions: entries.length,
      totalSeconds: entries.reduce((sum, e) => sum + e.seconds, 0),
      titles,
      topTitle: titles[0] || null,
      longestSession: { title: longest.title, seconds: longest.seconds, at: longest.at },
      peakHour: hours.indexOf(Math.max(...hours)),
      nightFraction: entries.filter((e) => {
        const h = new Date(e.at).getHours();
        return h >= 22 || h < 5;
      }).length / entries.length
    };
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

  uninstall(gameId, { keepSaves = true, keepPak = null } = {}) {
    if (keepPak === null) keepPak = this.settings.get('keepPakOnUninstall') === true;
    const entries = this.store.get('entries');
    const entry = entries[gameId];
    if (!entry) return { ok: false, error: 'Not installed.' };
    if (this.sessions.has(gameId)) return { ok: false, error: 'Close the game before uninstalling.' };

    // Saves live inside the install folder, so they have to be copied out
    // before it is deleted - otherwise "keep my saves" quietly means nothing.
    let savedAside = false;
    if (keepSaves) savedAside = this.backupSaves(gameId).ok;

    // Optionally hold on to the verified payload. Reinstalling then costs a
    // checksum pass instead of another 90 GB off someone's connection.
    let keptPak = null;
    if (keepPak && entry.path) {
      keptPak = this._stashPak(gameId, entry);
    }

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

    entry.keptPak = keptPak || null;

    entry.status = 'owned';
    entry.path = null;
    entry.version = null;
    entry.installedAt = null;
    this.store.save();
    return { ok: true, savesKept: keepSaves && savedAside, pakKept: !!keptPak, library: this.list() };
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

    // One line per session, so playtime is a history rather than a single
    // ever-growing number.
    if (seconds > 30 && this.settings.get('playJournal') !== false) {
      const game = this.catalog.games.find((g) => g.id === gameId);
      this.addJournalEntry({
        gameId,
        title: game?.title || gameId,
        seconds,
        version: entry.version || null,
        crashed
      });
    }

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
      // Keep the build about to be replaced, so a bad patch is a revert rather
      // than another full download.
      this.stashForRollback(item.gameId);
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
