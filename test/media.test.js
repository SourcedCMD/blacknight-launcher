'use strict';
/**
 * Screenshot fetching.
 *
 * The URL rules are the part that matters: whatever comes back is handed to
 * the renderer as a data URI, so a catalogue entry pointing somewhere it
 * should not is the one thing that must never work.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Media, validImageUrl, MAX_PER_GAME } = require('../electron/services/media');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-media-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Media(dir, null);
}

test('an https image URL is accepted', () => {
  for (const url of [
    'https://cdn.example.com/shot.jpg',
    'https://cdn.example.com/shot.jpeg',
    'https://cdn.example.com/a/b/shot.png',
    'https://cdn.example.com/shot.webp',
    'https://cdn.example.com/shot.avif'
  ]) {
    assert.ok(validImageUrl(url), `${url} should be accepted`);
  }
});

test('plain http is refused, because it can be swapped in transit', () => {
  assert.equal(validImageUrl('http://cdn.example.com/shot.jpg'), null);
});

test('anything that is not an image is refused', () => {
  for (const url of [
    'https://cdn.example.com/payload.svg',   // svg can carry script
    'https://cdn.example.com/thing.html',
    'https://cdn.example.com/no-extension',
    'file:///C:/Windows/win.ini',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined
  ]) {
    assert.equal(validImageUrl(url), null, `${url} must be refused`);
  }
});

test('a title with no media asks for nothing', async () => {
  assert.deepEqual(await store().screenshots({ id: 'demo' }), []);
  assert.deepEqual(await store().screenshots({ id: 'demo', media: {} }), []);
});

test('a bad URL is skipped rather than taking out the gallery', async () => {
  const media = store();
  // None of these are fetchable; the call must still resolve with an array.
  const shots = await media.screenshots({
    id: 'demo',
    media: { screenshots: ['http://insecure.example/a.jpg', 'https://example.com/not-an-image', 'nonsense'] }
  });
  assert.deepEqual(shots, []);
});

test('an unreachable host is an empty gallery, not a crash', async () => {
  const media = store();
  const shots = await media.screenshots({
    id: 'demo',
    // Reserved for documentation and never routable.
    media: { screenshots: ['https://127.0.0.1:1/shot.jpg'] }
  });
  assert.deepEqual(shots, []);
});

test('the number of screenshots per title is capped', () => {
  assert.ok(MAX_PER_GAME > 0 && MAX_PER_GAME <= 24, 'a sane cap');
});

test('usage reports an empty cache before anything is fetched', () => {
  const usage = store().usage();
  assert.equal(usage.count, 0);
  assert.equal(usage.bytes, 0);
});

test('clearing an empty cache is not an error', () => {
  const media = store();
  assert.equal(media.clear().ok, true);
  assert.equal(media.usage().count, 0);
});

test('a cached file is served without fetching again', async () => {
  const media = store();
  const url = validImageUrl('https://cdn.example.com/shot.png');

  // Plant a file where the cache would put it.
  const file = media._cacheFile(url);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const shots = await media.screenshots({ id: 'demo', media: { screenshots: [url.href] } });
  assert.equal(shots.length, 1, 'served from the cache');
  assert.match(shots[0].src, /^data:image\/png;base64,/);
  assert.equal(media.usage().count, 1);
});
