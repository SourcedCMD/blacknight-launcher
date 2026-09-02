'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

/**
 * Screenshots for a title.
 *
 * Until now every image in this launcher was generated. The art is good, but
 * it is not the game - and a store where nobody can see what they are buying
 * is not a store. This is the piece that lets a catalogue entry carry real
 * screenshots.
 *
 * The awkward part is the content security policy, which is `img-src 'self'
 * data:` and deliberately does not permit remote images. Relaxing it so the
 * renderer could load arbitrary URLs would trade a genuinely good security
 * posture for convenience. So the main process fetches instead: once, to a
 * cache on disk, and hands the renderer a data URI.
 *
 * That has three properties worth having. The renderer never talks to a
 * third-party host, so a compromised catalogue cannot use it to phone home.
 * Images work offline after the first fetch. And the CSP stays exactly as
 * strict as it was.
 *
 * Trailers are not fetched. A video is tens of megabytes and belongs in a
 * browser, so a trailer URL is opened externally instead.
 */

const TIMEOUT_MS = 15000;
// Generous for a screenshot, small enough that a bad URL cannot fill a disk.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PER_GAME = 12;

const TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
};

/**
 * Only https, and only something that looks like an image.
 *
 * http is refused as well as the obvious ones: a screenshot fetched over a
 * plain connection can be replaced in transit by anybody on the path, and this
 * one gets handed straight to a renderer as a data URI.
 */
function validImageUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:') return null;
    if (!TYPES[path.extname(url.pathname).toLowerCase()]) return null;
    return url;
  } catch {
    return null;
  }
}

class Media {
  constructor(dir, log) {
    this.dir = path.join(dir, 'media');
    this.log = log;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** A stable filename for a URL, so the same image is fetched once. */
  _cacheFile(url) {
    const hash = crypto.createHash('sha256').update(url.href).digest('hex').slice(0, 32);
    return path.join(this.dir, `${hash}${path.extname(url.pathname).toLowerCase()}`);
  }

  _asDataUri(file) {
    const type = TYPES[path.extname(file).toLowerCase()] || 'image/png';
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  _fetch(url, file) {
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'http:' ? http : https;
      const request = client.get(url, { timeout: TIMEOUT_MS }, (response) => {
        // One redirect hop is normal for a CDN; more than that is a loop or a
        // redirect chain nobody should be following blind.
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          const next = validImageUrl(new URL(response.headers.location, url).href);
          if (!next) return reject(new Error('redirected somewhere that is not an image'));
          return this._fetch(next, file).then(resolve, reject);
        }

        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${response.statusCode}`));
        }

        const type = String(response.headers['content-type'] || '').split(';')[0].trim();
        if (!Object.values(TYPES).includes(type)) {
          response.resume();
          return reject(new Error(`served ${type || 'no content type'}, not an image`));
        }

        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            request.destroy();
            return reject(new Error('that image is unreasonably large'));
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          // Written through a temporary name so an interrupted fetch cannot
          // leave a half-file that is then served forever as if it were good.
          const temp = `${file}.part`;
          fs.writeFileSync(temp, Buffer.concat(chunks));
          fs.renameSync(temp, file);
          resolve(file);
        });
      });

      request.on('timeout', () => request.destroy(new Error('timed out')));
      request.on('error', reject);
    });
  }

  /**
   * Screenshots for a title, as data URIs.
   *
   * Anything that fails is simply left out. A dead link in a catalogue should
   * cost one image, not the whole gallery, and certainly not the page.
   */
  async screenshots(game) {
    const urls = (game?.media?.screenshots || []).slice(0, MAX_PER_GAME);
    if (!urls.length) return [];

    const out = [];
    for (const raw of urls) {
      const url = validImageUrl(raw);
      if (!url) {
        this.log?.info('media', `Refused ${String(raw).slice(0, 80)}: not an https image URL`);
        continue;
      }

      const file = this._cacheFile(url);
      try {
        if (!fs.existsSync(file)) await this._fetch(url, file);
        out.push({ src: this._asDataUri(file), url: url.href });
      } catch (err) {
        this.log?.info('media', `Could not fetch a screenshot: ${err.message}`);
      }
    }
    return out;
  }

  /** What is cached, so a settings screen can offer to clear it. */
  usage() {
    let bytes = 0;
    let count = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        bytes += fs.statSync(path.join(this.dir, name)).size;
        count++;
      }
    } catch { /* nothing cached yet */ }
    return { count, bytes };
  }

  clear() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
    } catch { /* it will be rebuilt on demand anyway */ }
    return { ok: true };
  }
}

module.exports = { Media, validImageUrl, TYPES, MAX_PER_GAME };
