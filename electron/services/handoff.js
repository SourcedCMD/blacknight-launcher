'use strict';
const http = require('http');
const os = require('os');
const crypto = require('crypto');

/**
 * Moving a setup to another machine.
 *
 * "I built a new PC" should not mean redoing every preference by hand. This
 * serves a one-time bundle - settings, library records, journal, achievements -
 * over the local network to a second launcher that knows the pairing code.
 *
 * Deliberately narrow:
 *   - the window is short and single-use; the server stops after one transfer
 *   - a six-character code gates it, checked in constant time
 *   - loopback and private ranges only; it will not advertise across a router
 *   - accounts and passwords are never included, so a captured bundle cannot
 *     be signed in with
 */

const WINDOW_MS = 5 * 60 * 1000;
// No I, O, 0 or 1: this gets read off a screen and typed on another keyboard.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class Handoff {
  constructor(dataDir, settings, library, log) {
    this.dataDir = dataDir;
    this.settings = settings;
    this.library = library;
    this.log = log;
    this.server = null;
    this.code = null;
    this.expires = 0;
    this.timer = null;
  }

  static generateCode(length = 6) {
    const bytes = crypto.randomBytes(length);
    return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  /** The address another machine on this network can reach. */
  static localAddress() {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family !== 'IPv4' || entry.internal) continue;
        // Private ranges only: a public address here would be a mistake.
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) return entry.address;
      }
    }
    return '127.0.0.1';
  }

  /**
   * What travels. Everything here is preference and history; nothing here can
   * be used to authenticate as anyone.
   */
  bundle() {
    const settings = { ...this.settings.all() };
    // Machine-specific or identifying values do not transfer.
    for (const key of ['installDir', 'libraryFolders', 'peerId', 'windowBounds', 'windowMaximized']) {
      delete settings[key];
    }

    return {
      kind: 'blacknight-handoff',
      version: 1,
      at: Date.now(),
      settings,
      library: this.library.store.get('entries'),
      recent: this.library.store.get('recent'),
      journal: this.library.journal(null, { limit: 2000 })
    };
  }

  /** Opens the window. Returns the code and the URL to show as a QR. */
  start() {
    this.stop();
    this.code = Handoff.generateCode();
    this.expires = Date.now() + WINDOW_MS;

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._serve(req, res));
      this.server.on('error', (err) => {
        this.log?.warn('handoff', 'Could not open the handoff window', err);
        resolve({ ok: false, error: err.message });
      });
      this.server.listen(0, () => {
        const port = this.server.address().port;
        const host = Handoff.localAddress();
        // Closes itself even if nobody ever connects.
        this.timer = setTimeout(() => this.stop(), WINDOW_MS);
        this.timer.unref?.();

        resolve({
          ok: true,
          code: this.code,
          host,
          port,
          url: `blacknight://handoff?host=${host}&port=${port}&code=${this.code}`,
          expiresAt: this.expires
        });
      });
    });
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      this.server?.close();
    } catch {
      /* already gone */
    }
    this.server = null;
    this.code = null;
    this.expires = 0;
  }

  status() {
    return this.server
      ? { open: true, code: this.code, expiresAt: this.expires }
      : { open: false };
  }

  _serve(req, res) {
    try {
      const url = new URL(req.url, 'http://local');
      const given = Buffer.from(String(url.searchParams.get('code') || ''));
      const expected = Buffer.from(this.code || '');

      if (
        !this.code ||
        Date.now() > this.expires ||
        given.length !== expected.length ||
        !crypto.timingSafeEqual(given, expected)
      ) {
        res.writeHead(403).end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.bundle()));
      this.log?.info('handoff', 'A bundle was collected; closing the window');
      // Single use: once it has been taken, the code is spent.
      setTimeout(() => this.stop(), 250);
    } catch (err) {
      this.log?.warn('handoff', 'Bad handoff request', err);
      res.writeHead(400).end();
    }
  }

  /**
   * Pulls a bundle from another machine and applies it.
   *
   * Applied additively where it can be: an existing install record is left
   * alone rather than being replaced with one describing another machine's
   * disk.
   */
  async receive({ host, port, code }) {
    const url = `http://${host}:${port}/?code=${encodeURIComponent(code)}`;
    const body = await new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(res.statusCode === 403 ? 'That code is wrong or has expired.' : `HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('timeout', () => req.destroy(new Error('The other machine did not answer.')));
      req.on('error', reject);
    });

    let bundle;
    try {
      bundle = JSON.parse(body);
    } catch {
      throw new Error('That did not look like a handoff bundle.');
    }
    if (bundle.kind !== 'blacknight-handoff') throw new Error('That did not look like a handoff bundle.');

    this.settings.set(bundle.settings || {});

    const entries = this.library.store.get('entries');
    let added = 0;
    for (const [gameId, incoming] of Object.entries(bundle.library || {})) {
      if (entries[gameId]) continue; // this machine's own install record wins
      entries[gameId] = {
        ...incoming,
        // The build is not here, whatever the other machine had.
        status: incoming.owned ? 'owned' : 'not-installed',
        path: null,
        installedAt: null,
        version: null
      };
      added++;
    }
    this.library.store.save();

    return { ok: true, added, settings: Object.keys(bundle.settings || {}).length };
  }
}

module.exports = { Handoff, HANDOFF_ALPHABET: ALPHABET };
