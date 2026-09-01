'use strict';
/**
 * Passkey enrolment and sign-in, over HTTP, against a real server.
 *
 * Its own server so the relying-party id and origin can be pinned, and so the
 * rate limits stay off while a dozen requests go through in a second.
 *
 * The authenticator is the same fake used by the unit tests: a real P-256 key
 * producing real signatures. What this adds is the plumbing — that a challenge
 * issued by the server is the one the signature is checked against, that it is
 * consumed, and that a session comes back at the end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { FLAG, rpIdHash } = require('../lib/webauthn');

const ROOT = path.join(__dirname, '..');
const RP_ID = 'localhost';
const ORIGIN = 'https://localhost';
const FIXTURE_PASSWORD = 'a-perfectly-fine-one'; // sync-allow-secret: test fixture

let child;
let base;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-pk-'));
  child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      RATE_LIMITS: 'off',
      RP_ID,
      RP_ORIGIN: ORIGIN
    },
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
  });
});

test.after(() => {
  child?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function post(route, body, token) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* no body */ }
  return { status: res.status, data };
}

/* --- The same fake authenticator as the unit tests ----------------------- */

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(value, 1);
  return b;
}

function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(encode(k), encode(v));
    return Buffer.concat(parts);
  }
  throw new Error('cannot encode');
}

function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);

  const cose = new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')]
  ]);

  const authData = ({ signCount = 0, attested = true } = {}) => {
    const header = Buffer.alloc(37);
    rpIdHash(RP_ID).copy(header, 0);
    header[32] = FLAG.USER_PRESENT | FLAG.USER_VERIFIED | (attested ? FLAG.ATTESTED_DATA : 0);
    header.writeUInt32BE(signCount, 33);
    if (!attested) return header;

    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([header, Buffer.alloc(16), idLength, credentialId, encode(cose)]);
  };

  const clientData = (type, challenge) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }), 'utf8');

  return {
    credentialId: credentialId.toString('base64url'),

    enrol(challenge) {
      return {
        attestationObject: encode(
          new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData()]])
        ).toString('base64url'),
        clientDataJSON: clientData('webauthn.create', challenge).toString('base64url')
      };
    },

    sign(challenge, signCount = 1) {
      const data = authData({ signCount, attested: false });
      const client = clientData('webauthn.get', challenge);
      const hash = crypto.createHash('sha256').update(client).digest();
      return {
        credentialId: credentialId.toString('base64url'),
        authenticatorData: data.toString('base64url'),
        clientDataJSON: client.toString('base64url'),
        signature: crypto.sign('SHA256', Buffer.concat([data, hash]), privateKey).toString('base64url')
      };
    }
  };
}

/** Registers an account and enrols a passkey on it. */
async function accountWithPasskey(handle) {
  const auth = authenticator();
  const { data: account } = await post('/auth/register', {
    email: `${handle}@example.com`,
    handle,
    password: FIXTURE_PASSWORD
  });

  const { data: issued } = await post('/auth/passkey/challenge', { userId: account.user.id });
  const enrolled = await post('/auth/passkey/register', {
    userId: account.user.id,
    challenge: issued.challenge,
    ...auth.enrol(issued.challenge)
  });

  return { auth, account, issued, enrolled };
}

/* --- Enrolment ----------------------------------------------------------- */

test('a passkey can be enrolled on a signed-in account', async () => {
  const { account, enrolled } = await accountWithPasskey('pkone');
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.data.count, 1);

  const session = await fetch(`${base}/auth/session`, { headers: { Authorization: `Bearer ${account.token}` } });
  const me = await session.json();
  assert.equal(me.user.hasPasskey, true);
  assert.ok(!('passkeys' in me.user), 'no credential material leaves the server');
});

test('an enrolment challenge cannot be used twice', async () => {
  const { auth, account, issued } = await accountWithPasskey('pktwice');

  const again = await post('/auth/passkey/register', {
    userId: account.user.id,
    challenge: issued.challenge,
    ...auth.enrol(issued.challenge)
  });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /challenge/);
});

test('an enrolment signed for another origin is refused', async () => {
  const auth = authenticator();
  const { data: account } = await post('/auth/register', {
    email: 'pkorigin@example.com', handle: 'pkorigin', password: FIXTURE_PASSWORD
  });
  const { data: issued } = await post('/auth/passkey/challenge', { userId: account.user.id });

  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge: issued.challenge, origin: 'https://evil.example' })
  ).toString('base64url');

  const result = await post('/auth/passkey/register', {
    userId: account.user.id,
    challenge: issued.challenge,
    attestationObject: auth.enrol(issued.challenge).attestationObject,
    clientDataJSON
  });

  assert.equal(result.status, 400);
  assert.match(result.data.error, /evil\.example/);
});

/* --- Sign-in ------------------------------------------------------------- */

test('a passkey signs in and returns a working session', async () => {
  const { auth } = await accountWithPasskey('pksignin');

  const { data: challenge } = await post('/auth/passkey/login-challenge');
  assert.ok(challenge.challenge);
  assert.equal(challenge.userId, undefined, 'the challenge names nobody');

  const signedIn = await post('/auth/passkey/login', {
    challenge: challenge.challenge,
    ...auth.sign(challenge.challenge, 1)
  });

  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.user.handle, 'pksignin');

  const session = await fetch(`${base}/auth/session`, {
    headers: { Authorization: `Bearer ${signedIn.data.token}` }
  });
  assert.equal(session.status, 200, 'the token it issued actually works');
});

test('a login challenge cannot be replayed', async () => {
  const { auth } = await accountWithPasskey('pkreplay');

  const { data: challenge } = await post('/auth/passkey/login-challenge');
  const first = await post('/auth/passkey/login', { challenge: challenge.challenge, ...auth.sign(challenge.challenge, 1) });
  assert.equal(first.status, 200);

  const replayed = await post('/auth/passkey/login', { challenge: challenge.challenge, ...auth.sign(challenge.challenge, 2) });
  assert.equal(replayed.status, 401, 'the challenge was consumed');
});

test('a signature from an unenrolled authenticator is refused', async () => {
  await accountWithPasskey('pkstranger');
  const impostor = authenticator();

  const { data: challenge } = await post('/auth/passkey/login-challenge');
  const result = await post('/auth/passkey/login', {
    challenge: challenge.challenge,
    ...impostor.sign(challenge.challenge, 1)
  });

  assert.equal(result.status, 401);
});

test('a tampered signature is refused', async () => {
  const { auth } = await accountWithPasskey('pktamper');
  const { data: challenge } = await post('/auth/passkey/login-challenge');

  const assertion = auth.sign(challenge.challenge, 1);
  const bytes = Buffer.from(assertion.signature, 'base64url');
  bytes[8] ^= 0xff;

  const result = await post('/auth/passkey/login', {
    challenge: challenge.challenge,
    ...assertion,
    signature: bytes.toString('base64url')
  });

  assert.equal(result.status, 401);
});

test('every failure gives the same message, whatever went wrong', async () => {
  const { auth } = await accountWithPasskey('pkquiet');
  const impostor = authenticator();

  const a = await post('/auth/passkey/login-challenge');
  const unknown = await post('/auth/passkey/login', {
    challenge: a.data.challenge, ...impostor.sign(a.data.challenge, 1)
  });

  const b = await post('/auth/passkey/login-challenge');
  const tampered = auth.sign(b.data.challenge, 1);
  const bytes = Buffer.from(tampered.signature, 'base64url');
  bytes[8] ^= 0xff;
  const bad = await post('/auth/passkey/login', {
    challenge: b.data.challenge, ...tampered, signature: bytes.toString('base64url')
  });

  const stale = await post('/auth/passkey/login', { challenge: 'never-issued', ...auth.sign('never-issued', 1) });

  assert.equal(unknown.data.error, bad.data.error);
  assert.equal(bad.data.error, stale.data.error, 'or the message says which part was wrong');
});

test('the counter going backwards is refused as a possible clone', async () => {
  const { auth } = await accountWithPasskey('pkclone');

  const first = await post('/auth/passkey/login-challenge');
  await post('/auth/passkey/login', { challenge: first.data.challenge, ...auth.sign(first.data.challenge, 20) });

  const second = await post('/auth/passkey/login-challenge');
  const result = await post('/auth/passkey/login', {
    challenge: second.data.challenge,
    ...auth.sign(second.data.challenge, 5)
  });

  assert.equal(result.status, 401);
});

/* --- Removal ------------------------------------------------------------- */

test('a passkey can be removed by the account that owns it', async () => {
  const { auth, account } = await accountWithPasskey('pkremove');

  const removed = await post('/auth/passkey/remove', { credentialId: auth.credentialId }, account.token);
  assert.equal(removed.data.ok, true);
  assert.equal(removed.data.count, 0);

  const { data: challenge } = await post('/auth/passkey/login-challenge');
  const result = await post('/auth/passkey/login', { challenge: challenge.challenge, ...auth.sign(challenge.challenge, 9) });
  assert.equal(result.status, 401, 'and it no longer signs anyone in');
});

test('removing a passkey requires being signed in', async () => {
  const { auth } = await accountWithPasskey('pkguard');
  const result = await post('/auth/passkey/remove', { credentialId: auth.credentialId });
  assert.equal(result.status, 401);
});
