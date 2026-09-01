'use strict';
/**
 * Turns a failed test run into GitHub annotations.
 *
 *   node scripts/ci-annotate.js <captured-output-file>
 *
 * Reading a CI failure otherwise means opening the run and scrolling the log,
 * which is exactly the friction that leaves a red badge sitting there for a
 * week. Annotations appear on the run summary and on the commit, and are
 * readable through the API without downloading anything.
 *
 * Never changes the exit status: the test step already failed, and this only
 * exists to explain why.
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) process.exit(0);

let text = '';
try {
  text = fs.readFileSync(file, 'utf8');
} catch {
  process.exit(0);
}

const lines = text.split(/\r?\n/);

/** One-line summary of the run, if the reporter printed one. */
const counts = {};
for (const key of ['tests', 'pass', 'fail', 'cancelled']) {
  const match = text.match(new RegExp(`^\\s*[^\\w]*${key}\\s+(\\d+)`, 'm'));
  if (match) counts[key] = Number(match[1]);
}

// Everything after the "failing tests:" banner is the detail worth surfacing;
// before it is a long list of passes nobody needs.
const start = lines.findIndex((line) => /failing tests:/i.test(line));
const detail = (start === -1 ? lines : lines.slice(start))
  .filter((line) => line.trim())
  // Stack frames inside node internals say nothing about our code.
  .filter((line) => !/at\s+.*node:internal/.test(line))
  .slice(0, 60);

const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

if (counts.fail) {
  process.stdout.write(
    `::error title=Tests failed::${escape(`${counts.fail} of ${counts.tests} test(s) failed on ${process.platform}`)}\n`
  );
}

// Each failing test name becomes its own annotation, so the run summary lists
// them without anyone opening the log.
for (const line of detail) {
  const named = line.match(/^\s*(?:✖|not ok\s+\d+\s+-)\s*(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
  // The banner itself matches the marker; it is not a test name.
  if (named && !/^failing tests:?$/i.test(named[1])) {
    process.stdout.write(`::error title=Failing test::${escape(named[1])}\n`);
  }
}

// The raw tail goes to the step summary, which keeps formatting and length.
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Test failure (${process.platform}, node ${process.version})\n\n\`\`\`\n${detail.join('\n')}\n\`\`\`\n`
    );
  } catch {
    /* the annotations above are the important half */
  }
}
