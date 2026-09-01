'use strict';
/**
 * Multi-source scheduling.
 *
 * The interesting behaviour is what happens when sources are uneven or start
 * failing, which is exactly what a live download does and exactly what is
 * awkward to reproduce against a real network. The scheduler is pure, so it
 * can be driven straight into those states.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { planRanges, Scheduler, connectionCount } = require('../electron/services/multisource');

const MB = 1024 * 1024;
const origin = { id: 'origin', url: 'https://cdn/x.pak', kind: 'origin' };
const peerA = { id: 'peerA', url: 'http://192.168.1.5/x', kind: 'peer' };
const peerB = { id: 'peerB', url: 'http://192.168.1.9/x', kind: 'peer' };

/** A plan of `count` fetch blocks, each 4 MB. */
const fetchPlan = (count) =>
  Array.from({ length: count }, (_, i) => ({ type: 'fetch', offset: i * 4 * MB, length: 4 * MB }));

/* --- Planning ------------------------------------------------------------ */

test('adjacent blocks merge into larger ranges', () => {
  const ranges = planRanges(fetchPlan(4), { target: 8 * MB });
  assert.equal(ranges.length, 2, 'four 4 MB blocks become two 8 MB ranges');
  assert.deepEqual(ranges[0], { offset: 0, length: 8 * MB });
});

test('a copied block breaks the run', () => {
  const plan = [
    { type: 'fetch', offset: 0, length: 4 * MB },
    { type: 'copy', offset: 4 * MB, length: 4 * MB },
    { type: 'fetch', offset: 8 * MB, length: 4 * MB }
  ];
  const ranges = planRanges(plan, { target: 64 * MB });
  assert.equal(ranges.length, 2, 'the two fetches must not be merged across the copy');
  assert.equal(ranges[1].offset, 8 * MB);
});

test('nothing to fetch plans nothing', () => {
  assert.deepEqual(planRanges([{ type: 'copy', offset: 0, length: 4 * MB }]), []);
});

/* --- Handing out work ---------------------------------------------------- */

test('every range is handed out exactly once', () => {
  const ranges = planRanges(fetchPlan(6), { target: 4 * MB });
  const scheduler = new Scheduler(ranges, [origin, peerA, peerB]);

  const seen = [];
  while (!scheduler.complete) {
    for (const source of scheduler.active()) {
      const range = scheduler.take(source.id);
      if (!range) continue;
      seen.push(range.offset);
      scheduler.complete_(source.id);
    }
  }

  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6, 'no range was fetched twice');
});

test('a faster source naturally does more work', () => {
  const ranges = planRanges(fetchPlan(10), { target: 4 * MB });
  const scheduler = new Scheduler(ranges, [origin, peerA]);
  const counts = { origin: 0, peerA: 0 };

  // The origin finishes three ranges for every one the peer manages.
  let tick = 0;
  while (!scheduler.complete) {
    tick++;
    for (const id of ['origin', 'peerA']) {
      if (id === 'peerA' && tick % 3 !== 0) continue;
      if (scheduler.take(id)) {
        scheduler.complete_(id);
        counts[id]++;
      }
    }
  }

  assert.equal(counts.origin + counts.peerA, 10);
  assert.ok(counts.origin > counts.peerA, 'work follows throughput without measuring it');
});

/* --- Failure ------------------------------------------------------------- */

test("a failed range goes back to the front of the queue", () => {
  const ranges = planRanges(fetchPlan(3), { target: 4 * MB });
  const scheduler = new Scheduler(ranges, [origin, peerA]);

  const taken = scheduler.take('peerA');
  scheduler.fail('peerA');

  assert.equal(scheduler.take('origin').offset, taken.offset, 'the orphaned range is next out');
});

test('a peer that keeps failing is retired', () => {
  const scheduler = new Scheduler(planRanges(fetchPlan(6), { target: 4 * MB }), [origin, peerA]);

  scheduler.take('peerA');
  assert.equal(scheduler.fail('peerA').retired, false, 'one failure is bad luck');
  scheduler.take('peerA');
  assert.equal(scheduler.fail('peerA').retired, true, 'two in a row is a peer that has gone');
  assert.equal(scheduler.take('peerA'), null, 'and it is asked for nothing further');
});

test('the origin is never retired, however badly it behaves', () => {
  const scheduler = new Scheduler(planRanges(fetchPlan(6), { target: 4 * MB }), [origin, peerA]);
  for (let i = 0; i < 5; i++) {
    scheduler.take('origin');
    scheduler.fail('origin');
  }
  assert.equal(scheduler.retired.has('origin'), false);
  assert.ok(scheduler.take('origin'), 'it is the only source guaranteed to exist');
});

test('a success clears the failure count', () => {
  const scheduler = new Scheduler(planRanges(fetchPlan(6), { target: 4 * MB }), [origin, peerA]);

  scheduler.take('peerA');
  scheduler.fail('peerA');
  scheduler.take('peerA');
  scheduler.complete_('peerA');
  scheduler.take('peerA');

  assert.equal(scheduler.fail('peerA').retired, false, 'failures have to be consecutive');
});

test('losing every peer still finishes on the origin alone', () => {
  const scheduler = new Scheduler(planRanges(fetchPlan(4), { target: 4 * MB }), [origin, peerA, peerB]);

  for (const id of ['peerA', 'peerB']) {
    scheduler.take(id);
    scheduler.fail(id);
    scheduler.take(id);
    scheduler.fail(id);
  }
  assert.equal(scheduler.active().length, 1);

  let guard = 0;
  while (!scheduler.complete && guard++ < 50) {
    if (scheduler.take('origin')) scheduler.complete_('origin');
  }
  assert.ok(scheduler.complete, 'the transfer degrades rather than stalling');
  assert.equal(scheduler.done.length, 4);
});

/* --- Progress and sizing -------------------------------------------------- */

test('progress counts only what has actually landed', () => {
  const scheduler = new Scheduler(planRanges(fetchPlan(4), { target: 4 * MB }), [origin]);
  scheduler.take('origin');
  assert.equal(scheduler.bytesDone(), 0, 'in flight is not done');
  scheduler.complete_('origin');
  assert.equal(scheduler.bytesDone(), 4 * MB);
});

test('connection count is bounded by sources, work and a ceiling', () => {
  assert.equal(connectionCount([origin], 20), 1, 'one source, one connection');
  assert.equal(connectionCount([origin, peerA, peerB], 2), 2, 'never more than there is work');
  assert.equal(connectionCount(new Array(20).fill(peerA), 100, { max: 6 }), 6, 'capped');
});
