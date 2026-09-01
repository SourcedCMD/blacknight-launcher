'use strict';
/**
 * Rate limiting with the limits actually on.
 *
 * Its own server, because the functional suite deliberately runs with them off
 * — it registers dozens of accounts from one address, which is the thing these
 * limits exist to stop.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// A fixture for a throwaway server. Named so the credential scanner in
// `npm run sync` is not asked to tell it apart from a real one.
const PASSWORD = 'a-perfectly-fine-one'; // sync-allow-secret: test fixture
const WRONG = 'not-it';

let child;
let base;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-rl-'));
  child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, RATE_LIMITS: 'on' },
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

async function post(route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* some replies have no body */ }
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

test('guessing a password is eventually cut off', async () => {
  await post('/auth/register', { email: 'brute@example.com', handle: 'brute', password: PASSWORD });

  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await post('/auth/login', { identifier: 'brute', password: WRONG })).status);
  }

  assert.ok(statuses.includes(401), 'the first attempts are ordinary failures');
  assert.ok(statuses.includes(429), 'and then it stops being answerable');
  assert.equal(statuses.at(-1), 429, 'and stays that way');
});

test('a refusal says when to come back', async () => {
  const result = await post('/auth/login', { identifier: 'brute', password: WRONG });
  assert.equal(result.status, 429);
  assert.ok(Number(result.retryAfter) > 0);
});

test('being rate limited still does not reveal whether an account exists', async () => {
  const real = await post('/auth/login', { identifier: 'brute', password: WRONG });

  let fake;
  for (let i = 0; i < 12; i++) {
    fake = await post('/auth/login', { identifier: 'nobody-at-all', password: WRONG });
  }

  assert.equal(real.status, fake.status, 'a real and an imaginary account look the same');
});

test('registration is capped too', async () => {
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    statuses.push(
      (await post('/auth/register', { email: `spam${i}@example.com`, handle: `spam${i}`, password: PASSWORD })).status
    );
  }
  assert.ok(statuses.includes(429), 'or one address could create accounts without limit');
});
