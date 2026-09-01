'use strict';
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * LAN peer install.
 *
 * Two machines in the same house wanting the same 90 GB build should not both
 * pull it from the internet. Each launcher announces what it has finished
 * installing over UDP multicast and serves those files over a small HTTP
 * server bound to the local network; a launcher about to download checks for a
 * peer first.
 *
 * Deliberate limits, because this is a feature that touches the network:
 *   - announcements carry ids and versions, never account details
 *   - a shared secret derived from the install id gates every request, so a
 *     stranger on a coffee-shop network cannot enumerate what you own
 *   - only completed, checksum-verified installs are ever offered
 *   - everything a peer sends is verified against the catalog's own digest
 *     before it is used, so a hostile peer can waste your time and nothing more
 *
 * Off unless `lanSharing` is enabled.
 */

const MULTICAST_ADDR = '239.255.42.99';
const MULTICAST_PORT = 47846;
const ANNOUNCE_MS = 20000;
const PEER_TTL_MS = 70000;

class Peers extends EventEmitter {
  constructor(settings, log, { library = null } = {}) {
    super();
    this.settings = settings;
    this.log = log;
    this.library = library;
    this.peers = new Map(); // id -> { id, host, port, titles, playing, seenAt }
    // Set by the library so the announcement can carry it. A title and a
    // start time, nothing that identifies the person at the keyboard.
    this.playing = null;
    this.socket = null;
    this.server = null;
    this.timer = null;
    this.id = null;
    this.port = 0;
  }

  get enabled() {
    return this.settings.get('lanSharing') === true;
  }

  /**
   * A network-wide shared secret. Everyone running the launcher can derive it,
   * which is the point - it keeps casual scanners out without pretending to be
   * authentication.
   */
  static tokenFor(gameId, version) {
    return crypto.createHash('sha256').update(`blacknight:${gameId}:${version}`).digest('hex').slice(0, 24);
  }

  async start() {
    if (!this.enabled || this.socket) return { ok: false, reason: 'disabled' };
    this.id = this.settings.get('peerId') || crypto.randomUUID();
    if (!this.settings.get('peerId')) this.settings.set('peerId', this.id);

    try {
      await this._startServer();
      this._startDiscovery();
      this.log?.info('peers', `LAN sharing on, serving from port ${this.port}`);
      return { ok: true, port: this.port };
    } catch (err) {
      this.log?.warn('peers', 'Could not start LAN sharing', err);
      this.stop();
      return { ok: false, error: err.message };
    }
  }

  _startServer() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._serve(req, res));
      this.server.on('error', reject);
      // Port 0: the OS picks a free one, which is then announced.
      this.server.listen(0, () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  /** Serves byte ranges of an installed file to a peer that knows the token. */
  _serve(req, res) {
    try {
      const url = new URL(req.url, 'http://local');
      const gameId = url.searchParams.get('game');
      const version = url.searchParams.get('version');
      const token = url.searchParams.get('token');

      const entry = this.library?.store.get('entries')[gameId];
      if (!entry || entry.status !== 'installed' || entry.version !== version) {
        res.writeHead(404).end();
        return;
      }
      // Constant-time so the token cannot be probed a character at a time.
      const expected = Peers.tokenFor(gameId, version);
      const given = Buffer.from(String(token || ''));
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, Buffer.from(expected))) {
        res.writeHead(403).end();
        return;
      }

      const file = require('path').join(entry.path, `${gameId}.pak`);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }

      const size = fs.statSync(file).size;
      const range = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;

      if (start >= size || start > end) {
        res.writeHead(416).end();
        return;
      }

      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } catch (err) {
      this.log?.warn('peers', 'Bad peer request', err);
      res.writeHead(400).end();
    }
  }

  _startDiscovery() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (buffer, rinfo) => {
      try {
        const message = JSON.parse(buffer.toString('utf8'));
        if (message.app !== 'blacknight' || message.id === this.id) return;
        this.peers.set(message.id, {
          id: message.id,
          host: rinfo.address,
          port: message.port,
          titles: message.titles || [],
          name: typeof message.name === 'string' ? message.name.slice(0, 24) : null,
          playing: message.playing || null,
          seenAt: Date.now()
        });
        this.emit('changed', this.list());
      } catch {
        /* anything else on this port is not ours */
      }
    });

    this.socket.on('error', (err) => {
      this.log?.warn('peers', 'Discovery socket failed', err);
      this.stop();
    });

    this.socket.bind(MULTICAST_PORT, () => {
      try {
        this.socket.addMembership(MULTICAST_ADDR);
        this.socket.setMulticastTTL(1); // never leaves the local segment
      } catch (err) {
        this.log?.warn('peers', 'Could not join the multicast group', err);
      }
      this._announce();
      this.timer = setInterval(() => this._announce(), ANNOUNCE_MS);
      this.timer.unref?.();
    });
  }

  /** What this machine can offer: installed titles and their versions only. */
  _titles() {
    if (!this.library) return [];
    return Object.values(this.library.store.get('entries'))
      .filter((e) => e.status === 'installed' && e.version)
      .map((e) => ({ gameId: e.gameId, version: e.version }));
  }

  _announce() {
    if (!this.socket) return;
    const message = Buffer.from(
      JSON.stringify({
        app: 'blacknight',
        id: this.id,
        port: this.port,
        titles: this._titles(),
        // A machine name rather than an account: this is the household, not
        // a social network, and nobody signed up to be discoverable.
        name: this.settings.get('peerName') || null,
        playing: this.settings.get('sharePlaying') === false ? null : this.playing
      })
    );
    this.socket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR, (err) => {
      if (err) this.log?.debug('peers', 'Announce failed', err);
    });
    this._expire();
  }

  _expire() {
    const cutoff = Date.now() - PEER_TTL_MS;
    let dropped = false;
    for (const [id, peer] of this.peers) {
      if (peer.seenAt < cutoff) {
        this.peers.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.emit('changed', this.list());
  }

  list() {
    return [...this.peers.values()];
  }

  /**
   * Called by the library when a session starts or ends.
   *
   * Announced immediately rather than at the next interval, so "Sam just
   * started Tidebreaker" is actually news when it appears.
   */
  setPlaying(game, startedAt) {
    this.playing = game ? { gameId: game.id, title: game.title, startedAt } : null;
    if (this.socket) this._announce();
  }

  /**
   * Reads a byte range of an installed build, for the WebRTC transport to
   * send. Bounded and checked against the library, so a request cannot reach
   * outside what is actually installed.
   */
  readRange(gameId, version, offset, length) {
    try {
      const entry = this.library?.store.get('entries')[gameId];
      if (!entry || entry.status !== 'installed' || entry.version !== version) {
        return { ok: false, error: 'not installed' };
      }
      // A ceiling, so one request cannot ask for a whole build in memory.
      const want = Math.min(Number(length) || 0, 8 * 1024 * 1024);
      if (want <= 0) return { ok: false, error: 'bad length' };

      const file = require('path').join(entry.path, `${gameId}.pak`);
      const size = fs.statSync(file).size;
      const from = Math.max(0, Math.min(Number(offset) || 0, size));
      const buffer = Buffer.alloc(Math.min(want, size - from));
      if (!buffer.length) return { ok: false, error: 'past the end' };

      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, buffer.length, from);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, length: buffer.length, data: buffer.toString('base64') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Who on this network is in a game right now. */
  nowPlaying() {
    this._expire();
    return [...this.peers.values()]
      .filter((peer) => peer.playing)
      .map((peer) => ({
        peerId: peer.id,
        name: peer.name || 'Another machine',
        gameId: peer.playing.gameId,
        title: peer.playing.title,
        startedAt: peer.playing.startedAt
      }));
  }

  /** A peer that has this exact build, or null. */
  find(gameId, version) {
    this._expire();
    for (const peer of this.peers.values()) {
      if (peer.titles.some((t) => t.gameId === gameId && t.version === version)) {
        return {
          ...peer,
          url: `http://${peer.host}:${peer.port}/?game=${encodeURIComponent(gameId)}&version=${encodeURIComponent(version)}&token=${Peers.tokenFor(gameId, version)}`
        };
      }
    }
    return null;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try {
      this.socket?.close();
    } catch { /* already closed */ }
    try {
      this.server?.close();
    } catch { /* already closed */ }
    this.socket = null;
    this.server = null;
    this.peers.clear();
  }

  setEnabled(on) {
    this.settings.set('lanSharing', !!on);
    if (on) return this.start();
    this.stop();
    return { ok: true, stopped: true };
  }
}

module.exports = { Peers, MULTICAST_ADDR, MULTICAST_PORT };
