#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Boots the real app and drives it through every view.
 *
 * The launcher has 250-odd unit tests and, until this, no test that opened a
 * window. Everything those tests cover is pure logic; the things that actually
 * break a release are the things only a running app can find - a script that
 * throws on load, a view that references something removed from state, a
 * preload method a renderer calls and no longer exists.
 *
 * Deliberately not WebDriverIO or Playwright. Both mean a large dependency and
 * a browser download in CI, for a check whose entire job is "does it start and
 * can you get to every screen". Electron can already run a script in the
 * renderer; that is enough.
 *
 * Exit code 0 means every view rendered and nothing was logged to the console
 * as an error.
 *
 *   node scripts/smoke.js            -- run it
 *   node scripts/smoke.js --keep     -- leave the window open at the end
 */

const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const TIMEOUT_MS = 90000;

/**
 * Removes profiles left by earlier runs.
 *
 * Windows keeps a handle on the profile directory for a moment after Electron
 * exits, so the run that created it often cannot delete it. Sweeping at the
 * start of the next run is the reliable place: by then the owning process is
 * long gone.
 */
function sweepOldProfiles() {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith('bn-smoke-')) continue;
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
    } catch { /* still held; the next run will get it */ }
  }
}

sweepOldProfiles();

// Its own profile, so a developer's real settings, library and downloads are
// never touched - and so a run always starts from the same place.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-smoke-'));

// Not `shell: true`. On Windows that spawns cmd, and killing cmd leaves
// electron.exe running - which then holds the single-instance lock and makes
// every subsequent run hang with no output. The .cmd shim is resolved to the
// real executable instead, so there is one process and kill() reaches it.
function electronBinary() {
  const direct = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(direct)) return direct;

  // Fall back to whatever the electron package points at.
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch {
    return null;
  }
}

const electron = electronBinary();

if (!electron || !fs.existsSync(electron)) {
  console.error('Electron is not installed. Run npm ci first.');
  process.exit(1);
}

const child = spawn(electron, ['.', '--smoke-test'], {
  cwd: ROOT,
  env: { ...process.env, BN_SMOKE: '1', BN_USER_DATA: profile },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
let done = false;

const finish = (code, why) => {
  if (done) return;
  done = true;

  if (!KEEP) {
    try {
      // SIGKILL rather than the default: a renderer mid-render can ignore a
      // polite signal, and an Electron left running holds the instance lock.
      child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  // Best effort: Electron may still be releasing its handle on the profile.
  // Whatever survives is swept by the next run.
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch { /* the sweep at startup will get it */ }

  if (why) console.error(`\n${why}`);
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `The app did not finish the smoke run within ${TIMEOUT_MS / 1000}s.`),
  TIMEOUT_MS
);
timer.unref();

for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);

    // The renderer prints one line per step and a verdict at the end.
    if (output.includes('SMOKE: PASS')) {
      clearTimeout(timer);
      finish(0);
    }
    if (output.includes('SMOKE: FAIL')) {
      clearTimeout(timer);
      finish(1, 'The smoke run failed. The lines above say which step.');
    }
  });
}

child.on('error', (err) => finish(1, `Could not start Electron: ${err.message}`));
child.on('exit', (code) => {
  if (done) return;
  clearTimeout(timer);
  finish(code === 0 ? 1 : code, 'The app exited before finishing the smoke run.');
});
