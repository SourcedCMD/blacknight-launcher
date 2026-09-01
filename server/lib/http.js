'use strict';

/**
 * The small amount of HTTP plumbing the services need.
 *
 * No framework, matching the launcher: a router that dispatches on method and
 * path, JSON in and out, and a body reader with a ceiling so a request cannot
 * ask the process to buffer something enormous.
 */

const MAX_BODY = 2 * 1024 * 1024;

/** Reads and parses a JSON body, or throws something the router can report. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('Body was not JSON'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function json(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(text);
}

/**
 * CORS for the launcher and the site.
 *
 * The launcher sends `Origin: file://` or its own scheme, so an allowlist of
 * web origins plus a permissive fallback for non-web callers is the shape that
 * actually works here.
 */
function cors(req, res, allowedOrigin) {
  const origin = req.headers.origin;
  const allow = !origin || origin === allowedOrigin || origin.startsWith('file://') ? origin || '*' : null;
  if (!allow) return false;

  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  return true;
}

/**
 * A router that dispatches on `METHOD /path`.
 *
 * Handlers get `(req, res, context)` where context carries the parsed body,
 * the URL and whatever the server passes in. Anything a handler throws with a
 * `status` becomes that reply; anything else is a 500 and a log line.
 */
class Router {
  constructor() {
    this.routes = new Map();
  }

  on(method, path, handler) {
    this.routes.set(`${method} ${path}`, handler);
    return this;
  }

  get(path, handler) {
    return this.on('GET', path, handler);
  }

  post(path, handler) {
    return this.on('POST', path, handler);
  }

  async dispatch(req, res, context = {}) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;
    const handler = this.routes.get(key);

    if (!handler) {
      json(res, 404, { error: 'Not found' });
      return;
    }

    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      await handler(req, res, { ...context, url, body, json: (s, b) => json(res, s, b) });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) context.log?.('error', `${key} failed`, err);
      json(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  }
}

/**
 * The address a request came from.
 *
 * Behind a reverse proxy the socket address is the proxy, so the forwarded
 * header is used when one is present - but only the first entry, and only when
 * TRUST_PROXY is set. A client can send `X-Forwarded-For` itself, so trusting
 * it unconditionally would let anyone forge their way around a rate limit.
 */
function clientAddress(req, trustProxy = process.env.TRUST_PROXY === '1') {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = { Router, readJson, json, cors, clientAddress, MAX_BODY };
