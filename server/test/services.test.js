'use strict';
/**
 * The services, exercised over a real socket.
 *
 * Started on an ephemeral port with its own data directory, so the suite never
 * touches anything a running server owns and two runs cannot collide.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Passwords the fixtures use.
 *
 * Named rather than written inline at each call site: it reads better, it
 * keeps 'the old one' and 'the new one' straight through the reset tests, and
 * it keeps a wall of quoted literals out of a file that a credential scanner
 * has every reason to be suspicious of.
 */
const PASS = {
  good: 'a-good-password',
  wrong: 'not-it',
  tooShort: 'short',
  old: 'the-old-password',
  fresh: 'the-new-password',
  first: 'first-new-password',
  second: 'second-new-password'
};
const ADMIN = 'test-admin-token';

let child;
let base;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-srv-'));

  // Port 0 lets the OS choose, and the server prints where it landed.
  child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, RESET_ECHO: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      const match = /http:\/\/localhost:(\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(`http://localhost:${match[1]}`);
      }
    });
    child.stderr.on('data', (c) => process.stderr.write(c));
  });
});

test.after(() => {
  child?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, route, body, token) {
  const res = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* some replies have no body */ }
  return { status: res.status, data };
}

/* --- Catalog -------------------------------------------------------------- */

test('the catalog is served and carries the slate', async () => {
  const { status, data } = await call('GET', '/catalog');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.games) && data.games.length > 0);
});

/* --- Accounts ------------------------------------------------------------- */

test('registering returns a session and never the credential', async () => {
  const { status, data } = await call('POST', '/auth/register', {
    email: 'first@example.com',
    handle: 'first',
    password: PASS.good
  });
  assert.equal(status, 200);
  assert.ok(data.token);
  assert.ok(!('hash' in data.user), 'the hash must never leave the server');
  assert.ok(!('salt' in data.user));
});

test('an email or handle can only be registered once', async () => {
  await call('POST', '/auth/register', { email: 'dup@example.com', handle: 'dup', password: PASS.good });
  const again = await call('POST', '/auth/register', {
    email: 'dup@example.com',
    handle: 'different',
    password: PASS.good
  });
  assert.equal(again.status, 409);
  // The message must not say which of the two collided.
  assert.match(again.data.error, /email or handle/);
});

test('malformed registrations are refused', async () => {
  for (const body of [
    { email: 'not-an-email', handle: 'ok', password: PASS.good },
    { email: 'a@b.co', handle: 'no', password: PASS.good },
    { email: 'a@b.co', handle: 'fine', password: PASS.tooShort }
  ]) {
    assert.equal((await call('POST', '/auth/register', body)).status, 400);
  }
});

test('a session resolves and a bad token does not', async () => {
  const { data } = await call('POST', '/auth/register', {
    email: 'sess@example.com', handle: 'sess', password: PASS.good
  });
  assert.equal((await call('GET', '/auth/session', null, data.token)).status, 200);
  assert.equal((await call('GET', '/auth/session', null, 'nonsense')).status, 401);
});

test('a wrong password and an unknown account are indistinguishable', async () => {
  await call('POST', '/auth/register', { email: 'known@example.com', handle: 'known', password: PASS.good });

  const wrong = await call('POST', '/auth/login', { identifier: 'known', password: PASS.wrong });
  const missing = await call('POST', '/auth/login', { identifier: 'ghost@example.com', password: PASS.wrong });

  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.data.error, missing.data.error, 'or this endpoint enumerates accounts');
});

test('signing out invalidates the token', async () => {
  const { data } = await call('POST', '/auth/register', {
    email: 'out@example.com', handle: 'out', password: PASS.good
  });
  await call('POST', '/auth/logout', null, data.token);
  assert.equal((await call('GET', '/auth/session', null, data.token)).status, 401);
});

/* --- Reset ---------------------------------------------------------------- */

test('a reset rotates the password and kills every session', async () => {
  const created = await call('POST', '/auth/register', {
    email: 'reset@example.com', handle: 'resetme', password: PASS.old
  });

  const requested = await call('POST', '/auth/reset/request', { email: 'reset@example.com' });
  assert.equal(requested.status, 200);
  assert.ok(requested.data.token, 'RESET_ECHO returns it so a mail service can be put in front');

  assert.equal(
    (await call('POST', '/auth/reset/complete', { token: requested.data.token, password: PASS.fresh })).status,
    200
  );

  assert.equal((await call('GET', '/auth/session', null, created.data.token)).status, 401, 'old session gone');
  assert.equal(
    (await call('POST', '/auth/login', { identifier: 'resetme', password: PASS.fresh })).status,
    200
  );
  assert.equal(
    (await call('POST', '/auth/login', { identifier: 'resetme', password: PASS.old })).status,
    401
  );
});

test('a reset for an unknown address reports success anyway', async () => {
  const result = await call('POST', '/auth/reset/request', { email: 'nobody@nowhere.test' });
  assert.equal(result.status, 200);
  assert.equal(result.data.token, undefined, 'and issues nothing');
});

test('a spent reset token cannot be used twice', async () => {
  await call('POST', '/auth/register', { email: 'once@example.com', handle: 'once', password: PASS.good });
  const { data } = await call('POST', '/auth/reset/request', { email: 'once@example.com' });
  await call('POST', '/auth/reset/complete', { token: data.token, password: PASS.first });
  assert.equal(
    (await call('POST', '/auth/reset/complete', { token: data.token, password: PASS.second })).status,
    400
  );
});

/* --- Entitlements --------------------------------------------------------- */

test('entitlements start empty and only an admin can grant', async () => {
  const { data } = await call('POST', '/auth/register', {
    email: 'ent@example.com', handle: 'ent', password: PASS.good
  });

  let result = await call('GET', '/entitlements', null, data.token);
  assert.equal(result.data.tier, 'standard');
  assert.deepEqual(result.data.entitlements, []);

  assert.equal(
    (await call('POST', '/entitlements/grant', { userId: data.user.id, entitlement: 'plus' })).status,
    403,
    'a user must not be able to grant themselves a paid tier'
  );

  assert.equal(
    (await call('POST', '/entitlements/grant', { userId: data.user.id, entitlement: 'plus' }, ADMIN)).status,
    200
  );

  result = await call('GET', '/entitlements', null, data.token);
  assert.equal(result.data.tier, 'plus');
});

test('channel entitlements are reported separately', async () => {
  const { data } = await call('POST', '/auth/register', {
    email: 'chan@example.com', handle: 'chan', password: PASS.good
  });
  await call('POST', '/entitlements/grant', { userId: data.user.id, entitlement: 'channel:playtest' }, ADMIN);

  const result = await call('GET', '/entitlements', null, data.token);
  assert.deepEqual(result.data.channels, ['playtest']);
});

/* --- Crashes -------------------------------------------------------------- */

test('crashes are stored and grouped', async () => {
  for (let i = 0; i < 3; i++) {
    await call('POST', '/crash', { version: '1.0.1', platform: 'win32', message: 'Repeated failure', stack: 'at x' });
  }
  await call('POST', '/crash', { version: '1.0.1', platform: 'win32', message: 'A different one' });

  const summary = await call('GET', '/crash/summary', null, ADMIN);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.groups[0].message, 'Repeated failure');
  assert.equal(summary.data.groups[0].count, 3, 'the common one sorts first');
});

test('the crash summary is not public', async () => {
  assert.equal((await call('GET', '/crash/summary')).status, 403);
});

test('an over-long crash report is truncated rather than refused', async () => {
  const result = await call('POST', '/crash', { message: 'x'.repeat(5000), stack: 'y'.repeat(20000) });
  assert.equal(result.status, 200);
  const summary = await call('GET', '/crash/summary', null, ADMIN);
  const stored = summary.data.groups.find((g) => g.message.startsWith('xxx'));
  assert.ok(stored.message.length <= 500, 'stored at a bounded length');
});

/* --- Routing -------------------------------------------------------------- */

test('an unknown route is a 404, not a crash', async () => {
  assert.equal((await call('GET', '/nothing-here')).status, 404);
});

test('a body that is not JSON is a 400', async () => {
  const res = await fetch(`${base}/crash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json'
  });
  assert.equal(res.status, 400);
});

/* --- Rendezvous ----------------------------------------------------------- */

function connect(id, titles = []) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/rendezvous`);
    ws.inbox = [];
    ws.onmessage = (e) => ws.inbox.push(JSON.parse(e.data));
    ws.onerror = () => reject(new Error('socket error'));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', id, titles }));
      resolve(ws);
    };
  });
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('a peer is told who else is present and what they have', async () => {
  const a = await connect('rz-a', [{ gameId: 'demo', version: '1.0.0' }]);
  await settle();
  const b = await connect('rz-b');
  await settle();

  const peers = b.inbox.find((m) => m.type === 'peers');
  assert.ok(peers, 'a peer list arrives');
  const found = peers.peers.find((p) => p.id === 'rz-a');
  assert.ok(found, 'the earlier peer is listed');
  assert.equal(found.titles[0].gameId, 'demo');

  a.close();
  b.close();
});

test('offers, answers and candidates are relayed to the named peer', async () => {
  const a = await connect('rl-a');
  const b = await connect('rl-b');
  await settle();

  b.send(JSON.stringify({ type: 'offer', to: 'rl-a', sdp: { sdp: 'v=0 offer' } }));
  await settle();
  const offer = a.inbox.find((m) => m.type === 'offer');
  assert.ok(offer, 'the offer arrived');
  assert.equal(offer.from, 'rl-b', 'stamped with who sent it');
  assert.equal(offer.sdp.sdp, 'v=0 offer');

  a.send(JSON.stringify({ type: 'answer', to: 'rl-b', sdp: { sdp: 'v=0 answer' } }));
  a.send(JSON.stringify({ type: 'ice', to: 'rl-b', candidate: { candidate: 'candidate:1' } }));
  await settle();

  assert.ok(b.inbox.find((m) => m.type === 'answer'));
  assert.ok(b.inbox.find((m) => m.type === 'ice'));

  a.close();
  b.close();
});

test('a frame past the 125-byte length boundary survives intact', async () => {
  const a = await connect('big-a');
  const b = await connect('big-b');
  await settle();

  // Exercises the 16-bit length path in the frame decoder.
  const payload = 'x'.repeat(3000);
  b.send(JSON.stringify({ type: 'offer', to: 'big-a', sdp: { sdp: payload } }));
  await settle();

  const offer = a.inbox.find((m) => m.type === 'offer');
  assert.equal(offer.sdp.sdp.length, 3000);

  a.close();
  b.close();
});

test('a peer that disconnects stops being advertised', async () => {
  const a = await connect('gone-a');
  await settle();
  a.close();
  await settle(500);

  const c = await connect('gone-c');
  await settle();
  const peers = c.inbox.find((m) => m.type === 'peers');
  assert.ok(!peers.peers.some((p) => p.id === 'gone-a'));

  c.close();
});

test('signalling to a peer that is not there is ignored', async () => {
  const a = await connect('lonely');
  await settle();
  a.send(JSON.stringify({ type: 'offer', to: 'does-not-exist', sdp: {} }));
  await settle();
  assert.equal(a.readyState, 1, 'the socket survives');
  a.close();
});
