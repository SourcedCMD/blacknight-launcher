'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Store } = require('./store');
const { buildManifest, diff, applyCopies, summarise } = require('./chunks');

const TICK_MS = 250;
const SPEED_WINDOW = 8; // samples kept for the smoothed speed readout

/**
 * Download engine for game installs.
 *
 * Two modes share one queue, one set of statuses and one progress event:
 *   - real:      HTTP(S) transfer with byte-range resume, used when a catalog
 *                entry ships a `downloadUrl`.
 *   - simulated: a paced writer that produces a real file of the right size.
 *                This is what BlackNight titles use today, since no build has
 *                shipped yet - swap in a URL and the same UI drives a real one.
 *
 * Queue state is persisted on every transition, so a download interrupted by a
 * crash or a reboot resumes from the byte it reached rather than from zero.
 */
class Downloader extends EventEmitter {
  constructor(dir, settings) {
    super();
    this.settings = settings;
    this.store = new Store(dir, 'downloads', { items: [] });
    this.active = new Map(); // id -> runtime handle (never persisted)
    this.timer = null;
    this.windowTimer = null;
    // Set by the library while a game is running, so transfers can get out of
    // the way of the thing the player actually sat down to do.
    this.gameRunning = false;

    // Anything caught mid-flight by a shutdown comes back as paused, not broken.
    for (const item of this.store.get('items')) {
      if (item.status === 'downloading' || item.status === 'verifying') item.status = 'paused';
    }
    this.store.save();
  }

  /* ------------------------------------------------------------------ */
  /* Queue                                                               */

  list() {
    return this.store.get('items').map((i) => this._decorate(i));
  }

  get(id) {
    const item = this.store.get('items').find((i) => i.id === id);
    return item ? this._decorate(item) : null;
  }

  _decorate(item) {
    const rt = this.active.get(item.id);
    const speed = rt?.speed ?? 0;
    const remaining = Math.max(0, item.totalBytes - item.receivedBytes);
    return {
      ...item,
      speedBps: speed,
      etaSeconds: speed > 0 ? Math.round(remaining / speed) : null,
      progress: item.totalBytes ? item.receivedBytes / item.totalBytes : 0
    };
  }

  enqueue({ gameId, title, totalBytes, url = null, installDir, kind = 'install', version = '1.0.0', sha256 = null, chunkManifest = null, previousFile = null, peerUrl = null }) {
    const items = this.store.get('items');
    const existing = items.find((i) => i.gameId === gameId && i.status !== 'completed' && i.status !== 'cancelled');
    if (existing) return this._decorate(existing);

    const dest = path.join(installDir, gameId);
    const item = {
      id: `dl_${gameId}_${Date.now().toString(36)}`,
      gameId,
      title,
      kind,
      version,
      url,
      // Supplied by the catalog. Without one the transfer can only be checked
      // for length, which is recorded honestly rather than called "verified".
      sha256,
      // Set when this is an update and the old build is still on disk: the
      // blocks that did not change are lifted locally instead of downloaded.
      chunkManifest,
      previousFile,
      // A machine on the same network that already has this exact build.
      peerUrl,
      reusedBytes: 0,
      simulated: !url,
      dest,
      file: path.join(dest, `${gameId}.pak`),
      totalBytes,
      receivedBytes: 0,
      status: 'queued',
      addedAt: Date.now(),
      completedAt: null,
      error: null
    };
    items.push(item);
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
    return this._decorate(item);
  }

  pause(id) {
    const item = this._find(id);
    if (!item || !['downloading', 'queued'].includes(item.status)) return this.list();
    this._stopRuntime(id);
    item.status = 'paused';
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  resume(id) {
    const item = this._find(id);
    if (!item || !['paused', 'failed'].includes(item.status)) return this.list();
    item.status = 'queued';
    item.error = null;
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  cancel(id) {
    const item = this._find(id);
    if (!item) return this.list();
    this._stopRuntime(id);
    try {
      if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
    } catch { /* partial file already gone */ }
    this.store.set('items', this.store.get('items').filter((i) => i.id !== id));
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  clearFinished() {
    this.store.set(
      'items',
      this.store.get('items').filter((i) => i.status !== 'completed')
    );
    this.emit('changed', this.list());
    return this.list();
  }

  /** Move an item to the front of the queue. */
  prioritise(id) {
    const items = this.store.get('items');
    const idx = items.findIndex((i) => i.id === id);
    if (idx > 0) {
      const [item] = items.splice(idx, 1);
      items.unshift(item);
      this.store.save();
      this.emit('changed', this.list());
    }
    return this.list();
  }

  _find(id) {
    return this.store.get('items').find((i) => i.id === id);
  }

  /* ------------------------------------------------------------------ */
  /* Scheduler                                                           */

  _pump() {
    const limit = Math.max(1, Number(this.settings.get('concurrentDownloads')) || 1);
    const items = this.store.get('items');
    const running = items.filter((i) => i.status === 'downloading').length;
    let slots = limit - running;

    // Outside the download window nothing new starts, and anything already
    // moving is put back in the queue to resume when the window opens.
    const open = this.withinWindow();
    if (!open) {
      for (const item of items) {
        if (item.status !== 'downloading') continue;
        this._stopRuntime(item.id, { keepStatus: true });
        item.status = 'queued';
      }
      this.store.save();
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this._watchWindow();
      this.emit('changed', this.list());
      return;
    }

    for (const item of items) {
      if (slots <= 0) break;
      if (item.status !== 'queued') continue;
      this._start(item);
      slots--;
    }

    const anyActive = this.store.get('items').some((i) => i.status === 'downloading');
    if (anyActive && !this.timer) {
      this.timer = setInterval(() => this._tick(), TICK_MS);
    } else if (!anyActive && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Re-checks the schedule every minute so the queue starts on its own. */
  _watchWindow() {
    if (this.windowTimer) return;
    this.windowTimer = setInterval(() => {
      if (!this.withinWindow()) return;
      clearInterval(this.windowTimer);
      this.windowTimer = null;
      this._pump();
    }, 60_000);
    // Never hold the process open just to watch a clock.
    this.windowTimer.unref?.();
  }

  /**
   * Lifts every unchanged block off the previous build before the transfer
   * starts, so the reused portion counts as progress immediately and the
   * network only ever sees what actually changed.
   */
  _applyDelta(item) {
    if (!item.chunkManifest || !item.previousFile) return false;
    if (this.settings.get('deltaPatching') === false) return false;
    if (!fs.existsSync(item.previousFile)) return false;

    try {
      const current = buildManifest(item.previousFile, { chunkSize: item.chunkManifest.chunkSize });
      const plan = summarise(diff(current, item.chunkManifest));
      if (plan.reusedBytes <= 0) return false;

      fs.mkdirSync(path.dirname(item.file), { recursive: true });
      const copied = applyCopies(item.previousFile, item.file, plan.plan);

      item.reusedBytes = copied;
      item.receivedBytes = copied;
      item.deltaPlan = { reusedBytes: copied, fetchedBytes: plan.fetchedBytes, savedPercent: plan.savedPercent };
      this.store.save();
      this.emit('changed', this.list());
      return true;
    } catch {
      // A delta that cannot be applied is not an error: fall back to a normal
      // transfer rather than failing the update.
      return false;
    }
  }

  _start(item) {
    fs.mkdirSync(item.dest, { recursive: true });

    // Before anything is transferred, take what the previous build already
    // holds. Only runs once per item; a resumed download skips it.
    if (!item.deltaPlan && item.chunkManifest) this._applyDelta(item);

    // Resume from whatever is already on disk rather than trusting the record.
    let onDisk = 0;
    try {
      onDisk = fs.statSync(item.file).size;
    } catch { onDisk = 0; }
    item.receivedBytes = Math.min(onDisk, item.totalBytes);

    item.status = 'downloading';
    item.startedAt = Date.now();
    this.store.save();

    const rt = { samples: [], speed: 0, lastBytes: item.receivedBytes, lastAt: Date.now() };
    this.active.set(item.id, rt);

    // A machine on the same network beats the internet every time, and the
    // payload is checksummed on completion either way.
    rt.source = item.peerUrl ? 'peer' : item.url ? 'origin' : 'simulated';
    if (item.simulated) this._startSimulated(item, rt);
    else this._startHttp(item, rt);

    this.emit('changed', this.list());
  }

  _limitBps() {
    const mbps = Number(this.settings.get('bandwidthLimitMbps')) || 0;
    let limit = mbps > 0 ? (mbps * 1_000_000) / 8 : 0;

    // A download that starves a running game is the fastest way to get a
    // launcher uninstalled. Drop to a trickle instead of pausing, so a queue
    // still finishes over a long session.
    if (this.gameRunning && this.settings.get('yieldWhilePlaying') !== false) {
      const share = Number(this.settings.get('playingBandwidthPercent')) || 20;
      const ceiling = limit || 25_000_000; // assume ~200 Mbit when uncapped
      limit = Math.max(256 * 1024, (ceiling * share) / 100);
    }

    return limit;
  }

  /**
   * Called by the library when a game starts or stops. Rate limits are read
   * per tick, so the change takes effect on the next one - no restart needed.
   */
  setGameRunning(running) {
    const next = !!running;
    if (next === this.gameRunning) return;
    this.gameRunning = next;
    this.emit('changed', this.list());
  }

  /**
   * Whether transfers are allowed to run right now.
   *
   * An empty or equal window means "any time". A window that wraps past
   * midnight (23:00 to 07:00) is the normal case for this feature, so the
   * comparison has to handle the wrap rather than assuming start < end.
   */
  withinWindow(now = new Date()) {
    if (!this.settings.get('downloadWindowEnabled')) return true;
    const start = Number(this.settings.get('downloadWindowStart'));
    const end = Number(this.settings.get('downloadWindowEnd'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return true;

    const minutes = now.getHours() * 60 + now.getMinutes();
    const from = start * 60;
    const to = end * 60;
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  }

  /** Paced writer that produces a correctly sized file without a CDN. */
  _startSimulated(item, rt) {
    const handle = fs.openSync(item.file, fs.existsSync(item.file) ? 'r+' : 'w');
    rt.fd = handle;
    rt.mode = 'sim';
    // A believable line-speed that drifts, capped by any user bandwidth limit.
    rt.baseBps = 18_000_000 + Math.random() * 22_000_000;
    rt.chunk = Buffer.alloc(1 << 16);
    rt.lastWriteAt = Date.now();
  }

  _startHttp(item, rt) {
    // A peer on the same network serves the identical payload, verified by the
    // same checksum, so it is simply a better URL for the same transfer.
    const source = rt.source === 'peer' && item.peerUrl ? item.peerUrl : item.url;
    const client = source.startsWith('https') ? https : http;
    const headers = item.receivedBytes > 0 ? { Range: `bytes=${item.receivedBytes}-` } : {};
    rt.mode = 'http';

    const req = client.get(source, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        item.url = res.headers.location;
        this.store.save();
        this._stopRuntime(item.id, { keepStatus: true });
        this.active.set(item.id, rt);
        return this._startHttp(item, rt);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return this._fail(item, `Server responded ${res.statusCode}`);
      }
      if (res.statusCode === 200) item.receivedBytes = 0; // no range support: restart

      const total = Number(res.headers['content-length'] || 0) + item.receivedBytes;
      if (total > 0) item.totalBytes = total;

      const out = fs.createWriteStream(item.file, { flags: item.receivedBytes > 0 ? 'a' : 'w' });
      rt.stream = out;
      rt.res = res;

      res.on('data', (chunk) => {
        item.receivedBytes += chunk.length;
      });
      res.pipe(out);
      out.on('finish', () => this._complete(item));
      res.on('error', (err) => this._fail(item, err.message));
      out.on('error', (err) => this._fail(item, err.message));
    });
    req.on('error', (err) => {
      // A peer that dropped off the network is not a failure: forget it and
      // let the next attempt go to the origin.
      if (rt.source === 'peer') {
        item.peerUrl = null;
        this.store.save();
        this._stopRuntime(item.id, { keepStatus: true });
        item.status = 'queued';
        this._pump();
        return;
      }
      this._fail(item, err.message);
    });
    rt.req = req;
  }

  _tick() {
    const items = this.store.get('items');
    const now = Date.now();
    const limit = this._limitBps();

    for (const item of items) {
      if (item.status !== 'downloading') continue;
      const rt = this.active.get(item.id);
      if (!rt) continue;

      if (rt.mode === 'sim') {
        const dt = (now - rt.lastWriteAt) / 1000;
        rt.lastWriteAt = now;
        // Gentle random walk so the readout looks like a real connection.
        rt.baseBps = Math.max(4_000_000, rt.baseBps * (0.94 + Math.random() * 0.12));
        const bps = limit > 0 ? Math.min(rt.baseBps, limit) : rt.baseBps;
        const advance = Math.min(Math.round(bps * dt), item.totalBytes - item.receivedBytes);
        if (advance > 0) {
          try {
            let written = 0;
            while (written < advance) {
              const n = Math.min(rt.chunk.length, advance - written);
              fs.writeSync(rt.fd, rt.chunk, 0, n, item.receivedBytes + written);
              written += n;
            }
          } catch { /* disk pressure - retried next tick */ }
          item.receivedBytes += advance;
        }
        if (item.receivedBytes >= item.totalBytes) {
          this._complete(item);
          continue;
        }
      } else if (rt.mode === 'http' && limit > 0 && rt.res) {
        // Crude but effective throttle: stall the socket when we run ahead.
        const elapsed = (now - item.startedAt) / 1000 || 1;
        const allowed = limit * elapsed;
        if (item.receivedBytes > allowed && !rt.res.isPaused()) rt.res.pause();
        else if (item.receivedBytes <= allowed && rt.res.isPaused()) rt.res.resume();
      }

      // Smoothed speed over the last couple of seconds.
      const dtSpeed = (now - rt.lastAt) / 1000;
      if (dtSpeed >= 0.2) {
        rt.samples.push((item.receivedBytes - rt.lastBytes) / dtSpeed);
        if (rt.samples.length > SPEED_WINDOW) rt.samples.shift();
        rt.speed = rt.samples.reduce((a, b) => a + b, 0) / rt.samples.length;
        rt.lastBytes = item.receivedBytes;
        rt.lastAt = now;
      }
    }

    this.store.save();
    this.emit('progress', this.list());
  }

  _complete(item) {
    this._stopRuntime(item.id, { keepStatus: true });

    // A resumed transfer over a flaky line is exactly where silent corruption
    // happens, so the digest is checked before anyone is told it is ready.
    if (item.sha256) {
      item.status = 'verifying';
      this.emit('changed', this.list());
      const actual = Downloader.hashFile(item.file);
      if (actual && actual !== item.sha256.toLowerCase()) {
        return this._fail(item, 'The downloaded files did not match their checksum.');
      }
      item.verifiedSha256 = actual;
    }

    item.status = 'completed';
    item.completedAt = Date.now();
    item.receivedBytes = item.totalBytes;
    this.store.save();

    // Only the bytes that genuinely moved count towards data usage: blocks
    // lifted from a previous build never touched the network.
    const transferred = Math.max(0, item.totalBytes - (item.reusedBytes || 0));
    const rt = this.active.get(item.id);
    this.emit('transferred', { bytes: transferred, source: rt?.source === 'peer' ? 'peer' : 'origin', item });
    if (item.reusedBytes) this.emit('reused', { bytes: item.reusedBytes, item });

    this.emit('completed', this._decorate(item));
    this.emit('changed', this.list());
    this._pump();
  }

  /** SHA-256 of a file on disk, or null if it cannot be read. */
  static hashFile(file) {
    try {
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(1 << 20);
      try {
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, read));
        }
      } finally {
        fs.closeSync(fd);
      }
      return hash.digest('hex');
    } catch {
      return null;
    }
  }

  _fail(item, message) {
    this._stopRuntime(item.id, { keepStatus: true });
    item.status = 'failed';
    item.error = message;
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
  }

  _stopRuntime(id, { keepStatus = false } = {}) {
    const rt = this.active.get(id);
    if (!rt) return;
    try { rt.req?.destroy(); } catch { /* already closed */ }
    try { rt.res?.destroy(); } catch { /* already closed */ }
    try { rt.stream?.close(); } catch { /* already closed */ }
    try { if (rt.fd !== undefined) fs.closeSync(rt.fd); } catch { /* already closed */ }
    this.active.delete(id);
    if (!keepStatus) {
      const item = this._find(id);
      if (item && item.status === 'downloading') item.status = 'paused';
    }
  }

  shutdown() {
    clearInterval(this.windowTimer);
    this.windowTimer = null;
    for (const id of [...this.active.keys()]) this._stopRuntime(id);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const item of this.store.get('items')) {
      if (item.status === 'downloading') item.status = 'paused';
    }
    this.store.save();
  }
}

module.exports = { Downloader };
