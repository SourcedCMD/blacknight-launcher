'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

/**
 * Cloud saves, from the launcher's side.
 *
 * The server holds an opaque blob and refuses a push that would overwrite work
 * it has not seen. This is the half that decides what to put in the blob, when
 * to push, and what to do when the server says no.
 *
 * The archive format is deliberately trivial: a JSON document of relative
 * paths and base64 contents, gzipped. Saves are small, there is no dependency
 * to add, and a format nothing else has to read is a format that cannot go
 * subtly wrong against somebody else's implementation.
 *
 * The rule this holds to: never overwrite without being told to. A conflict
 * stops and asks. Losing a save is the worst thing a launcher can do to
 * somebody, and it is worth being slow and annoying to avoid.
 */

const TIMEOUT_MS = 30000;
const MAX_BYTES = 64 * 1024 * 1024;
// A save folder with more files than this is not a save folder.
const MAX_FILES = 2000;

function validUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/* --- The archive --------------------------------------------------------- */

/** Every file under a directory, as paths relative to it. */
function walk(root) {
  const out = [];
  const recurse = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) recurse(full);
      else if (entry.isFile()) out.push(full);
      // Symlinks are skipped: following one out of the save folder would put
      // something unrelated into the archive.
    }
  };
  recurse(root);
  return out;
}

function pack(dir) {
  const files = walk(dir);
  if (files.length > MAX_FILES) throw new Error('That save folder has too many files to sync.');

  const entries = [];
  let total = 0;

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('That save folder is larger than the service accepts.');
    entries.push({
      // Forward slashes so an archive made on Windows unpacks anywhere.
      path: path.relative(dir, file).split(path.sep).join('/'),
      data: bytes.toString('base64')
    });
  }

  const doc = JSON.stringify({ v: 1, entries });
  return zlib.gzipSync(Buffer.from(doc, 'utf8'), { level: 6 }).toString('base64');
}

function unpack(archive, dir) {
  const doc = JSON.parse(zlib.gunzipSync(Buffer.from(archive, 'base64')).toString('utf8'));
  if (doc.v !== 1) throw new Error('That save was written by a newer version of the launcher.');

  for (const entry of doc.entries) {
    // The archive comes from a server, so a path in it is not trusted: it must
    // land inside the target directory and nowhere else.
    const target = path.resolve(dir, entry.path);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error('That save archive contains a path outside the save folder.');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(entry.data, 'base64'));
  }

  return { files: doc.entries.length };
}

/* --- Talking to the service ---------------------------------------------- */

function request(url, { method = 'POST', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const client = url.protocol === 'http:' ? http : https;

    const req = client.request(
      url,
      {
        method,
        timeout: TIMEOUT_MS,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES * 2) {
            req.destroy();
            reject(new Error('the reply was unreasonably large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: the reply was not JSON`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class CloudSaves {
  constructor(library, settings, log) {
    this.library = library;
    this.settings = settings;
    this.log = log;
  }

  _base() {
    return validUrl(this.settings.get('accountsUrl'));
  }

  _enabled() {
    return this.settings.get('cloudSaves') === true && !!this._base() && !!this.settings.get('remoteToken');
  }

  _url(route) {
    const base = this._base();
    return new URL(route.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
  }

  _token() {
    return this.settings.get('remoteToken');
  }

  /** What the launcher last successfully synced for a title. */
  _lastSynced(gameId) {
    return (this.settings.get('cloudSaveState') || {})[gameId] || null;
  }

  _remember(gameId, versionId) {
    const state = { ...(this.settings.get('cloudSaveState') || {}) };
    state[gameId] = versionId;
    this.settings.set('cloudSaveState', state);
  }

  status() {
    if (this.settings.get('cloudSaves') !== true) return { ok: false, reason: 'off' };
    if (!this._base()) return { ok: false, reason: 'not-configured' };
    if (!this._token()) return { ok: false, reason: 'signed-out' };
    return { ok: true };
  }

  /**
   * Uploads the current save.
   *
   * Called after a session ends. A conflict is reported rather than resolved:
   * the launcher asks, because only the person playing knows which machine
   * has the progress they care about.
   */
  async push(gameId) {
    if (!this._enabled()) return this.status();

    const entry = this.library.store.get('entries')[gameId];
    const dir = this.library.savePath(entry);
    if (!dir || !fs.existsSync(dir)) return { ok: false, reason: 'no-saves' };

    let data;
    try {
      data = pack(dir);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    try {
      const { status, body } = await request(this._url('saves/push'), {
        token: this._token(),
        body: {
          gameId,
          data,
          basedOn: this._lastSynced(gameId),
          machine: this.settings.get('peerName') || 'this PC',
          playtimeSeconds: entry?.playtimeSeconds || 0
        }
      });

      if (status === 409) {
        this.log?.info('saves', `${gameId}: another machine has saved since this one last synced`);
        return { ok: false, conflict: body.conflict, error: body.error };
      }
      if (status !== 200) return { ok: false, error: body?.error || `HTTP ${status}` };

      this._remember(gameId, body.version.id);
      this.log?.info('saves', `${gameId}: uploaded ${body.version.sizeBytes} bytes`);
      return { ok: true, version: body.version };
    } catch (err) {
      this.log?.info('saves', `${gameId}: upload failed - ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Downloads a save over the local one.
   *
   * Always takes a local snapshot first, using the backup machinery that
   * already exists, so "the cloud one was older than I thought" is a restore
   * rather than a loss.
   */
  async pull(gameId, versionId = null) {
    if (!this._enabled()) return this.status();

    const entry = this.library.store.get('entries')[gameId];
    const dir = this.library.savePath(entry);
    if (!dir) return { ok: false, error: 'That title is not installed.' };
    if (this.library.sessions.has(gameId)) return { ok: false, error: 'Close the game first.' };

    try {
      const { status, body } = await request(this._url('saves/pull'), {
        token: this._token(),
        body: { gameId, versionId }
      });
      if (status !== 200) return { ok: false, error: body?.error || `HTTP ${status}` };

      // The local one is kept before anything is written over it.
      this.library.backupSaves(gameId);

      fs.mkdirSync(dir, { recursive: true });
      const result = unpack(body.data, dir);

      this._remember(gameId, body.id);
      this.log?.info('saves', `${gameId}: restored ${result.files} files from the cloud`);
      return { ok: true, files: result.files, version: body.id };
    } catch (err) {
      this.log?.info('saves', `${gameId}: download failed - ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** What the service holds, for a settings screen. */
  async usage() {
    if (!this._enabled()) return this.status();
    try {
      const { status, body } = await request(this._url('saves'), { method: 'GET', token: this._token() });
      return status === 200 ? { ok: true, ...body } : { ok: false, error: body?.error };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Checks whether the cloud has something newer before a session starts.
   *
   * Deliberately only reports; it never pulls on its own. Overwriting a local
   * save because a server said so is exactly the behaviour that loses people
   * their progress.
   */
  async check(gameId) {
    if (!this._enabled()) return this.status();
    try {
      const url = this._url('saves/head');
      url.searchParams.set('gameId', gameId);
      const { status, body } = await request(url, { method: 'GET', token: this._token() });
      if (status !== 200) return { ok: false, error: body?.error };

      const head = body.head;
      const known = this._lastSynced(gameId);
      return {
        ok: true,
        head,
        // True when another machine pushed something this one has not seen.
        newer: !!head && head.id !== known
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { CloudSaves, pack, unpack, validUrl };
