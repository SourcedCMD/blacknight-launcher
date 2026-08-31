'use strict';
/** Channels, rollback, install recovery, data usage and achievements. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { Library } = require('../electron/services/library');
const { Achievements } = require('../electron/services/achievements');
const { createSettings } = require('../electron/services/settings');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-ch-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CATALOG = {
  games: [
    {
      id: 'demo',
      title: 'Demo',
      status: 'released',
      sizeBytes: 64,
      version: '1.0.0',
      downloadUrl: 'https://example.com/d.zip',
      channels: [
        { id: 'playtest', label: 'Playtest', version: '1.1.0-pt3', notes: 'Weekly build' },
        { id: 'public-beta', label: 'Public beta', version: '1.1.0-beta', requiresPlus: false }
      ]
    },
    { id: 'plain', title: 'Plain', status: 'released', sizeBytes: 32, version: '2.0.0' }
  ]
};

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

/** An installed build with a real payload and matching manifest. */
function install(library, gameId, version, fill) {
  library.acquire(gameId);
  const entry = library.store.get('entries')[gameId];
  entry.status = 'installed';
  entry.version = version;
  entry.path = path.join(library.installDir(), gameId);
  fs.mkdirSync(entry.path, { recursive: true });

  const payload = Buffer.alloc(64, fill);
  fs.writeFileSync(path.join(entry.path, `${gameId}.pak`), payload);
  fs.writeFileSync(
    path.join(entry.path, 'blacknight.manifest.json'),
    JSON.stringify({
      gameId,
      title: gameId,
      version,
      sizeBytes: payload.length,
      installedAt: Date.now(),
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    })
  );
  library.store.save();
  return entry;
}

/* --- Channels ------------------------------------------------------------ */

test('stable is always offered and is never declared in the catalog', () => {
  const library = makeLibrary();
  const channels = library.channelsFor('demo');
  assert.equal(channels[0].id, 'stable');
  assert.equal(channels[0].requiresPlus, false);
  assert.equal(channels.length, 3);
});

test('a title with no channels still has stable', () => {
  const library = makeLibrary();
  const channels = library.channelsFor('plain');
  assert.equal(channels.length, 1);
  assert.equal(channels[0].version, '2.0.0');
});

test('a playtest channel defaults to members only', () => {
  const library = makeLibrary();
  const playtest = library.channelsFor('demo').find((c) => c.id === 'playtest');
  assert.equal(playtest.requiresPlus, true, 'BlackNight+ sells this, so it defaults to gated');
});

test('a standard account cannot take a members-only channel', () => {
  const library = makeLibrary();
  const result = library.setChannel('demo', 'playtest', { tier: 'standard' });
  assert.equal(result.ok, false);
  assert.equal(result.requiresPlus, true);
  assert.equal(library.channelOf('demo').id, 'stable', 'and nothing changed');
});

test('a Plus account can', () => {
  const library = makeLibrary();
  const result = library.setChannel('demo', 'playtest', { tier: 'plus' });
  assert.equal(result.ok, true);
  assert.equal(library.channelOf('demo').id, 'playtest');
});

test('a channel explicitly opened to everyone needs no membership', () => {
  const library = makeLibrary();
  assert.equal(library.setChannel('demo', 'public-beta', { tier: 'standard' }).ok, true);
});

test('switching channels while installed reports that the build is now wrong', () => {
  const library = makeLibrary();
  install(library, 'demo', '1.0.0', 1);
  const result = library.setChannel('demo', 'playtest', { tier: 'plus' });
  assert.equal(result.needsSwap, true);
});

test('an unknown channel is refused', () => {
  const library = makeLibrary();
  assert.equal(library.setChannel('demo', 'nightly', { tier: 'plus' }).ok, false);
});

/* --- Rollback ------------------------------------------------------------ */

test('nothing is offered when no previous build was kept', () => {
  const library = makeLibrary();
  install(library, 'demo', '1.0.0', 1);
  assert.equal(library.rollbackAvailable('demo'), null);
});

test('the replaced build is what comes back', () => {
  const library = makeLibrary();
  const entry = install(library, 'demo', '1.0.0', 1);

  assert.equal(library.stashForRollback('demo').ok, true);

  // Stand in for an update landing.
  const updated = Buffer.alloc(64, 2);
  fs.writeFileSync(path.join(entry.path, 'demo.pak'), updated);
  fs.writeFileSync(
    path.join(entry.path, 'blacknight.manifest.json'),
    JSON.stringify({
      gameId: 'demo', version: '1.1.0', sizeBytes: 64,
      sha256: crypto.createHash('sha256').update(updated).digest('hex')
    })
  );
  entry.version = '1.1.0';
  library.store.save();

  assert.equal(library.rollbackAvailable('demo').version, '1.0.0');
  const result = library.rollback('demo');
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(fs.readFileSync(path.join(entry.path, 'demo.pak')), Buffer.alloc(64, 1));
});

test('a rollback is itself reversible', () => {
  const library = makeLibrary();
  const entry = install(library, 'demo', '1.0.0', 1);
  library.stashForRollback('demo');
  entry.version = '1.1.0';
  library.store.save();

  const result = library.rollback('demo');
  assert.equal(result.canRedo, true, 'the build being replaced is kept in turn');
});

test('a corrupt kept build is refused and discarded', () => {
  const library = makeLibrary();
  const entry = install(library, 'demo', '1.0.0', 1);
  library.stashForRollback('demo');
  entry.version = '1.1.0';
  library.store.save();

  // Rot the stashed payload without touching its manifest.
  fs.writeFileSync(path.join(library.rollbackRoot('demo'), 'demo.pak'), Buffer.alloc(64, 9));

  const result = library.rollback('demo');
  assert.equal(result.ok, false);
  assert.match(result.error, /corrupt/);
  assert.equal(library.rollbackAvailable('demo'), null, 'and is not offered again');
});

test('rolling back a running game is refused', () => {
  const library = makeLibrary();
  install(library, 'demo', '1.0.0', 1);
  library.stashForRollback('demo');
  library.sessions.set('demo', { pid: 1, startedAt: Date.now() });
  assert.match(library.rollback('demo').error, /Close the game/);
});

/* --- Install recovery ---------------------------------------------------- */

test('a build on disk with no library entry is found', () => {
  const library = makeLibrary();
  install(library, 'demo', '1.0.0', 1);

  // Forget it, the way a reinstalled launcher would.
  delete library.store.get('entries').demo;
  library.store.save();

  const found = library.scanForInstalls();
  assert.equal(found.length, 1);
  assert.equal(found[0].gameId, 'demo');
  assert.equal(found[0].hasChecksum, true);
});

test('an install already known about is not offered', () => {
  const library = makeLibrary();
  install(library, 'demo', '1.0.0', 1);
  assert.equal(library.scanForInstalls().length, 0);
});

test('a partial download is not mistaken for an install', () => {
  const library = makeLibrary();
  const entry = install(library, 'demo', '1.0.0', 1);
  fs.writeFileSync(path.join(entry.path, 'demo.pak'), Buffer.alloc(8, 1)); // truncated
  delete library.store.get('entries').demo;
  library.store.save();
  assert.equal(library.scanForInstalls().length, 0);
});

test('adopting verifies before it trusts', () => {
  const library = makeLibrary();
  const entry = install(library, 'demo', '1.0.0', 1);
  const dir = entry.path;
  delete library.store.get('entries').demo;
  library.store.save();

  assert.equal(library.adoptInstall('demo').ok, true);
  assert.equal(library.list().find((g) => g.id === 'demo').installed, true);

  // Now corrupt it and make sure a second adoption is refused.
  library.store.set('entries', {});
  fs.writeFileSync(path.join(dir, 'demo.pak'), Buffer.alloc(64, 7));
  const bad = library.adoptInstall('demo');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /checksum/);
});

/* --- Data usage ---------------------------------------------------------- */

test('usage is recorded by source and totalled', () => {
  const library = makeLibrary();
  library.recordTransfer(1000, { source: 'origin' });
  library.recordTransfer(500, { source: 'peer' });
  library.recordTransfer(9000, { source: 'reused' });

  const [month] = library.dataUsage();
  assert.equal(month.origin, 1000);
  assert.equal(month.peer, 500);
  assert.equal(month.reused, 9000);
  assert.equal(month.total, 1500, 'reused blocks never crossed the connection');
});

test('a zero or negative transfer is ignored', () => {
  const library = makeLibrary();
  library.recordTransfer(0);
  library.recordTransfer(-5);
  assert.equal(library.dataUsage().length, 0);
});

/* --- Achievements -------------------------------------------------------- */

function achievementsFor(library) {
  return new Achievements(library.dir, library);
}

test('nothing is earned on a fresh install', () => {
  const library = makeLibrary();
  assert.equal(achievementsFor(library).evaluate().length, 0);
});

test('the first session earns the first achievement', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 600 });
  const earned = achievementsFor(library).evaluate();
  assert.ok(earned.some((a) => a.id === 'first-night'));
});

test('an achievement is only ever awarded once', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 600 });
  const achievements = achievementsFor(library);
  assert.equal(achievements.evaluate().length > 0, true);
  assert.equal(achievements.evaluate().length, 0, 're-evaluating awards nothing new');
});

test('a long session earns Long Haul', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 7 * 3600 });
  assert.ok(achievementsFor(library).evaluate().some((a) => a.id === 'long-haul'));
});

test('progress counts what has been earned', () => {
  const library = makeLibrary();
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 600 });
  const achievements = achievementsFor(library);
  achievements.evaluate();
  const progress = achievements.progress();
  assert.ok(progress.earned >= 1);
  assert.ok(progress.total > progress.earned);
});

test('an earned achievement survives uninstalling the game', () => {
  const library = makeLibrary();
  install(library, 'demo', '1.0.0', 1);
  library.addJournalEntry({ gameId: 'demo', title: 'Demo', seconds: 600 });
  const achievements = achievementsFor(library);
  achievements.evaluate();

  library.uninstall('demo');
  assert.equal(achievements.evaluate().length, 0);
  assert.ok(achievements.list().find((a) => a.id === 'first-night').earned, 'not revoked');
});
