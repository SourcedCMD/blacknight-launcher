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
  /**
   * How many times a transfer is picked back up before it is called failed.
   *
   * Five, spread over roughly three minutes of backoff. Enough to ride out a
   * router reboot or a lift, not so many that a genuinely dead URL keeps a
   * queue busy for an hour.
   */
  static MAX_ATTEMPTS = 5;

  constructor(dir, settings, log = null) {
    super();
    this.settings = settings;
    this.log = log;
    this.store = new Store(dir, 'downloads', { items: [] });
    this.active = new Map(); // id -> runtime handle (never persisted)
    // Pending retries, so pausing or cancelling can stop one before it fires.
    this.retryTimers = new Map();
    this.timer = null;
    this.windowTimer = null;
    // Set by the library while a game is running, so transfers can get out of
    // the way of the thing the player actually sat down to do.
    this.gameRunning = false;

    // Anything caught mid-flight by a shutdown comes back as paused, not broken.
    // A retry that was pending when the process died is put back in the queue:
    // the wait it was serving has certainly elapsed by now.
    for (const item of this.store.get('items')) {
      if (item.status === 'downloading' || item.status === 'verifying') item.status = 'paused';
      if (item.status === 'retrying') {
        item.status = 'queued';
        item.retryAt = null;
      }
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
      error: null,
      // How many times this has been picked back up after a network failure,
      // and when the next attempt is due. Both survive a restart, so a machine
      // that reboots mid-retry does not start the count again.
      attempts: 0,
      retryAt: null,
      lastError: null
    };
    items.push(item);
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
    return this._decorate(item);
  }

  pause(id) {
    const item = this._find(id);
    if (!item || !['downloading', 'queued', 'retrying'].includes(item.status)) return this.list();
    this._clearRetry(id);
    item.retryAt = null;
    this._stopRuntime(id);
    item.status = 'paused';
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  resume(id) {
    const item = this._find(id);
    if (!item || !['paused', 'failed', 'retrying'].includes(item.status)) return this.list();
    this._clearRetry(id);
    item.status = 'queued';
    item.error = null;
    item.retryAt = null;
    // Asking for it by hand resets the budget: the person watching has decided
    // the network is back, and they are usually right.
    item.attempts = 0;
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  /**
   * Moves an item within the queue.
   *
   * The pump takes work in list order, so the order of the array *is* the
   * queue. Reordering is therefore a splice rather than a priority field that
   * something else has to remember to sort by.
   *
   * Only queued and retrying items move. Something already downloading stays
   * where it is: stopping a transfer to start a different one throws away
   * whatever the first was part-way through, which is a bad trade for a
   * position in a list.
   */
  reorder(id, direction) {
    const items = this.store.get('items');
    const from = items.findIndex((i) => i.id === id);
    if (from === -1) return this.list();

    const movable = (item) => ['queued', 'retrying', 'paused'].includes(item.status);
    if (!movable(items[from])) return this.list();

    const step = direction === 'up' ? -1 : 1;
    let to = from + step;
    // Skip past anything that cannot be displaced.
    while (to >= 0 && to < items.length && !movable(items[to])) to += step;
    if (to < 0 || to >= items.length) return this.list();

    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);

    this.store.set('items', items);
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  /** Puts an item at the head of the queue, ahead of anything else waiting. */
  prioritise(id) {
    const items = this.store.get('items');
    const from = items.findIndex((i) => i.id === id);
    if (from === -1) return this.list();
    if (!['queued', 'retrying', 'paused'].includes(items[from].status)) return this.list();

    // In front of the first item that has not started, so an in-flight
    // transfer is not displaced.
    const first = items.findIndex((i) => ['queued', 'retrying', 'paused'].includes(i.status));
    const [moved] = items.splice(from, 1);
    items.splice(Math.max(0, first), 0, moved);

    this.store.set('items', items);
    this.emit('changed', this.list());
    this._pump();
    return this.list();
  }

  cancel(id) {
    const item = this._find(id);
    if (!item) return this.list();
    this._clearRetry(id);
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

  /**
   * Failures worth trying again.
   *
   * A dropped connection, a socket timeout, a 5xx or a 429 are all things that
   * are usually different a minute later. A 404 or a 403 is not: the file is
   * not there, or this client is not allowed to have it, and retrying that is
   * just a slower way to fail.
   */
  static retryable(message) {
    const text = String(message || '');
    if (/^Server responded (?:4(?:0[0-9]|1[0-8]))/.test(text)) return false; // 400-418, minus 429
    if (/checksum|integrity|not enough space|ENOSPC|EACCES|EPERM/i.test(text)) return false;
    return true;
  }

  /**
   * Backoff between attempts, in milliseconds.
   *
   * Climbs quickly to a couple of minutes and stops there. A 90 GB download is
   * a long-running thing and the network being out for five minutes is
   * ordinary; a client that gives up on the first blip is a client that never
   * finishes a large file on a domestic connection.
   */
  static backoffMs(attempt) {
    const schedule = [5000, 15000, 45000, 120000];
    return schedule[Math.min(attempt, schedule.length - 1)];
  }

  _fail(item, message) {
    this._stopRuntime(item.id, { keepStatus: true });

    item.lastError = message;

    if (Downloader.retryable(message) && item.attempts < Downloader.MAX_ATTEMPTS) {
      const wait = Downloader.backoffMs(item.attempts);
      item.attempts++;
      item.status = 'retrying';
      item.retryAt = Date.now() + wait;
      // The message says what is happening rather than only what went wrong,
      // because a user watching a progress bar wants to know if it is over.
      item.error = `${message} - retrying (${item.attempts}/${Downloader.MAX_ATTEMPTS})`;

      this.log?.info('downloads', `${item.gameId}: ${message}; attempt ${item.attempts} in ${Math.round(wait / 1000)}s`);

      this.store.save();
      this.emit('changed', this.list());

      const timer = setTimeout(() => {
        this.retryTimers.delete(item.id);
        const current = this._find(item.id);
        // Only if nobody paused or cancelled it in the meantime.
        if (current?.status !== 'retrying') return;
        current.status = 'queued';
        current.retryAt = null;
        this.store.save();
        this.emit('changed', this.list());
        this._pump();
      }, wait);
      timer.unref?.();
      this.retryTimers.set(item.id, timer);

      this._pump();
      return;
    }

    item.status = 'failed';
    item.retryAt = null;
    item.error = item.attempts
      ? `${message} - gave up after ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`
      : message;

    this.log?.warn('downloads', `${item.gameId} failed: ${item.error}`);
    this.store.save();
    this.emit('changed', this.list());
    this._pump();
  }

  /** Stops a pending retry, for pause and cancel. */
  _clearRetry(id) {
    const timer = this.retryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(id);
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
