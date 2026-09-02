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

/* --- Sessions that outlive the launcher ---------------------------------- */

test('a session open when the launcher died is credited on the next start', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  settings.set('installDir', path.join(dir, 'games'));

  // A library that thinks a session started ninety minutes ago and never ended.
  const first = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  first.store.get('entries').demo = {
    gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0
  };
  first.store.set('openSessions', { demo: { pid: 1234, startedAt: Date.now() - 90 * 60000 } });

  // Restarting is what triggers recovery.
  const second = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  const entry = second.store.get('entries').demo;

  assert.ok(entry.playtimeSeconds >= 89 * 60, `credited ${entry.playtimeSeconds}s`);
  assert.ok(entry.playtimeSeconds <= 91 * 60);
  assert.deepEqual(second.store.get('openSessions'), {}, 'and the record is cleared');
});

test('a recovered session is written to the journal and marked as inferred', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const first = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  first.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };
  first.store.set('openSessions', { demo: { pid: 1, startedAt: Date.now() - 30 * 60000 } });

  const second = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  const [entry] = second.journal('demo');

  assert.ok(entry, 'a journal line was written');
  assert.equal(entry.recovered, true, 'and it says the figure was inferred, not measured');
  assert.ok(entry.seconds >= 29 * 60);
});

test('an absurdly long open session is capped rather than believed', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const first = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  first.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };
  // The machine slept for three days with a session open.
  first.store.set('openSessions', { demo: { pid: 1, startedAt: Date.now() - 3 * 86400000 } });

  const second = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  const entry = second.store.get('entries').demo;

  assert.equal(entry.playtimeSeconds, 6 * 3600, 'capped at six hours');
  assert.equal(second.journal('demo')[0].capped, true, 'and says so');
});

test('a launch that died in seconds is not recorded as a session', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const first = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  first.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };
  first.store.set('openSessions', { demo: { pid: 1, startedAt: Date.now() - 5000 } });

  const second = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  assert.equal(second.store.get('entries').demo.playtimeSeconds, 0, 'five seconds is a failed launch');
  assert.equal(second.journal('demo').length, 0);
});

test('an ordinary session still ends normally and is not double counted', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const library = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };

  library._beginSession('demo', 42);
  assert.ok(library.store.get('openSessions').demo, 'the open session is on disk while it runs');

  library.endSession('demo');
  assert.deepEqual(library.store.get('openSessions'), {}, 'and cleared when it ends');

  const playtimeAfterEnding = library.store.get('entries').demo.playtimeSeconds;

  // A restart must not credit the same session a second time. endSession only
  // journals sessions over thirty seconds, so this one writes no line at all -
  // what matters is that recovery adds nothing on top of it.
  const after = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
  assert.equal(after.store.get('entries').demo.playtimeSeconds, playtimeAfterEnding, 'not counted twice');
  assert.equal(after.journal('demo').length, 0, 'and no recovery line was invented');
});

/* --- Guards -------------------------------------------------------------- */

test('a title still downloading cannot be uninstalled out from under it', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const downloader = stubDownloader();
  downloader.list = () => [{ id: 'd1', gameId: 'demo', status: 'downloading' }];

  const library = new Library(dir, CATALOG, downloader, settings, { allowSimulated: true });
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', path: dir };

  const result = library.uninstall('demo');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'downloading');
  assert.equal(result.downloadId, 'd1', 'and names the download so the UI can offer to cancel it');
});

test('a finished download does not block uninstalling', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const downloader = stubDownloader();
  downloader.list = () => [{ id: 'd1', gameId: 'demo', status: 'completed' }];

  const library = new Library(dir, CATALOG, downloader, settings, { allowSimulated: true });
  library.store.get('entries').demo = {
    gameId: 'demo', title: 'Demo', owned: true, status: 'installed', path: path.join(dir, 'demo')
  };

  assert.notEqual(library.uninstall('demo').reason, 'downloading');
});

test('a session whose process has gone is reaped', () => {
  const dir = tmpDir();
  const library = new Library(dir, CATALOG, stubDownloader(), createSettings(dir), { allowSimulated: true });
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };

  // A pid that is certainly not running.
  library.sessions.set('demo', { pid: 0x7ffffffe, startedAt: Date.now() - 60000 });

  assert.equal(library.sessionAlive('demo'), false);
  assert.deepEqual(library.reapDeadSessions(), ['demo']);
  assert.equal(library.sessions.has('demo'), false, 'and it is no longer marked as running');
});

test('a live session is left alone', () => {
  const dir = tmpDir();
  const library = new Library(dir, CATALOG, stubDownloader(), createSettings(dir), { allowSimulated: true });
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };

  // This test process is definitely alive.
  library.sessions.set('demo', { pid: process.pid, startedAt: Date.now() });

  assert.equal(library.sessionAlive('demo'), true);
  assert.deepEqual(library.reapDeadSessions(), []);
});

test('a simulated session has no process and is not reaped', () => {
  const dir = tmpDir();
  const library = new Library(dir, CATALOG, stubDownloader(), createSettings(dir), { allowSimulated: true });
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', playtimeSeconds: 0 };

  library.sessions.set('demo', { pid: null, startedAt: Date.now() });
  assert.equal(library.sessionAlive('demo'), true);
  assert.deepEqual(library.reapDeadSessions(), []);
});

/* --- Moving an install --------------------------------------------------- */

function installedAt(library, dir, gameId = 'demo') {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${gameId}.pak`), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(dir, 'data', 'levels.bin'), Buffer.alloc(2048, 3));
  library.store.get('entries')[gameId] = {
    gameId, title: 'Demo', owned: true, status: 'installed', path: dir, playtimeSeconds: 0
  };
  return dir;
}

test('a title moves to another folder with its files intact', async () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });

  const from = path.join(root, 'drive-a', 'demo');
  fs.mkdirSync(from, { recursive: true });
  installedAt(library, from);

  const targetFolder = path.join(root, 'drive-b');
  const result = await library.moveInstall('demo', targetFolder);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.path, path.join(targetFolder, 'demo'));
  assert.ok(fs.existsSync(path.join(result.path, 'demo.pak')), 'the build came with it');
  assert.ok(fs.existsSync(path.join(result.path, 'data', 'levels.bin')), 'and so did the subfolders');
  assert.ok(!fs.existsSync(from), 'the old copy is gone');
  assert.equal(library.store.get('entries').demo.path, result.path, 'and the record points at the new one');
});

test('the original is untouched when the target already exists', async () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });

  const from = path.join(root, 'drive-a', 'demo');
  fs.mkdirSync(from, { recursive: true });
  installedAt(library, from);

  const targetFolder = path.join(root, 'drive-b');
  fs.mkdirSync(path.join(targetFolder, 'demo'), { recursive: true });

  const result = await library.moveInstall('demo', targetFolder);
  assert.equal(result.ok, false);
  assert.ok(fs.existsSync(path.join(from, 'demo.pak')), 'nothing was moved');
  assert.equal(library.store.get('entries').demo.path, from);
});

test('moving somewhere it already is, is refused', async () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });
  const from = path.join(root, 'drive-a', 'demo');
  fs.mkdirSync(from, { recursive: true });
  installedAt(library, from);

  const result = await library.moveInstall('demo', path.join(root, 'drive-a'));
  assert.equal(result.ok, false);
  assert.match(result.error, /already there/);
});

test('a running game cannot be moved', async () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });
  const from = path.join(root, 'drive-a', 'demo');
  fs.mkdirSync(from, { recursive: true });
  installedAt(library, from);

  library.sessions.set('demo', { pid: process.pid, startedAt: Date.now() });
  const result = await library.moveInstall('demo', path.join(root, 'drive-b'));
  assert.equal(result.ok, false);
  assert.match(result.error, /Close the game/);
});

test('a title that is downloading cannot be moved', async () => {
  const root = tmpDir();
  const downloader = stubDownloader();
  downloader.list = () => [{ id: 'd1', gameId: 'demo', status: 'downloading' }];

  const library = new Library(root, CATALOG, downloader, createSettings(root), { allowSimulated: true });
  const from = path.join(root, 'drive-a', 'demo');
  fs.mkdirSync(from, { recursive: true });
  installedAt(library, from);

  const result = await library.moveInstall('demo', path.join(root, 'drive-b'));
  assert.equal(result.ok, false);
  assert.match(result.error, /still downloading/);
});

test('moving something that is not installed is refused', async () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });
  const result = await library.moveInstall('demo', path.join(root, 'anywhere'));
  assert.equal(result.ok, false);
  assert.match(result.error, /not installed/);
});

/* --- Finding the damaged blocks ------------------------------------------ */

test('inspect names exactly the blocks that are wrong', () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });

  const dir = path.join(root, 'install');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'demo.pak');

  // Eight distinct 1 KB blocks.
  const original = Buffer.concat(Array.from({ length: 8 }, (_, i) => Buffer.alloc(CHUNK, i + 1)));
  fs.writeFileSync(file, original);

  const manifest = buildManifest(file, { chunkSize: CHUNK });
  fs.writeFileSync(
    path.join(dir, 'blacknight.manifest.json'),
    JSON.stringify({ ...manifest, chunkSize: CHUNK })
  );

  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', path: dir };

  // Nothing wrong yet.
  const clean = library.inspect('demo');
  assert.equal(clean.ok, true);
  assert.equal(clean.damaged, 0);

  // Corrupt blocks 2 and 5.
  const damaged = Buffer.from(original);
  damaged.fill(0xff, 2 * CHUNK, 3 * CHUNK);
  damaged.fill(0xff, 5 * CHUNK, 6 * CHUNK);
  fs.writeFileSync(file, damaged);

  const result = library.inspect('demo');
  assert.equal(result.damaged, 2, 'two blocks, not the whole file');
  assert.equal(result.damagedBytes, 2 * CHUNK);
  assert.deepEqual(
    result.ranges.map((r) => r.start),
    [2 * CHUNK, 5 * CHUNK],
    'and it says exactly which byte ranges to refetch'
  );
  assert.equal(result.worthRepairing, true);
});

test('a mostly-destroyed install is not worth repairing', () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });

  const dir = path.join(root, 'install');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'demo.pak');

  const original = Buffer.concat(Array.from({ length: 8 }, (_, i) => Buffer.alloc(CHUNK, i + 1)));
  fs.writeFileSync(file, original);
  const manifest = buildManifest(file, { chunkSize: CHUNK });
  fs.writeFileSync(
    path.join(dir, 'blacknight.manifest.json'),
    JSON.stringify({ ...manifest, chunkSize: CHUNK })
  );
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', path: dir };

  fs.writeFileSync(file, Buffer.alloc(original.length, 0xff));
  const result = library.inspect('demo');

  assert.ok(result.damaged >= 7);
  assert.equal(result.worthRepairing, false, 'a fresh download is genuinely faster at this point');
});

test('a build with no block hashes says so rather than guessing', () => {
  const root = tmpDir();
  const library = new Library(root, CATALOG, stubDownloader(), createSettings(root), { allowSimulated: true });

  const dir = path.join(root, 'install');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo.pak'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(dir, 'blacknight.manifest.json'), JSON.stringify({ sizeBytes: 1024 }));
  library.store.get('entries').demo = { gameId: 'demo', title: 'Demo', owned: true, status: 'installed', path: dir };

  const result = library.inspect('demo');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-chunks');
});
