'use strict';
/** Block-level delta patching, peer tokens, journal and year-in-review. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { buildManifest, diff, fetchRanges, applyCopies, summarise } = require('../electron/services/chunks');
const { Peers } = require('../electron/services/peers');
const { Library } = require('../electron/services/library');
const { createSettings } = require('../electron/services/settings');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-chunk-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CHUNK = 1024;

/** A deterministic build made of distinct 1 KB blocks. */
function build(dir, name, blocks) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(blocks.map((b) => Buffer.alloc(CHUNK, b))));
  return file;
}

/* --- Manifests ----------------------------------------------------------- */

test('a manifest hashes every chunk and the whole file', () => {
  const dir = tmpDir();
  const file = build(dir, 'a.pak', [1, 2, 3]);
  const manifest = buildManifest(file, { chunkSize: CHUNK });

  assert.equal(manifest.chunks.length, 3);
  assert.equal(manifest.totalBytes, CHUNK * 3);
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
});

test('identical blocks hash identically', () => {
  const dir = tmpDir();
  const manifest = buildManifest(build(dir, 'a.pak', [7, 7, 9]), { chunkSize: CHUNK });
  assert.equal(manifest.chunks[0], manifest.chunks[1]);
  assert.notEqual(manifest.chunks[0], manifest.chunks[2]);
});

test('a short trailing chunk is handled', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'odd.pak');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(CHUNK, 1), Buffer.alloc(100, 2)]));
  const manifest = buildManifest(file, { chunkSize: CHUNK });
  assert.equal(manifest.chunks.length, 2);
  assert.equal(manifest.totalBytes, CHUNK + 100);
});

/* --- Diffing ------------------------------------------------------------- */

test('an unchanged build needs no transfer at all', () => {
  const dir = tmpDir();
  const before = buildManifest(build(dir, 'a.pak', [1, 2, 3]), { chunkSize: CHUNK });
  const after = buildManifest(build(dir, 'b.pak', [1, 2, 3]), { chunkSize: CHUNK });

  const result = summarise(diff(before, after));
  assert.equal(result.fetchedBytes, 0);
  assert.equal(result.savedPercent, 100);
});

test('only the changed block is fetched', () => {
  const dir = tmpDir();
  const before = buildManifest(build(dir, 'a.pak', [1, 2, 3, 4]), { chunkSize: CHUNK });
  const after = buildManifest(build(dir, 'b.pak', [1, 2, 9, 4]), { chunkSize: CHUNK });

  const result = summarise(diff(before, after));
  assert.equal(result.fetchedBytes, CHUNK, 'one block changed, one block moves');
  assert.equal(result.reusedBytes, CHUNK * 3);
  assert.equal(result.savedPercent, 75);
});

test('a block that merely moved is copied, not downloaded', () => {
  const dir = tmpDir();
  const before = buildManifest(build(dir, 'a.pak', [1, 2, 3]), { chunkSize: CHUNK });
  const after = buildManifest(build(dir, 'b.pak', [3, 1, 2]), { chunkSize: CHUNK });

  const result = summarise(diff(before, after));
  assert.equal(result.fetchedBytes, 0, 'reordering costs no bandwidth');
  assert.equal(result.plan.every((op) => op.type === 'copy'), true);
});

test('a completely different build falls back to fetching everything', () => {
  const dir = tmpDir();
  const before = buildManifest(build(dir, 'a.pak', [1, 2]), { chunkSize: CHUNK });
  const after = buildManifest(build(dir, 'b.pak', [8, 9]), { chunkSize: CHUNK });

  const result = summarise(diff(before, after));
  assert.equal(result.reusedBytes, 0);
  assert.equal(result.fetchedBytes, CHUNK * 2);
});

test('a mismatched chunk size is not trusted', () => {
  const dir = tmpDir();
  const before = buildManifest(build(dir, 'a.pak', [1, 2]), { chunkSize: CHUNK });
  const after = buildManifest(build(dir, 'b.pak', [1, 2]), { chunkSize: CHUNK * 2 });
  assert.equal(diff(before, after).reusedBytes, 0, 'different chunking cannot be compared');
});

test('a missing previous manifest means a full fetch', () => {
  const dir = tmpDir();
  const after = buildManifest(build(dir, 'b.pak', [1, 2]), { chunkSize: CHUNK });
  assert.equal(diff(null, after).fetchedBytes, CHUNK * 2);
});

/* --- Ranges -------------------------------------------------------------- */

test('adjacent fetches are merged into one range', () => {
  const plan = [
    { type: 'fetch', offset: 0, length: 100 },
    { type: 'fetch', offset: 100, length: 100 },
    { type: 'copy', offset: 200, length: 100 },
    { type: 'fetch', offset: 300, length: 100 }
  ];
  const ranges = fetchRanges(plan);
  assert.equal(ranges.length, 2, 'two requests, not three');
  assert.deepEqual(ranges[0], { offset: 0, length: 200 });
  assert.deepEqual(ranges[1], { offset: 300, length: 100 });
});

/* --- Applying ------------------------------------------------------------ */

test('applying the copies reproduces every reused block exactly', () => {
  const dir = tmpDir();
  const oldFile = build(dir, 'old.pak', [1, 2, 3, 4]);
  const newFile = build(dir, 'new.pak', [1, 2, 9, 4]);

  const before = buildManifest(oldFile, { chunkSize: CHUNK });
  const after = buildManifest(newFile, { chunkSize: CHUNK });
  const plan = diff(before, after);

  const target = path.join(dir, 'patched.pak');
  const copied = applyCopies(oldFile, target, plan.plan);
  assert.equal(copied, CHUNK * 3);

  const patched = fs.readFileSync(target);
  const expected = fs.readFileSync(newFile);
  assert.equal(patched.length, expected.length, 'the result is the right length');
  // The three reused blocks must match; the fetched one is still a hole.
  for (const i of [0, 1, 3]) {
    assert.deepEqual(
      patched.subarray(i * CHUNK, (i + 1) * CHUNK),
      expected.subarray(i * CHUNK, (i + 1) * CHUNK),
      `block ${i} was reused correctly`
    );
  }
});

test('filling the fetched hole yields a byte-identical build', () => {
  const dir = tmpDir();
  const oldFile = build(dir, 'old.pak', [1, 2, 3, 4]);
  const newFile = build(dir, 'new.pak', [1, 2, 9, 4]);

  const plan = diff(buildManifest(oldFile, { chunkSize: CHUNK }), buildManifest(newFile, { chunkSize: CHUNK }));
  const target = path.join(dir, 'patched.pak');
  applyCopies(oldFile, target, plan.plan);

  // Stand in for the download engine writing the range it fetched.
  const fd = fs.openSync(target, 'r+');
  for (const op of plan.plan.filter((o) => o.type === 'fetch')) {
    fs.writeSync(fd, Buffer.alloc(op.length, 9), 0, op.length, op.offset);
  }
  fs.closeSync(fd);

  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(newFile), 'a patched build equals a fresh one');
});

/* --- Peer tokens --------------------------------------------------------- */

test('a peer token is stable per build and differs across builds', () => {
  const a = Peers.tokenFor('eclipse', '1.0.0');
  assert.equal(a, Peers.tokenFor('eclipse', '1.0.0'), 'same build, same token');
  assert.notEqual(a, Peers.tokenFor('eclipse', '1.1.0'), 'a new version rotates it');
  assert.notEqual(a, Peers.tokenFor('ashfall', '1.0.0'), 'a different title differs');
});

/* --- Journal and review -------------------------------------------------- */

const CATALOG = { games: [{ id: 'demo', title: 'Demo', status: 'released', sizeBytes: 32 }] };

function stubDownloader() {
  const d = new EventEmitter();
  d.list = () => [];
  d.enqueue = () => {};
  d.setGameRunning = () => {};
  return d;
}

function makeLibrary() {
  const dir = tmpDir();
  const settings = createSettings(dir);
  settings.set('installDir', path.join(dir, 'games'));
  return new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
}

test('journal entries are written newest first and notes stick', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 600 });
  const second = library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 900 });

  const entries = library.journal('demo');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, second.id, 'newest first');

  assert.equal(library.setJournalNote(second.id, 'beat the second boss').ok, true);
  assert.equal(library.journal('demo')[0].note, 'beat the second boss');
});

test('insights describe the shape of a play history', () => {
  const library = makeLibrary();
  for (const seconds of [1800, 3600, 5400]) {
    library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds });
  }
  const insights = library.sessionInsights('demo');
  assert.equal(insights.sessions, 3);
  assert.equal(insights.medianSeconds, 3600, 'the median session, not the mean');
  assert.equal(insights.longestSeconds, 5400);
});

test('sessions too short to mean anything are ignored', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 10 });
  assert.equal(library.sessionInsights('demo'), null);
});

test('year in review totals only the year asked for', () => {
  const library = makeLibrary();
  const year = new Date().getFullYear();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 3600 });
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 1800 });
  // An entry from a previous year must not be counted.
  library._journal().get('entries').push({
    id: 'old', at: new Date(year - 2, 5, 1).getTime(), gameId: 'demo', title: 'Demo', seconds: 99999
  });

  const review = library.yearInReview(year);
  assert.equal(review.sessions, 2);
  assert.equal(review.totalSeconds, 5400);
  assert.equal(review.topTitle.gameId, 'demo');
  assert.ok(review.nightFraction >= 0 && review.nightFraction <= 1);
});

test('a year with no play does not throw', () => {
  const library = makeLibrary();
  const review = library.yearInReview(1999);
  assert.equal(review.sessions, 0);
  assert.deepEqual(review.titles, []);
});

/* --- The night map ------------------------------------------------------- */

/** A local timestamp for a given weekday and hour in the recent past. */
function momentAt({ daysAgo, hour, minute = 0 }) {
  const at = new Date();
  at.setDate(at.getDate() - daysAgo);
  at.setHours(hour, minute, 0, 0);
  return at.getTime();
}

test('a session lands in the hour it was played, on the right day', () => {
  const library = makeLibrary();
  const ended = momentAt({ daysAgo: 3, hour: 21, minute: 30 });
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 1800, at: ended });

  const { grid } = library.playMap();
  const day = (new Date(ended).getDay() + 6) % 7;

  assert.equal(Math.round(grid[day][21]), 1800, 'the whole half hour is in the 21:00 cell');
  assert.equal(grid[day][20], 0);
  assert.equal(grid[day][22], 0);
});

test('a long session is spread across the hours it actually covered', () => {
  const library = makeLibrary();
  // 19:30 to 22:30: half an hour in 19, a full hour in 20 and 21, half in 22.
  const ended = momentAt({ daysAgo: 2, hour: 22, minute: 30 });
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 3 * 3600, at: ended });

  const { grid } = library.playMap();
  const day = (new Date(ended).getDay() + 6) % 7;

  assert.equal(Math.round(grid[day][19]), 1800);
  assert.equal(Math.round(grid[day][20]), 3600);
  assert.equal(Math.round(grid[day][21]), 3600);
  assert.equal(Math.round(grid[day][22]), 1800);
});

test('a session over midnight carries into the next day', () => {
  const library = makeLibrary();
  // 23:00 to 01:00.
  const ended = momentAt({ daysAgo: 2, hour: 1 });
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 2 * 3600, at: ended });

  const { grid } = library.playMap();
  const endDay = (new Date(ended).getDay() + 6) % 7;
  const startDay = (endDay + 6) % 7;

  assert.equal(Math.round(grid[startDay][23]), 3600, 'the hour before midnight');
  assert.equal(Math.round(grid[endDay][0]), 3600, 'and the hour after, on the next day');
});

test('the map only looks back as far as it was asked to', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 3600, at: momentAt({ daysAgo: 3, hour: 12 }) });
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 3600, at: momentAt({ daysAgo: 200, hour: 12 }) });

  assert.equal(library.playMap({ weeks: 4 }).sessions, 1);
  assert.equal(library.playMap({ weeks: 52 }).sessions, 2);
});

test('the map can be narrowed to one title', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 3600, at: momentAt({ daysAgo: 1, hour: 14 }) });
  library.addJournalEntry({ gameId: 'other', title: 'Other', seconds: 3600, at: momentAt({ daysAgo: 1, hour: 15 }) });

  assert.equal(library.playMap({ gameId: 'demo' }).sessions, 1);
  assert.equal(library.playMap().sessions, 2);
});

test('a corrupt entry claiming an absurd length cannot spin the loop forever', () => {
  const library = makeLibrary();
  library.addJournalEntry({
    gameId: 'demo', title: 'Demo',
    seconds: 400 * 24 * 3600, // over a year in one sitting
    at: momentAt({ daysAgo: 1, hour: 12 })
  });
  // The guard caps the walk; what matters is that this returns at all.
  const map = library.playMap();
  assert.ok(map.grid.length === 7);
});

test('an empty history gives an empty grid rather than a division by zero', () => {
  const map = makeLibrary().playMap();
  assert.equal(map.sessions, 0);
  assert.equal(map.peak, 1, 'so a shade calculation cannot divide by zero');
  assert.equal(map.grid.flat().reduce((a, b) => a + b, 0), 0);
});

/* --- Ghost sessions ------------------------------------------------------ */

test('there is no ghost when nothing is running', () => {
  assert.equal(makeLibrary().ghost('demo'), null);
});

test('a ghost reports elapsed time but no comparison until there is history', () => {
  const library = makeLibrary();
  library.sessions.set('demo', { pid: 1, startedAt: Date.now() - 60000 });

  const ghost = library.ghost('demo');
  assert.ok(ghost.elapsed >= 59 && ghost.elapsed <= 62);
  assert.equal(ghost.median, null, 'two sessions is not a pattern');
});

test('a ghost compares the current run against the usual one', () => {
  const library = makeLibrary();
  for (const seconds of [1800, 3600, 5400]) {
    library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds, at: Date.now() - 86400000 });
  }
  library.sessions.set('demo', { pid: 1, startedAt: Date.now() - 3600 * 1000 });

  const ghost = library.ghost('demo');
  assert.equal(ghost.median, 3600, 'the middle of the three');
  assert.ok(Math.abs(ghost.ratio - 1) < 0.02, 'this run is right about typical');
  assert.equal(ghost.personalBest, false);
});

test('a ghost knows when the current run is the longest yet', () => {
  const library = makeLibrary();
  for (const seconds of [1800, 3600, 5400]) {
    library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds, at: Date.now() - 86400000 });
  }
  library.sessions.set('demo', { pid: 1, startedAt: Date.now() - 6000 * 1000 });

  assert.equal(library.ghost('demo').personalBest, true);
});
