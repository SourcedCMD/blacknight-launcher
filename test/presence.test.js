'use strict';
/**
 * Discord rich presence, as a state machine.
 *
 * The socket half is exercised against a real Discord client by hand; what is
 * worth testing here is the part that decides *what* to publish, because that
 * is where the bug was: presence was only ever set during a play session, so
 * anybody with no games installed showed nothing and the feature looked broken
 * when it was merely idle.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { Presence, socketPath, encode } = require('../electron/services/presence');

/** A Presence that never opens a socket, so the decisions can be inspected. */
function offline({ enabled = true, clientId = 'test-client' } = {}) {
  const presence = new Presence({ enabled, clientId });
  presence.connect = () => {};
  // Pretend Discord accepted us, so setActivity takes the publishing path.
  presence.connected = true;
  presence.sent = [];
  presence.socket = { write: (buf) => presence.sent.push(buf) };
  return presence;
}

const published = (presence) => presence.current;

/* --- The idle state ------------------------------------------------------ */

test('the launcher publishes presence before any game runs', () => {
  const presence = offline();
  presence.setIdle('In the launcher');

  assert.equal(published(presence).title, 'BlackNight Launcher');
  assert.equal(published(presence).details, 'In the launcher');
  assert.equal(published(presence).idle, true);
});

test('the screen someone is on replaces the previous one', () => {
  const presence = offline();
  presence.setIdle('In the launcher');
  presence.setIdle('Browsing the store');

  assert.equal(published(presence).details, 'Browsing the store');
});

test('the launcher timestamp does not restart on every navigation', () => {
  // Otherwise Discord shows "elapsed: 0:00" every time somebody clicks a tab.
  const presence = offline();
  presence.setIdle('In the launcher');
  const started = published(presence).startedAt;

  presence.setIdle('Browsing the store');
  presence.setIdle('In settings');

  assert.equal(published(presence).startedAt, started, 'the elapsed clock keeps running');
});

/* --- A game outranks the launcher ---------------------------------------- */

test('starting a game replaces the launcher presence', () => {
  const presence = offline();
  presence.setIdle('Browsing the store');
  presence.setActivity({ title: 'Eclipse Protocol', details: 'A city that forgot the sun', startedAt: Date.now() });

  assert.equal(published(presence).title, 'Eclipse Protocol');
});

test('changing screens while playing does not displace the game', () => {
  const presence = offline();
  presence.setActivity({ title: 'Eclipse Protocol', startedAt: Date.now() });
  presence.setIdle('Browsing the store');

  assert.equal(published(presence).title, 'Eclipse Protocol', 'the game still wins');
});

test('closing a game falls back to the launcher rather than going blank', () => {
  const presence = offline();
  presence.setIdle('Browsing the store');
  presence.setActivity({ title: 'Eclipse Protocol', startedAt: Date.now() });
  presence.clear();

  assert.ok(published(presence), 'something is still published');
  assert.equal(published(presence).title, 'BlackNight Launcher');
  assert.equal(published(presence).details, 'Browsing the store');
});

test('quitting clears presence outright', () => {
  const presence = offline();
  presence.setIdle('In the launcher');
  presence.clearAll();

  assert.equal(published(presence), null, 'a launcher that has quit must not still show as open');
});

/* --- Staying off when it should -------------------------------------------- */

test('nothing is published while the setting is off', () => {
  const presence = offline({ enabled: false });
  presence.setIdle('In the launcher');
  assert.equal(presence.sent.length, 0, 'not a single frame');
});

test('nothing is published without an application id', () => {
  const presence = offline({ clientId: '' });
  presence.setIdle('In the launcher');
  assert.equal(presence.sent.length, 0);
  assert.equal(presence.status().state, 'unconfigured');
});

test('status reports the reason it is not running', () => {
  assert.equal(new Presence({ enabled: true, clientId: '' }).status().state, 'unconfigured');
  assert.equal(new Presence({ enabled: false, clientId: 'x' }).status().state, 'off');
  assert.equal(new Presence({ enabled: true, clientId: 'x' }).status().state, 'waiting');
});

test('turning it back on republishes what was showing', () => {
  const presence = offline();
  presence.setIdle('Browsing the store');

  presence.setEnabled(false);
  assert.equal(presence.enabled, false);

  presence.connected = true;
  presence.socket = { write: (buf) => presence.sent.push(buf) };
  presence.setEnabled(true);

  assert.equal(published(presence).details, 'Browsing the store');
});

/* --- The wire format ------------------------------------------------------ */

test('a frame is an opcode, a length, then the JSON', () => {
  const frame = encode(1, { cmd: 'SET_ACTIVITY' });
  assert.equal(frame.readInt32LE(0), 1, 'opcode');
  assert.equal(frame.readInt32LE(4), frame.length - 8, 'length matches the body');
  assert.deepEqual(JSON.parse(frame.subarray(8).toString('utf8')), { cmd: 'SET_ACTIVITY' });
});

test('the socket path is the one Discord actually listens on', () => {
  const first = socketPath(0);
  assert.match(first, /discord-ipc-0$/);
  if (process.platform === 'win32') assert.match(first, /pipe/);
});

test('every index Discord probes resolves to a distinct path', () => {
  const paths = new Set();
  for (let i = 0; i < 10; i++) paths.add(socketPath(i));
  assert.equal(paths.size, 10);
});
