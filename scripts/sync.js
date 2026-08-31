'use strict';
/**
 * One command to get everything onto GitHub.
 *
 *   npm run sync                 -- validate, commit anything outstanding, push
 *   npm run sync -- "message"    -- with your own commit message
 *   npm run sync -- --dry-run    -- say what it would do and stop
 *
 * It refuses rather than pushes when anything is wrong. That is the whole
 * point: a sync command that will happily publish a failing build is worse
 * than typing the git commands by hand, because it removes the moment where
 * you would have noticed.
 *
 * What it checks, in order, stopping at the first failure:
 *   - you are on a branch, not a detached HEAD
 *   - nothing that looks like a credential is about to be committed
 *   - every JS file parses
 *   - the test suite passes
 *   - the catalog is valid
 *
 * Then it commits, integrates whatever is on the remote (you edit the README
 * on github.com; that has to survive), and pushes.
 */
const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const message = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || null;

/* --- Plumbing ------------------------------------------------------------ */

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function tryGit(...args) {
  try {
    return { ok: true, out: git(...args) };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

const step = (name) => process.stdout.write(`  ${name.padEnd(34, '.')} `);
const pass = (detail = 'ok') => process.stdout.write(`${detail}\n`);

function die(why, detail) {
  process.stdout.write('FAILED\n\n');
  console.error(why);
  if (detail) console.error(`\n${String(detail).trim()}`);
  console.error('\nNothing was pushed.');
  process.exit(1);
}

function run(command, label) {
  try {
    execSync(command, { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    die(label, (err.stdout || '') + (err.stderr || ''));
  }
}

/* --- Checks -------------------------------------------------------------- */

function readWorking(file) {
  try {
    return { ok: true, out: require('fs').readFileSync(path.join(ROOT, file), 'utf8') };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * A public repository makes a committed credential a disclosed credential.
 * Rotating one is far more work than this check costs.
 */
function scanForSecrets(files) {
  const PATTERNS = [
    [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub personal access token'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub fine-grained token'],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'a private key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/\b(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i, 'a hard-coded credential']
  ];

  const found = [];
  for (const file of files) {
    // Only text we are actually adding, and never the lockfile or binaries.
    if (/\.(png|ico|jpg|jpeg|webp|woff2?|exe|zip|pak)$/i.test(file)) continue;
    if (file === 'package-lock.json') continue;

    // From the index normally; from disk on a dry run, where nothing is staged.
    const result = DRY ? readWorking(file) : tryGit('show', `:${file}`);
    if (!result.ok) continue;
    for (const [pattern, what] of PATTERNS) {
      if (pattern.test(result.out)) found.push(`${file}: looks like ${what}`);
    }
  }
  return found;
}

let syntaxCount = 0;

/**
 * Parses every file we ship. Walking from the project root through a shell
 * would drag in node_modules, which is neither ours to validate nor quick.
 */
function checkSyntax() {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const problems = [];
  syntaxCount = 0;

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) {
        syntaxCount++;
        try {
          execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
        } catch (err) {
          problems.push(`${rel}: ${String(err.stderr || err.message).split('\n')[0]}`);
        }
      }
    }
  };

  for (const dir of ['src', 'electron', 'scripts', 'test']) walk(dir);
  return problems;
}

/* --- Main ---------------------------------------------------------------- */

function main() {
  console.log(`\nSyncing BlackNight Launcher to GitHub${DRY ? ' (dry run)' : ''}\n`);

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') die('You are on a detached HEAD. Check out a branch first.');

  const remote = tryGit('remote', 'get-url', 'origin');
  if (!remote.ok) die('No "origin" remote is configured.');

  step('branch');
  pass(branch);

  // Stage first, so the checks see exactly what would be committed. A dry run
  // must not touch the index, so it reads the same list out of the status
  // instead - reporting "no changes" while files sit untracked would be a lie.
  const dirty = git('status', '--porcelain');
  if (dirty && !DRY) git('add', '-A');

  const staged = !dirty
    ? []
    : DRY
      ? dirty.split('\n').filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ''))
      : git('diff', '--cached', '--name-only').split('\n').filter(Boolean);

  step('changes');
  pass(staged.length ? `${staged.length} file(s)` : 'none');

  if (staged.length) {
    step('credential scan');
    const leaks = scanForSecrets(staged);
    if (leaks.length) {
      // Leave the changes staged so they are easy to inspect and fix.
      die('Something that looks like a credential is about to be committed:', leaks.join('\n'));
    }
    pass();
  }

  step('syntax');
  const broken = checkSyntax();
  if (broken.length) die('A JavaScript file does not parse.', broken.join('\n'));
  pass(`${syntaxCount} file(s)`);

  step('tests');
  run('npm test', 'The test suite failed, so nothing was pushed.');
  pass();

  step('catalog');
  run('npm run check:catalog', 'The catalog is not valid.');
  pass();

  /* --- Commit ------------------------------------------------------------ */

  if (staged.length) {
    const subject = message || describe(staged);
    step('commit');
    if (DRY) pass(`would commit: "${subject}"`);
    else {
      // safecrlf off: this repo is edited on Windows and normalised on commit,
      // and the warning is noise rather than information.
      git('-c', 'core.safecrlf=false', 'commit', '-m', subject);
      pass(git('log', '--oneline', '-1'));
    }
  }

  /* --- Integrate and push ------------------------------------------------ */

  step('fetch');
  const fetched = tryGit('fetch', 'origin');
  if (!fetched.ok) die('Could not reach the remote.', fetched.out);
  pass();

  const behind = tryGit('rev-list', '--count', `HEAD..origin/${branch}`);
  if (behind.ok && Number(behind.out) > 0) {
    step('integrate remote');
    if (DRY) pass(`${behind.out} commit(s) to merge`);
    else {
      // Merge rather than rebase: the remote may already be published, and
      // rewriting published history is how people lose work.
      const merged = tryGit('-c', 'core.safecrlf=false', 'merge', '--no-edit', `origin/${branch}`);
      if (!merged.ok) {
        die(
          'The remote has changes that conflict with yours.\n' +
            'Resolve them, then run this again:\n' +
            '  git status\n' +
            '  git add <the files you fixed>\n' +
            '  git commit',
          merged.out
        );
      }
      pass(`merged ${behind.out}`);
    }
  }

  const ahead = git('rev-list', '--count', `origin/${branch}..HEAD`);
  step('push');
  if (Number(ahead) === 0) {
    pass('already up to date');
  } else if (DRY) {
    pass(`would push ${ahead} commit(s)`);
  } else {
    const pushed = tryGit('push', 'origin', branch);
    if (!pushed.ok) {
      die(
        'The push was rejected. If this is an authentication problem, sign in once with:\n' +
          '  gh auth login          (if you have the GitHub CLI)\n' +
          'or set up a credential helper for HTTPS.',
        pushed.out
      );
    }
    pass(`${ahead} commit(s)`);
  }

  const url = remote.out.replace(/\.git$/, '');
  console.log(`\nDone. ${url}\n`);
}

/** A commit subject good enough to not be a lie, when none was given. */
function describe(files) {
  const areas = new Set();
  for (const file of files) {
    if (file.startsWith('src/')) areas.add('renderer');
    else if (file.startsWith('electron/')) areas.add('main process');
    else if (file.startsWith('test/')) areas.add('tests');
    else if (file.startsWith('.github/')) areas.add('CI');
    else if (file.startsWith('docs/')) areas.add('docs');
    else if (file.startsWith('scripts/')) areas.add('scripts');
    else areas.add('project');
  }
  const list = [...areas].sort();
  const where = list.length > 2 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list.join(' and ');
  return `Update ${where} (${files.length} file${files.length === 1 ? '' : 's'})`;
}

main();
