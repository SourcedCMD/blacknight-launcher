/* =========================================================================
   Attract mode, wallpaper export, and the accents you earn.

   Three small things that lean on generators the launcher already has, and
   which between them make the library feel like it belongs to whoever is
   sitting in front of it.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el } = BN.util;

  /* --------------------------------------------------------------------- */
  /* Attract mode                                                           */

  /**
   * After a few idle minutes the launcher becomes a dashboard: key art full
   * bleed, taglines fading through, the constellation breathing behind it.
   * Every console has one. No PC launcher does.
   *
   * Any input at all dismisses it, and it never appears while something is
   * downloading or a game is running - both are cases where somebody is
   * waiting on the screen rather than ignoring it.
   */
  let idleTimer = null;
  let layer = null;
  let slideTimer = null;

  const IDLE_MS = 4 * 60 * 1000;

  function eligible() {
    if (BN.state.data.settings.attractMode === false) return false;
    if (document.querySelector('.overlay, .palette-overlay, .ritual')) return false;
    if (BN.state.data.library.some((g) => g.running)) return false;
    if (BN.state.activeDownloads?.().length) return false;
    return true;
  }

  function show() {
    // A layer that has left the DOM by some other route must not block this
    // for the rest of the session, so the reference is checked rather than
    // just its existence.
    if (layer && !layer.isConnected) layer = null;
    if (layer || !eligible()) return;

    const slate = BN.state.data.library.filter((g) => g.art);
    if (!slate.length) return;

    // Held locally as well as on the module binding. Any input calls hide(),
    // which nulls that binding, and every async callback below would then be
    // reading null - which is precisely when they run.
    const node = el('div', { class: 'attract', role: 'presentation' });
    node.innerHTML = `
      <div class="attract-art" id="attract-art"></div>
      <div class="attract-body">
        <div class="attract-eyebrow" id="attract-eyebrow"></div>
        <div class="attract-title chrome-text" id="attract-title"></div>
        <div class="attract-tagline" id="attract-tagline"></div>
      </div>
      <div class="attract-hint">Move to continue</div>`;
    layer = node;
    document.body.appendChild(node);

    let index = Math.floor(Math.random() * slate.length);
    const paint = () => {
      if (!node.isConnected) return;
      const game = slate[index % slate.length];
      index++;
      const art = node.querySelector('#attract-art');
      art.innerHTML = BN.art.livingArt(game, 1920, 1080, 0.9);
      BN.util.coverSvg(art);
      node.querySelector('#attract-eyebrow').textContent =
        BN.components.STATUS_LABEL[game.status] || game.status;
      node.querySelector('#attract-title').textContent = game.title;
      node.querySelector('#attract-tagline').textContent = game.tagline || '';
      art.classList.remove('in');
      void art.offsetWidth;
      art.classList.add('in');
    };

    paint();
    slideTimer = setInterval(paint, 9000);
    requestAnimationFrame(() => node.classList.add('on'));
  }

  function hide() {
    if (!layer) return;
    clearInterval(slideTimer);
    const going = layer;
    layer = null;
    going.classList.remove('on');
    setTimeout(() => going.remove(), 600);
  }

  function poke() {
    if (layer) hide();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(show, IDLE_MS);
  }

  function initAttract() {
    for (const evt of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'gamepadconnected']) {
      window.addEventListener(evt, poke, { passive: true });
    }
    poke();
  }

  /* --------------------------------------------------------------------- */
  /* Wallpaper                                                              */

  /**
   * Renders a title's art at the exact size of the screen it is going on and
   * hands it to the main process to save. The generator is resolution
   * independent, so this costs nothing but the rasterising.
   */
  async function wallpaper(gameId) {
    const game = BN.state.game(gameId);
    if (!game) return;

    const w = Math.round(screen.width * (devicePixelRatio || 1));
    const h = Math.round(screen.height * (devicePixelRatio || 1));

    try {
      const svg = BN.art.livingArt(game, w, h, 1);
      const img = new Image();
      // data: rather than blob: - the CSP allows one and refuses the other.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('could not draw the art'));
      });

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      const saved = await BN.api.app.savePoster(
        canvas.toDataURL('image/png'),
        `${game.id}-${w}x${h}.png`
      );
      BN.ui.toast(
        saved?.ok ? 'Wallpaper saved' : saved?.cancelled ? 'Cancelled' : 'Could not save',
        saved?.path || saved?.error || '',
        { kind: saved?.ok ? 'ok' : 'info' }
      );
    } catch (err) {
      BN.log?.warn('wallpaper', 'Could not render a wallpaper', err);
      BN.ui.toast('Could not make a wallpaper', err.message, { kind: 'error' });
    }
  }

  /* --------------------------------------------------------------------- */
  /* Accents you earn                                                       */

  /**
   * Two accents that only exist once they have been earned.
   *
   * The achievements were a list that ended at being a list; the accents were
   * six options nobody had a reason to revisit. Tying them together gives both
   * a point, for the cost of a lookup.
   */
  const LOCKED_ACCENTS = [
    {
      id: 'aurora',
      label: 'Aurora',
      color: '#5ef0d0',
      achievement: 'after-dark',
      how: 'Finish ten sessions between midnight and five.'
    },
    {
      id: 'signal',
      label: 'Signal',
      color: '#ff8bd0',
      achievement: 'centurion',
      how: 'Reach a hundred hours across the slate.'
    }
  ];

  async function accentState() {
    let earned = [];
    try {
      earned = (await BN.api.achievements.list()).filter((a) => a.earned).map((a) => a.id);
    } catch {
      earned = [];
    }
    return LOCKED_ACCENTS.map((accent) => ({ ...accent, unlocked: earned.includes(accent.achievement) }));
  }

  BN.ambient = { initAttract, show, hide, wallpaper, accentState, LOCKED_ACCENTS };
})();
