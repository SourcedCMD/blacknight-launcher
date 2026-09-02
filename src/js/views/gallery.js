/* =========================================================================
   Screenshots.

   The one thing a store page cannot do without. Everything else in this
   launcher — the generated art, the night map, the evolving skies — is about
   a game somebody already owns. This is the part that has to convince
   somebody who does not.

   The images arrive from the main process as data URIs, already fetched and
   cached, because the content security policy does not permit the renderer to
   load a remote image and weakening it for this would be a poor trade.

   When a title has no screenshots the generated art stands in, and the panel
   says plainly that these are not screenshots rather than implying they are.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el } = BN.util;

  /**
   * Renders the gallery into a host element.
   *
   * Asynchronous and deliberately not awaited by the detail sheet: fetching a
   * dozen images should never hold up the page that describes the game.
   */
  async function render(host, game) {
    if (!host) return;

    let shots = [];
    try {
      shots = await BN.api.library.screenshots(game.id);
    } catch (err) {
      BN.log?.warn('gallery', 'Could not load screenshots', err);
    }

    host.innerHTML = '';

    if (!shots.length) {
      host.append(placeholder(game));
      return;
    }

    const strip = el('div', { class: 'shots' });
    shots.forEach((shot, index) => {
      const button = el('button', {
        class: 'shot',
        'aria-label': `Screenshot ${index + 1} of ${shots.length}`
      });
      const img = el('img', { src: shot.src, alt: '', loading: 'lazy' });
      button.append(img);
      button.addEventListener('click', () => lightbox(shots, index, game));
      strip.append(button);
    });

    host.append(strip);
  }

  /**
   * What to show when a title has no screenshots yet.
   *
   * Says so, rather than quietly showing generated art in the place a
   * screenshot would be and letting somebody assume that is the game.
   */
  function placeholder(game) {
    const wrap = el('div', { class: 'shots-empty' });
    wrap.innerHTML = `
      <div class="shots-empty-art">${BN.art.banner(game)}</div>
      <p>No screenshots yet — the image above is generated artwork, not gameplay.</p>`;
    BN.util.coverSvg(wrap.querySelector('.shots-empty-art'));
    return wrap;
  }

  /**
   * Full-size viewing, with the keyboard working properly.
   *
   * Arrow keys move, Escape closes. A gallery you can only click through is a
   * gallery half the people using a launcher on a sofa cannot use at all.
   */
  function lightbox(shots, startAt, game) {
    let index = startAt;

    const figure = el('figure', { class: 'lightbox-figure' });
    const img = el('img', { src: shots[index].src, alt: `${game.title} screenshot` });
    const caption = el('figcaption');
    figure.append(img, caption);

    const paint = () => {
      img.src = shots[index].src;
      caption.textContent = `${index + 1} of ${shots.length}`;
    };

    const move = (step) => {
      index = (index + step + shots.length) % shots.length;
      paint();
    };

    const body = el('div', { class: 'lightbox' });

    const prev = el('button', { class: 'lightbox-nav', 'aria-label': 'Previous screenshot' });
    prev.innerHTML = BN.icon('chevronLeft');
    prev.addEventListener('click', () => move(-1));

    const next = el('button', { class: 'lightbox-nav', 'aria-label': 'Next screenshot' });
    next.innerHTML = BN.icon('chevronRight');
    next.addEventListener('click', () => move(1));

    body.append(prev, figure, next);
    paint();

    // Scoped to the modal rather than the document, so this stops listening
    // when the modal closes without anything having to remember to detach it.
    body.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') move(-1);
      else if (event.key === 'ArrowRight') move(1);
    });

    BN.ui.modal({
      title: game.title,
      wide: true,
      content: body,
      footer: [{ label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }]
    });

    // The container has to be focusable for the arrow keys to reach it.
    body.tabIndex = -1;
    setTimeout(() => body.focus(), 60);
  }

  /**
   * The trailer, opened in a browser.
   *
   * Not embedded: a video player inside the launcher means either a remote
   * frame the content security policy rightly forbids, or tens of megabytes
   * downloaded before somebody has decided they care.
   */
  function trailerButton(game) {
    const url = game?.media?.trailerUrl;
    if (!url || !/^https:\/\//i.test(url)) return null;

    const button = el('button', { class: 'btn btn-ghost', 'data-tip': 'Watch the trailer' });
    button.innerHTML = `${BN.icon('play')} Trailer`;
    button.addEventListener('click', () => BN.api.app.openExternal(url));
    return button;
  }

  BN.views = BN.views || {};
  BN.views.gallery = { render, trailerButton, lightbox };
})();
