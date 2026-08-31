'use strict';
/**
 * Unit tests for the main-process services.
 *
 * None of these modules import electron, so they run under plain `node --test`
 * with no display and no packaged app:
 *
 *   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Store } = require('../electron/services/store');
const { createSettings, SETTINGS_DEFAULTS } = require('../electron/services/settings');
const { Auth } = require('../electron/services/auth');
const { Library } = require('../electron/services/library');

/** A throwaway data directory per test, cleaned up when the run ends. */
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* --- Store ------------------------------------------------------------- */

test('Store applies defaults for keys the file does not carry', () => {
  const store = new Store(tmpDir(), 'demo', { a: 1, b: 'two' });
  assert.equal(store.get('a'), 1);
  assert.equal(store.get('b'), 'two');
  assert.equal(store.get('missing', 'fallback'), 'fallback');
});

test('Store round-trips through disk', () => {
  const dir = tmpDir();
  new Store(dir, 'demo', { count: 0 }).set('count', 41);
  assert.equal(new Store(dir, 'demo', { count: 0 }).get('count'), 41);
});

test('Store.set accepts a patch object', () => {
  const store = new Store(tmpDir(), 'demo', { a: 1, b: 2 });
  store.set({ a: 9, c: 3 });
  assert.equal(store.get('a'), 9);
  assert.equal(store.get('b'), 2);
  assert.equal(store.get('c'), 3);
});

test('Store falls back to defaults when the file is corrupt', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'demo.json'), '{ this is not json');
  assert.equal(new Store(dir, 'demo', { safe: true }).get('safe'), true);
});

test('Store.reset restores every default', () => {
  const store = new Store(tmpDir(), 'demo', { a: 1 });
  store.set('a', 99);
  store.reset();
  assert.equal(store.get('a'), 1);
});

/* --- Settings ---------------------------------------------------------- */

test('settings ship the keys the launcher reads at boot', () => {
  const settings = createSettings(tmpDir());
  for (const key of ['accent', 'installDir', 'autoCheckUpdates', 'closeAction', 'concurrentDownloads']) {
    assert.ok(key in settings.get(), `missing default: ${key}`);
  }
  assert.equal(settings.get('autoCheckUpdates'), true);
  assert.equal(SETTINGS_DEFAULTS.accent, 'moonlight');
});

/* --- Accounts ---------------------------------------------------------- */

const GOOD = {
  email: 'player@example.com',
  handle: 'NightRunner',
  password: 'Moonlight42!',
  displayName: 'Night'
};

test('signUp rejects a malformed email', () => {
  const auth = new Auth(tmpDir());
  assert.equal(auth.signUp({ ...GOOD, email: 'not-an-email' }).ok, false);
});

test('signUp rejects a handle outside 3-20 word characters', () => {
  const auth = new Auth(tmpDir());
  assert.equal(auth.signUp({ ...GOOD, handle: 'no' }).ok, false);
  assert.equal(auth.signUp({ ...GOOD, handle: 'has spaces' }).ok, false);
});

test('signUp rejects short and weak passwords', () => {
  const auth = new Auth(tmpDir());
  assert.equal(auth.signUp({ ...GOOD, password: 'short' }).ok, false);
  assert.equal(auth.signUp({ ...GOOD, password: 'aaaaaaaaaaaa' }).ok, false);
});

test('signUp accepts a valid account and refuses duplicates', () => {
  const auth = new Auth(tmpDir());
  assert.equal(auth.signUp(GOOD).ok, true);
  assert.equal(auth.signUp(GOOD).ok, false, 'duplicate email must be refused');
  assert.equal(
    auth.signUp({ ...GOOD, email: 'other@example.com' }).ok,
    false,
    'duplicate handle must be refused'
  );
});

test('the account handed to the renderer never carries the hash or salt', () => {
  const auth = new Auth(tmpDir());
  const { user } = auth.signUp(GOOD);
  assert.ok(user.handle);
  assert.equal(user.hash, undefined);
  assert.equal(user.salt, undefined);
});

test('signIn works by email or handle, and fails on a wrong password', () => {
  const auth = new Auth(tmpDir());
  auth.signUp(GOOD);
  assert.equal(auth.signIn({ identifier: GOOD.email, password: GOOD.password }).ok, true);
  assert.equal(auth.signIn({ identifier: 'nightrunner', password: GOOD.password }).ok, true);
  assert.equal(auth.signIn({ identifier: GOOD.email, password: 'wrong-password' }).ok, false);
});

test('signIn on an unknown account fails without revealing that it is unknown', () => {
  const auth = new Auth(tmpDir());
  auth.signUp(GOOD);
  const unknown = auth.signIn({ identifier: 'ghost@example.com', password: 'whatever12!' });
  const wrong = auth.signIn({ identifier: GOOD.email, password: 'whatever12!' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, wrong.error, 'the two failures must be indistinguishable');
});

test('a session survives a restart, and signOut ends it', () => {
  const dir = tmpDir();
  const auth = new Auth(dir);
  auth.signUp(GOOD);
  assert.equal(new Auth(dir).session().ok, true);
  auth.signOut();
  assert.equal(new Auth(dir).session().ok, false);
});

test('changePassword requires the current one and rotates the credential', () => {
  const auth = new Auth(tmpDir());
  const { user } = auth.signUp(GOOD);
  assert.equal(auth.changePassword(user.id, { current: 'nope', next: 'Starlight88!' }).ok, false);
  assert.equal(auth.changePassword(user.id, { current: GOOD.password, next: 'Starlight88!' }).ok, true);
  assert.equal(auth.signIn({ identifier: GOOD.email, password: GOOD.password }).ok, false);
  assert.equal(auth.signIn({ identifier: GOOD.email, password: 'Starlight88!' }).ok, true);
});

/* --- Library ----------------------------------------------------------- */

const CATALOG = {
  games: [
    {
      id: 'shipped',
      title: 'Shipped Game',
      status: 'released',
      sizeBytes: 1024,
      downloadUrl: 'https://downloads.example.com/shipped.zip'
    },
    { id: 'no-build', title: 'No Build Yet', status: 'released', sizeBytes: 1024 },
    { id: 'upcoming', title: 'Upcoming', status: 'coming-soon', sizeBytes: 1024 }
  ]
};

/** Records what the library asked the download engine to do. */
function stubDownloader() {
  const downloader = new EventEmitter();
  downloader.queued = [];
  downloader.list = () => downloader.queued;
  downloader.enqueue = (item) => {
    downloader.queued.push({ ...item, id: `dl_${item.gameId}`, status: 'queued' });
    return item;
  };
  downloader.cancelForGame = () => {};
  return downloader;
}

function makeLibrary(dir, options) {
  const settings = createSettings(dir);
  settings.set('installDir', path.join(dir, 'games'));
  return new Library(dir, CATALOG, stubDownloader(), settings, options);
}

test('a released title with a real build installs', () => {
  const library = makeLibrary(tmpDir(), { allowSimulated: false });
  library.acquire('shipped');
  assert.equal(library.install('shipped').ok, true);
});

test('a title with no build is refused in a shipped launcher', () => {
  const library = makeLibrary(tmpDir(), { allowSimulated: false });
  library.acquire('no-build');
  const result = library.install('no-build');
  assert.equal(result.ok, false);
  assert.match(result.error, /does not have a downloadable build/);
});

test('the simulated writer is still available to development builds', () => {
  const library = makeLibrary(tmpDir(), { allowSimulated: true });
  library.acquire('no-build');
  assert.equal(library.install('no-build').ok, true);
});

test('an unreleased title never installs', () => {
  const library = makeLibrary(tmpDir(), { allowSimulated: true });
  const result = library.install('upcoming');
  assert.equal(result.ok, false);
  assert.match(result.error, /not been released/);
});

test('an unknown id is rejected rather than throwing', () => {
  const library = makeLibrary(tmpDir(), { allowSimulated: true });
  assert.equal(library.install('does-not-exist').ok, false);
});
