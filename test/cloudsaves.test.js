'use strict';
/**
 * The save archive.
 *
 * The format is trivial, so most of what matters here is the unpacking: the
 * archive arrives from a server, and a path inside it that escapes the save
 * folder would let a compromised or hostile service write anywhere the
 * launcher can.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { pack, unpack, validUrl } = require('../electron/services/cloudsaves');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-cloud-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relative, contents) {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

/* --- Round trip ---------------------------------------------------------- */

test('a save folder packs and unpacks unchanged', () => {
  const source = tmp();
  write(source, 'slot1.sav', Buffer.from([0, 1, 2, 253, 254, 255]));
  write(source, 'profile.json', '{"name":"Sam"}');
  write(source, 'screenshots/one.png', Buffer.alloc(64, 7));

  const target = tmp();
  const result = unpack(pack(source), target);

  assert.equal(result.files, 3);
  assert.deepEqual(fs.readFileSync(path.join(target, 'slot1.sav')), Buffer.from([0, 1, 2, 253, 254, 255]));
  assert.equal(fs.readFileSync(path.join(target, 'profile.json'), 'utf8'), '{"name":"Sam"}');
  assert.equal(fs.readFileSync(path.join(target, 'screenshots/one.png')).length, 64);
});

test('nested folders survive the round trip', () => {
  const source = tmp();
  write(source, 'a/b/c/deep.sav', 'down here');

  const target = tmp();
  unpack(pack(source), target);
  assert.equal(fs.readFileSync(path.join(target, 'a/b/c/deep.sav'), 'utf8'), 'down here');
});

test('an empty folder packs to something that unpacks to nothing', () => {
  const source = tmp();
  const target = tmp();
  assert.equal(unpack(pack(source), target).files, 0);
});

test('the archive is compressed rather than raw base64', () => {
  const source = tmp();
  // Highly compressible, so the difference is unambiguous.
  write(source, 'big.sav', Buffer.alloc(200000, 65));

  const archive = pack(source);
  assert.ok(archive.length < 20000, `${archive.length} bytes is not compressed`);
});

/* --- What unpacking refuses ---------------------------------------------- */

/** Builds an archive by hand, the way a hostile server would. */
function forge(entries) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, entries }), 'utf8')).toString('base64');
}

test('a path that climbs out of the save folder is refused', () => {
  const target = tmp();
  for (const nasty of [
    '../escaped.txt',
    '../../escaped.txt',
    'a/../../escaped.txt',
    '..\\escaped.txt'
  ]) {
    assert.throws(
      () => unpack(forge([{ path: nasty, data: Buffer.from('x').toString('base64') }]), target),
      /outside the save folder/,
      `for ${nasty}`
    );
  }
});

test('an absolute path is refused', () => {
  const target = tmp();
  const absolute = process.platform === 'win32' ? 'C:\\Windows\\Temp\\bn.txt' : '/tmp/bn.txt';
  assert.throws(
    () => unpack(forge([{ path: absolute, data: Buffer.from('x').toString('base64') }]), target),
    /outside the save folder/
  );
});

test('nothing is written when a bad path is found', () => {
  const target = tmp();
  const archive = forge([
    { path: 'fine.sav', data: Buffer.from('ok').toString('base64') },
    { path: '../escaped.sav', data: Buffer.from('bad').toString('base64') }
  ]);

  assert.throws(() => unpack(archive, target), /outside/);
  // The good entry before it may exist; what must not is anything outside.
  assert.ok(!fs.existsSync(path.join(path.dirname(target), 'escaped.sav')));
});

test('an archive from a newer launcher is refused rather than half-read', () => {
  const target = tmp();
  const future = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 99, entries: [] }))).toString('base64');
  assert.throws(() => unpack(future, target), /newer version/);
});

test('rubbish is an error, not a crash', () => {
  const target = tmp();
  for (const junk of ['', 'not-base64!!', Buffer.from('not gzip').toString('base64')]) {
    assert.throws(() => unpack(junk, target));
  }
});

/* --- Limits -------------------------------------------------------------- */

test('a folder with too many files is refused', () => {
  const source = tmp();
  for (let i = 0; i < 2100; i++) write(source, `f${i}.sav`, 'x');
  assert.throws(() => pack(source), /too many files/);
});

/* --- The service URL ----------------------------------------------------- */

test('only http and https are accepted as a service URL', () => {
  assert.ok(validUrl('https://saves.example.com'));
  assert.ok(validUrl('http://localhost:8080'));
  for (const bad of ['file:///etc/passwd', 'ftp://x', 'javascript:alert(1)', '', null]) {
    assert.equal(validUrl(bad), null, `${bad} must be refused`);
  }
});
