'use strict';
/** The remote account client: what it will and will not talk to. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { RemoteAccounts, validUrl } = require('../electron/services/accounts-remote');

test('http and https are accepted', () => {
  assert.ok(validUrl('https://accounts.example.com'));
  assert.ok(validUrl('http://localhost:8080'));
});

test('anything that is not http or https is refused', () => {
  for (const url of [
    'file:///C:/Windows/win.ini',
    'ftp://example.com',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'not a url',
    '',
    null,
    undefined
  ]) {
    assert.equal(validUrl(url), null, `${url} must be refused`);
  }
});

/** A settings stub, so no real settings file is touched. */
const withUrl = (accountsUrl) =>
  new RemoteAccounts({ get: (key) => (key === 'accountsUrl' ? accountsUrl : undefined) }, null);

test('an empty accountsUrl leaves the feature dormant rather than erroring', async () => {
  const result = await withUrl('').passkeyChallenge('user-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured', 'the UI shows this as "nowhere to keep a passkey"');
});

test('a malformed accountsUrl is treated as unconfigured, not attempted', async () => {
  for (const bad of ['file:///etc/passwd', 'nonsense', null]) {
    const result = await withUrl(bad).passkeyRegister({ userId: 'user-1' });
    assert.equal(result.reason, 'not-configured', `${bad} should not be dialled`);
  }
});

test('a configured but unreachable service reports an error, not a crash', async () => {
  // Port 1 on the loopback refuses immediately and is host independent, which
  // an unroutable address on the public internet is not.
  const result = await withUrl('http://127.0.0.1:1').passkeyChallenge('user-1');
  assert.equal(result.ok, false);
  assert.ok(result.error, 'and says why');
});
