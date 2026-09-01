#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Records what the art engine currently draws.
 *
 *   node scripts/art-snapshots.js          -- print the current hashes
 *   node scripts/art-snapshots.js --write  -- update the recorded ones
 *
 * The generators are deterministic, so the same inputs must produce the same
 * drawing on every machine and every release. A hash per case is enough to
 * catch a change, and unlike a pile of committed SVGs it stays readable in a
 * diff: one line moves, and you know exactly which piece of art changed.
 *
 * When a change is deliberate, running this with --write is the moment you
 * confirm you meant it.
 */

global.window = global.window || {};
global.document = global.document || { documentElement: { setAttribute() {} } };
require('../src/js/util.js');
require('../src/js/i18n.js');
require('../src/js/art.js');
const BN = global.window.BN;

const FILE = path.join(__dirname, '..', 'test', 'art-snapshots.json');

/** Ids are random per call by design, so they are normalised away. */
// One or more, not {4,10}: nextId() concatenates two base-36 numbers and the
// random half can be a single character, so a short id escaped the old pattern
// and the two calls hashed differently roughly one run in a hundred.
const geometry = (svg) => svg.replace(/bn[a-z0-9]+-/g, 'id-');
const digest = (svg) => crypto.createHash('sha256').update(geometry(svg)).digest('hex').slice(0, 16);

function current() {
  const out = {};

  // One per motif at a fixed seed and size: catches a change to any generator.
  for (const motif of BN.art.MOTIFS) {
    out[`motif:${motif}`] = digest(BN.art.keyArt({ seed: 20260901, hue: 212, motif, w: 800, h: 450, detail: 0.7 }));
  }

  // Maturity changes the sky, so each step is its own case.
  for (const maturity of [0, 0.5, 1]) {
    out[`maturity:${maturity}`] = digest(
      BN.art.keyArt({ seed: 4242, hue: 200, motif: 'city', w: 600, h: 400, detail: 0.6, maturity })
    );
  }

  // The logo ships in the installer and the tray, so it is worth pinning.
  for (const size of [16, 64, 256]) out[`logo:${size}`] = digest(BN.art.logo(size));

  return out;
}

/**
 * Only when run directly.
 *
 * This file is also required by the snapshot test, and a module that prints a
 * table of hashes every time it is imported makes test output unreadable.
 */
if (require.main === module) {
  const now = current();

  if (process.argv.includes('--write')) {
    fs.writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${Object.keys(now).length} snapshots to test/art-snapshots.json`);
  } else {
    for (const [key, hash] of Object.entries(now)) console.log(`  ${key.padEnd(20)} ${hash}`);
  }
}

module.exports = { current, digest, geometry };
