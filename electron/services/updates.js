'use strict';
const { EventEmitter } = require('events');

/**
 * Launcher self-update, wrapped around electron-updater.
 *
 * The renderer only ever sees one small state machine rather than the raw
 * event stream:
 *
 *   unsupported -> not a packaged build, nothing to compare against
 *   idle | checking | none | available | downloading | ready | error
 *
 * Downloads are explicit rather than automatic: a launcher that silently
 * saturates the connection while a game is installing is a launcher people
 * turn off. `install()` quits and relaunches into the new version.
 */
class Updates extends EventEmitter {
  constructor({ packaged, autoCheck = true }) {
    super();
    this.supported = !!packaged;
    this.state = { status: this.supported ? 'idle' : 'unsupported', version: null, progress: 0, error: null };
    this.autoCheck = autoCheck;
    this.updater = null;

    if (!this.supported) return;

    // Required lazily: pulling electron-updater into an unpackaged run costs
    // startup time for a code path that cannot do anything useful.
    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this._set({ status: 'available', version: info?.version || null }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'none', version: null }));
    autoUpdater.on('download-progress', (p) =>
      this._set({ status: 'downloading', progress: (p?.percent || 0) / 100 })
    );
    autoUpdater.on('update-downloaded', (info) =>
      this._set({ status: 'ready', version: info?.version || null, progress: 1 })
    );
    autoUpdater.on('error', (err) =>
      this._set({ status: 'error', error: String(err?.message || err || 'Update failed') })
    );
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Fired once after boot so the user learns about updates without asking. */
  start() {
    if (!this.supported || !this.autoCheck) return;
    // Late enough that it never competes with the launcher's own startup work.
    setTimeout(() => this.check().catch(() => {}), 8000);
  }

  async check() {
    if (!this.supported) return this.state;
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this._set({ status: 'error', error: String(err?.message || err) });
    }
    return this.state;
  }

  async download() {
    if (!this.supported || this.state.status !== 'available') return this.state;
    try {
      this._set({ status: 'downloading', progress: 0 });
      await this.updater.downloadUpdate();
    } catch (err) {
      this._set({ status: 'error', error: String(err?.message || err) });
    }
    return this.state;
  }

  /** Quits and relaunches into the downloaded version. */
  install() {
    if (!this.supported || this.state.status !== 'ready') return { ok: false, error: 'No update is ready.' };
    setImmediate(() => this.updater.quitAndInstall(false, true));
    return { ok: true };
  }

  get() {
    return this.state;
  }
}

module.exports = { Updates };
