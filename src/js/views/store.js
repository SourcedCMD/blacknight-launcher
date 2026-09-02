/* =========================================================================
   Store view: featured banner, filters, sorting and the catalogue grid.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, countdown, debounce } = BN.util;
  const icon = BN.icon;

  const FILTERS = [
    { id: 'all', label: 'Browse all', test: () => true },
    { id: 'available', label: 'Available now', test: (g) => g.status === 'released' },
    { id: 'preorder', label: 'Pre-order', test: (g) => g.status === 'preorder' },
    { id: 'soon', label: 'Coming soon', test: (g) => g.status === 'announced' || g.status === 'coming-soon' },
    { id: 'free', label: 'Free to play', test: (g) => g.price.usd === 0 },
    { id: 'owned', label: 'My library', test: (g) => g.owned },
    { id: 'wishlist', label: 'Wishlist', test: (g) => g.favorite }
  ];

  const SORTS = {
    featured: (a, b) => Number(b.featured) - Number(a.featured) || a.title.localeCompare(b.title),
    release: (a, b) => new Date(a.releaseDate) - new Date(b.releaseDate),
    // Sorted on what a title actually costs today, not its list price - a
    // sale that does not move it in the list is a sale nobody finds.
    'price-low': (a, b) => BN.util.priceOf(a).now - BN.util.priceOf(b).now,
    'price-high': (a, b) => BN.util.priceOf(b).now - BN.util.priceOf(a).now,
    title: (a, b) => a.title.localeCompare(b.title),
    size: (a, b) => b.sizeBytes - a.sizeBytes
  };

  let filter = 'all';
  let sort = 'featured';
  let query = '';
  let bannerIndex = 0;
  let bannerTimer = null;

  /* --------------------------------------------------------------------- */

  function paintBanner(view) {
    const featured = BN.state.featuredGames();
    if (!featured.length) return;
    const game = featured[bannerIndex % featured.length];
    const host = view.querySelector('#store-banner');
    if (!host) return;

    const days = countdown(game.releaseDate);
    host.innerHTML = `
      <div class="art">${BN.art.banner(game)}</div>
      <div class="body">
        <div class="row wrap" style="gap:8px">${BN.components.statusBadge(game)}<span class="badge">${esc(game.rating)}</span></div>
        <h2 class="display" style="font-size:2.4rem">${esc(game.title)}</h2>
        <p class="dim" style="max-width:52ch">${esc(game.tagline)} ${days ? `Launching in ${days} days.` : ''}</p>
        <div class="row" style="gap:12px;margin-top:6px" id="banner-actions"></div>
      </div>
      <div class="hero-dots">
        ${featured.map((_, i) => `<button class="hero-dot" data-banner="${i}" aria-current="${i === bannerIndex % featured.length}" aria-label="Featured ${i + 1}"></button>`).join('')}
      </div>`;

    const actions = host.querySelector('#banner-actions');
    const primary = BN.components.actionButton(game);
    primary.classList.add('btn-lg');
    actions.appendChild(primary);

    const details = el('button', { class: 'btn btn-ghost btn-lg' });
    details.innerHTML = `${icon('info')} Learn more`;
    details.addEventListener('click', () => BN.components.openDetailGated(game.id));
    actions.appendChild(details);

    host.querySelectorAll('[data-banner]').forEach((dot) =>
      dot.addEventListener('click', () => {
        bannerIndex = Number(dot.dataset.banner);
        paintBanner(view);
        cycle(view);
      })
    );
  }

  function cycle(view) {
    clearInterval(bannerTimer);
    if (document.documentElement.dataset.motion === 'reduced') return;
    bannerTimer = setInterval(() => {
      bannerIndex++;
      paintBanner(view);
    }, 9000);
  }

  /* --------------------------------------------------------------------- */

  function paintGrid(view) {
    const grid = view.querySelector('#store-grid');
    const count = view.querySelector('#store-count');
    if (!grid) return;

    const rule = FILTERS.find((f) => f.id === filter) || FILTERS[0];
    const q = query.trim().toLowerCase();

    const results = BN.state.data.library
      .filter(rule.test)
      .filter((g) =>
        !q
          ? true
          : (g.title + ' ' + g.genre.join(' ') + ' ' + g.tags.join(' ') + ' ' + g.tagline).toLowerCase().includes(q)
      )
      .sort(SORTS[sort]);

    count.textContent = `${results.length} ${results.length === 1 ? 'title' : 'titles'}`;
    grid.innerHTML = '';

    if (!results.length) {
      grid.style.display = 'block';
      grid.innerHTML = `
        <div class="empty">
          ${icon('search')}
          <h3>Nothing here yet</h3>
          <p>No titles match ${q ? `"${esc(query)}"` : 'that filter'}. Try a different search or clear the filters.</p>
        </div>`;
      const reset = el('button', { class: 'btn btn-ghost btn-sm' }, 'Clear filters');
      reset.addEventListener('click', () => {
        filter = 'all';
        query = '';
        render();
      });
      grid.querySelector('.empty').appendChild(reset);
      return;
    }

    grid.style.display = '';
    grid.classList.add('stagger');
    for (const game of results) grid.appendChild(BN.components.gameCard(game));
  }

  /* --------------------------------------------------------------------- */

  function render() {
    const view = document.getElementById('view-store');
    if (!view) return;

    view.innerHTML = `
      <div class="view-pad">
        <div class="section-head" style="margin-bottom:22px">
          <div>
            <h2>Store</h2>
            <div class="sub">Everything from BlackNight Studios, in one place</div>
          </div>
          <div class="row" style="gap:10px">
            <div class="input-wrap" style="height:38px;width:250px">
              ${icon('search')}
              <input class="input" id="store-search" placeholder="Search the catalogue" value="${esc(query)}" spellcheck="false">
            </div>
            <select class="select" id="store-sort" aria-label="Sort">
              <option value="featured">Featured</option>
              <option value="release">Release date</option>
              <option value="price-low">Price: low to high</option>
              <option value="price-high">Price: high to low</option>
              <option value="title">Title A-Z</option>
              <option value="size">Download size</option>
            </select>
          </div>
        </div>

        <div class="store-banner" id="store-banner"></div>

        <div class="filters">
          ${FILTERS.map((f) => `<button class="chip" data-filter="${f.id}" aria-pressed="${f.id === filter}">${esc(f.label)}</button>`).join('')}
          <span class="mute grow" style="text-align:right;font-size:.78rem" id="store-count"></span>
        </div>

        <div class="grid" id="store-grid"></div>
      </div>`;

    view.querySelector('#store-sort').value = sort;
    paintBanner(view);
    cycle(view);
    paintGrid(view);

    view.querySelectorAll('[data-filter]').forEach((chip) =>
      chip.addEventListener('click', () => {
        filter = chip.dataset.filter;
        view.querySelectorAll('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', c === chip));
        paintGrid(view);
      })
    );

    view.querySelector('#store-sort').addEventListener('change', (e) => {
      sort = e.target.value;
      paintGrid(view);
    });

    const search = view.querySelector('#store-search');
    search.addEventListener(
      'input',
      debounce(() => {
        query = search.value;
        paintGrid(view);
      }, 150)
    );
  }

  BN.views = BN.views || {};
  BN.views.store = {
    render,
    onLeave: () => clearInterval(bannerTimer),
    onEnter: () => {
      const view = document.getElementById('view-store');
      if (view) cycle(view);
    },
    search(term) {
      query = term;
      filter = 'all';
      render();
    }
  };
})();
