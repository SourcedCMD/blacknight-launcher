'use strict';
/**
 * Prints the CHANGELOG section for a version, for the release workflow to put
 * on the GitHub release.
 *
 *   node scripts/release-notes.js 1.0.1
 *   node scripts/release-notes.js v1.0.1
 *
 * Doing this in Node rather than awk in a YAML block is not fussiness: the
 * quoting between YAML, bash and awk mangles the brackets in "## [1.0.1]"
 * quietly, and a release published with silently empty notes is exactly the
 * kind of thing nobody notices until it has happened three times.
 *
 * Never fails the build. A release with generic notes is a small problem; a
 * release that did not publish because its notes could not be formatted is a
 * bigger one.
 */
const fs = require('fs');
const path = require('path');

const version = String(process.argv[2] || '').replace(/^v/, '');
const file = path.join(__dirname, '..', 'CHANGELOG.md');

function extract() {
  if (!version) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  // Matches "## [1.0.1] - 2026-08-31" and "## 1.0.1" alike.
  const heading = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);

  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }

  const trimmed = body.join('\n').trim();
  return trimmed || null;
}

const notes = extract();
process.stdout.write(
  notes || `Released ${version || 'this version'}. See the commit history for what changed.\n`
);
