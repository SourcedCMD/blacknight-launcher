/* =========================================================================
   The renderer half of the smoke test.

   Runs only when the app was started with --smoke-test, and does nothing at
   all otherwise: this file ships, but in an ordinary launch it defines one
   function and never calls it.

   What it checks is deliberately shallow and broad. Deep assertions about
   what a view contains belong in unit tests, where they run in a second and
   say something precise when they fail. What only a real window can tell you
   is whether every script loaded, every module registered itself, and every
   view can render against real state without throwing - which is exactly the
   class of bug that reaches a release.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const ROUTES = ['games', 'store', 'plus', 'downloads', 'settings', 'profile'];

  // Modules every view assumes exist. A missing one is usually a script that
  // threw on load, which otherwise shows up much later as a confusing error.
  const MODULES = [
    'util', 'i18n', 'icon', 'art', 'api', 'ui', 'state', 'components',
    'sound', 'fx', 'share', 'passkeys', 'session'
  ];

  const VIEWS = [
    'games', 'store', 'plus', 'downloads', 'settings', 'profile',
    'auth', 'journal', 'achievements', 'handoff', 'nightmap', 'libraryShare', 'transfer', 'insights'
  ];

  const problems = [];
  // Reported to the main process, which writes it to stdout where the runner
  // is watching. Also logged locally so a --keep run is readable in devtools.
  const say = (line) => {
    console.log(`SMOKE: ${line}`);
    BN.api.app.smokeReport?.(line);
  };

  function check(what, fn) {
    try {
      const result = fn();
      if (result === false) throw new Error('returned false');
      say(`ok    ${what}`);
    } catch (err) {
      problems.push(`${what}: ${err.message}`);
      say(`FAIL  ${what} - ${err.message}`);
    }
  }

  const settle = (ms = 220) => new Promise((r) => setTimeout(r, ms));

  async function run() {
    say('starting');

    /**
     * A clean profile has no account, so the app is sitting on the sign-in
     * screen and none of the views exist yet. Offline mode is the right way
     * in: it is a real supported path, it needs no server, and it exercises
     * the same start() every other launch goes through.
     */
    if (!BN.state.data.user) {
      try {
        await BN.state.signInOffline();
        await settle(600);
        say('ok    signed in offline');
      } catch (err) {
        say(`FAIL  could not sign in - ${err.message}`);
        say('FAIL (1)');
        return;
      }
    }

    /**
     * Anything that actually goes wrong while this runs counts against it.
     *
     * Listening for real errors rather than swapping console.error: an
     * uncaught exception in a view and a rejected promise nobody handled are
     * the failures that matter, and a view can throw without ever calling
     * console.error.
     */
    const failures = [];
    const onError = (e) => failures.push(`${e.message || e.error} (${e.filename || '?'}:${e.lineno || 0})`);
    const onRejection = (e) => failures.push(`unhandled rejection: ${e.reason?.message || e.reason}`);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    for (const name of MODULES) check(`module ${name}`, () => !!BN[name]);
    for (const name of VIEWS) check(`view ${name}`, () => !!BN.views?.[name]);

    check('the catalogue loaded', () => BN.state.data.catalog.games.length > 0);
    check('the library resolved', () => Array.isArray(BN.state.data.library));
    check('settings resolved', () => typeof BN.state.data.settings === 'object');

    // Every route, rendered for real.
    for (const route of ROUTES) {
      BN.app.go(route);
      await settle();
      check(`route ${route} rendered`, () => {
        const view = document.getElementById(`view-${route}`);
        if (!view) throw new Error('no view element');
        if (!view.children.length) throw new Error('rendered empty');
        return true;
      });
    }

    // The modals, which are where most of the newer code lives.
    check('a game detail opens', () => {
      BN.components.openDetail(BN.state.data.catalog.games[0].id);
      return !!document.querySelector('.modal');
    });
    await settle(150);
    BN.ui.closeModal();
    await settle(120);

    check('the command palette opens', () => {
      BN.app.openPalette();
      return !!document.querySelector('.palette');
    });
    BN.ui.closePalette?.();
    await settle(120);

    // open() reads the journal from disk before it builds anything, so this
    // has to wait for it rather than looking immediately.
    await BN.views.journal.open();
    await settle(150);
    check('the journal opens', () => !!document.querySelector('.modal'));
    BN.ui.closeModal();
    await settle(120);

    // Generators, which run on every screen and are easy to break.
    check('art draws', () => BN.art.keyArt({ seed: 1, motif: 'city', w: 100, h: 100 }).startsWith('<svg'));
    check('the logo draws', () => BN.art.logo(32).includes('<svg'));
    check('a QR code draws', () => BN.qr.svg('blacknight://games').startsWith('<svg'));
    check('translation resolves', () => BN.t('action.play') === 'Play');

    // Settings search, since it reaches into every section builder.
    BN.app.go('settings');
    await settle();
    check('settings search finds something', () => {
      const box = document.getElementById('settings-search');
      if (!box) throw new Error('no search box');
      box.value = 'download';
      box.dispatchEvent(new Event('input'));
      return document.getElementById('settings-panel').children.length > 0;
    });

    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);

    if (failures.length) {
      problems.push(`${failures.length} uncaught error(s): ${failures[0].slice(0, 200)}`);
      say(`FAIL  nothing threw - ${failures.length}: ${failures[0].slice(0, 160)}`);
    } else {
      say('ok    nothing threw');
    }

    say(problems.length ? `FAIL (${problems.length})` : 'PASS');
  }

  BN.smoke = { run };
})();
