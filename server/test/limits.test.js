'use strict';
/** Rate limiting and lockout, driven with a controllable clock. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { Limits, lockoutMs } = require('../lib/limits');

/** A Limits with time under test control, so nothing here sleeps. */
function withClock() {
  let now = 1_000_000;
  const limits = new Limits(() => now);
  return { limits, advance: (ms) => { now += ms; }, at: () => now };
}

test('requests inside the ceiling are allowed', () => {
  const { limits } = withClock();
  for (let i = 0; i < 10; i++) assert.equal(limits.take('login', '1.2.3.4').ok, true, `attempt ${i + 1}`);
});

test('the eleventh login from one address is refused', () => {
  const { limits } = withClock();
  for (let i = 0; i < 10; i++) limits.take('login', '1.2.3.4');
  const blocked = limits.take('login', '1.2.3.4');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter > 0, 'and says when to come back');
});

test('a different address is unaffected', () => {
  const { limits } = withClock();
  for (let i = 0; i < 10; i++) limits.take('login', '1.2.3.4');
  assert.equal(limits.take('login', '5.6.7.8').ok, true);
});

test('the window slides rather than resetting on a boundary', () => {
  const { limits, advance } = withClock();

  // Ten attempts spread over four minutes.
  for (let i = 0; i < 10; i++) {
    assert.equal(limits.take('login', 'x').ok, true);
    advance(24_000);
  }
  assert.equal(limits.take('login', 'x').ok, false, 'still inside the five minute window');

  // Once the earliest attempts age out, capacity returns gradually.
  advance(60_000);
  assert.equal(limits.take('login', 'x').ok, true, 'the oldest attempt expired');
});

test('buckets are independent', () => {
  const { limits } = withClock();
  for (let i = 0; i < 5; i++) limits.take('register', 'x');
  assert.equal(limits.take('register', 'x').ok, false, 'register is the tighter bucket');
  assert.equal(limits.take('login', 'x').ok, true, 'and login has its own budget');
});

test('an unknown bucket falls back to a default rather than being unlimited', () => {
  const { limits } = withClock();
  for (let i = 0; i < 120; i++) assert.equal(limits.take('made-up', 'x').ok, true);
  assert.equal(limits.take('made-up', 'x').ok, false);
});

/* --- Lockout -------------------------------------------------------------- */

test('a few mistyped passwords do not lock anyone out', () => {
  const { limits } = withClock();
  for (let i = 0; i < 4; i++) limits.fail('sam');
  assert.equal(limits.locked('sam'), null, 'people mistype');
});

test('sustained failures lock the account, and the delay grows', () => {
  const { limits } = withClock();
  for (let i = 0; i < 5; i++) limits.fail('sam');
  const first = limits.locked('sam');
  assert.ok(first, 'locked after five');

  for (let i = 0; i < 7; i++) limits.fail('sam');
  const later = limits.locked('sam');
  assert.ok(later.retryAfter > first.retryAfter, 'and it gets longer');
});

test('the lockout expires on its own', () => {
  const { limits, advance } = withClock();
  for (let i = 0; i < 5; i++) limits.fail('sam');
  assert.ok(limits.locked('sam'));

  advance(61_000);
  assert.equal(limits.locked('sam'), null, 'a minute later they can try again');
});

test('a successful sign-in wipes the slate', () => {
  const { limits } = withClock();
  for (let i = 0; i < 6; i++) limits.fail('sam');
  limits.succeed('sam');
  assert.equal(limits.locked('sam'), null);
});

test('the identifier is matched without regard to case', () => {
  const { limits } = withClock();
  for (let i = 0; i < 5; i++) limits.fail('Sam@Example.com');
  assert.ok(limits.locked('sam@example.com'), 'or changing the case would reset the counter');
});

test('the delay schedule climbs and then caps', () => {
  assert.equal(lockoutMs(1), 0);
  assert.equal(lockoutMs(4), 0);
  assert.ok(lockoutMs(5) > 0);
  assert.ok(lockoutMs(9) > lockoutMs(5));
  assert.ok(lockoutMs(20) > 0);
  assert.equal(lockoutMs(20), lockoutMs(100), 'capped, so nobody is locked out forever');
});

/* --- Housekeeping --------------------------------------------------------- */

test('counters for quiet addresses are dropped', () => {
  const { limits, advance } = withClock();
  limits.take('login', 'a');
  limits.take('login', 'b');
  assert.equal(limits.size().hits, 2);

  advance(30 * 60000);
  limits.sweep();
  assert.equal(limits.size().hits, 0, 'or this becomes a list of everyone who ever connected');
});

test('a live lockout survives a sweep', () => {
  const { limits, advance } = withClock();
  for (let i = 0; i < 12; i++) limits.fail('sam');

  advance(60_000);
  limits.sweep();
  assert.ok(limits.locked('sam'), 'the lockout is still in force');
});
