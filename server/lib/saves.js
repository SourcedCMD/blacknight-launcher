'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Cloud saves.
 *
 * The launcher already snapshots a save folder locally when a session ends;
 * this is where one of those snapshots goes so a second machine can pick it
 * up. What arrives is an opaque archive — this never opens it, never parses a
 * save format, and never needs to know one.
 *
 * The part that matters is what happens when two machines both have changes.
 * Silently keeping the newest is how people lose a weekend of progress, so a
 * push carries the version it was based on, and a push based on something
 * other than what is here is refused. The launcher is then told there is a
 * conflict and both versions still exist.
 *
 * Every save is kept for a few versions, so "it overwrote my save" is
 * recoverable rather than final.
 */

const MAX_BYTES = 64 * 1024 * 1024;
const KEEP = 5;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** A game id that cannot climb out of its directory. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class Saves {
  constructor(dir) {
    this.root = path.join(dir, 'saves');
    fs.mkdirSync(this.root, { recursive: true });
  }

  _dir(userId, gameId) {
    if (!SAFE_ID.test(String(gameId || ''))) throw fail(400, 'That is not a valid title id.');
    // The user id is a UUID this server generated, but it is joined into a
    // path, so it gets the same treatment rather than being trusted for being
    // ours.
    if (!SAFE_ID.test(String(userId || ''))) throw fail(400, 'Bad account.');
    return path.join(this.root, userId, gameId);
  }

  /** Versions held for a title, newest first. */
  list(userId, gameId) {
    const dir = this._dir(userId, gameId);
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
      .sort((a, b) => b.at - a.at);
  }

  /** What the launcher compares against before deciding to push or pull. */
  head(userId, gameId) {
    return this.list(userId, gameId)[0] || null;
  }

  /**
   * Stores a new version.
   *
   * `basedOn` is the version the machine had when it started playing. If the
   * server has moved on since then, another machine has pushed in the
   * meantime and this would be overwriting it — so it is refused, with both
   * versions named so the launcher can offer a choice.
   */
  push(userId, gameId, { data, basedOn, machine, playtimeSeconds }) {
    const dir = this._dir(userId, gameId);

    const bytes = Buffer.from(String(data || ''), 'base64');
    if (!bytes.length) throw fail(400, 'That save is empty.');
    if (bytes.length > MAX_BYTES) throw fail(413, 'That save is larger than this service accepts.');

    const current = this.head(userId, gameId);
    if (current && basedOn !== current.id) {
      throw Object.assign(new Error('Another machine has saved since this one last synced.'), {
        status: 409,
        conflict: { theirs: current, yours: { basedOn } }
      });
    }

    fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(12).toString('hex');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    fs.writeFileSync(path.join(dir, `${id}.bin`), bytes);
    const record = {
      id,
      at: Date.now(),
      sizeBytes: bytes.length,
      sha256,
      machine: String(machine || '').slice(0, 64),
      playtimeSeconds: Number(playtimeSeconds) || 0
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record));

    // Older versions beyond the keep window are dropped, so this does not grow
    // without limit - but never the newest, whatever happens.
    for (const old of this.list(userId, gameId).slice(KEEP)) {
      fs.rmSync(path.join(dir, `${old.id}.bin`), { force: true });
      fs.rmSync(path.join(dir, `${old.id}.json`), { force: true });
    }

    return record;
  }

  /** Fetches one version, or the newest. */
  pull(userId, gameId, versionId = null) {
    const dir = this._dir(userId, gameId);
    const wanted = versionId ? this.list(userId, gameId).find((v) => v.id === versionId) : this.head(userId, gameId);
    if (!wanted) throw fail(404, 'There is no save here for that title.');

    const file = path.join(dir, `${wanted.id}.bin`);
    if (!fs.existsSync(file)) throw fail(404, 'That version is no longer stored.');

    const bytes = fs.readFileSync(file);
    // Checked on the way out: a corrupted file should be an error, not a save
    // that overwrites a good local one with rubbish.
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== wanted.sha256) {
      throw fail(500, 'That stored save failed its checksum.');
    }

    return { ...wanted, data: bytes.toString('base64') };
  }

  /** Everything this account has stored, for a settings screen. */
  usage(userId) {
    const dir = path.join(this.root, userId);
    if (!fs.existsSync(dir)) return { titles: [], totalBytes: 0 };

    const titles = [];
    let totalBytes = 0;

    for (const gameId of fs.readdirSync(dir)) {
      const versions = this.list(userId, gameId);
      if (!versions.length) continue;
      const bytes = versions.reduce((sum, v) => sum + v.sizeBytes, 0);
      totalBytes += bytes;
      titles.push({ gameId, versions: versions.length, bytes, newest: versions[0].at });
    }

    return { titles: titles.sort((a, b) => b.newest - a.newest), totalBytes };
  }

  remove(userId, gameId) {
    const dir = this._dir(userId, gameId);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }
}

module.exports = { Saves, MAX_BYTES, KEEP };
