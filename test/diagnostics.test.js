'use strict';
/** Logging, catalog fallback, deep links, checksums and save snapshots. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { Logger, safeJson } = require('../electron/services/logger');
const { Catalog } = require('../electron/services/catalog');
const { Downloader } = require('../electron/services/downloader');
const { Library } = require('../electron/services/library');
const { createSettings } = require('../electron/services/settings');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-diag-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fakeApp = { getVersion: () => '1.0.0', isPackaged: false };

/* --- Logger -------------------------------------------------------------- */

test('the logger writes a readable line', () => {
  const dir = tmpDir();
  const log = new Logger(dir);
  log.info('boot', 'Started up');
  const text = fs.readFileSync(log.location().file, 'utf8');
  assert.match(text, /INFO {2}\[boot\] Started up/);
});

test('levels below the threshold are dropped', () => {
  const dir = tmpDir();
  const log = new Logger(dir, { level: 'warn' });
  log.info('scope', 'not written');
  log.error('scope', 'written');
  const text = fs.readFileSync(log.location().file, 'utf8');
  assert.ok(!text.includes('not written'));
  assert.ok(text.includes('written'));
});

test('machine details follow the diagnostics setting', () => {
  const off = new Logger(tmpDir(), { includeSystemInfo: false });
  off.header(fakeApp);
  assert.ok(!fs.readFileSync(off.location().file, 'utf8').includes('cpu'));

  const on = new Logger(tmpDir(), { includeSystemInfo: true });
  on.header(fakeApp);
  assert.ok(fs.readFileSync(on.location().file, 'utf8').includes('cpu'));
});

test('an Error logs its stack rather than {}', () => {
  const dir = tmpDir();
  const log = new Logger(dir);
  log.error('scope', 'It broke', new Error('kaboom'));
  const text = fs.readFileSync(log.location().file, 'utf8');
  assert.ok(text.includes('kaboom'), 'the message survives');
  assert.ok(text.includes('at '), 'and so does the stack');
});

test('a circular object does not throw', () => {
  const loop = { name: 'loop' };
  loop.self = loop;
  assert.match(safeJson(loop), /circular/);
});

/* --- Catalog fallback ---------------------------------------------------- */

const GOOD = { games: [{ id: 'a', title: 'A' }], news: [{ id: 'n1' }] };

function bundled(doc) {
  const dir = tmpDir();
  const file = path.join(dir, 'bundled.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return { dir, file };
}

test('the bundled catalog is used when nothing is cached', () => {
  const { dir, file } = bundled(GOOD);
  const catalog = new Catalog(dir, file, createSettings(tmpDir()), null);
  assert.equal(catalog.source, 'bundled');
  assert.equal(catalog.games.length, 1);
});

test('a cached catalog wins over the bundled one', () => {
  const { dir, file } = bundled(GOOD);
  fs.writeFileSync(
    path.join(dir, 'catalog.cache.json'),
    JSON.stringify({ games: [{ id: 'a' }, { id: 'b' }], news: [] })
  );
  const catalog = new Catalog(dir, file, createSettings(tmpDir()), null);
  assert.equal(catalog.source, 'cache');
  assert.equal(catalog.games.length, 2);
});

test('a corrupt cache falls back rather than emptying the store', () => {
  const { dir, file } = bundled(GOOD);
  fs.writeFileSync(path.join(dir, 'catalog.cache.json'), '{ not json');
  const catalog = new Catalog(dir, file, createSettings(tmpDir()), null);
  assert.equal(catalog.source, 'bundled');
  assert.equal(catalog.games.length, 1);
});

test('an empty games array is never accepted', () => {
  assert.equal(Catalog.valid({ games: [], news: [] }), false, 'a broken deploy must not empty the slate');
  assert.equal(Catalog.valid({ games: [{ id: 'a' }] }), true);
  assert.equal(Catalog.valid({ games: [{ title: 'no id' }] }), false);
  assert.equal(Catalog.valid(null), false);
});

test('refresh reports not-configured when no url is set', async () => {
  const { dir, file } = bundled(GOOD);
  const catalog = new Catalog(dir, file, createSettings(tmpDir()), null);
  const result = await catalog.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured');
});

test('an unreachable url keeps the catalog already loaded', async () => {
  const { dir, file } = bundled(GOOD);
  const settings = createSettings(tmpDir());
  // Reserved by RFC 5737 and guaranteed not to route anywhere.
  settings.set('catalogUrl', 'http://192.0.2.1:9/catalog.json');
  const catalog = new Catalog(dir, file, settings, null);
  const result = await catalog.refresh();
  assert.equal(result.ok, false);
  assert.equal(catalog.games.length, 1, 'the working catalog survived');
});

/* --- Checksums ----------------------------------------------------------- */

test('hashFile matches a known digest', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'blob.bin');
  fs.writeFileSync(file, 'blacknight');
  const expected = crypto.createHash('sha256').update('blacknight').digest('hex');
  assert.equal(Downloader.hashFile(file), expected);
});

test('hashFile returns null for a file that is not there', () => {
  assert.equal(Downloader.hashFile(path.join(tmpDir(), 'missing.bin')), null);
});

/* --- Saves and uninstall ------------------------------------------------- */

const CATALOG = {
  games: [{ id: 'demo', title: 'Demo', status: 'released', sizeBytes: 32, downloadUrl: 'https://example.com/d.zip' }]
};

function stubDownloader() {
  const d = new EventEmitter();
  d.list = () => [];
  d.enqueue = () => {};
  d.setGameRunning = () => {};
  return d;
}

function installedLibrary() {
  const dir = tmpDir();
  const settings = createSettings(dir);
  const games = path.join(dir, 'games');
  settings.set('installDir', games);
  const library = new Library(dir, CATALOG, stubDownloader(), settings, { allowSimulated: true });

  library.acquire('demo');
  const entry = library.store.get('entries').demo;
  entry.status = 'installed';
  entry.path = path.join(games, 'demo');
  fs.mkdirSync(path.join(entry.path, 'saves'), { recursive: true });
  fs.writeFileSync(path.join(entry.path, 'saves', 'slot1.sav'), 'progress');
  library.store.save();
  return { library, entry };
}

test('a save snapshot is taken and can be listed', () => {
  const { library } = installedLibrary();
  assert.equal(library.backupSaves('demo').ok, true);
  const snapshots = library.saveBackups('demo');
  assert.equal(snapshots.length, 1);
  assert.ok(snapshots[0].at > 0, 'the snapshot id parses back to a time');
});

test('only the requested number of snapshots is kept', () => {
  const { library } = installedLibrary();
  for (let i = 0; i < 5; i++) library.backupSaves('demo', { keep: 2 });
  assert.ok(library.saveBackups('demo').length <= 2);
});

test('keeping saves survives an uninstall', () => {
  const { library, entry } = installedLibrary();
  const installPath = entry.path;

  const result = library.uninstall('demo', { keepSaves: true });
  assert.equal(result.ok, true);
  assert.equal(result.savesKept, true);
  assert.equal(fs.existsSync(installPath), false, 'the install folder is gone');
  assert.ok(library.saveBackups('demo').length >= 1, 'but the saves are not');
});

test('declining to keep saves discards the snapshots too', () => {
  const { library } = installedLibrary();
  library.backupSaves('demo');
  library.uninstall('demo', { keepSaves: false });
  assert.equal(library.saveBackups('demo').length, 0);
});

test('a save can be restored after reinstalling', () => {
  const { library, entry } = installedLibrary();
  library.backupSaves('demo');
  const snapshot = library.saveBackups('demo')[0];

  // Lose the save the way a corrupt write would.
  fs.writeFileSync(path.join(entry.path, 'saves', 'slot1.sav'), 'corrupt');

  assert.equal(library.restoreSave('demo', snapshot.id).ok, true);
  assert.equal(fs.readFileSync(path.join(entry.path, 'saves', 'slot1.sav'), 'utf8'), 'progress');
});

test('restoring a snapshot that does not exist fails cleanly', () => {
  const { library } = installedLibrary();
  const result = library.restoreSave('demo', 'not-a-snapshot');
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer exists/);
});

/* --- Updates ------------------------------------------------------------- */

test('a version mismatch is what marks a title out of date', () => {
  const { library } = installedLibrary();
  library.store.get('entries').demo.version = '1.0.0';
  library.store.save();
  assert.equal(library.outdated().length, 0, 'same version, nothing to do');

  CATALOG.games[0].version = '1.1.0';
  const pending = library.outdated();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].availableVersion, '1.1.0');
  assert.equal(pending[0].installedVersion, '1.0.0');
  delete CATALOG.games[0].version;
});

test('updateAll holds off when automatic updates are switched off', () => {
  const { library } = installedLibrary();
  library.store.get('entries').demo.version = '0.9.0';
  library.store.save();
  CATALOG.games[0].version = '1.0.0';
  library.settings.set('autoUpdateGames', false);

  const result = library.updateAll({ auto: true });
  assert.equal(result.started.length, 0, 'nothing starts on its own');
  assert.equal(result.pending.length, 1, 'but the update is still reported');
  delete CATALOG.games[0].version;
});

/* --- Verify -------------------------------------------------------------- */

test('verify says so when it only had a size to go on', () => {
  const { library, entry } = installedLibrary();
  fs.writeFileSync(path.join(entry.path, 'demo.pak'), Buffer.alloc(32));
  fs.writeFileSync(
    path.join(entry.path, 'blacknight.manifest.json'),
    JSON.stringify({ gameId: 'demo', sizeBytes: 32, sha256: null })
  );

  const result = library.verify('demo');
  assert.equal(result.ok, true);
  assert.equal(result.checked, 'size');
  assert.match(result.message, /only file sizes/);
});

test('verify catches a file that is the right size and wrong content', () => {
  const { library, entry } = installedLibrary();
  const pak = path.join(entry.path, 'demo.pak');
  fs.writeFileSync(pak, Buffer.alloc(32, 1));
  const wrong = crypto.createHash('sha256').update(Buffer.alloc(32, 9)).digest('hex');
  fs.writeFileSync(
    path.join(entry.path, 'blacknight.manifest.json'),
    JSON.stringify({ gameId: 'demo', sizeBytes: 32, sha256: wrong })
  );

  const result = library.verify('demo');
  assert.equal(result.ok, false, 'a size check alone would have passed this');
  assert.equal(result.checked, 'checksum');
  assert.match(result.error, /corrupt/);
});

test('verify passes a file whose checksum matches', () => {
  const { library, entry } = installedLibrary();
  const bytes = Buffer.alloc(32, 7);
  const pak = path.join(entry.path, 'demo.pak');
  fs.writeFileSync(pak, bytes);
  fs.writeFileSync(
    path.join(entry.path, 'blacknight.manifest.json'),
    JSON.stringify({
      gameId: 'demo',
      sizeBytes: 32,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    })
  );

  const result = library.verify('demo');
  assert.equal(result.ok, true);
  assert.equal(result.checked, 'checksum');
});

/* --- Library folders ----------------------------------------------------- */

test('the primary folder always leads the list and cannot be removed', () => {
  const { library } = installedLibrary();
  const primary = library.installDir();
  assert.equal(library.libraryFolders()[0], primary);
  assert.equal(library.removeLibraryFolder(primary).ok, false);
});

test('a second folder can be added and removed', () => {
  const { library } = installedLibrary();
  const extra = path.join(tmpDir(), 'second-library');

  assert.equal(library.addLibraryFolder(extra).ok, true);
  assert.ok(library.libraryFolders().includes(extra));
  assert.equal(library.addLibraryFolder(extra).ok, false, 'no duplicates');
  assert.equal(library.removeLibraryFolder(extra).ok, true);
  assert.ok(!library.libraryFolders().includes(extra));
});

test('a folder holding an install cannot be dropped', () => {
  const { library, entry } = installedLibrary();
  const extra = path.join(tmpDir(), 'busy-library');
  library.addLibraryFolder(extra);

  entry.path = path.join(extra, 'demo');
  library.store.save();

  const result = library.removeLibraryFolder(extra);
  assert.equal(result.ok, false);
  assert.match(result.error, /still installed/);
});
