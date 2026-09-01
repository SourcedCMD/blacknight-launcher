'use strict';
/**
 * Prerequisite detection and, more importantly, what it refuses to run.
 *
 * This module spawns an executable, which makes the path checks the part worth
 * testing hardest: an installer picked from outside the install directory is
 * arbitrary code execution with a friendly name on it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, install, findInstaller, CHECKS } = require('../electron/services/prerequisites');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-prereq-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a normal Windows machine needs nothing', { skip: process.platform !== 'win32' }, () => {
  // The point of this test is the false-positive case: an earlier version
  // looked for clr.dll in System32, which is not where it lives, and reported
  // .NET missing on every machine that had it.
  assert.deepEqual(check(null), [], 'nothing should be reported missing on a working install');
});

test('nothing is reported on platforms where these do not exist', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(check('/anywhere'), []);
});

test('every check names a file and at least one installer', () => {
  for (const item of CHECKS) {
    assert.ok(item.files.length, `${item.id} has files to look for`);
    assert.ok(item.installers.length, `${item.id} has an installer to suggest`);
    assert.ok(item.name, `${item.id} has something to call it`);
  }
});

/* --- Finding an installer ------------------------------------------------ */

test('an installer shipped with the build is found', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '_CommonRedist', 'vcredist'), { recursive: true });
  const target = path.join(dir, '_CommonRedist', 'vcredist', 'vc_redist.x64.exe');
  fs.writeFileSync(target, 'not really an exe');

  assert.equal(findInstaller(dir, ['vc_redist.x64.exe']), target);
});

test('an unrelated executable is not mistaken for one', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'game.exe'), 'x');
  assert.equal(findInstaller(dir, ['vc_redist.x64.exe']), null);
});

test('a missing install directory is not an error', () => {
  assert.equal(findInstaller(path.join(os.tmpdir(), 'does-not-exist-at-all'), ['vc_redist.x64.exe']), null);
  assert.equal(findInstaller(null, ['vc_redist.x64.exe']), null);
});

/* --- What install() refuses ---------------------------------------------- */

test('an installer outside the install directory is refused', async () => {
  const dir = tmp();
  const elsewhere = tmp();
  const outside = path.join(elsewhere, 'evil.exe');
  fs.writeFileSync(outside, 'x');

  const result = await install(outside, dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /not part of this title/);
});

test('a path that climbs out with .. is refused', async () => {
  const dir = tmp();
  const result = await install(path.join(dir, '..', '..', 'Windows', 'System32', 'cmd.exe'), dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /not part of this title/);
});

test('something that is not an exe is refused', async () => {
  const dir = tmp();
  const script = path.join(dir, 'setup.bat');
  fs.writeFileSync(script, 'echo hello');

  const result = await install(script, dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /not there any more|not part/);
});

test('an installer that has been deleted is refused', async () => {
  const dir = tmp();
  const result = await install(path.join(dir, 'gone.exe'), dir);
  assert.equal(result.ok, false);
});

test('no install directory means nothing can be run', async () => {
  const result = await install('C:\Windows\System32\cmd.exe', null);
  assert.equal(result.ok, false);
});
