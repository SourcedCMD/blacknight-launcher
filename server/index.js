'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const { Router, json, cors } = require('./lib/http');
const { Accounts } = require('./lib/accounts');
const { Store } = require('./lib/store');
const { upgrade } = require('./lib/ws');

/**
 * The services the launcher already knows how to talk to.
 *
 * Every endpoint here has a client that is built, shipped and tested against
 * fixtures. Nothing in the launcher changes to use this - the three settings
 * that point at it are already there and empty.
 */

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CATALOG_FILE = process.env.CATALOG_FILE || path.join(__dirname, '..', 'electron', 'data', 'catalog.json');
const ORIGIN = process.env.ORIGIN || 'https://sourcedcmd.github.io';

fs.mkdirSync(DATA_DIR, { recursive: true });

const accounts = new Accounts(DATA_DIR);
const crashes = new Store(DATA_DIR, 'crashes', { items: [] });

const log = (level, message, detail) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error') console.error(line, detail || '');
  else console.log(line);
};

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;

/* -------------------------------------------------------------------- */
/* Routes                                                                */

const router = new Router();

router.get('/health', (req, res) => json(res, 200, { ok: true, uptime: Math.round(process.uptime()) }));

/**
 * The slate.
 *
 * Served from a file so this can start as the same document the launcher
 * ships, and become something editable without the client noticing. The
 * launcher validates whatever comes back and keeps its own copy if this is
 * unreachable or wrong, so a bad deploy here cannot empty anyone's store.
 */
router.get('/catalog', (req, res) => {
  try {
    const doc = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    json(res, 200, doc, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    log('error', 'Catalog could not be read', err);
    json(res, 503, { error: 'Catalog unavailable' });
  }
});

/* --- Accounts --------------------------------------------------------- */

router.post('/auth/register', (req, res, { body }) => json(res, 200, accounts.register(body)));
router.post('/auth/login', (req, res, { body }) => json(res, 200, accounts.signIn(body)));
router.post('/auth/logout', (req, res) => json(res, 200, accounts.signOut(bearer(req))));

router.get('/auth/session', (req, res) => {
  const user = accounts.session(bearer(req));
  json(res, user ? 200 : 401, user ? { ok: true, user } : { ok: false });
});

// Always 200: whether an address is registered is not something this endpoint
// should be willing to confirm.
router.post('/auth/reset/request', (req, res, { body }) => {
  const result = accounts.requestReset(body.email);
  log('info', `Password reset requested${result.token ? ' (token issued)' : ''}`);
  // The token is returned only so a mail service can be put in front of this.
  json(res, 200, { ok: true, ...(process.env.RESET_ECHO === '1' ? result : {}) });
});

router.post('/auth/reset/complete', (req, res, { body }) => json(res, 200, accounts.completeReset(body)));

/* --- Passkeys ---------------------------------------------------------- */

router.post('/auth/passkey/challenge', (req, res, { body }) => json(res, 200, accounts.challenge(body.userId)));
router.post('/auth/passkey/register', (req, res, { body }) => json(res, 200, accounts.registerPasskey(body)));

/* --- Entitlements ------------------------------------------------------ */

router.get('/entitlements', (req, res) => json(res, 200, accounts.entitlements(bearer(req))));

/**
 * Grants an entitlement.
 *
 * Guarded by a shared secret rather than a session, because the caller is
 * meant to be a payment processor's webhook rather than a person. Without
 * ADMIN_TOKEN set, nothing can grant anything.
 */
router.post('/entitlements/grant', (req, res, { body }) => {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin || bearer(req) !== admin) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }
  json(res, 200, accounts.grant(body.userId, body.entitlement));
});

/* --- Crash reports ------------------------------------------------------ */

/**
 * Takes what the launcher's reporter sends and nothing more.
 *
 * The client is careful about what it includes - the error, the version, the
 * platform - and this is careful not to store more than arrived.
 */
router.post('/crash', (req, res, { body }) => {
  const items = crashes.get('items');
  items.unshift({
    at: Date.now(),
    version: String(body.version || '').slice(0, 32),
    platform: String(body.platform || '').slice(0, 32),
    electron: String(body.electron || '').slice(0, 32),
    message: String(body.message || '').slice(0, 500),
    stack: String(body.stack || '').slice(0, 4000),
    scope: String(body.scope || '').slice(0, 64)
  });
  // A ring buffer: a crash loop must not fill the disk.
  crashes.set('items', items.slice(0, 2000));
  log('info', `Crash reported: ${items[0].message.slice(0, 80)}`);
  json(res, 200, { ok: true });
});

/** What the studio actually wants: crashes grouped by message. */
router.get('/crash/summary', (req, res) => {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin || bearer(req) !== admin) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }

  const groups = new Map();
  for (const item of crashes.get('items')) {
    const key = `${item.message}|${item.version}`;
    const group = groups.get(key) || { message: item.message, version: item.version, count: 0, lastAt: 0 };
    group.count++;
    group.lastAt = Math.max(group.lastAt, item.at);
    groups.set(key, group);
  }

  json(res, 200, {
    total: crashes.get('items').length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 50)
  });
});

/* -------------------------------------------------------------------- */
/* Rendezvous                                                            */

/**
 * Relays signalling between launchers so they can connect directly.
 *
 * Deliberately dumb: it knows peer ids and which builds they advertise, and
 * forwards offers and answers between them. The builds themselves never come
 * through here - that is the entire point of using WebRTC.
 */
const peers = new Map(); // id -> { connection, titles }

function relay(fromId, message) {
  const target = peers.get(message.to);
  if (!target) return;
  target.connection.send(JSON.stringify({ ...message, from: fromId }));
}

function handleSignal(connection, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === 'hello') {
    if (!message.id) return;
    connection.peerId = message.id;
    peers.set(message.id, { connection, titles: message.titles || [] });
    // Who else here has something, so a client knows who to offer to.
    connection.send(
      JSON.stringify({
        type: 'peers',
        peers: [...peers.entries()]
          .filter(([id]) => id !== message.id)
          .map(([id, peer]) => ({ id, titles: peer.titles }))
      })
    );
    return;
  }

  if (['offer', 'answer', 'ice'].includes(message.type) && connection.peerId) {
    relay(connection.peerId, message);
  }
}

/* -------------------------------------------------------------------- */

const server = http.createServer((req, res) => {
  if (!cors(req, res, ORIGIN)) {
    json(res, 403, { error: 'Origin not allowed' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  router.dispatch(req, res, { log });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/rendezvous') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }

  const connection = upgrade(req, socket, head);
  if (!connection) return;

  connection.onmessage = (raw) => handleSignal(connection, raw);
  connection.onclose = () => {
    if (connection.peerId) peers.delete(connection.peerId);
  };
});

server.listen(PORT, () => {
  log('info', `BlackNight services on http://localhost:${PORT}`);
  log('info', `  catalog       GET  /catalog`);
  log('info', `  accounts      POST /auth/register, /auth/login, /auth/session`);
  log('info', `  entitlements  GET  /entitlements`);
  log('info', `  crashes       POST /crash`);
  log('info', `  rendezvous    WS   /rendezvous`);
  if (!process.env.ADMIN_TOKEN) log('warn', 'ADMIN_TOKEN is unset: granting and the crash summary are closed.');
});

module.exports = { server, accounts, router };
