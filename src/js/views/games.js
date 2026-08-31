/* =========================================================================
   Games view: the spotlight carousel, continue playing, and the news rail.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, speed, duration, countdown, date } = BN.util;
  const icon = BN.icon;

  const ROTATE_MS = 11000;
  let slides = [];
  let index = 0;
  let timer = null;

  function stopRotation() {
    clearInterval(timer);
    timer = null;
  }

  function startRotation() {
    stopRotation();
    if (slides.length < 2 || document.documentElement.dataset.motion === 'reduced') return;
    timer = setInterval(() => show(index + 1), ROTATE_MS);
  }

  /* --------------------------------------------------------------------- */

  function heroPanel(game) {
    const days = countdown(game.releaseDate);
    const panel = el('div', { class: 'hero-body' });

    panel.innerHTML = `
      <div class="hero-eyebrow">
        ${BN.components.statusBadge(game)}
        <span class="eyebrow">${esc(game.genre.join(' · '))}</span>
      </div>
      <h1 class="hero-title">${esc(game.title)}${game.subtitle ? `<span class="sub">${esc(game.subtitle)}</span>` : ''}</h1>
      <p class="hero-tagline">${esc(game.tagline)}</p>
      <div class="hero-meta">
        <span class="badge">${esc(game.rating)}</span>
        <span class="badge">${esc(bytes(game.sizeBytes))}</span>
        <span class="badge">${days ? `${days} days out` : esc(date(game.releaseDate))}</span>
        ${Number.isFinite(game.playersOnline) && game.playersOnline > 0 ? `<span class="badge badge-ok"><span class="dot dot-live"></span> ${game.playersOnline.toLocaleString()} playing</span>` : ''}
      </div>
      <div class="hero-actions"></div>`;

    const actions = panel.querySelector('.hero-actions');

    if (game.download) {
      const dl = game.download;
      const box = el('div', { class: 'hero-install' });
      box.innerHTML = `
        <div class="between">
          <b style="font-family:var(--font-display);letter-spacing:.1em;text-transform:uppercase;font-size:.78rem">
            ${dl.status === 'paused' ? 'Paused' : 'Downloading'}
          </b>
          <span class="mono" style="font-size:.78rem">${Math.round(dl.progress * 100)}%</span>
        </div>
        <div class="progress${dl.status === 'paused' ? ' paused' : ''}"><i style="width:${dl.progress * 100}%"></i></div>
        <div class="between mute" style="font-size:.74rem">
          <span>${esc(bytes(dl.receivedBytes))} / ${esc(bytes(dl.totalBytes))}</span>
          <span>${dl.status === 'downloading' ? `${esc(speed(dl.speedBps))} · ${esc(duration(dl.etaSeconds))} left` : 'Paused'}</span>
        </div>`;
      actions.appendChild(box);
      actions.appendChild(BN.components.actionButton(game, { size: 'btn-lg' }));
    } else {
      const primary = BN.components.actionButton(game);
      primary.classList.remove('btn-sm');
      if (game.installed) primary.classList.add('btn-play');
      else primary.classList.add('btn-lg');
      actions.appendChild(primary);

      const details = el('button', { class: 'btn btn-ghost btn-lg' });
      details.innerHTML = `${icon('info')} Details`;
      details.addEventListener('click', () => BN.components.openDetail(game.id));
      actions.appendChild(details);
    }

    const more = el('button', { class: 'btn btn-ghost btn-lg btn-icon', 'data-tip': 'More' });
    more.innerHTML = icon('more');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      gameMenu(more, game);
    });
    actions.appendChild(more);

    return panel;
  }

  function gameMenu(anchor, game) {
    const menu = el('div', { class: 'menu', style: { top: 'auto', bottom: 'calc(100% + 10px)', right: 'auto', left: '0' } });
    const item = (label, iconName, fn, cls = '') => {
      const b = el('button', { class: `menu-item ${cls}` });
      b.innerHTML = `${icon(iconName)} <span>${esc(label)}</span>`;
      b.addEventListener('click', () => {
        BN.ui.closeDropdown();
        fn();
      });
      return b;
    };

    menu.append(item('View details', 'info', () => BN.components.openDetail(game.id)));
    menu.append(item(game.favorite ? 'Remove from wishlist' : 'Add to wishlist', 'heart', () => BN.state.toggleFavorite(game.id).then(render)));
    if (game.installed) {
      menu.append(item('Open install folder', 'folder', () => BN.api.app.openPath(game.installPath)));
      menu.append(item('Verify files', 'shield', async () => {
        const r = await BN.state.verify(game.id);
        BN.ui.toast(r.ok ? 'Verification complete' : 'Verification failed', r.message || r.error, { kind: r.ok ? 'ok' : 'error' });
      }));
      menu.append(el('div', { class: 'menu-sep' }));
      menu.append(item('Uninstall', 'trash', async () => {
        const yes = await BN.ui.confirm({ title: `Uninstall ${game.title}?`, message: 'Saves and account progress are kept.', confirmLabel: 'Uninstall', danger: true });
        if (yes) {
          await BN.state.uninstall(game.id);
          BN.ui.toast('Uninstalled', `${game.title} was removed.`, { kind: 'ok' });
        }
      }, 'danger'));
    }
    BN.ui.dropdown(anchor, menu);
  }

  /* --------------------------------------------------------------------- */

  function show(next) {
    if (!slides.length) return;
    index = ((next % slides.length) + slides.length) % slides.length;
    const game = slides[index];
    const hero = document.getElementById('hero');
    if (!hero) return;

    const art = hero.querySelector('.hero-art');
    const oldBody = hero.querySelector('.hero-body');

    art.style.opacity = 0;
    setTimeout(() => {
      art.innerHTML = BN.art.hero(game);
      art.style.opacity = 1;
    }, 220);

    const body = heroPanel(game);
    body.style.animation = 'rise-in 520ms var(--ease-out)';
    if (oldBody) oldBody.replaceWith(body);
    else hero.insertBefore(body, hero.querySelector('.hero-dots'));

    hero.querySelectorAll('.hero-dot').forEach((dot, i) => {
      dot.setAttribute('aria-current', i === index);
      dot.innerHTML = i === index ? `<i style="animation-duration:${ROTATE_MS}ms"></i>` : '';
    });

    BN.state.data.selectedGameId = game.id;
  }

  /* --------------------------------------------------------------------- */

  function render() {
    const view = document.getElementById('view-games');
    if (!view) return;
    const { catalog } = BN.state.data;
    const library = BN.state.data.library;

    slides = BN.state.featuredGames();
    const installed = BN.state.installedGames();
    const recentIds = BN.state.data.stats.recent || [];
    const recent = recentIds.map((id) => library.find((g) => g.id === id)).filter(Boolean);
    const continuePlaying = [...new Set([...recent, ...installed])].slice(0, 6);

    view.innerHTML = `
      <div class="view-pad">
        <section class="hero" id="hero">
          <div class="hero-art" style="transition:opacity 240ms ease"></div>
          <div class="hero-dots">
            ${slides.map((_, i) => `<button class="hero-dot" data-slide="${i}" aria-label="Slide ${i + 1}"></button>`).join('')}
          </div>
        </section>

        ${
          continuePlaying.length
            ? `<section class="section" data-reveal>
                 <div class="section-head">
                   <div><h2>Continue playing</h2><div class="sub">Jump straight back in</div></div>
                 </div>
                 <div class="col" style="gap:10px" id="continue-list"></div>
               </section>`
            : ''
        }

        <section class="section" data-reveal>
          <div class="section-head">
            <div><h2>News and events</h2><div class="sub">From BlackNight Studios</div></div>
            <div class="rail-nav">
              <button class="btn btn-sm btn-ghost btn-icon" data-rail="news" data-dir="-1" aria-label="Scroll left">${icon('chevronLeft')}</button>
              <button class="btn btn-sm btn-ghost btn-icon" data-rail="news" data-dir="1" aria-label="Scroll right">${icon('chevronRight')}</button>
            </div>
          </div>
          <div class="rail" id="rail-news"></div>
        </section>

        <section class="section" data-reveal>
          <div class="section-head">
            <div><h2>The BlackNight slate</h2><div class="sub">${library.length} titles in development and release</div></div>
            <button class="btn btn-sm btn-ghost" id="games-see-store">${icon('store')} Open store</button>
          </div>
          <div class="grid stagger" id="slate-grid"></div>
        </section>
      </div>`;

    show(0);
    startRotation();

    view.querySelectorAll('.hero-dot').forEach((dot) =>
      dot.addEventListener('click', () => {
        show(Number(dot.dataset.slide));
        startRotation();
      })
    );

    const hero = view.querySelector('#hero');
    hero.addEventListener('pointerenter', stopRotation);
    hero.addEventListener('pointerleave', startRotation);

    const continueList = view.querySelector('#continue-list');
    if (continueList) {
      for (const game of continuePlaying) continueList.appendChild(libraryRow(game));
    }

    const news = view.querySelector('#rail-news');
    for (const item of catalog.news) news.appendChild(BN.components.newsCard(item, catalog.games));

    const grid = view.querySelector('#slate-grid');
    for (const game of library) grid.appendChild(BN.components.gameCard(game));

    view.querySelectorAll('[data-rail]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const rail = view.querySelector(`#rail-${btn.dataset.rail}`);
        rail.scrollBy({ left: Number(btn.dataset.dir) * 380, behavior: 'smooth' });
      })
    );

    view.querySelector('#games-see-store')?.addEventListener('click', () => BN.app.go('store'));

    BN.fx.reveal(view);
  }

  function libraryRow(game) {
    const row = el('div', { class: 'lib-row' });
    row.innerHTML = `
      <div class="lib-thumb">${BN.art.thumb(game)}</div>
      <div class="grow">
        <div class="lib-name">${esc(game.title)}</div>
        <div class="lib-meta">${esc(BN.components.statusLine(game))}${game.lastPlayed ? ` · last played ${esc(BN.util.relative(game.lastPlayed))}` : ''}</div>
        ${game.download ? `<div class="progress" style="margin-top:8px;max-width:320px"><i style="width:${game.download.progress * 100}%"></i></div>` : ''}
      </div>
      <div class="row" style="gap:8px"></div>`;
    const actions = row.querySelector('.row:last-child');
    actions.appendChild(BN.components.actionButton(game, { size: 'btn-sm' }));

    if (game.running) {
      const stop = el('button', { class: 'btn btn-sm btn-ghost', 'data-tip': 'End session' });
      stop.innerHTML = icon('stop');
      stop.addEventListener('click', async () => {
        await BN.state.endSession(game.id);
        BN.ui.toast('Session ended', `Playtime for ${game.title} was saved.`, { kind: 'ok', ms: 3000 });
      });
      actions.appendChild(stop);
    }

    const more = el('button', { class: 'btn btn-sm btn-ghost btn-icon', 'data-tip': 'More' });
    more.innerHTML = icon('more');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      gameMenu(more, game);
    });
    actions.appendChild(more);
    return row;
  }

  BN.views = BN.views || {};
  BN.views.games = {
    render,
    onEnter: startRotation,
    onLeave: stopRotation,
    libraryRow
  };
})();
