'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * The slate, and the news attached to it.
 *
 * Both used to be baked into the asar, which meant announcing a title, moving
 * a release date or posting an update all required shipping a new installer.
 * Now the launcher prefers a remote document, falls back to the last one it
 * successfully fetched, and falls back again to the copy that shipped with the
 * build - so it is always correct offline and on first run, and current
 * whenever the network allows.
 *
 * A bad remote document is treated as no document at all: a catalog that fails
 * to parse must never take out a launcher that has a perfectly good one on
 * disk already.
 */

const TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024;

class Catalog {
  constructor(dir, bundledPath, settings, log) {
    this.cacheFile = path.join(dir, 'catalog.cache.json');
    this.bundledPath = bundledPath;
    this.settings = settings;
    this.log = log;
    this.data = this._load();
  }

  /** Best available copy at construction time, newest first. */
  _load() {
    for (const [source, read] of [
      ['cache', () => JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))],
      ['bundled', () => JSON.parse(fs.readFileSync(this.bundledPath, 'utf8'))]
    ]) {
      try {
        const parsed = read();
        if (Catalog.valid(parsed)) {
          this.source = source;
          return parsed;
        }
      } catch {
        /* try the next one */
      }
    }
    this.source = 'empty';
    return { games: [], news: [] };
  }

  /**
   * A document is only usable if it actually carries a slate. An empty games
   * array is almost certainly a broken deploy, and swapping a working catalog
   * for it would empty the user's store front.
   */
  static valid(doc) {
    return !!doc && Array.isArray(doc.games) && doc.games.length > 0 && doc.games.every((g) => g && g.id);
  }

  get games() {
    return this.data.games;
  }

  get news() {
    return this.data.news || [];
  }

  /**
   * Fetches the configured URL and adopts it if it parses.
   *
   * Returns what happened rather than throwing: refreshing the catalog is
   * best-effort background work, never a reason to interrupt anyone.
   */
  async refresh() {
    const url = this.settings.get('catalogUrl');
    if (!url) return { ok: false, reason: 'not-configured', source: this.source };

    try {
      const body = await Catalog.fetch(url);
      const parsed = JSON.parse(body);
      if (!Catalog.valid(parsed)) {
        this.log?.warn('catalog', 'Remote catalog was rejected: no usable games array');
        return { ok: false, reason: 'invalid', source: this.source };
      }

      this.data = parsed;
      this.source = 'remote';
      try {
        fs.writeFileSync(this.cacheFile, JSON.stringify(parsed), 'utf8');
      } catch (err) {
        this.log?.warn('catalog', 'Could not cache the catalog', err);
      }

      this.log?.info('catalog', `Updated from ${url}: ${parsed.games.length} titles`);
      return { ok: true, source: 'remote', games: parsed.games.length };
    } catch (err) {
      // Offline is the normal case here, not an error worth shouting about.
      this.log?.info('catalog', `Keeping the ${this.source} catalog: ${err.message}`);
      return { ok: false, reason: 'unreachable', source: this.source };
    }
  }

  static fetch(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('http://') ? http : https;
      const request = client.get(url, { timeout: TIMEOUT_MS }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            request.destroy();
            reject(new Error('catalog is unreasonably large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });

      request.on('timeout', () => request.destroy(new Error('timed out')));
      request.on('error', reject);
    });
  }
}

module.exports = { Catalog };
