'use strict';
/** Download scheduling, bandwidth yielding, ownership and pre-order rules. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Downloader } = require('../electron/services/downloader');
const { Library } = require('../electron/services/library');
const { createSettings } = require('../electron/services/settings');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-sched-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const at = (hour, minute = 0) => new Date(2026, 0, 15, hour, minute);

function makeDownloader(patch = {}) {
  const dir = tmpDir();
  const settings = createSettings(dir);
  settings.set(patch);
  const downloader = new Downloader(dir, settings);
  test.after(() => downloader.shutdown());
  return { downloader, settings };
}

/* --- Download window ---------------------------------------------------- */

test('with no window configured, downloads may run at any hour', () => {
  const { downloader } = makeDownloader();
  assert.equal(downloader.withinWindow(at(3)), true);
  assert.equal(downloader.withinWindow(at(14)), true);
});

test('a window that wraps past midnight covers the small hours', () => {
  const { downloader } = makeDownloader({
    downloadWindowEnabled: true,
    downloadWindowStart: 23,
    downloadWindowEnd: 7
  });
  assert.equal(downloader.withinWindow(at(23, 30)), true, 'just after the window opens');
  assert.equal(downloader.withinWindow(at(2)), true, 'the middle of the night');
  assert.equal(downloader.withinWindow(at(6, 59)), true, 'the last minute');
  assert.equal(downloader.withinWindow(at(7)), false, 'the window has closed');
  assert.equal(downloader.withinWindow(at(14)), false, 'the afternoon');
});

test('a window inside one day behaves normally', () => {
  const { downloader } = makeDownloader({
    downloadWindowEnabled: true,
    downloadWindowStart: 9,
    downloadWindowEnd: 17
  });
  assert.equal(downloader.withinWindow(at(8, 59)), false);
  assert.equal(downloader.withinWindow(at(9)), true);
  assert.equal(downloader.withinWindow(at(16, 59)), true);
  assert.equal(downloader.withinWindow(at(17)), false);
});

test('a window with matching start and end is treated as always open', () => {
  const { downloader } = makeDownloader({
    downloadWindowEnabled: true,
    downloadWindowStart: 4,
    downloadWindowEnd: 4
  });
  assert.equal(downloader.withinWindow(at(4)), true);
  assert.equal(downloader.withinWindow(at(15)), true);
});

/* --- Bandwidth yielding -------------------------------------------------- */

test('a running game drops the transfer rate but never stops it', () => {
  const { downloader } = makeDownloader({ bandwidthLimitMbps: 100 });
  const full = downloader._limitBps();

  downloader.setGameRunning(true);
  const reduced = downloader._limitBps();

  assert.ok(reduced > 0, 'downloads must keep making progress');
  assert.ok(reduced < full, 'a running game should get the bandwidth back');
  assert.equal(Math.round(reduced), Math.round(full * 0.2), 'defaults to a 20% share');

  downloader.setGameRunning(false);
  assert.equal(downloader._limitBps(), full, 'the limit returns when the game closes');
});

test('yielding can be switched off', () => {
  const { downloader } = makeDownloader({ bandwidthLimitMbps: 100, yieldWhilePlaying: false });
  const full = downloader._limitBps();
  downloader.setGameRunning(true);
  assert.equal(downloader._limitBps(), full);
});

test('yielding still applies when no explicit limit is set', () => {
  const { downloader } = makeDownloader({ bandwidthLimitMbps: 0 });
  assert.equal(downloader._limitBps(), 0, 'uncapped by default');
  downloader.setGameRunning(true);
  const reduced = downloader._limitBps();
  assert.ok(reduced > 0 && reduced < 25_000_000);
});

/* --- Ownership and pre-orders -------------------------------------------- */

const CATALOG = {
  games: [
    { id: 'paid', title: 'Paid Game', status: 'released', sizeBytes: 1024, downloadUrl: 'https://example.com/a.zip' },
    { id: 'soon', title: 'Coming Soon', status: 'preorder', releaseDate: '2099-01-01', sizeBytes: 1024, downloadUrl: 'https://example.com/b.zip' },
    { id: 'past', title: 'Out Already', status: 'preorder', releaseDate: '2000-01-01', sizeBytes: 1024, downloadUrl: 'https://example.com/c.zip' },
    { id: 'far', title: 'Announced Only', status: 'announced', sizeBytes: 1024, downloadUrl: 'https://example.com/d.zip' }
  ]
};

function stubDownloader() {
  const d = new EventEmitter();
  d.queued = [];
  d.list = () => d.queued;
  d.enqueue = (item) => { d.queued.push({ ...item, id: `dl_${item.gameId}`, status: 'queued' }); return item; };
  d.setGameRunning = () => {};
  return d;
}

function makeLibrary() {
  const dir = tmpDir();
  const settings = createSettings(dir);
  settings.set('installDir', path.join(dir, 'games'));
  return new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });
}

const owns = (library, id) => library.list().find((g) => g.id === id).owned;

test('wishlisting a title does not hand it to the player', () => {
  const library = makeLibrary();
  library.setFavorite('paid', true);
  assert.equal(owns(library, 'paid'), false, 'a wishlist is not a purchase');
  assert.equal(library.list().find((g) => g.id === 'paid').favorite, true);
});

test('setting launch options does not hand it to the player either', () => {
  const library = makeLibrary();
  library.setLaunchOptions('paid', { launchArgs: '-windowed' });
  assert.equal(owns(library, 'paid'), false);
});

test('acquiring is what marks a title as owned', () => {
  const library = makeLibrary();
  library.acquire('paid');
  assert.equal(owns(library, 'paid'), true);
});

test('a pre-order can be pre-loaded once it is owned', () => {
  const library = makeLibrary();
  assert.equal(library.install('soon').ok, false, 'not before it is pre-ordered');
  library.acquire('soon');
  assert.equal(library.install('soon').ok, true, 'pre-loading is the point of a pre-order');
});

test('a title that is merely announced cannot be pre-loaded', () => {
  const library = makeLibrary();
  library.acquire('far');
  const result = library.install('far');
  assert.equal(result.ok, false);
  assert.match(result.error, /not been released/);
});

test('a pre-loaded title stays locked until its release date', () => {
  const library = makeLibrary();
  library.acquire('soon');
  library.install('soon');
  // Pretend the download finished.
  const entry = library.store.get('entries').soon;
  entry.status = 'installed';
  entry.path = tmpDir();
  library.store.save();

  const result = library.launch('soon');
  assert.equal(result.ok, false);
  assert.match(result.error, /unlocks on/);
  assert.ok(result.lockedUntil > Date.now());
});

test('a pre-order whose date has passed launches normally', () => {
  const library = makeLibrary();
  library.acquire('past');
  const entry = library.store.get('entries').past;
  entry.status = 'installed';
  entry.path = tmpDir();
  library.store.save();

  // No executable exists, so this takes the simulated-launch path - the point
  // is that the release-date gate did not block it.
  const result = library.launch('past');
  assert.equal(result.ok, true);
});

test('unlockAt only applies to dated pre-orders', () => {
  assert.equal(Library.unlockAt({ status: 'released', releaseDate: '2099-01-01' }), null);
  assert.equal(Library.unlockAt({ status: 'preorder' }), null);
  assert.ok(Library.unlockAt({ status: 'preorder', releaseDate: '2099-01-01' }) > Date.now());
});

/* --- Reclaimable --------------------------------------------------------- */

test('reclaimable puts never-played titles first', () => {
  const library = makeLibrary();
  const entries = library.store.get('entries');
  for (const id of ['paid', 'past']) {
    library.acquire(id);
    entries[id].status = 'installed';
  }
  entries.paid.playtimeSeconds = 7200;
  entries.paid.lastPlayed = Date.now() - 86400000;
  entries.past.playtimeSeconds = 0;
  entries.past.lastPlayed = null;
  library.store.save();

  const list = library.reclaimable();
  assert.equal(list.length, 2);
  assert.equal(list[0].gameId, 'past', 'never played should be offered up first');
});

/* --- Retrying a failed transfer ------------------------------------------ */

test('a network failure is retried rather than abandoned', () => {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const downloader = new Downloader(dir, settings);

  const item = downloader.enqueue({
    gameId: 'demo', title: 'Demo', totalBytes: 1000, installDir: dir, url: 'http://example.invalid/x.pak'
  });

  downloader._fail(downloader._find(item.id), 'socket hang up');

  const after = downloader._find(item.id);
  assert.equal(after.status, 'retrying', 'not failed');
  assert.equal(after.attempts, 1);
  assert.ok(after.retryAt > Date.now(), 'and it is scheduled');
  assert.match(after.error, /retrying \(1\/5\)/, 'and says so');

  downloader.cancel(item.id);
});

test('it gives up after the attempt budget, and says how many', () => {
  const dir = tmpDir();
  const downloader = new Downloader(dir, createSettings(dir));
  const item = downloader.enqueue({
    gameId: 'demo', title: 'Demo', totalBytes: 1000, installDir: dir, url: 'http://example.invalid/x.pak'
  });

  for (let i = 0; i <= Downloader.MAX_ATTEMPTS; i++) {
    downloader._fail(downloader._find(item.id), 'socket hang up');
  }

  const after = downloader._find(item.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /gave up after 5 attempts/);

  downloader.cancel(item.id);
});

test('a failure that will never come right is not retried', () => {
  // A static classification, so no instance is needed.
  for (const [message, retried] of [
    ['socket hang up', true],
    ['ETIMEDOUT', true],
    ['Server responded 500', true],
    ['Server responded 503', true],
    ['Server responded 429', true],
    ['Server responded 404', false],
    ['Server responded 403', false],
    ['Server responded 401', false],
    ['That file failed its checksum', false],
    ['ENOSPC: no space left on device', false]
  ]) {
    assert.equal(Downloader.retryable(message), retried, `${message} should ${retried ? '' : 'not '}retry`);
  }
});

test('the backoff climbs and then holds', () => {
  const waits = [0, 1, 2, 3, 4, 10].map((n) => Downloader.backoffMs(n));
  for (let i = 1; i < 4; i++) assert.ok(waits[i] > waits[i - 1], 'it climbs');
  assert.equal(waits[4], waits[5], 'and caps rather than growing forever');
  assert.ok(waits[5] <= 120000, 'and never waits more than a couple of minutes');
});

test('pausing a retry stops it, and resuming resets the budget', () => {
  const dir = tmpDir();
  const downloader = new Downloader(dir, createSettings(dir));
  const item = downloader.enqueue({
    gameId: 'demo', title: 'Demo', totalBytes: 1000, installDir: dir, url: 'http://example.invalid/x.pak'
  });

  downloader._fail(downloader._find(item.id), 'socket hang up');
  downloader._fail(downloader._find(item.id), 'socket hang up');
  assert.equal(downloader._find(item.id).attempts, 2);

  downloader.pause(item.id);
  assert.equal(downloader._find(item.id).status, 'paused');
  assert.equal(downloader._find(item.id).retryAt, null);

  downloader.resume(item.id);
  const after = downloader._find(item.id);
  // The pump picks it straight back up, so it is already moving rather than
  // sitting in the queue.
  assert.ok(['queued', 'downloading'].includes(after.status), `resumed to ${after.status}`);
  assert.equal(after.attempts, 0, 'asking by hand means the person thinks the network is back');

  downloader.cancel(item.id);
});
