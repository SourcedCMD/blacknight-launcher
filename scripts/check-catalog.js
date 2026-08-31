'use strict';
/**
 * Validates catalog.json.
 *
 * `Catalog.valid()` guards the launcher at runtime, on the user's machine,
 * against a catalog that would empty their store front. That is the last line
 * of defence, not the first: once the catalog is hosted, a bad field should be
 * caught here, in CI, before anyone downloads it.
 *
 * Deliberately dependency-free - a schema validator is not worth a package tree
 * for one document with a known shape.
 *
 *   npm run check:catalog [path]
 */
const fs = require('fs');
const path = require('path');

const STATUSES = ['released', 'preorder', 'announced', 'coming-soon'];
const MOTIFS = ['city', 'peaks', 'orbit', 'ruins', 'circuit', 'sea'];
const RATINGS = ['E', 'E10', 'T', 'M', 'AO', 'RP'];
const SPEC_KEYS = ['os', 'cpu', 'ram', 'gpu', 'storage'];

const problems = [];
const warn = [];

const fail = (where, message) => problems.push(`${where}: ${message}`);
const note = (where, message) => warn.push(`${where}: ${message}`);

const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function checkGame(game, index) {
  const where = `games[${index}]${game && game.id ? ` (${game.id})` : ''}`;

  if (!game || typeof game !== 'object') return fail(where, 'is not an object');
  if (!isString(game.id)) return fail(where, 'needs an id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(game.id)) {
    fail(where, `id "${game.id}" should be lowercase, digits and hyphens (it becomes a folder name)`);
  }

  for (const key of ['title', 'developer', 'publisher', 'description']) {
    if (!isString(game[key])) fail(where, `needs a ${key}`);
  }

  if (!STATUSES.includes(game.status)) {
    fail(where, `status "${game.status}" is not one of ${STATUSES.join(', ')}`);
  }

  if (!isNumber(game.sizeBytes) || game.sizeBytes <= 0) fail(where, 'needs a positive sizeBytes');

  // A release date is what drives countdowns and the pre-order unlock gate.
  if (game.status !== 'released' || game.releaseDate) {
    if (!isString(game.releaseDate) || !/^\d{4}-\d{2}-\d{2}$/.test(game.releaseDate)) {
      fail(where, 'releaseDate must be YYYY-MM-DD');
    } else if (Number.isNaN(Date.parse(`${game.releaseDate}T00:00:00`))) {
      fail(where, `releaseDate "${game.releaseDate}" is not a real date`);
    }
  }

  if (game.status === 'preorder' && !game.releaseDate) {
    fail(where, 'a pre-order needs a releaseDate, or it can never unlock');
  }

  if (!game.price || !isNumber(game.price.usd)) fail(where, 'needs price.usd');
  if (game.price && game.price.usd < 0) fail(where, 'price.usd cannot be negative');

  if (!game.art || !isNumber(game.art.hue) || !isNumber(game.art.seed)) {
    fail(where, 'needs art.hue and art.seed');
  } else if (!MOTIFS.includes(game.art.motif)) {
    fail(where, `art.motif "${game.art.motif}" is not one of ${MOTIFS.join(', ')}`);
  }

  if (game.rating && !RATINGS.includes(game.rating)) note(where, `rating "${game.rating}" is unusual`);

  for (const key of ['genre', 'tags', 'features']) {
    if (game[key] !== undefined && !Array.isArray(game[key])) fail(where, `${key} must be an array`);
  }

  if (game.requirements) {
    for (const tier of ['minimum', 'recommended']) {
      const spec = game.requirements[tier];
      if (!spec) {
        note(where, `has no ${tier} requirements, so "will it run?" cannot answer`);
        continue;
      }
      for (const key of SPEC_KEYS) {
        if (!isString(spec[key])) note(where, `requirements.${tier}.${key} is missing`);
      }
    }
  } else {
    note(where, 'has no requirements at all');
  }

  // A download URL without a digest means an install can only ever be length
  // checked, which verify() then has to admit to.
  if (game.downloadUrl && !isString(game.sha256)) {
    note(where, 'has a downloadUrl but no sha256, so installs cannot be verified');
  }
  if (isString(game.sha256) && !/^[a-f0-9]{64}$/i.test(game.sha256)) {
    fail(where, 'sha256 must be 64 hex characters');
  }

  for (const [i, channel] of (game.channels || []).entries()) {
    const cw = `${where}.channels[${i}]`;
    if (!isString(channel.id)) fail(cw, 'needs an id');
    if (channel.id === 'stable') fail(cw, '"stable" is implicit and must not be declared');
    if (channel.sha256 && !/^[a-f0-9]{64}$/i.test(channel.sha256)) fail(cw, 'sha256 must be 64 hex characters');
  }

  for (const [i, edition] of (game.editions || []).entries()) {
    const ew = `${where}.editions[${i}]`;
    if (!isString(edition.id)) fail(ew, 'needs an id');
    if (!isString(edition.name)) fail(ew, 'needs a name');
    if (!isNumber(edition.usd)) fail(ew, 'needs a usd price');
  }
}

function checkNews(item, index, gameIds) {
  const where = `news[${index}]${item && item.id ? ` (${item.id})` : ''}`;
  if (!isString(item.id)) fail(where, 'needs an id');
  if (!isString(item.title)) fail(where, 'needs a title');
  if (!isString(item.body)) fail(where, 'needs a body');
  if (item.date && Number.isNaN(Date.parse(item.date))) fail(where, `date "${item.date}" is not a real date`);
  // A news item pointing at a title that does not exist opens an empty sheet.
  if (item.gameId && !gameIds.has(item.gameId)) fail(where, `gameId "${item.gameId}" is not in the catalog`);
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', 'electron', 'data', 'catalog.json');

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`catalog is not readable JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(doc.games) || doc.games.length === 0) {
    fail('catalog', 'needs a non-empty games array, or the launcher will reject it outright');
  } else {
    doc.games.forEach(checkGame);

    const seen = new Set();
    for (const game of doc.games) {
      if (game && game.id) {
        if (seen.has(game.id)) fail('catalog', `duplicate game id "${game.id}"`);
        seen.add(game.id);
      }
    }

    const ids = new Set(doc.games.map((g) => g && g.id));
    (doc.news || []).forEach((item, i) => checkNews(item, i, ids));
  }

  for (const line of warn) console.warn(`warning  ${line}`);
  for (const line of problems) console.error(`error    ${line}`);

  const counts = `${doc.games ? doc.games.length : 0} titles, ${(doc.news || []).length} news items`;
  if (problems.length) {
    console.error(`\ncatalog check failed: ${problems.length} problem(s) across ${counts}`);
    process.exit(1);
  }
  console.log(`catalog ok: ${counts}${warn.length ? `, ${warn.length} warning(s)` : ''}`);
}

main();
