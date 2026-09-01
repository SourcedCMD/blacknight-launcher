'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');

/**
 * Tells the service that somebody is playing, so the store can show a count.
 *
 * What is sent: a title id and a random client id. That is the whole payload.
 * No account, no handle, no address beyond the one any HTTP request carries.
 * The client id is generated once, stored locally, and exists only so the
 * server can tell two launchers apart without knowing who either of them is —
 * it is deliberately not the account id, so a count cannot be turned back into
 * a list of who was playing what.
 *
 * Dormant unless two things are true: a URL is configured, and the player has
 * left `sharePlaying` on. Either one off and nothing leaves the machine.
 */

const TIMEOUT_MS = 6000;
const BEAT_MS = 60000;

function validUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

class PresenceCount {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
    this.timers = new Map(); // gameId -> interval
  }

  /** Stable per install, and meaningless anywhere else. */
  _clientId() {
    let id = this.settings.get('presenceClientId');
    if (!id) {
      id = crypto.randomBytes(16).toString('hex');
      this.settings.set('presenceClientId', id);
    }
    return id;
  }

  _enabled() {
    return this.settings.get('sharePlaying') !== false && validUrl(this.settings.get('presenceUrl'));
  }

  _send(gameId) {
    const url = this._enabled();
    if (!url) return;

    const payload = Buffer.from(JSON.stringify({ gameId, clientId: this._clientId() }), 'utf8');
    const client = url.protocol === 'http:' ? http : https;

    const request = client.request(
      url,
      {
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      },
      (response) => response.resume()
    );

    // A count is not worth a single line of noise in the log when it fails.
    request.on('timeout', () => request.destroy());
    request.on('error', () => {});
    request.end(payload);
  }

  /** Starts beating for a title. Safe to call twice. */
  start(gameId) {
    if (this.timers.has(gameId) || !this._enabled()) return;
    this._send(gameId);
    const timer = setInterval(() => this._send(gameId), BEAT_MS);
    // Must never hold the process open at quit.
    timer.unref?.();
    this.timers.set(gameId, timer);
  }

  stop(gameId) {
    const timer = this.timers.get(gameId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(gameId);
    // No goodbye message: the server expires an entry on its own, and a
    // launcher that is killed cannot send one anyway. One code path is better
    // than two, and the two-and-a-half-minute wait is invisible in a count
    // that is rounded to the nearest five.
  }

  stopAll() {
    for (const gameId of [...this.timers.keys()]) this.stop(gameId);
  }
}

module.exports = { PresenceCount, validUrl };
