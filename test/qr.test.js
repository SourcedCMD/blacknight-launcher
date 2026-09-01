'use strict';
/**
 * QR encoding.
 *
 * A QR that renders but does not decode looks exactly like one that works, so
 * these check the parts that actually determine that: the Reed-Solomon
 * codewords against an independently derived implementation, and the layout
 * invariants a scanner relies on to find and orient the symbol.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// The module is renderer code and hangs itself off window.
global.window = global.window || {};
require('../src/js/qr.js');
const qr = global.window.BN.qr;
const { ecCodewords, pickVersion } = qr._internals;

/* --- An independent GF(256), derived here rather than imported ----------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of dividing a codeword by its generator. Zero means valid. */
function remainder(codeword, degree) {
  const gen = generatorPoly(degree);
  const work = codeword.slice();
  for (let i = 0; i < codeword.length - degree; i++) {
    const factor = work[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) work[i + j] ^= mul(gen[j], factor);
  }
  return work.slice(codeword.length - degree);
}

/* --- Reed-Solomon -------------------------------------------------------- */

test('the field arithmetic wraps on the QR primitive polynomial', () => {
  // 0x11d is what makes this GF(256) rather than any other; if it were wrong
  // every codeword would still look plausible and none would decode.
  assert.equal(mul(2, 128), 0x1d ^ 0x00, 'x * x^7 reduces by the polynomial');
  assert.equal(mul(1, 200), 200);
  assert.equal(mul(0, 200), 0);
});

test('error-correction codewords divide cleanly by their generator', () => {
  const cases = [
    [[32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10],
    [[1, 2, 3, 4, 5], 16],
    [[...Array(50).keys()], 22],
    [[0], 26]
  ];

  for (const [data, ecLength] of cases) {
    const ec = ecCodewords(data, ecLength);
    assert.equal(ec.length, ecLength, `${ecLength} codewords produced`);
    assert.deepEqual(
      remainder([...data, ...ec], ecLength),
      new Array(ecLength).fill(0),
      `data+EC is a valid codeword for ${data.length}B / ${ecLength}EC`
    );
  }
});

test('a single corrupted byte stops the codeword being valid', () => {
  const data = [10, 20, 30, 40, 50];
  const ec = ecCodewords(data, 10);
  const corrupted = [...data, ...ec];
  corrupted[2] ^= 0xff;
  assert.notDeepEqual(remainder(corrupted, 10), new Array(10).fill(0));
});

/* --- Version selection --------------------------------------------------- */

test('the smallest version that fits is chosen', () => {
  assert.equal(pickVersion(5), 1);
  assert.equal(pickVersion(100), 6);
  assert.equal(pickVersion(120), 7);
  assert.equal(pickVersion(10000), null, 'beyond version 10 it declines rather than truncating');
});

/* --- Layout -------------------------------------------------------------- */

function invariants(code) {
  const { grid, size } = code;
  const finderAt = (r, c) =>
    grid[r][c] === 1 && grid[r][c + 6] === 1 && grid[r + 6][c] === 1 &&
    grid[r + 1][c + 1] === 0 && grid[r + 3][c + 3] === 1;

  let timing = true;
  for (let i = 8; i < size - 8; i++) {
    const expected = i % 2 === 0 ? 1 : 0;
    if (grid[6][i] !== expected || grid[i][6] !== expected) timing = false;
  }

  return {
    // Three finders: a scanner uses these to locate and orient the symbol.
    finders: finderAt(0, 0) && finderAt(0, size - 7) && finderAt(size - 7, 0),
    timing,
    // The module at (4v+9, 8) is always dark, by definition.
    darkModule: grid[size - 8][8] === 1,
    // Nothing may be left unwritten.
    complete: grid.every((row) => row.every((v) => v === 0 || v === 1))
  };
}

test('every symbol carries the patterns a scanner looks for', () => {
  for (const text of [
    'HELLO',
    'blacknight://handoff?host=192.168.1.20&port=8431&code=K7QP2M',
    'https://github.com/SourcedCMD/blacknight-launcher',
    'x'.repeat(120)
  ]) {
    const code = qr.encode(text);
    assert.ok(code, `${text.length} bytes encodes`);
    const checks = invariants(code);
    assert.ok(checks.finders, `finder patterns present for ${text.length} bytes`);
    assert.ok(checks.timing, `timing patterns alternate for ${text.length} bytes`);
    assert.ok(checks.darkModule, `dark module set for ${text.length} bytes`);
    assert.ok(checks.complete, `no module left unwritten for ${text.length} bytes`);
  }
});

test('the symbol grows with the payload', () => {
  const small = qr.encode('hi');
  const large = qr.encode('y'.repeat(110));
  assert.equal(small.size, small.version * 4 + 17);
  assert.ok(large.size > small.size);
});

test('encoding is deterministic', () => {
  const a = qr.encode('blacknight://store');
  const b = qr.encode('blacknight://store');
  assert.deepEqual(a.grid, b.grid, 'the same input always produces the same symbol');
});

test('non-ASCII survives as UTF-8 bytes', () => {
  const code = qr.encode('BlackNight — après minuit');
  assert.ok(code, 'multi-byte characters encode rather than throwing');
});

test('text too long for version 10 is declined, not truncated', () => {
  assert.equal(qr.encode('z'.repeat(5000)), null);
  assert.equal(qr.svg('z'.repeat(5000)), '');
});

/* --- SVG ----------------------------------------------------------------- */

test('the svg carries a quiet zone and one path', () => {
  const svg = qr.svg('blacknight://games', { size: 200, quiet: 4 });
  const code = qr.encode('blacknight://games');
  assert.match(svg, /^<svg/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`), 'quiet zone included');
  assert.equal((svg.match(/<path/g) || []).length, 1, 'modules are one path, not thousands of rects');
  assert.match(svg, /shape-rendering="crispEdges"/, 'no antialiasing between modules');
});
