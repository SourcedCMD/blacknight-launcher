/* =========================================================================
   Shared game components: status logic, the primary action button, cards,
   and the full game detail sheet.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, money, date, countdown, playtime } = BN.util;
  const icon = BN.icon;

  /* --------------------------------------------------------------------- */
  /* Status                                                                 */

  const STATUS_LABEL = {
    released: 'Available now',
    preorder: 'Pre-order',
    announced: 'Announced',
    'coming-soon': 'Coming soon'
  };

  /** The single source of truth for what a title's main button should do. */
  function primaryAction(game) {
    if (game.running) return { key: 'running', label: 'Running', icon: 'zap', variant: 'btn-ghost', disabled: true };
    if (game.installed) return { key: 'play', label: 'Play', icon: 'play', variant: 'btn-play' };
    if (game.download) {
      return game.download.status === 'paused'
        ? { key: 'resume', label: 'Resume', icon: 'download', variant: 'btn-accent' }
        : { key: 'pause', label: 'Pause', icon: 'pause', variant: 'btn-ghost' };
    }
    if (game.status === 'released') {
      if (!game.owned && game.price.usd > 0) return { key: 'buy', label: money(game.price.usd), icon: 'store', variant: 'btn-chrome' };
      return { key: 'install', label: game.owned ? 'Install' : 'Get', icon: 'download', variant: 'btn-chrome' };
    }
    if (game.status === 'preorder') return { key: 'preorder', label: 'Pre-order', icon: 'sparkles', variant: 'btn-chrome' };
    return { key: 'wishlist', label: game.favorite ? 'Wishlisted' : 'Wishlist', icon: 'heart', variant: 'btn-ghost' };
  }

  /** Runs whatever primaryAction() decided, with the right feedback. */
  async function runAction(game, node) {
    const action = primaryAction(game);
    switch (action.key) {
      case 'play': {
        BN.sound?.play('launch');
        if (node) BN.fx.burst(node);
        const result = await BN.state.launch(game.id);
        if (result.ok) {
          BN.ui.toast('Launching ' + game.title, result.message || 'Have a good night out there.', { kind: 'ok', ms: 6000 });
          if (BN.state.data.settings.exitOnGameLaunch) setTimeout(() => BN.api.app.quit(), 1200);
        } else {
          BN.ui.toast('Could not launch', result.error, { kind: 'error' });
        }
        break;
      }
      case 'install': {
        const result = await BN.state.install(game.id);
        if (result.ok) {
          BN.ui.toast('Download started', `${game.title} - ${bytes(game.sizeBytes)}`, {
            kind: 'ok',
            action: { label: 'View queue', onClick: () => BN.app.go('downloads') }
          });
        } else {
          BN.ui.toast('Install failed', result.error, { kind: 'error' });
        }
        break;
      }
      case 'buy':
      case 'preorder':
        openDetail(game.id, { focus: 'editions' });
        break;
      case 'pause':
        await BN.state.downloadAction('pause', game.download.id);
        break;
      case 'resume':
        await BN.state.downloadAction('resume', game.download.id);
        break;
      case 'wishlist': {
        await BN.state.toggleFavorite(game.id);
        const now = BN.state.game(game.id);
        BN.ui.toast(
          now.favorite ? 'Added to wishlist' : 'Removed from wishlist',
          now.favorite ? `We will let you know when ${game.title} is playable.` : '',
          { kind: 'ok', ms: 3200 }
        );
        break;
      }
      case 'running':
        break;
    }
  }

  /** Renders the primary button for a title, already wired. */
  function actionButton(game, { size = '', block = false } = {}) {
    const action = primaryAction(game);
    const btn = el('button', {
      class: `btn ${action.variant} ${size} ${block ? 'btn-block' : ''}`,
      disabled: action.disabled
    });
    btn.innerHTML = `${icon(action.icon)} <span>${esc(action.label)}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runAction(game, btn);
    });
    return btn;
  }

  /** Small status line: install size, playtime, release countdown. */
  function statusLine(game) {
    if (game.running) return 'Running now';
    if (game.download) {
      const pct = Math.round(game.download.progress * 100);
      return `${game.download.status === 'paused' ? 'Paused' : 'Downloading'} - ${pct}%`;
    }
    if (game.installed) return BN.state.data.settings.showPlaytime ? playtime(game.playtimeSeconds) : 'Installed';
    if (game.status === 'released') return `${bytes(game.sizeBytes)} download`;
    const days = countdown(game.releaseDate);
    return days ? `${days} days to launch` : date(game.releaseDate);
  }

  function statusBadge(game) {
    if (game.installed) return `<span class="badge badge-ok">${icon('checkCircle')} Installed</span>`;
    if (game.download) return `<span class="badge badge-accent">${icon('download')} ${Math.round(game.download.progress * 100)}%</span>`;
    if (game.status === 'released') return `<span class="badge">${STATUS_LABEL.released}</span>`;
    if (game.status === 'preorder') return `<span class="badge badge-accent">${STATUS_LABEL.preorder}</span>`;
    return `<span class="badge">${STATUS_LABEL[game.status] || ''}</span>`;
  }

  const priceTag = (game) => {
    if (game.owned) return '<span class="price">In library</span>';
    if (game.price.usd === 0) return '<span class="price free">Free</span>';
    if (game.price.sale > 0)
      return `<span class="price"><span class="was">${money(game.price.usd)}</span>${money(game.price.sale)}</span>`;
    return `<span class="price">${money(game.price.usd)}</span>`;
  };

  /* --------------------------------------------------------------------- */
  /* Cards                                                                  */

  function gameCard(game) {
    const card = el('div', { class: 'game-card', tabindex: '0', role: 'button', 'aria-label': game.title });
    card.innerHTML = `
      <div class="poster">
        ${BN.art.poster(game)}
        <div class="sheen"></div>
        <div class="poster-top">
          ${statusBadge(game)}
          ${game.favorite ? `<span class="badge badge-accent" data-tip="Wishlisted">${icon('heart')}</span>` : ''}
        </div>
        <div class="poster-bottom">
          <h3>${esc(game.title)}</h3>
          <div class="genre">${esc(game.genre.slice(0, 2).join(' / '))}</div>
        </div>
        <div class="quick"></div>
      </div>
      <div class="foot">
        ${priceTag(game)}
        <span class="mute" style="font-size:.74rem">${esc(statusLine(game))}</span>
      </div>`;

    const quick = card.querySelector('.quick');
    quick.appendChild(actionButton(game, { size: 'btn-sm' }));
    const info = el('button', { class: 'btn btn-sm btn-ghost btn-icon', 'data-tip': 'Details' });
    info.innerHTML = icon('info');
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetail(game.id);
    });
    quick.appendChild(info);

    const open = () => openDetail(game.id);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    BN.fx.tilt(card);
    return card;
  }

  function newsCard(item, games) {
    const card = el('div', { class: 'news-card', tabindex: '0', role: 'button' });
    card.innerHTML = `
      <div class="art">${BN.art.newsArt(item, games)}</div>
      <div class="body">
        <span class="badge badge-accent" style="align-self:flex-start">${esc(item.kind)}</span>
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.body)}</p>
        <span class="cta">${esc(item.cta)} &rarr;</span>
      </div>`;
    const open = () => {
      if (item.gameId) openDetail(item.gameId);
      else
        BN.ui.modal({
          title: item.title,
          content: `<span class="badge badge-accent">${esc(item.kind)}</span>
            <p style="margin-top:14px;color:var(--text-dim);line-height:1.8">${esc(item.body)}</p>
            <p class="mute" style="margin-top:18px;font-size:.78rem">Posted ${esc(date(item.date))}</p>`,
          footer: [{ label: 'Close', class: 'btn-ghost', onClick: ({ close }) => close() }]
        });
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    return card;
  }

  /* --------------------------------------------------------------------- */
  /* Detail sheet                                                           */

  function openDetail(gameId, { focus = null } = {}) {
    const game = BN.state.game(gameId);
    if (!game) return;

    const days = countdown(game.releaseDate);
    const body = el('div');

    body.innerHTML = `
      <div class="detail-hero">
        <div class="art">${BN.art.hero(game)}</div>
        <div class="body">
          <div class="row wrap" style="gap:8px;margin-bottom:10px">${statusBadge(game)}<span class="badge">${esc(game.rating)}</span>${game.genre.map((g) => `<span class="badge">${esc(g)}</span>`).join('')}</div>
          <h2 class="display" style="font-size:2.1rem">${esc(game.title)}</h2>
          <p class="dim" style="margin-top:4px">${esc(game.tagline)}</p>
        </div>
      </div>

      <div style="padding:24px">
        <div class="row wrap" style="gap:12px;margin-bottom:22px" id="detail-actions"></div>

        <div class="detail-grid">
          <div>
            <p style="color:var(--text-dim);line-height:1.8">${esc(game.description)}</p>

            <h3 class="display" style="margin:26px 0 12px;font-size:.9rem">Features</h3>
            <div class="row wrap" style="gap:8px">
              ${game.features.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}
              ${game.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
            </div>

            <h3 class="display" style="margin:26px 0 12px;font-size:.9rem" id="editions-head">Editions</h3>
            <div class="col" style="gap:10px" id="editions"></div>

            <h3 class="display" style="margin:26px 0 12px;font-size:.9rem">System requirements</h3>
            <table class="spec-table">
              <tbody>
                ${['os', 'cpu', 'ram', 'gpu', 'storage']
                  .map(
                    (k) => `<tr>
                      <th>${k === 'os' ? 'Operating system' : k === 'cpu' ? 'Processor' : k === 'ram' ? 'Memory' : k === 'gpu' ? 'Graphics' : 'Storage'}</th>
                      <td><b style="color:var(--text-mute);font-weight:500">Min</b> ${esc(game.requirements.minimum[k])}<br>
                          <b style="color:var(--text-mute);font-weight:500">Rec</b> ${esc(game.requirements.recommended[k])}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>

          <aside>
            <div class="panel" style="padding:18px">
              <dl class="kv">
                <dt>Status</dt><dd>${esc(STATUS_LABEL[game.status] || game.status)}</dd>
                <dt>Release</dt><dd>${esc(date(game.releaseDate))}${days ? ` (${days}d)` : ''}</dd>
                <dt>Developer</dt><dd>${esc(game.developer)}</dd>
                <dt>Publisher</dt><dd>${esc(game.publisher)}</dd>
                <dt>Size</dt><dd>${esc(bytes(game.sizeBytes))}</dd>
                <dt>Rating</dt><dd>${esc(game.rating)}</dd>
                ${game.installed ? `<dt>Version</dt><dd>${esc(game.installedVersion || '1.0.0')}</dd>` : ''}
                ${game.installed ? `<dt>Installed</dt><dd>${esc(date(game.installedAt))}</dd>` : ''}
                ${game.playtimeSeconds ? `<dt>Playtime</dt><dd>${esc(playtime(game.playtimeSeconds))}</dd>` : ''}
              </dl>
            </div>

            ${
              game.installed
                ? `<div class="panel" style="padding:14px;margin-top:14px">
                     <div class="col" style="gap:8px" id="manage"></div>
                   </div>`
                : ''
            }

            ${
              game.playersOnline
                ? `<div class="panel" style="padding:16px;margin-top:14px" class="row">
                     <div class="row"><span class="dot dot-live" style="color:var(--ok)"></span>
                     <span class="mono">${game.playersOnline.toLocaleString()}</span>
                     <span class="mute" style="font-size:.78rem">playing now</span></div>
                   </div>`
                : ''
            }
          </aside>
        </div>
      </div>`;

    const sheet = BN.ui.modal({ content: body, wide: true, chrome: false });

    // Close affordance floated over the art
    const close = el('button', { class: 'modal-close', style: { position: 'absolute', top: '14px', right: '14px', zIndex: 5, background: 'rgba(6,6,12,.6)', backdropFilter: 'blur(8px)' }, 'aria-label': 'Close' });
    close.innerHTML = icon('x');
    close.addEventListener('click', () => BN.ui.closeModal());
    body.querySelector('.detail-hero').appendChild(close);

    /* Actions ---------------------------------------------------------- */
    const actions = body.querySelector('#detail-actions');
    actions.appendChild(actionButton(game, { size: game.installed ? '' : '' }));

    const fav = el('button', { class: 'btn btn-ghost', 'data-tip': game.favorite ? 'Remove from wishlist' : 'Add to wishlist' });
    fav.innerHTML = `${icon('heart')} ${game.favorite ? 'Wishlisted' : 'Wishlist'}`;
    fav.addEventListener('click', async () => {
      await BN.state.toggleFavorite(game.id);
      BN.ui.closeModal();
      openDetail(game.id);
    });
    actions.appendChild(fav);

    if (game.installed) {
      const folder = el('button', { class: 'btn btn-ghost', 'data-tip': 'Open install folder' });
      folder.innerHTML = icon('folder');
      folder.addEventListener('click', () => BN.api.app.openPath(game.installPath));
      actions.appendChild(folder);
    }

    /* Editions --------------------------------------------------------- */
    const editions = body.querySelector('#editions');
    let selected = game.editions[0]?.id;
    const paintEditions = () => {
      editions.innerHTML = '';
      for (const edition of game.editions) {
        const row = el('div', { class: 'edition', role: 'radio', 'aria-checked': edition.id === selected });
        row.innerHTML = `
          <span class="radio"></span>
          <div class="grow">
            <div class="row between">
              <b style="font-family:var(--font-display);letter-spacing:.08em;text-transform:uppercase;font-size:.85rem">${esc(edition.name)}</b>
              <span class="price">${edition.usd === 0 ? 'Free' : money(edition.usd)}</span>
            </div>
            <div class="perks">${esc(edition.perks.join(' · '))}</div>
          </div>`;
        row.addEventListener('click', () => {
          selected = edition.id;
          BN.sound?.play('click');
          paintEditions();
        });
        editions.appendChild(row);
      }

      const cta = el('button', { class: 'btn btn-chrome btn-block', style: { marginTop: '6px' } });
      const edition = game.editions.find((e) => e.id === selected);
      const isPre = game.status !== 'released';
      cta.innerHTML = `${icon(isPre ? 'sparkles' : 'download')} ${isPre ? 'Pre-order' : edition.usd === 0 ? 'Add to library' : 'Buy'} ${edition.usd === 0 ? '' : '- ' + money(edition.usd)}`;
      cta.addEventListener('click', () => checkout(game, edition));
      editions.appendChild(cta);
    };
    paintEditions();

    /* Manage (installed only) ------------------------------------------ */
    const manage = body.querySelector('#manage');
    if (manage) {
      const verify = el('button', { class: 'btn btn-ghost btn-sm btn-block' });
      verify.innerHTML = `${icon('shield')} Verify files`;
      verify.addEventListener('click', async () => {
        verify.disabled = true;
        verify.innerHTML = '<span class="spinner"></span> Verifying';
        const result = await BN.state.verify(game.id);
        verify.disabled = false;
        verify.innerHTML = `${icon('shield')} Verify files`;
        BN.ui.toast(result.ok ? 'Verification complete' : 'Verification failed', result.message || result.error, {
          kind: result.ok ? 'ok' : 'error'
        });
      });

      const options = el('button', { class: 'btn btn-ghost btn-sm btn-block' });
      options.innerHTML = `${icon('sliders')} Launch options`;
      options.addEventListener('click', () => launchOptions(game));

      const remove = el('button', { class: 'btn btn-danger btn-sm btn-block' });
      remove.innerHTML = `${icon('trash')} Uninstall`;
      remove.addEventListener('click', async () => {
        const yes = await BN.ui.confirm({
          title: `Uninstall ${game.title}?`,
          message: `This removes ${bytes(game.sizeBytes)} from ${game.installPath || 'your install folder'}. Your saves and account progress are kept.`,
          confirmLabel: 'Uninstall',
          danger: true
        });
        if (!yes) return;
        const result = await BN.state.uninstall(game.id);
        BN.ui.toast(result.ok ? 'Uninstalled' : 'Could not uninstall', result.ok ? `${game.title} was removed.` : result.error, {
          kind: result.ok ? 'ok' : 'error'
        });
        BN.ui.closeModal();
      });

      manage.append(verify, options, remove);
    }

    if (focus === 'editions') {
      setTimeout(() => body.querySelector('#editions-head')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 260);
    }

    return sheet;
  }

  /* --------------------------------------------------------------------- */
  /* Checkout / acquire                                                     */

  async function checkout(game, edition) {
    const isPre = game.status !== 'released';

    if (edition.usd > 0) {
      const proceed = await BN.ui.confirm({
        title: `${isPre ? 'Pre-order' : 'Purchase'} ${game.title}`,
        message:
          `${edition.name} - ${money(edition.usd)}. Payment is handled by the BlackNight store service, which is not connected in this build. ` +
          `Continuing adds the title to your library so you can try the install and download flow.`,
        confirmLabel: isPre ? 'Pre-order' : 'Add to library'
      });
      if (!proceed) return;
    }

    await BN.state.acquire(game.id);
    BN.sound?.play('success');
    BN.ui.toast(
      isPre ? 'Pre-order placed' : 'Added to your library',
      isPre ? `${game.title} unlocks on ${date(game.releaseDate)}.` : `${game.title} is ready to install.`,
      { kind: 'ok' }
    );

    BN.ui.closeModal();
    if (!isPre) {
      const result = await BN.state.install(game.id);
      if (result.ok) BN.app.go('downloads');
    }
  }

  function launchOptions(game) {
    const body = el('div');
    body.innerHTML = `
      <div class="field">
        <label class="field-label" for="lo-args">Launch arguments</label>
        <div class="input-wrap"><input class="input" id="lo-args" placeholder="-dx12 -windowed" value="${esc(game.launchArgs || '')}"></div>
        <span class="field-hint">Passed to the game executable on launch.</span>
      </div>
      <div class="field" style="margin-top:18px">
        <label class="field-label">Executable</label>
        <div class="path-box"><span id="lo-exe">${esc(game.executable || `${game.installPath || ''}\\${game.id}.exe`)}</span></div>
        <span class="field-hint">Point this at the game build once it is available.</span>
      </div>`;

    let exe = game.executable || null;
    BN.ui.modal({
      title: `${game.title} - launch options`,
      content: body,
      footer: [
        {
          label: 'Browse',
          class: 'btn-ghost',
          onClick: async () => {
            const picked = await BN.api.app.chooseExecutable();
            if (picked) {
              exe = picked;
              body.querySelector('#lo-exe').textContent = picked;
            }
          }
        },
        {
          label: 'Save',
          class: 'btn-accent',
          onClick: async ({ close }) => {
            await BN.api.library.setLaunchOptions(game.id, { launchArgs: body.querySelector('#lo-args').value, executable: exe });
            await BN.state.refreshLibrary();
            BN.ui.toast('Launch options saved', '', { kind: 'ok', ms: 2600 });
            close();
          }
        }
      ]
    });
  }

  BN.components = {
    primaryAction, runAction, actionButton, statusLine, statusBadge, priceTag,
    gameCard, newsCard, openDetail, STATUS_LABEL
  };
})();
