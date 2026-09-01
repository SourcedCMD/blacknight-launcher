'use strict';
/**
 * Visual regression, for art that is generated rather than drawn.
 *
 * There are no reference images to compare against because there is no
 * designer's export to compare to - the art *is* the code. What can be checked
 * is that the code keeps producing what it produced yesterday, which is the
 * part that actually breaks: a tweak to the skyline generator quietly changing
 * every title's key art, or a refactor of the PRNG reshuffling the sky.
 *
 * When a change is deliberate:
 *
 *   node scripts/art-snapshots.js --write
 *
 * and the diff shows exactly which pieces changed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { current } = require('../scripts/art-snapshots.js');

const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'art-snapshots.json'), 'utf8'));

test('every recorded case still exists', () => {
  const now = current();
  const gone = Object.keys(recorded).filter((key) => !(key in now));
  assert.deepEqual(gone, [], 'a case disappeared: update the snapshots if that was intended');
});

test('the art engine draws what it drew before', () => {
  const now = current();
  const changed = [];

  for (const [key, hash] of Object.entries(recorded)) {
    if (now[key] !== hash) changed.push(`${key}: ${hash} -> ${now[key]}`);
  }

  assert.deepEqual(
    changed,
    [],
    'art changed. If that was deliberate: node scripts/art-snapshots.js --write'
  );
});

test('drawing twice in the same process gives the same hash', () => {
  // Guards the guard: a snapshot that varies run to run would be worthless.
  assert.deepEqual(current(), current());
});
