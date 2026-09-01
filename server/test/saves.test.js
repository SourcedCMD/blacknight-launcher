'use strict';
/**
 * Cloud saves, with the conflict case as the point of the exercise.
 *
 * Losing a save is the worst thing a launcher can do to somebody, so most of
 * these tests are about refusing to overwrite rather than about transferring
 * successfully.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Saves, KEEP } = require('../lib/saves');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-saves-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Saves(dir);
}

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'.replace(/-/g, '');
const body = (text) => Buffer.from(text, 'utf8').toString('base64');

test('nothing is stored for a title until something is pushed', () => {
  const saves = store();
  assert.deepEqual(saves.list(USER, 'ashfall'), []);
  assert.equal(saves.head(USER, 'ashfall'), null);
});

test('a save round-trips intact', () => {
  const saves = store();
  const pushed = saves.push(USER, 'ashfall', { data: body('chapter three'), basedOn: null, machine: 'desk' });

  const pulled = saves.pull(USER, 'ashfall');
  assert.equal(pulled.id, pushed.id);
  assert.equal(Buffer.from(pulled.data, 'base64').toString('utf8'), 'chapter three');
  assert.equal(pulled.machine, 'desk');
});

test('a second machine pushing blind is refused rather than overwriting', () => {
  const saves = store();
  const first = saves.push(USER, 'ashfall', { data: body('from the desktop'), basedOn: null });

  // The laptop still thinks the world is empty.
  assert.throws(
    () => saves.push(USER, 'ashfall', { data: body('from the laptop'), basedOn: null }),
    (err) => err.status === 409 && err.conflict.theirs.id === first.id
  );

  // And the desktop's save is untouched.
  assert.equal(Buffer.from(saves.pull(USER, 'ashfall').data, 'base64').toString('utf8'), 'from the desktop');
});

test('a machine that has synced can push', () => {
  const saves = store();
  const first = saves.push(USER, 'ashfall', { data: body('one'), basedOn: null });
  const second = saves.push(USER, 'ashfall', { data: body('two'), basedOn: first.id });

  assert.equal(saves.head(USER, 'ashfall').id, second.id);
  assert.equal(Buffer.from(saves.pull(USER, 'ashfall').data, 'base64').toString('utf8'), 'two');
});

test('a conflict leaves both versions recoverable', () => {
  const saves = store();
  const first = saves.push(USER, 'ashfall', { data: body('one'), basedOn: null });
  const second = saves.push(USER, 'ashfall', { data: body('two'), basedOn: first.id });

  // The older one can still be fetched by id, which is what makes a conflict
  // recoverable rather than a choice you get once.
  assert.equal(Buffer.from(saves.pull(USER, 'ashfall', first.id).data, 'base64').toString('utf8'), 'one');
  assert.equal(saves.list(USER, 'ashfall').length, 2);
  assert.equal(saves.head(USER, 'ashfall').id, second.id);
});

test('old versions are pruned but the newest never is', () => {
  const saves = store();
  let basedOn = null;
  for (let i = 0; i < KEEP + 4; i++) {
    basedOn = saves.push(USER, 'ashfall', { data: body(`version ${i}`), basedOn }).id;
  }

  const versions = saves.list(USER, 'ashfall');
  assert.equal(versions.length, KEEP);
  assert.equal(versions[0].id, basedOn, 'the newest survived');
  assert.equal(Buffer.from(saves.pull(USER, 'ashfall').data, 'base64').toString('utf8'), `version ${KEEP + 3}`);
});

test('an empty save is refused', () => {
  const saves = store();
  assert.throws(() => saves.push(USER, 'ashfall', { data: '', basedOn: null }), /empty/);
});

test('an enormous save is refused rather than accepted and stored', () => {
  const saves = store();
  const huge = Buffer.alloc(65 * 1024 * 1024).toString('base64');
  assert.throws(() => saves.push(USER, 'ashfall', { data: huge, basedOn: null }), (err) => err.status === 413);
});

test('a title id cannot climb out of its directory', () => {
  const saves = store();
  for (const nasty of ['../../etc', '..\\..\\windows', 'a/b', '', '.', 'x'.repeat(100)]) {
    assert.throws(() => saves.push(USER, nasty, { data: body('x'), basedOn: null }), /valid title id/, `for ${nasty}`);
  }
});

test('an account id is checked the same way', () => {
  const saves = store();
  assert.throws(() => saves.list('../someone-else', 'ashfall'), /Bad account/);
});

test('a corrupted stored save is an error, not a bad restore', () => {
  const saves = store();
  const pushed = saves.push(USER, 'ashfall', { data: body('good data'), basedOn: null });

  // Simulate bit rot on disk.
  const file = path.join(saves.root, USER, 'ashfall', `${pushed.id}.bin`);
  fs.writeFileSync(file, 'corrupted');

  assert.throws(() => saves.pull(USER, 'ashfall'), /checksum/);
});

test('pulling a title that has nothing is a 404, not an empty save', () => {
  const saves = store();
  assert.throws(() => saves.pull(USER, 'never-played'), (err) => err.status === 404);
});

test('usage reports what an account is storing', () => {
  const saves = store();
  saves.push(USER, 'ashfall', { data: body('a'.repeat(100)), basedOn: null });
  saves.push(USER, 'tidebreaker', { data: body('b'.repeat(50)), basedOn: null });

  const usage = saves.usage(USER);
  assert.equal(usage.titles.length, 2);
  assert.ok(usage.totalBytes > 0);
  assert.ok(usage.titles.every((t) => t.versions === 1));
});

test('one account cannot see another account saves', () => {
  const saves = store();
  saves.push(USER, 'ashfall', { data: body('mine'), basedOn: null });

  const other = 'ffffffffffffffffffffffffffffffff';
  assert.deepEqual(saves.list(other, 'ashfall'), []);
  assert.throws(() => saves.pull(other, 'ashfall'), (err) => err.status === 404);
});

test('removing a title clears every version of it', () => {
  const saves = store();
  let basedOn = null;
  for (let i = 0; i < 3; i++) basedOn = saves.push(USER, 'ashfall', { data: body(`v${i}`), basedOn }).id;

  saves.remove(USER, 'ashfall');
  assert.deepEqual(saves.list(USER, 'ashfall'), []);
});
