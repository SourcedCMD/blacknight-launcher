'use strict';
/**
 * Cuts a release.
 *
 *   npm run release -- patch     -- 1.0.0 to 1.0.1
 *   npm run release -- minor     -- 1.0.0 to 1.1.0
 *   npm run release -- major     -- 1.0.0 to 2.0.0
 *   npm run release -- 1.2.3     -- exactly that
 *   npm run release -- patch --dry-run
 *
 * Bumps the version, moves the CHANGELOG's Unreleased section under the new
 * number, commits, tags and pushes. Pushing the tag is what starts the release
 * workflow, which builds the installer and publishes it - which in turn is
 * what auto-update reads.
 *
 * It will not release from a tree that is dirty, behind, or failing.
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const bump = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'patch';

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function die(why, detail) {
  console.error(`\n${why}`);
  if (detail) console.error(`\n${String(detail).trim()}`);
  console.error('\nNothing was released.');
  process.exit(1);
}

function nextVersion(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = current.split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  die(`"${how}" is not a version or one of major, minor, patch.`);
}

/**
 * Moves everything under "Unreleased" into a section for this version.
 *
 * A changelog that is only ever written at release time gets written badly, so
 * this rewards keeping Unreleased current rather than replacing it.
 */
function rollChangelog(version) {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return null;

  const text = fs.readFileSync(file, 'utf8');
  const marker = '## [Unreleased]';
  if (!text.includes(marker)) return null;

  const start = text.indexOf(marker) + marker.length;
  const nextHeading = text.indexOf('\n## ', start);
  const body = text.slice(start, nextHeading === -1 ? undefined : nextHeading).trim();

  if (!body) {
    console.warn('  ! CHANGELOG has an empty Unreleased section; releasing with no notes.');
  }

  const today = new Date().toISOString().slice(0, 10);
  const updated =
    text.slice(0, text.indexOf(marker)) +
    `${marker}\n\n## [${version}] - ${today}\n\n${body}\n` +
    (nextHeading === -1 ? '' : text.slice(nextHeading + 1));

  if (!DRY) fs.writeFileSync(file, updated);
  return body;
}

function main() {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = nextVersion(pkg.version, bump);
  const tag = `v${version}`;

  console.log(`\nReleasing ${pkg.version} -> ${version}${DRY ? ' (dry run)' : ''}\n`);

  /* --- Refuse to release from a bad state ------------------------------- */

  if (git('status', '--porcelain')) {
    die('The working tree has uncommitted changes. Run "npm run sync" first.');
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') die(`Releases are cut from main, not "${branch}".`);

  git('fetch', 'origin');
  if (Number(git('rev-list', '--count', 'HEAD..origin/main')) > 0) {
    die('Your branch is behind origin/main. Run "npm run sync" first.');
  }
  if (Number(git('rev-list', '--count', 'origin/main..HEAD')) > 0) {
    die('You have unpushed commits. Run "npm run sync" first.');
  }

  const tags = git('tag', '--list').split('\n');
  if (tags.includes(tag)) die(`${tag} already exists.`);

  try {
    execSync('npm test', { cwd: ROOT, stdio: 'pipe' });
    execSync('npm run check:catalog', { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    die('Checks failed, so nothing was released.', (err.stdout || '') + (err.stderr || ''));
  }
  console.log('  checks .......................... ok');

  /* --- Bump, tag, push --------------------------------------------------- */

  const notes = rollChangelog(version);
  console.log(`  changelog ....................... ${notes ? `${notes.split('\n').length} line(s)` : 'no notes'}`);

  if (DRY) {
    console.log(`\nWould commit, tag ${tag} and push.\n`);
    return;
  }

  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  git('add', 'package.json', 'CHANGELOG.md');
  git('-c', 'core.safecrlf=false', 'commit', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `Release ${tag}`);

  git('push', 'origin', 'main');
  git('push', 'origin', tag);

  const url = git('remote', 'get-url', 'origin').replace(/\.git$/, '');
  console.log(`\nTagged ${tag} and pushed.`);
  console.log(`The release workflow is building it now: ${url}/actions`);
  console.log(`It will appear at: ${url}/releases/tag/${tag}\n`);
}

main();
