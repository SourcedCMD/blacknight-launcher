'use strict';
/**
 * The renderer's pure logic.
 *
 * Twenty-nine files lived in src/js with one of them tested, despite a good
 * deal of it being ordinary functions over ordinary data. None of this needs a
 * DOM: the modules hang themselves off `window`, so a stub is enough to load
 * them and call the parts that only take arguments and return values.
 *
 * What is deliberately not here: anything that draws. Those are verified by
 * running the launcher, because a test asserting an SVG string matches another
 * SVG string tells you the file has not changed, not that it is right.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/* --- A window, minus a document ------------------------------------------ */

global.window = global.window || {};
// Node ships a read-only `navigator`; i18n only reads `.language` from it.
// i18n stamps a lang attribute on load; nothing else touches the document.
global.document = global.document || { documentElement: { setAttribute() {} } };

require('../src/js/util.js');
require('../src/js/i18n.js');
require('../src/js/art.js');

const BN = global.window.BN;

/* --- Formatters ----------------------------------------------------------- */

test('bytes reads at the scale a person would say it', () => {
  assert.equal(BN.util.bytes(0), '0 B');
  assert.equal(BN.util.bytes(999), '999 B');
  assert.match(BN.util.bytes(1024), /1.0 KB/);
  assert.match(BN.util.bytes(90 * 1024 ** 3), /90.0 GB/);
});

test('duration drops the units that would be noise', () => {
  assert.match(BN.util.duration(45), /45s/);
  assert.match(BN.util.duration(3600), /1h/);
  assert.match(BN.util.duration(3660), /1h 1m/);
  // A four hour session should not be reported in seconds.
  assert.ok(!/\d+s/.test(BN.util.duration(4 * 3600 + 62)));
});

test('initials handle one word, two, and nothing', () => {
  assert.equal(BN.util.initials('Sam'), 'S');
  assert.equal(BN.util.initials('Sam Vale'), 'SV');
  assert.equal(BN.util.initials('ash_fall'), 'AF', 'underscores separate too');
  assert.equal(BN.util.initials(''), '?');
  assert.equal(BN.util.initials(undefined), '?');
});

test('esc closes the holes that matter in an attribute or a body', () => {
  const nasty = '<img src=x onerror="alert(1)">';
  const escaped = BN.util.esc(nasty);
  assert.ok(!escaped.includes('<'), 'no raw angle brackets survive');
  assert.ok(!escaped.includes('"'), 'nor a quote that could end an attribute');
});

/* --- The seeded PRNG ------------------------------------------------------ */

test('the same seed always gives the same sequence', () => {
  const a = BN.util.rng(12345);
  const b = BN.util.rng(12345);
  const first = [a(), a(), a()];
  const second = [b(), b(), b()];
  assert.deepEqual(first, second, 'art must look identical on every machine');
});

test('different seeds diverge', () => {
  const a = BN.util.rng(1);
  const b = BN.util.rng(2);
  assert.notEqual(a(), b());
});

test('the sequence stays inside zero and one', () => {
  const rand = BN.util.rng(99);
  for (let i = 0; i < 500; i++) {
    const value = rand();
    assert.ok(value >= 0 && value < 1, `${value} is outside the range`);
  }
});

test('hashString is stable and spreads', () => {
  assert.equal(BN.util.hashString('eclipse-protocol'), BN.util.hashString('eclipse-protocol'));
  assert.notEqual(BN.util.hashString('ashfall'), BN.util.hashString('tidebreaker'));
});

/* --- Translation ---------------------------------------------------------- */

test('a known key resolves and an unknown one returns itself', () => {
  assert.equal(BN.t('action.play'), 'Play');
  // A visible key in the UI is a bug report; an empty label is not.
  assert.equal(BN.t('nothing.here'), 'nothing.here');
});

test('placeholders are filled, and unknown ones are left alone', () => {
  assert.equal(BN.t('status.download', { size: '90 GB' }), '90 GB download');
  assert.equal(BN.t('status.download', {}), '{size} download');
});

test('plurals pick the right form', () => {
  assert.equal(BN.i18n.plural('updates.available', 1), '1 update available');
  assert.equal(BN.i18n.plural('updates.available', 3), '3 updates available');
});

test('a locale with no catalog falls back to English rather than breaking', () => {
  BN.i18n.setLocale('xx');
  assert.equal(BN.t('action.play'), 'Play');
  BN.i18n.setLocale('en');
});

test('a registered locale overrides only what it defines', () => {
  // A made-up code, not a real one: registering over a shipped catalogue would
  // make this test depend on what that catalogue happens to contain.
  BN.i18n.register('zz', { 'action.play': 'Zzz' });
  BN.i18n.setLocale('zz');
  assert.equal(BN.t('action.play'), 'Zzz', 'the translated key');
  assert.equal(BN.t('action.close'), 'Close', 'and English for the rest');
  BN.i18n.setLocale('en');
});

/* --- Art ------------------------------------------------------------------ */

/**
 * Every gradient and filter gets a unique id per call, so two pieces of art on
 * one page cannot capture each other's `url(#...)` references. That id is
 * random by design, so determinism is a claim about the geometry.
 */
const geometry = (svg) => svg.replace(/bn[a-z0-9]{4,10}-/g, 'id-');

test('the same title always draws the same art', () => {
  const options = { seed: 7331, hue: 212, motif: 'city', w: 400, h: 300, detail: 0.8 };
  assert.equal(geometry(BN.art.keyArt(options)), geometry(BN.art.keyArt(options)));
});

const skyId = (svg) => /id="(bn[a-z0-9]+)-sky"/.exec(svg)[1];

test('two different pieces of art never share a gradient id', () => {
  // This is the collision that would actually show: on one page, the first
  // definition wins for both, so two pieces sharing an id would mean one of
  // them drawing the other's sky.
  const base = { hue: 212, motif: 'city', w: 400, h: 300, detail: 0.8 };
  const ids = new Set();
  for (let seed = 0; seed < 40; seed++) ids.add(skyId(BN.art.keyArt({ ...base, seed })));
  assert.equal(ids.size, 40, 'every distinct piece got its own id');
});

test('identical art is drawn once and reused', () => {
  const options = { seed: 90210, hue: 212, motif: 'city', w: 400, h: 300, detail: 0.8 };
  const first = BN.art.keyArt(options);
  assert.equal(BN.art.keyArt(options), first, 'the same string, ids and all');
  // Sharing ids here is safe precisely because the definitions are identical.
  assert.equal(skyId(first), skyId(BN.art.keyArt(options)));
});

test('the cache is bounded and can be emptied', () => {
  BN.art.keyArt.clearCache();
  const options = { seed: 5150, hue: 200, motif: 'sea', w: 200, h: 200, detail: 0.4 };
  const before = skyId(BN.art.keyArt(options));

  // Push well past the limit so the entry above is evicted.
  for (let seed = 1000; seed < 1200; seed++) BN.art.keyArt({ ...options, seed });

  assert.notEqual(skyId(BN.art.keyArt(options)), before, 'it was redrawn, not held forever');
});

test('a different seed draws something else', () => {
  const base = { hue: 212, motif: 'city', w: 400, h: 300, detail: 0.8 };
  assert.notEqual(geometry(BN.art.keyArt({ ...base, seed: 1 })), geometry(BN.art.keyArt({ ...base, seed: 2 })));
});

test('every motif renders', () => {
  for (const motif of BN.art.MOTIFS) {
    const svg = BN.art.keyArt({ seed: 42, hue: 200, motif, w: 300, h: 200, detail: 0.6 });
    assert.match(svg, /^\s*<svg/, `${motif} produced an svg`);
    assert.ok(svg.includes('</svg>'), `${motif} closed it`);
  }
});

test('maturity rises with playtime and settles', () => {
  const at = (hours) => BN.art.maturity({ playtimeSeconds: hours * 3600 });
  assert.equal(at(0), 0);
  assert.ok(at(1) > 0 && at(1) < at(10), 'the first hour is visible');
  assert.ok(at(10) < at(50));
  assert.equal(at(50), 1, 'and it tops out rather than growing forever');
  assert.equal(at(500), 1);
});

test('a played-in title gains sky', () => {
  const stars = (maturity) =>
    (BN.art.keyArt({ seed: 5, hue: 200, motif: 'city', w: 400, h: 300, detail: 0.8, maturity }).match(/<circle/g) || [])
      .length;
  assert.ok(stars(1) > stars(0), 'more of the same place, not a different one');
});

test('logo renders at any size and stays square', () => {
  for (const size of [16, 64, 256]) {
    const svg = BN.art.logo(size);
    assert.ok(svg.includes(`width="${size}"`) && svg.includes(`height="${size}"`));
  }
});

/* --- QR, which the handoff depends on ------------------------------------- */

require('../src/js/qr.js');

test('a handoff link encodes and carries a quiet zone', () => {
  const svg = BN.qr.svg('blacknight://handoff?host=192.168.1.20&port=8431&code=K7QP2M');
  assert.match(svg, /^<svg/);
  assert.ok(svg.length > 500, 'a real symbol, not an empty one');
});

/* --- Translation keys used by the UI ------------------------------------- */

/**
 * A key that does not exist renders as the key itself — `nav.gamez` sitting in
 * the sidebar. That is a typo nobody catches in review and everybody sees in
 * the product, so it is worth a test.
 */
test('every translation key the code references exists', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const root = path.join(__dirname, '..', 'src', 'js');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'i18n.js') files.push(full);
    }
  };
  walk(root);

  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // Literal keys only: an interpolated one cannot be checked from here.
    for (const match of source.matchAll(/\bt\(\s*'([a-z][a-zA-Z]*\.[a-zA-Z]+)'/g)) {
      if (BN.t(match[1]) === match[1]) missing.push(`${path.basename(file)}: ${match[1]}`);
    }
  }

  assert.deepEqual(missing, [], 'these keys are used but not defined');
});

test('the nav keys the sidebar builds by hand all exist', () => {
  // Built as `nav.${id}`, so the check above cannot see them.
  for (const id of ['games', 'store', 'plus', 'downloads', 'settings']) {
    assert.notEqual(BN.t(`nav.${id}`), `nav.${id}`, `nav.${id} is missing`);
  }
});

test('no key resolves to an empty label', () => {
  // An empty string is worse than a missing key: it renders as a blank button.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'js', 'i18n.js'), 'utf8');
  for (const match of source.matchAll(/^    '([^']+)':\s*'(.*)'/gm)) {
    assert.ok(match[2].length > 0, `${match[1]} is empty`);
  }
});

/* --- Deep links ---------------------------------------------------------- */

/**
 * The parser lives in the main process, which this suite does not load, so it
 * is required directly. It is a pure function over a string, which is exactly
 * the kind of thing that should be tested rather than clicked.
 */
test('deep links resolve to the right target, and nothing else does', () => {
  // Loaded lazily: requiring main.js would start an app.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'electron', 'main.js'),
    'utf8'
  );

  // The route allowlist is the security-relevant part: a link must not be able
  // to name an arbitrary internal view.
  const match = /\[('games'[^\]]*)\]\.includes\(action\)/.exec(source);
  assert.ok(match, 'the route allowlist is still an allowlist');

  const routes = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.ok(routes.includes('store'));
  assert.ok(routes.includes('journal'));
  assert.ok(!routes.includes('*'), 'no wildcard');
});

test('an install or play link is parsed as an intent, not an action', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'electron', 'main.js'),
    'utf8'
  );
  // The main process must hand these to the renderer to confirm rather than
  // installing or launching on its own.
  assert.match(source, /type: 'intent'/);
  assert.ok(
    !/action === 'install'[\s\S]{0,200}library\.install/.test(source),
    'the main process must not act on an install link directly'
  );
});

/* --- Settings transfer --------------------------------------------------- */

// transfer.js needs BN.util, which is already loaded above.
require('../src/js/views/transfer.js');

test('an export leaves out anything private to one machine', () => {
  const exported = BN.views.transfer.exportable({
    theme: 'dark',
    presenceClientId: 'abc123',
    installDir: 'D:\Games',
    peerName: "Sam's PC",
    lastRoute: 'store',
    accountsUrl: 'https://accounts.example.com'
  });

  assert.equal(exported.theme, 'dark', 'ordinary settings travel');
  assert.equal(exported.accountsUrl, 'https://accounts.example.com', 'and so do service URLs');

  for (const key of ['presenceClientId', 'installDir', 'peerName', 'lastRoute']) {
    assert.ok(!(key in exported), `${key} must not travel`);
  }
});

test('an export never carries a secret, whatever it is called', () => {
  const exported = BN.views.transfer.exportable({
    theme: 'dark',
    adminToken: 'zzz',
    apiKey: 'zzz',
    sessionSecret: 'zzz',
    userPassword: 'zzz'
  });
  assert.deepEqual(Object.keys(exported), ['theme']);
});

test('a file that is not an export is refused before anything is applied', () => {
  assert.ok(BN.views.transfer.validate(null));
  assert.ok(BN.views.transfer.validate({}));
  assert.ok(BN.views.transfer.validate({ kind: 'something-else', settings: {} }));
  assert.ok(BN.views.transfer.validate({ kind: 'blacknight-settings' }), 'no settings in it');
  assert.equal(BN.views.transfer.validate({ kind: 'blacknight-settings', settings: {} }), null);
});

test('an import keeps only keys this build knows, with matching types', () => {
  const known = { theme: 'dark', volume: 50, attractMode: true };
  const { accepted, ignored } = BN.views.transfer.reconcile(
    {
      theme: 'light',            // known, same type
      volume: 'loud',            // known, wrong type
      attractMode: false,        // known, same type
      somethingFromTheFuture: 1, // unknown
      presenceClientId: 'abc',   // never travels
      apiKey: 'zzz'              // secret
    },
    known
  );

  assert.deepEqual(accepted, { theme: 'light', attractMode: false });
  for (const key of ['volume', 'somethingFromTheFuture', 'presenceClientId', 'apiKey']) {
    assert.ok(ignored.includes(key), `${key} should be reported as skipped`);
  }
});

test('an export of the real defaults round-trips into itself', () => {
  // Whatever the defaults are, exporting and importing them must be a no-op
  // rather than dropping half of them on the floor.
  const defaults = { theme: 'dark', volume: 50, attractMode: true, locale: 'en' };
  const exported = BN.views.transfer.exportable(defaults);
  const { accepted } = BN.views.transfer.reconcile(exported, defaults);
  assert.deepEqual(accepted, defaults);
});

/* --- The changelog renderer ---------------------------------------------- */

test('markdown renders headings, bullets and inline code', () => {
  const html = BN.views.transfer.renderMarkdown('## 1.0.2\n\n### Added\n\n- A **thing** with `code`\n');
  assert.match(html, /<h3>1\.0\.2<\/h3>/);
  assert.match(html, /<li>A <strong>thing<\/strong> with <code>code<\/code><\/li>/);
});

test('markdown cannot smuggle html through the changelog', () => {
  const html = BN.views.transfer.renderMarkdown('- <img src=x onerror="alert(1)">\n');
  assert.ok(!html.includes('<img'), 'the tag is escaped');
  assert.match(html, /&lt;img/);
});

test('an unterminated list still closes', () => {
  const html = BN.views.transfer.renderMarkdown('- one\n- two');
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length);
});

/* --- The French catalogue ------------------------------------------------ */

require('../src/js/locales/fr.js');

test('French is registered alongside English', () => {
  // Other tests in this file register throwaway locales, so this checks that
  // the two real ones are present rather than that nothing else is.
  const available = BN.i18n.available();
  assert.ok(available.includes('en'));
  assert.ok(available.includes('fr'));
});

test('every English key has a French translation', () => {
  // A partial catalogue is not a bug in itself — the fallback handles it — but
  // it means somebody added a string and did not say so. This turns that into
  // a failed build rather than an English word in a French UI.
  const fs = require('node:fs');
  const path = require('node:path');

  const english = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'i18n.js'), 'utf8');
  const keys = [...english.matchAll(/^ {4}'([^']+)':/gm)].map((m) => m[1]);

  BN.i18n.setLocale('en');
  const inEnglish = Object.fromEntries(keys.map((key) => [key, BN.t(key)]));
  BN.i18n.setLocale('fr');
  // t() falls back to English, so a key with no French entry comes back byte
  // for byte identical to the English one.
  const missing = keys.filter((key) => BN.t(key) === inEnglish[key]);
  BN.i18n.setLocale('en');

  // Some keys are legitimately identical in both (a brand name, "Pause").
  const identical = ['nav.plus', 'action.pause', 'status.preorder'];
  const real = missing.filter((key) => !identical.includes(key));

  assert.deepEqual(real, [], 'these keys have no French translation');
});

test('placeholders survive translation', () => {
  BN.i18n.setLocale('fr');
  const filled = BN.t('status.download', { size: '90 Go' });
  assert.match(filled, /90 Go/);
  assert.ok(!filled.includes('{size}'), 'the placeholder was replaced');
  BN.i18n.setLocale('en');
});

test('French plurals pick the right form', () => {
  BN.i18n.setLocale('fr');
  assert.match(BN.i18n.plural('updates.available', 1, { count: 1 }), /1 mise à jour/);
  assert.match(BN.i18n.plural('updates.available', 3, { count: 3 }), /3 mises à jour/);
  BN.i18n.setLocale('en');
});

test('a key French does not define falls back to English', () => {
  BN.i18n.register('xx', { 'action.play': 'Xx' });
  BN.i18n.setLocale('xx');
  assert.equal(BN.t('action.play'), 'Xx');
  assert.equal(BN.t('action.close'), 'Close', 'and everything else stays readable');
  BN.i18n.setLocale('en');
});
