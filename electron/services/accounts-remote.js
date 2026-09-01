'use strict';
const https = require('https');
const http = require('http');

/**
 * The client for the account service in `server/`.
 *
 * Scoped deliberately narrowly. The launcher's own accounts are local and stay
 * local; this exists so a passkey can be enrolled against a real server rather
 * than being invented in the renderer. When `accountsUrl` is empty — which is
 * the default — every call here reports `not-configured` and nothing in the UI
 * pretends otherwise.
 *
 * Kept in the main process rather than the renderer because the renderer's CSP
 * forbids reaching arbitrary origins, and because a URL from settings should be
 * validated somewhere that a compromised page cannot rewrite.
 */

const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

/**
 * Only http and https, and nothing that could be turned into a file read or a
 * request to a local socket by way of a stray scheme.
 */
function validUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function postJson(url, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const client = url.protocol === 'http:' ? http : https;

    const request = client.request(
      url,
      {
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            request.destroy();
            reject(new Error('the response was unreasonably large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: response.statusCode, body: JSON.parse(text) });
          } catch {
            reject(new Error(`HTTP ${response.statusCode}: the reply was not JSON`));
          }
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

class RemoteAccounts {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
  }

  /** The configured base, or null when the feature is dormant. */
  _base() {
    return validUrl(this.settings.get('accountsUrl'));
  }

  async _call(route, body, token = null) {
    const base = this._base();
    if (!base) return { ok: false, reason: 'not-configured' };

    try {
      const url = new URL(route.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
      const { status, body: reply } = await postJson(url, body, token);
      if (status !== 200) return { ok: false, error: reply?.error || `HTTP ${status}` };
      return { ok: true, ...reply };
    } catch (err) {
      this.log?.info('accounts', `${route} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  passkeyChallenge(userId) {
    return this._call('auth/passkey/challenge', { userId });
  }

  passkeyRegister(payload) {
    return this._call('auth/passkey/register', payload);
  }

  /** A challenge to sign in with. Names no account, by design. */
  passkeyLoginChallenge() {
    return this._call('auth/passkey/login-challenge', {});
  }

  passkeyLogin(payload) {
    return this._call('auth/passkey/login', payload);
  }

  passkeyRemove(token, credentialId) {
    return this._call('auth/passkey/remove', { credentialId }, token);
  }
}

module.exports = { RemoteAccounts, validUrl };
