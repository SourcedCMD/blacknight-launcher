'use strict';
/** Reading what other launchers installed. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseVdf, looksLikeAGame, isLauncherUrl, scan, SOURCES } = require('../electron/services/foreign');

/* --- Valve's KeyValues --------------------------------------------------- */

test('a flat block of pairs parses', () => {
  const doc = parseVdf(`
"AppState"
{
  "appid"    "570"
  "name"     "Dota 2"
  "installdir"  "dota 2 beta"
}`);
  assert.equal(doc.AppState.appid, '570');
  assert.equal(doc.AppState.name, 'Dota 2');
  assert.equal(doc.AppState.installdir, 'dota 2 beta');
});

test('nested blocks keep their shape', () => {
  const doc = parseVdf(`
"libraryfolders"
{
  "0"
  {
    "path"  "C:\\Program Files (x86)\\Steam"
    "apps"
    {
      "570"  "12345"
    }
  }
  "1"
  {
    "path"  "D:\\SteamLibrary"
  }
}`);
  assert.equal(Object.keys(doc.libraryfolders).length, 2);
  assert.match(doc.libraryfolders['0'].path, /Steam/);
  assert.equal(doc.libraryfolders['0'].apps['570'], '12345');
  assert.match(doc.libraryfolders['1'].path, /SteamLibrary/);
});

test('a value containing spaces and punctuation survives', () => {
  const doc = parseVdf('"AppState"\n{\n  "name" "Tom Clancy\'s Rainbow Six Siege"\n}');
  assert.equal(doc.AppState.name, "Tom Clancy's Rainbow Six Siege");
});

test('a truncated file does not throw', () => {
  // A manifest read while Steam is rewriting it.
  assert.doesNotThrow(() => parseVdf('"AppState"\n{\n  "appid" "570"\n  "name"'));
});

test('unbalanced braces do not walk off the stack', () => {
  assert.doesNotThrow(() => parseVdf('}\n}\n}\n"a" "b"'));
  assert.equal(parseVdf('}\n}\n"a" "b"').a, 'b');
});

test('an empty document is an empty object', () => {
  assert.deepEqual(parseVdf(''), {});
});

/* --- What counts as a game ----------------------------------------------- */

test('shared runtimes and save folders are not games', () => {
  for (const name of [
    'Steamworks Common Redistributables',
    'Steam Linux Runtime 3.0 (sniper)',
    'Proton 9.0',
    'SteamVR',
    'GameSave'
  ]) {
    assert.equal(looksLikeAGame(name), false, `${name} should be filtered`);
  }
});

test('actual games are kept, including ones that start with the same words', () => {
  for (const name of ['Counter-Strike 2', 'Wallpaper Engine', 'Protonwar', 'Steamworld Dig']) {
    assert.equal(looksLikeAGame(name), true, `${name} should be kept`);
  }
});

/* --- The scan ------------------------------------------------------------ */

test('every source is callable and returns an array', () => {
  // Whatever is or is not installed on the machine running this, none of them
  // may throw: a missing launcher is the common case.
  for (const [name, fn] of Object.entries(SOURCES)) {
    const result = fn();
    assert.ok(Array.isArray(result), `${name} returned an array`);
  }
});

test('a scan returns the documented shape', () => {
  const result = scan();
  assert.ok(Array.isArray(result.games));
  assert.ok(Array.isArray(result.errors));
  assert.equal(typeof result.scannedAt, 'number');

  for (const game of result.games) {
    assert.ok(game.id.includes(':'), 'ids are namespaced by source');
    assert.ok(game.title, 'every entry is named');
    assert.ok(game.path, 'and points somewhere');
  }
});

test('asking for one source does not run the others', () => {
  const result = scan({ sources: ['gog'] });
  assert.ok(result.games.every((g) => g.source === 'gog'));
});

test('an unknown source is ignored rather than throwing', () => {
  assert.doesNotThrow(() => scan({ sources: ['nintendo'] }));
});

test('results are sorted and free of duplicate paths', () => {
  const { games } = scan();
  const titles = games.map((g) => g.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));

  const paths = games.map((g) => g.path.toLowerCase());
  assert.equal(new Set(paths).size, paths.length, 'no install path appears twice');
});

/* --- What may be handed to the shell ------------------------------------- */

test('the two launcher URLs this app generates are allowed', () => {
  assert.ok(isLauncherUrl('steam://rungameid/730'));
  assert.ok(isLauncherUrl('com.epicgames.launcher://apps/Fortnite?action=launch&silent=true'));
});

test('nothing else is', () => {
  for (const url of [
    'steam://open/console',            // a different steam verb
    'steam://install/730',             // starts a download
    'steam://rungameid/730 --exec x',  // a trailing argument
    'steam://rungameid/abc',           // not an id
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'ms-settings:',
    'com.epicgames.launcher://apps/x?action=launch&silent=true&extra=1',
    'com.epicgames.launcher://apps/../../x?action=launch&silent=true',
    'https://example.com',
    '',
    null,
    undefined
  ]) {
    assert.equal(isLauncherUrl(url), false, `${url} must be refused`);
  }
});

test('every launch URL the scanner produces passes its own whitelist', () => {
  // Otherwise the feature would generate links it then refuses to open.
  for (const game of scan().games) {
    if (game.launch) assert.ok(isLauncherUrl(game.launch), `${game.launch} should be allowed`);
  }
});
