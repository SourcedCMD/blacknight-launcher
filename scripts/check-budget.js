#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * The performance budget.
 *
 * The renderer has no build step and no dependencies, which is the reason it
 * starts quickly. Both of those are easy to give away one file at a time -
 * nobody ever adds two megabytes of JavaScript deliberately, it arrives as
 * twelve reasonable-looking commits.
 *
 * So the sizes are written down and checked. When a limit is genuinely too
 * small, raising it here is a visible line in a diff that someone has to
 * justify, which is the entire point.
 *
 * Measured on the source, not on a bundle, because the source is what ships.
 */

const ROOT = path.join(__dirname, '..');

const BUDGETS = [
  // Every classic script the page loads, in dependency order. This is the
  // number that decides how quickly the window paints.
  //
  // Raised from 460 when passkeys, cloud saves, the backlog, the art timeline,
  // session goals and a French catalogue landed together. That is six features
  // and a locale, not drift - but the next raise should be argued for on its
  // own terms rather than treated as a precedent.
  { name: 'Renderer JavaScript', dir: 'src/js', ext: '.js', maxKB: 540 },

  // One stylesheet, parsed before first paint.
  { name: 'Stylesheets', dir: 'src/css', ext: '.css', maxKB: 190 },

  // Runs before the window exists, so its cost is start-up cost.
  { name: 'Main process', dir: 'electron', ext: '.js', maxKB: 360 },

  // The whole shipped renderer, which is what the budget is really about.
  { name: 'Everything the window loads', dir: 'src', ext: null, maxKB: 780 }
];

/** Total bytes of the matching files under a directory. */
function measure(dir, ext) {
  const root = path.join(ROOT, dir);
  let total = 0;
  const files = [];

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (!ext || entry.name.endsWith(ext)) {
        const size = fs.statSync(full).size;
        total += size;
        files.push({ path: path.relative(ROOT, full), size });
      }
    }
  };

  walk(root);
  return { total, files: files.sort((a, b) => b.size - a.size) };
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

let failed = false;
console.log('Performance budget\n');

for (const budget of BUDGETS) {
  const { total, files } = measure(budget.dir, budget.ext);
  const used = total / 1024;
  const share = Math.round((used / budget.maxKB) * 100);
  const over = used > budget.maxKB;
  if (over) failed = true;

  // A bar, because a percentage on its own does not show how close the next
  // commit is to the edge.
  const width = 24;
  const filled = Math.min(width, Math.round((share / 100) * width));
  const bar = '#'.repeat(filled) + '.'.repeat(width - filled);

  console.log(
    `  ${over ? 'FAIL' : ' ok '}  ${budget.name.padEnd(30)} [${bar}] ` +
      `${kb(total).padStart(7)} / ${String(budget.maxKB).padStart(4)} KB  (${share}%)`
  );

  // Naming the three biggest files turns a failure into an action.
  if (over) {
    console.log('        largest:');
    for (const file of files.slice(0, 3)) console.log(`          ${kb(file.size).padStart(7)} KB  ${file.path}`);
  }
}

if (failed) {
  console.error('\nOver budget. Either trim it, or raise the limit in scripts/check-budget.js and say why.');
  process.exit(1);
}

console.log('\nWithin budget.');
