/* =========================================================================
   Sharing a title, or a library.

   The share pages already exist — `npm run og` writes one per title into
   docs/g/, with real metadata so a link unfurls properly in a chat window.
   Nothing in the launcher pointed at them, which meant the whole thing was
   built and unreachable.

   On the OS share sheet: Chromium implements `navigator.share` on Windows,
   but Electron loading from file:// does not wire it up, so it is used only
   when the runtime genuinely provides it and the clipboard is the path that
   actually runs today. Claiming otherwise in a menu would be a lie the user
   discovers by clicking it.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const SITE = 'https://sourcedcmd.github.io/blacknight-launcher';

  /** The public page for a title. */
  const pageFor = (gameId) => `${SITE}/g/${encodeURIComponent(gameId)}.html`;

  /**
   * Whether the platform can open a real share sheet.
   *
   * Checked rather than assumed: this is false in the packaged launcher today
   * and true in a browser preview on a phone, and the menu should say what is
   * actually going to happen.
   */
  const canShareNatively = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  /**
   * Shares a title.
   *
   * Returns how it was shared so the caller can say the right thing, rather
   * than showing "Copied" after opening a share sheet.
   */
  async function shareGame(gameId) {
    const game = BN.state.game(gameId);
    if (!game) return { ok: false };

    const url = pageFor(gameId);
    const payload = {
      title: game.title,
      text: game.tagline || `${game.title} — BlackNight Studios`,
      url
    };

    if (canShareNatively()) {
      try {
        await navigator.share(payload);
        return { ok: true, how: 'sheet' };
      } catch (err) {
        // A cancelled sheet is not a failure and must not fall through to the
        // clipboard, or cancelling would silently copy instead.
        if (err?.name === 'AbortError') return { ok: false, how: 'cancelled' };
        BN.log?.warn('share', 'The share sheet failed; copying instead', err);
      }
    }

    await BN.api.app.copy?.(url);
    return { ok: true, how: 'clipboard', url };
  }

  /** The share action as a button handler, with the toast that goes with it. */
  async function share(gameId) {
    const result = await shareGame(gameId);
    if (result.how === 'cancelled') return;
    if (!result.ok) {
      BN.ui.toast('Could not share that', '', { kind: 'error' });
      return;
    }
    if (result.how === 'clipboard') {
      BN.ui.toast('Link copied', result.url, { kind: 'ok' });
      BN.sound?.play('click');
    }
  }

  /** Opens the public page for a title in the browser. */
  const openPage = (gameId) => BN.api.app.openExternal?.(pageFor(gameId));

  BN.share = { share, shareGame, openPage, pageFor, canShareNatively, SITE };
})();
