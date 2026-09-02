#!/usr/bin/env node
'use strict';

/**
 * Measures the things a person actually feels.
 *
 * Not a benchmark suite. Four numbers that map onto complaints somebody would
 * make out loud: how long the window takes to be usable, how long a view
 * switch takes, how long the heaviest generator takes, and how much work a
 * re-render repeats.
 *
 *   node scripts/perf.js
 *
 * The renderer is measured in Node with a stubbed window, which is honest for
 * the generator and formatter work - that is the same code doing the same
 * arithmetic. Anything involving layout is measured by the smoke run instead,
 * because guessing at layout cost outside a browser would be fiction.
 */

global.window = global.window || {};
global.document = global.document || { documentElement: { setAttribute() {} } };

require('../src/js/util.js');
require('../src/js/i18n.js');
require('../src/js/art.js');

const BN = global.window.BN;
const catalog = require('../electron/data/catalog.json');

const ms = (fn, runs = 1) => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) fn(i);
  return Number(process.hrtime.bigint() - start) / 1e6;
};

/**
 * Budgets are set at roughly eight times what the work actually costs today.
 *
 * Loose enough that a slow or contended CI runner does not fail the build,
 * tight enough that doubling the cost of something trips it. A budget nothing
 * can ever exceed is decoration, not a check.
 */
const row = (label, value, budget, unit = 'ms') => {
  const over = value > budget;
  const bar = '#'.repeat(Math.min(24, Math.round((value / budget) * 24))).padEnd(24, '.');
  console.log(
    `  ${over ? 'SLOW' : ' ok '}  ${label.padEnd(34)} [${bar}] ` +
      `${value.toFixed(1).padStart(8)} / ${String(budget).padStart(5)} ${unit}`
  );
  return over;
};

console.log('\nPerformance\n');
let slow = false;

/* --- The generators, which run on every screen --------------------------- */

BN.art.keyArt.clearCache();
slow = row('First paint of the whole slate', ms(() => {
  for (const game of catalog.games) BN.art.thumb(game);
}), 15) || slow;

// The second pass is what a filter keystroke or a tab return costs.
slow = row('Re-render of the same slate', ms(() => {
  for (const game of catalog.games) BN.art.thumb(game);
}), 1) || slow;

BN.art.keyArt.clearCache();
slow = row('One hero, cold', ms(() => BN.art.hero(catalog.games[0])), 8) || slow;

slow = row('Logo at every size used', ms(() => {
  for (const size of [16, 17, 32, 38, 64, 108, 132, 256]) BN.art.logo(size);
}), 4) || slow;

/* --- Formatting, which runs per row per render --------------------------- */

slow = row('1,000 formatted rows', ms(() => {
  for (let i = 0; i < 1000; i++) {
    BN.util.bytes(i * 7919);
    BN.util.duration(i * 37);
    BN.util.priceOf({ price: { usd: 69.99, sale: 0 } });
    BN.t('action.play');
  }
}), 12) || slow;

/* --- What the cache is worth --------------------------------------------- */

BN.art.keyArt.clearCache();
const cold = ms(() => {
  for (const game of catalog.games) BN.art.thumb(game);
});
const warm = ms(() => {
  for (const game of catalog.games) BN.art.thumb(game);
});

console.log(`\n  Art memoisation saves ${(cold / Math.max(warm, 0.001)).toFixed(0)}x on a re-render`);
console.log(`  (${cold.toFixed(1)} ms cold, ${warm.toFixed(2)} ms warm)\n`);

if (slow) {
  console.error('Something is slower than its budget. That is a regression, not a threshold to raise.');
  process.exit(1);
}
console.log('Within budget.\n');
