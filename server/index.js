'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const { Router, json, cors, clientAddress } = require('./lib/http');
const { Accounts } = require('./lib/accounts');
const { Store } = require('./lib/store');
const { upgrade } = require('./lib/ws');
const { Limits } = require('./lib/limits');
const { render } = require('./lib/dashboard');

/**
 * The services the launcher already knows how to talk to.
 *
 * Every endpoint here has a client that is built, shipped and tested against
 * fixtures. Nothing in the launcher changes to use this - the three settings
 * that point at it are already there and empty.
 */

// Not `Number(x) || 8080`: PORT=0 is a legitimate request for an ephemeral
// port, and zero is falsy, so that spelling silently binds 8080 instead.
const PORT = process.env.PORT === undefined || process.env.PORT === '' ? 8080 : Number(process.env.PORT);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CATALOG_FILE = process.env.CATALOG_FILE || path.join(__dirname, '..', 'electron', 'data', 'catalog.json');
const ORIGIN = process.env.ORIGIN || 'https://sourcedcmd.github.io';

fs.mkdirSync(DATA_DIR, { recursive: true });

const accounts = new Accounts(DATA_DIR);
const crashes = new Store(DATA_DIR, 'crashes', { items: [] });

const limits = new Limits();
// Counters for addresses nobody has seen in a while are dropped, so this does
// not slowly become a list of everyone who has ever connected.
const sweeper = setInterval(() => limits.sweep(), 5 * 60000);
sweeper.unref();

/**
 * Applies a rate limit, replying 429 when it bites.
 *
 * Returns false when the caller should stop. Written as a guard rather than
 * middleware because there are six routes and a guard is easier to read than
 * a chain you have to hold in your head.
 */
function within(bucket, req, res) {
  // The functional suite registers dozens of accounts from one address, which
  // is exactly what these limits exist to stop. It runs with them off and the
  // limits are covered by their own unit tests plus a dedicated server that
  // runs with them on - rather than the alternative, which is loosening the
  // production numbers until the tests pass.
  if (process.env.RATE_LIMITS === 'off') return true;

  const result = limits.take(bucket, clientAddress(req));
  if (result.ok) return true;
  json(res, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(result.retryAfter) });
  return false;
}

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

    // Live counts are folded in here rather than fetched separately: the
    // launcher already refreshes the catalog, and the store UI already reads
    // `playersOnline` off a game. A title below the reporting floor simply
    // does not gain the field, and the badge stays hidden.
    const players = counts();
    for (const game of doc.games || []) {
      if (players[game.id]) game.playersOnline = players[game.id];
    }

    // Shorter than the catalog would otherwise be cached for, because the
    // counts are the part that goes stale.
    json(res, 200, doc, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    log('error', 'Catalog could not be read', err);
    json(res, 503, { error: 'Catalog unavailable' });
  }
});

/* --- Accounts --------------------------------------------------------- */

router.post('/auth/register', (req, res, { body }) => {
  if (!within('register', req, res)) return;
  json(res, 200, accounts.register(body));
});
/**
 * Sign in.
 *
 * Two guards before the password is even hashed: a per-address ceiling,
 * because scrypt is expensive and this endpoint is unauthenticated; and a
 * per-account lockout, because that is what actually stops guessing.
 *
 * The lockout reply is identical in shape to a wrong password, so it still
 * cannot be used to work out which accounts exist.
 */
router.post('/auth/login', (req, res, { body }) => {
  if (!within('login', req, res)) return;

  const locked = process.env.RATE_LIMITS === 'off' ? null : limits.locked(body.identifier);
  if (locked) {
    json(res, 429, { error: 'Too many attempts. Try again shortly.' }, { 'Retry-After': String(locked.retryAfter) });
    return;
  }

  try {
    const result = accounts.signIn(body);
    limits.succeed(body.identifier);
    json(res, 200, result);
  } catch (err) {
    if (err.status === 401) {
      const record = limits.fail(body.identifier);
      log('info', `Failed sign-in (${record.count} in a row)`);
    }
    throw err;
  }
});
router.post('/auth/logout', (req, res) => json(res, 200, accounts.signOut(bearer(req))));

router.get('/auth/session', (req, res) => {
  const user = accounts.session(bearer(req));
  json(res, user ? 200 : 401, user ? { ok: true, user } : { ok: false });
});

// Always 200: whether an address is registered is not something this endpoint
// should be willing to confirm.
router.post('/auth/reset/request', (req, res, { body }) => {
  if (!within('reset', req, res)) return;
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
  if (!within('crash', req, res)) return;
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

/** Crashes grouped by message and version, most common first. */
function summarise() {
  const groups = new Map();
  for (const item of crashes.get('items')) {
    const key = `${item.message}|${item.version}`;
    const group = groups.get(key) || { message: item.message, version: item.version, count: 0, lastAt: 0 };
    group.count++;
    group.lastAt = Math.max(group.lastAt, item.at);
    groups.set(key, group);
  }

  return {
    total: crashes.get('items').length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 50)
  };
}

const isAdmin = (req) => {
  const admin = process.env.ADMIN_TOKEN;
  return !!admin && bearer(req) === admin;
};

router.get('/crash/summary', (req, res) => {
  if (!isAdmin(req)) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }
  json(res, 200, summarise());
});

/**
 * The same data with a face on it.
 *
 * Behind the same token as the JSON: a list of what is breaking, and in which
 * version, is not something to leave open. The token can be given as a header
 * or as `?token=` so the page can simply be opened in a browser - which is
 * the only way a dashboard actually gets looked at.
 */
router.get('/crash/dashboard', (req, res, { url }) => {
  const admin = process.env.ADMIN_TOKEN;
  const supplied = bearer(req) || url.searchParams.get('token');
  if (!admin || supplied !== admin) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const html = render(summarise());
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    // A token in a query string should not be sat in a shared cache.
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(html);
});

/* -------------------------------------------------------------------- */
/* Live player counts                                                    */

/**
 * How many people are in each title right now.
 *
 * The launcher already knows when a game starts and stops; this is the only
 * missing half of a number the store UI has been ready to show since it was
 * written. Deliberately thin:
 *
 *   - A heartbeat carries a title id and an opaque client id, and nothing
 *     else. No account, no address, no handle. Two people playing the same
 *     game are indistinguishable here, which is the point.
 *   - Entries expire. A launcher that is killed rather than closed stops
 *     counting on its own within a couple of minutes, so a crash cannot
 *     inflate the number forever.
 *   - Counts are rounded once they are large, and suppressed while they are
 *     tiny, because "3 playing" on a launch day is worse than saying nothing.
 */
const STALE_MS = 150000; // two and a half heartbeats
const presence = new Map(); // gameId -> Map(clientId -> lastSeen)

function heartbeat(gameId, clientId) {
  if (!gameId || !clientId) return;
  const seen = presence.get(gameId) || new Map();
  seen.set(clientId, Date.now());
  presence.set(gameId, seen);
}

function dropStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const [gameId, seen] of presence) {
    for (const [clientId, at] of seen) if (at < cutoff) seen.delete(clientId);
    if (!seen.size) presence.delete(gameId);
  }
}

/** Below the floor nothing is reported, so the field simply stays absent. */
const FLOOR = 5;

function counts() {
  dropStale();
  const out = {};
  for (const [gameId, seen] of presence) {
    if (seen.size < FLOOR) continue;
    // Rounded so the number does not visibly tick with individual people.
    out[gameId] = seen.size < 100 ? Math.round(seen.size / 5) * 5 : Math.round(seen.size / 50) * 50;
  }
  return out;
}

router.post('/presence', (req, res, { body }) => {
  if (!within('default', req, res)) return;
  heartbeat(String(body.gameId || '').slice(0, 64), String(body.clientId || '').slice(0, 64));
  json(res, 200, { ok: true });
});

router.get('/presence', (req, res) => json(res, 200, { players: counts() }, { 'Cache-Control': 'public, max-age=30' }));

const presenceSweeper = setInterval(dropStale, 60000);
presenceSweeper.unref();

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
  // The bound port, not the requested one - with PORT=0 they are different and
  // the bound one is the only useful thing to print.
  const bound = server.address().port;
  log('info', `BlackNight services on http://localhost:${bound}`);
  log('info', `  catalog       GET  /catalog`);
  log('info', `  accounts      POST /auth/register, /auth/login, /auth/session`);
  log('info', `  entitlements  GET  /entitlements`);
  log('info', `  crashes       POST /crash`);
  log('info', `  presence      GET  /presence`);
  log('info', `  crashes       GET  /crash/dashboard?token=...`);
  log('info', `  rendezvous    WS   /rendezvous`);
  if (!process.env.ADMIN_TOKEN) log('warn', 'ADMIN_TOKEN is unset: granting and the crash summary are closed.');
});

module.exports = { server, accounts, router, limits, heartbeat, counts };
