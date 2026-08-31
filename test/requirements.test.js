'use strict';
/** Tests for the "will it run?" comparison. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { check, checkTier, gpuTier, cpuTier, parseBytes, parseWindowsVersion } =
  require('../electron/services/requirements');

const GB = 1024 * 1024 * 1024;

/* --- Parsing ----------------------------------------------------------- */

test('parseBytes reads the units the catalog uses', () => {
  assert.equal(parseBytes('12 GB'), 12 * GB);
  assert.equal(parseBytes('16GB'), 16 * GB);
  assert.equal(parseBytes('90 GB SSD'), 90 * GB);
  assert.equal(parseBytes('1 TB'), 1024 * GB);
  assert.equal(parseBytes('nonsense'), null);
});

test('parseWindowsVersion pulls the major version out', () => {
  assert.equal(parseWindowsVersion('Windows 10 64-bit'), 10);
  assert.equal(parseWindowsVersion('Windows 11 64-bit'), 11);
  assert.equal(parseWindowsVersion('macOS 14'), null);
});

/* --- Tiers -------------------------------------------------------------- */

test('gpuTier ranks within a GeForce generation', () => {
  assert.ok(gpuTier('RTX 4070') > gpuTier('RTX 4060'));
  assert.ok(gpuTier('RTX 4070 Ti') > gpuTier('RTX 4070'));
});

test('a Ti variant does not leapfrog the next model up', () => {
  // Caught against real hardware: a +6 Ti bonus made a GTX 1050 Ti outrank a
  // GTX 1060, which would have told players their PC was fine when it was not.
  assert.ok(gpuTier('GTX 1050 Ti') > gpuTier('GTX 1050'), 'a Ti still beats its base model');
  assert.ok(gpuTier('GTX 1050 Ti') < gpuTier('GTX 1060'), 'but not the next model up');
  assert.ok(gpuTier('RTX 4070 Ti') < gpuTier('RTX 4080'));
  assert.ok(gpuTier('RX 6700 XT') < gpuTier('RX 6800'));
});

test('gpuTier ranks across generations', () => {
  assert.ok(gpuTier('RTX 4060') > gpuTier('RTX 3060'));
  assert.ok(gpuTier('RTX 3060') > gpuTier('GTX 1660'));
});

test('gpuTier handles Radeon and Arc', () => {
  assert.ok(gpuTier('RX 7900 XTX') > gpuTier('RX 6700 XT'));
  assert.ok(gpuTier('Arc B580') > gpuTier('Arc A770'));
});

test('gpuTier reports null rather than guessing at something unknown', () => {
  assert.equal(gpuTier('Some Unknown Adapter'), null);
  assert.equal(gpuTier(''), null);
});

test('cpuTier ranks by generation then class', () => {
  assert.ok(cpuTier('Intel i7-12700K') > cpuTier('Intel i5-12400'));
  assert.ok(cpuTier('Intel i5-12400') > cpuTier('Intel i5-8400'));
  assert.ok(cpuTier('Ryzen 7 5800X3D') > cpuTier('Ryzen 5 2600'));
  assert.equal(cpuTier('Some Unknown CPU'), null);
});

/* --- Comparison --------------------------------------------------------- */

const SPEC = {
  minimum: { os: 'Windows 10 64-bit', cpu: 'Intel i5-8400 / Ryzen 5 2600', ram: '12 GB', gpu: 'GTX 1660 6GB', storage: '90 GB SSD' },
  recommended: { os: 'Windows 11 64-bit', cpu: 'Intel i7-12700K / Ryzen 7 5800X3D', ram: '32 GB', gpu: 'RTX 4070 12GB', storage: '90 GB NVMe' }
};

const STRONG = { os: 'Windows 11 64-bit', cpu: 'Intel i9-13900K', gpu: 'NVIDIA GeForce RTX 4080', ramBytes: 32 * GB, freeBytes: 500 * GB };
const MID = { os: 'Windows 11 64-bit', cpu: 'Intel i5-10400', gpu: 'NVIDIA GeForce RTX 3060', ramBytes: 16 * GB, freeBytes: 300 * GB };
const WEAK = { os: 'Windows 10 64-bit', cpu: 'Intel i3-6100', gpu: 'NVIDIA GeForce GTX 1050', ramBytes: 8 * GB, freeBytes: 20 * GB };

test('a strong machine clears the recommended spec', () => {
  assert.equal(check(SPEC, STRONG).level, 'recommended');
});

test('a mid machine clears minimum but not recommended', () => {
  assert.equal(check(SPEC, MID).level, 'minimum');
});

test('a weak machine is reported as below minimum', () => {
  assert.equal(check(SPEC, WEAK).level, 'below');
});

test('the failing rows name what actually falls short', () => {
  const failing = check(SPEC, WEAK).minimum.rows.filter((r) => r.status === 'below').map((r) => r.key);
  assert.ok(failing.includes('ram'), '8 GB does not meet a 12 GB requirement');
  assert.ok(failing.includes('storage'), '20 GB free does not fit a 90 GB install');
  assert.ok(failing.includes('gpu'), 'a GTX 1050 is below a GTX 1660');
});

test('a machine sized exactly at the requirement passes', () => {
  // Reported memory always lands a little under the sticker figure.
  const exact = { ...MID, ramBytes: 11.6 * GB };
  const ram = checkTier(SPEC.minimum, exact).rows.find((r) => r.key === 'ram');
  assert.equal(ram.status, 'ok');
});

test('unmeasurable hardware reports unknown rather than a verdict', () => {
  const blank = { os: null, cpu: null, gpu: null, ramBytes: null, freeBytes: null };
  const result = check(SPEC, blank);
  assert.equal(result.level, 'unknown');
  assert.ok(result.minimum.rows.every((r) => r.status === 'unknown'));
});

test('an unrecognised GPU never counts as a failure', () => {
  const odd = { ...STRONG, gpu: 'Mystery Graphics 9000' };
  const gpu = checkTier(SPEC.minimum, odd).rows.find((r) => r.key === 'gpu');
  assert.equal(gpu.status, 'unknown');
  // Everything else still clears, so the headline must not read "below".
  assert.notEqual(check(SPEC, odd).level, 'below');
});

test('a slash-separated requirement is satisfied by either side', () => {
  const amd = { ...MID, cpu: 'AMD Ryzen 5 3600' };
  const cpu = checkTier(SPEC.minimum, amd).rows.find((r) => r.key === 'cpu');
  assert.equal(cpu.status, 'ok');
});

test('missing requirements produce an unknown result rather than throwing', () => {
  assert.equal(check(null, STRONG).level, 'unknown');
  assert.equal(check(SPEC, null).level, 'unknown');
});
