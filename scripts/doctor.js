'use strict';
/**
 * Prints everything a bug report needs, in one paste.
 *
 *   npm run doctor
 *
 * "It doesn't work" is not actionable. This turns it into versions, paths,
 * disk space, what the launcher thinks is installed, and the last errors it
 * logged - which is most of what anyone would otherwise ask for over three
 * round trips.
 *
 * Reads only. It never changes anything, so it is always safe to run and to
 * ask someone else to run.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const out = [];
const say = (line = '') => out.push(line);
const head = (title) => {
  say('');
  say(title);
  say('-'.repeat(title.length));
};

const gb = (bytes) => (bytes === null || bytes === undefined ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

function quietly(fn, fallback = 'unknown') {
  try {
    const value = fn();
    return value === undefined || value === null || value === '' ? fallback : value;
  } catch {
    return fallback;
  }
}

/** The launcher's data directory, without needing Electron to tell us. */
function dataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BlackNight Launcher', 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'BlackNight Launcher', 'data');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'BlackNight Launcher', 'data');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/* --- Report -------------------------------------------------------------- */

const pkg = readJson(path.join(ROOT, 'package.json')) || {};

say('BlackNight Launcher - diagnostic report');
say(new Date().toISOString());

head('Versions');
say(`launcher     ${pkg.version || 'unknown'}`);
say(`node         ${process.version}`);
say(`electron     ${quietly(() => readJson(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version, 'not installed')}`);
say(`os           ${os.type()} ${os.release()} (${os.arch()})`);
say(`cpu          ${quietly(() => os.cpus()[0].model.trim())} x${os.cpus().length}`);
say(`memory       ${gb(os.totalmem())}`);

head('Git');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
say(`branch       ${quietly(() => git('rev-parse', '--abbrev-ref', 'HEAD'))}`);
say(`commit       ${quietly(() => git('log', '--oneline', '-1'))}`);
say(`remote       ${quietly(() => git('remote', 'get-url', 'origin'), 'none')}`);
say(`dirty        ${quietly(() => (git('status', '--porcelain') ? 'yes' : 'no'))}`);

const dir = dataDir();
head('Data directory');
say(dir);
say(fs.existsSync(dir) ? 'exists' : 'does not exist (the launcher has not run yet)');

const settings = readJson(path.join(dir, 'settings.json'));
if (settings) {
  head('Settings that affect behaviour');
  for (const key of [
    'installDir', 'libraryFolders', 'catalogUrl', 'concurrentDownloads',
    'bandwidthLimitMbps', 'yieldWhilePlaying', 'downloadWindowEnabled',
    'deltaPatching', 'lanSharing', 'backgroundVerify', 'betaChannel', 'locale'
  ]) {
    if (settings[key] !== undefined) say(`${key.padEnd(22)} ${JSON.stringify(settings[key])}`);
  }

  // The single most common cause of a launcher eating someone's cloud quota.
  const installDir = settings.installDir || '';
  if (/[\\/](OneDrive|Dropbox|Google Drive)[\\/]/i.test(installDir)) {
    say('');
    say('!! The install folder is inside a cloud-synced directory. Games will be');
    say('!! uploaded to your cloud storage. Change it in Settings > Downloads.');
  }
}

const library = readJson(path.join(dir, 'library.json'));
if (library && library.entries) {
  const entries = Object.values(library.entries);
  head('Library');
  say(`${entries.length} record(s), ${entries.filter((e) => e.status === 'installed').length} installed`);
  for (const entry of entries) {
    say(`  ${String(entry.gameId).padEnd(20)} ${String(entry.status).padEnd(14)} ${entry.version || '-'}`);
  }
}

const downloads = readJson(path.join(dir, 'downloads.json'));
if (downloads && downloads.items && downloads.items.length) {
  head('Download queue');
  for (const item of downloads.items) {
    const pct = item.totalBytes ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0;
    say(`  ${String(item.gameId).padEnd(20)} ${String(item.status).padEnd(12)} ${pct}%`);
  }
}

head('Disk');
for (const target of [ROOT, settings?.installDir].filter(Boolean)) {
  const free = quietly(() => {
    let probe = target;
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const stat = fs.statfsSync(probe);
    return stat.bavail * stat.bsize;
  }, null);
  say(`${gb(free).padEnd(12)} free at ${target}`);
}

head('Recent errors from the log');
const logFile = path.join(dir, 'logs', 'launcher.log');
if (!fs.existsSync(logFile)) {
  say('No log file yet.');
} else {
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  const errors = lines.filter((line) => /\b(ERROR|WARN)\b/.test(line)).slice(-15);
  say(errors.length ? errors.join('\n') : 'No errors or warnings logged.');
  say('');
  say(`Full log: ${logFile}`);
}

say('');
say('Paste this into an issue: https://github.com/SourcedCMD/blacknight-launcher/issues/new/choose');
say('');

process.stdout.write(out.join('\n'));
