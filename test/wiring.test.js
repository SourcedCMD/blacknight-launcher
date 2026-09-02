'use strict';
/**
 * That the pieces are actually wired to each other.
 *
 * The renderer has no build step and no module system: forty-odd classic
 * scripts hang themselves off one `window.BN` and are loaded in a fixed order
 * from index.html. That is a deliberate trade - it is why the window paints
 * quickly - but it moves a whole class of error from "the bundler tells you"
 * to "nobody notices until a user clicks the wrong thing".
 *
 * These are the checks a bundler would have done.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);

const read = (src) => fs.readFileSync(path.join(ROOT, 'src', src), 'utf8');

/* --- Everything referenced exists ---------------------------------------- */

test('every script the page loads is actually there', () => {
  const missing = scripts.filter((src) => !fs.existsSync(path.join(ROOT, 'src', src)));
  assert.deepEqual(missing, [], 'a missing classic script fails silently in the browser');
});

test('every stylesheet the page loads is actually there', () => {
  const missing = styles.filter((href) => !fs.existsSync(path.join(ROOT, 'src', href)));
  assert.deepEqual(missing, []);
});

test('every renderer file is loaded by the page', () => {
  // A file nobody loads is dead weight in the repository and, worse, looks
  // live to the next person reading it.
  const onDisk = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.js')) onDisk.push(`${prefix}${entry.name}`);
    }
  };
  walk(path.join(ROOT, 'src', 'js'), 'js/');

  const loaded = new Set(scripts);
  const orphans = onDisk.filter((file) => !loaded.has(file));

  assert.deepEqual(orphans, [], 'these files exist but nothing loads them');
});

/* --- Load order ----------------------------------------------------------- */

test('nothing reads another module before that module is defined', () => {
  /**
   * Modules register themselves on BN when they load and use each other at
   * runtime, which is why the order mostly does not matter. Where it does
   * matter is a module reaching for another *at load time* - that reads
   * undefined, and the failure surfaces somewhere else entirely.
   */
  const definesIn = new Map();
  scripts.forEach((src) => {
    for (const m of read(src).matchAll(/^\s*BN\.(\w+)\s*=/gm)) {
      if (!definesIn.has(m[1])) definesIn.set(m[1], scripts.indexOf(src));
    }
  });

  const problems = [];
  scripts.forEach((src, index) => {
    // Top-level statements only: anything indented further is inside a
    // function and therefore runs later.
    const topLevel = read(src)
      .split('\n')
      .filter((line) => /^ {2}(const|let|var|if|for|BN\.)/.test(line))
      .join('\n');

    for (const m of topLevel.matchAll(/BN\.(\w+)/g)) {
      const definedAt = definesIn.get(m[1]);
      if (definedAt !== undefined && definedAt > index) {
        problems.push(`${src} reads BN.${m[1]} at load, defined later by ${scripts[definedAt]}`);
      }
    }
  });

  assert.deepEqual([...new Set(problems)], []);
});

/* --- The preload surface -------------------------------------------------- */

test('every channel the preload calls is handled in the main process', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

  const called = [...preload.matchAll(/call\('([^']+)'/g)].map((m) => m[1]);
  const handled = new Set([...main.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));

  const orphans = [...new Set(called)].filter((channel) => !handled.has(channel));
  assert.deepEqual(orphans, [], 'these would reject at runtime with no handler registered');
});

test('no IPC channel is registered twice', () => {
  // A duplicate registration throws on startup, which is a blank window.
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const handled = [...main.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]);

  const seen = new Set();
  const duplicates = handled.filter((channel) => (seen.has(channel) ? true : (seen.add(channel), false)));
  assert.deepEqual(duplicates, []);
});

test('the browser bridge answers everything the preload does', () => {
  /**
   * The browser preview stands in for the preload, so a method it lacks is a
   * feature that throws in `npm run web` and works in the app - which is the
   * hardest kind of difference to notice.
   */
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'js', 'bridge.js'), 'utf8');

  // Method names on the preload surface, e.g. `foo: (x) => call(...)`.
  const methods = [...preload.matchAll(/^\s{4}(\w+):\s*\(/gm)].map((m) => m[1]);
  const missing = [...new Set(methods)].filter((name) => !new RegExp(`\\b${name}\\b`).test(bridge));

  assert.deepEqual(missing, [], 'the browser preview would throw on these');
});

/* --- Styles --------------------------------------------------------------- */

test('a selector is not defined in two different stylesheets', () => {
  // Two files fighting over one selector is how a change lands in the wrong
  // place and appears not to work.
  const where = new Map();

  for (const href of styles) {
    const text = fs.readFileSync(path.join(ROOT, 'src', href), 'utf8');
    for (const m of text.matchAll(/^([.#][a-zA-Z][\w-]*)(?:[^{,]*)?(?:,|\s*\{)/gm)) {
      const set = where.get(m[1]) || new Set();
      set.add(href);
      where.set(m[1], set);
    }
  }

  const shared = [...where.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([selector, files]) => `${selector} in ${[...files].join(' and ')}`);

  assert.deepEqual(shared, []);
});
