/* =========================================================================
   Profile view: identity, lifetime stats and the full owned library.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, duration, date, relative, initials, countTo } = BN.util;
  const icon = BN.icon;

  function render() {
    const view = document.getElementById('view-profile');
    if (!view) return;

    const user = BN.state.data.user;
    const stats = BN.state.data.stats;
    const owned = BN.state.ownedGames();
    const installed = BN.state.installedGames();
    const wishlist = BN.state.data.library.filter((g) => g.favorite);
    const mostPlayed = [...BN.state.data.library].sort((a, b) => b.playtimeSeconds - a.playtimeSeconds)[0];

    view.innerHTML = `
      <div class="view-pad">
        <section class="profile-head">
          <div class="profile-banner" id="profile-banner" aria-hidden="true"></div>
          <div class="avatar avatar-lg avatar-ring">${esc(initials(user?.displayName || user?.handle))}</div>
          <div class="grow">
            <div class="row" style="gap:10px">
              <h1 class="display" style="font-size:1.9rem">${esc(user?.displayName || user?.handle || 'Player')}</h1>
              ${user?.tier === 'plus' ? `<span class="badge badge-solid">${icon('crown')} BlackNight+</span>` : ''}
              ${user?.offline ? `<span class="badge badge-warn">${icon('wifiOff')} Offline</span>` : ''}
            </div>
            <div class="mute" style="font-size:.84rem;margin-top:2px">
              @${esc(user?.handle || 'guest')}${user?.email ? ` · ${esc(user.email)}` : ''} · member since ${esc(date(user?.createdAt))}
            </div>
          </div>
          <div class="row" style="gap:10px" id="profile-actions"></div>
        </section>

        <section class="stat-grid" data-reveal>
          <div class="stat-cell"><div class="n mono" id="st-owned">0</div><div class="l">Titles owned</div></div>
          <div class="stat-cell"><div class="n mono" id="st-installed">0</div><div class="l">Installed</div></div>
          <div class="stat-cell"><div class="n mono">${esc(duration(stats.totalPlaytimeSeconds) )}</div><div class="l">Total playtime</div></div>
          <div class="stat-cell"><div class="n mono">${esc(bytes(stats.diskUsedBytes))}</div><div class="l">On disk</div></div>
          <div class="stat-cell"><div class="n mono" id="st-wishlist">0</div><div class="l">Wishlisted</div></div>
        </section>

        ${
          mostPlayed && mostPlayed.playtimeSeconds
            ? `<section class="section" data-reveal>
                 <div class="section-head"><div><h2>Most played</h2></div></div>
                 <div id="most-played"></div>
               </section>`
            : ''
        }

        <section class="section" data-reveal>
          <div class="section-head">
            <div><h2>Your library</h2><div class="sub">${owned.length} owned · ${installed.length} installed</div></div>
            <div class="segmented" id="lib-filter">
              <button data-lib="all" aria-pressed="true">All</button>
              <button data-lib="installed" aria-pressed="false">Installed</button>
              <button data-lib="wishlist" aria-pressed="false">Wishlist</button>
            </div>
          </div>
          <div class="col" style="gap:10px" id="profile-library"></div>
        </section>
      </div>`;

    countTo(view.querySelector('#st-owned'), owned.length, { format: (n) => String(Math.round(n)) });
    countTo(view.querySelector('#st-installed'), installed.length, { format: (n) => String(Math.round(n)) });
    countTo(view.querySelector('#st-wishlist'), wishlist.length, { format: (n) => String(Math.round(n)) });

    const actions = view.querySelector('#profile-actions');
    const edit = el('button', { class: 'btn btn-sm btn-ghost' });
    edit.innerHTML = `${icon('user')} Edit profile`;
    edit.addEventListener('click', () => BN.app.go('settings', 'account'));
    const membership = el('button', { class: 'btn btn-sm btn-chrome' });
    membership.innerHTML = `${icon('crown')} ${user?.tier === 'plus' ? 'Membership' : 'Join BlackNight+'}`;
    membership.addEventListener('click', () => BN.app.go('plus'));
    actions.append(edit, membership);

    const most = view.querySelector('#most-played');
    if (most) most.appendChild(BN.views.games.libraryRow(mostPlayed));

    const list = view.querySelector('#profile-library');
    const paint = (mode) => {
      const set =
        mode === 'installed' ? installed : mode === 'wishlist' ? wishlist : owned.length ? owned : BN.state.data.library;
      list.innerHTML = '';
      if (!set.length) {
        list.innerHTML = `
          <div class="empty">${icon('library')}<h3>Nothing here yet</h3>
          <p>${mode === 'wishlist' ? 'Wishlist a title and it shows up here.' : 'Titles you own appear here once you add them from the store.'}</p></div>`;
        const browse = el('button', { class: 'btn btn-ghost btn-sm' }, 'Open the store');
        browse.addEventListener('click', () => BN.app.go('store'));
        list.querySelector('.empty').appendChild(browse);
        return;
      }
      for (const game of set) list.appendChild(BN.views.games.libraryRow(game));
    };
    paint('all');

    view.querySelectorAll('[data-lib]').forEach((btn) =>
      btn.addEventListener('click', () => {
        view.querySelectorAll('[data-lib]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        paint(btn.dataset.lib);
      })
    );

    paintBanner(user);
    BN.fx.reveal(view);
  }

  /** Fills the header with the sky generated from this account's seed. */
  function paintBanner(user) {
    const host = document.getElementById('profile-banner');
    if (host) host.innerHTML = BN.art.profileBanner(user);
  }

  BN.views = BN.views || {};
  BN.views.profile = { render };
})();
