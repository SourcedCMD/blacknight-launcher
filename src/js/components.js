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

  /** Release instant for a pre-order, or null once a title is simply out. */
  function unlockAt(game) {
    if (game.status !== 'preorder' || !game.releaseDate) return null;
    const at = Date.parse(`${game.releaseDate}T00:00:00`);
    return Number.isFinite(at) ? at : null;
  }

  const isLocked = (game) => {
    const at = unlockAt(game);
    return at !== null && Date.now() < at;
  };

  /** The single source of truth for what a title's main button should do. */
  function primaryAction(game) {
    if (game.running) return { key: 'running', label: 'Running', icon: 'zap', variant: 'btn-ghost', disabled: true };

    // A pre-loaded pre-order sits installed but locked until release night.
    if (game.installed && isLocked(game)) {
      return { key: 'locked', label: 'Unlocks soon', icon: 'clock', variant: 'btn-ghost', disabled: true };
    }
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
    if (game.status === 'preorder') {
      // Owning it early is the whole point: stage the build now so release
      // night is not spent watching a progress bar.
      return game.owned
        ? { key: 'install', label: 'Pre-load', icon: 'download', variant: 'btn-chrome' }
        : { key: 'preorder', label: 'Pre-order', icon: 'sparkles', variant: 'btn-chrome' };
    }
    return { key: 'wishlist', label: game.favorite ? 'Wishlisted' : 'Wishlist', icon: 'heart', variant: 'btn-ghost' };
  }

  /** Runs whatever primaryAction() decided, with the right feedback. */
  async function runAction(game, node) {
    const action = primaryAction(game);
    switch (action.key) {
      case 'play': {
        if (node) BN.fx.burst(node);
        const ritual = launchRitual(game);
        const result = await BN.state.launch(game.id);
        if (!result.ok) ritual.abort();
        if (result.ok) {
          BN.ui.toast('Launching ' + game.title, result.message || 'Have a good night out there.', { kind: 'ok', ms: 6000 });
          // Their own history, shown once the launch has actually taken.
          setTimeout(() => BN.views.journal?.noteBeforeLaunch(game.id), 2600);
          if (BN.state.data.settings.exitOnGameLaunch) setTimeout(() => BN.api.app.quit(), 1200);
        } else {
          BN.ui.toast('Could not launch', result.error, { kind: 'error' });
        }
        break;
      }
      case 'install': {
        const result = await BN.state.install(game.id);
        if (result.ok) {
          BN.ui.toast(isLocked(game) ? 'Pre-load started' : 'Download started', `${game.title} - ${bytes(game.sizeBytes)}`, {
            kind: 'ok',
            action: { label: 'View queue', onClick: () => BN.app.go('downloads') }
          });
        } else if (result.reason === 'no-space') {
          showSpaceProblem(game, result);
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
      case 'locked': {
        const at = unlockAt(game);
        BN.ui.toast('Not yet', `${game.title} unlocks ${new Date(at).toLocaleString()}.`, { kind: 'info', ms: 5000 });
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
    if (game.installed && isLocked(game)) return `Pre-loaded - unlocks ${date(game.releaseDate)}`;
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
            <div id="fit-verdict" class="fit fit-unknown">
              <span class="fit-dot"></span><span class="fit-text">Checking this machine...</span>
            </div>
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
              Number.isFinite(game.playersOnline) && game.playersOnline > 0
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
        const choice = await confirmUninstall(game);
        if (!choice) return;
        const result = await BN.state.uninstall(game.id, choice);
        BN.ui.toast(
          result.ok ? 'Uninstalled' : 'Could not uninstall',
          result.ok
            ? result.savesKept
              ? `${game.title} was removed. Save data was kept.`
              : `${game.title} was removed.`
            : result.error,
          { kind: result.ok ? 'ok' : 'error' }
        );
        BN.ui.closeModal();
      });

      const channel = el('button', { class: 'btn btn-ghost btn-sm btn-block' });
      channel.innerHTML = `${icon('layers')} Build channel`;
      channel.addEventListener('click', () => BN.views.achievements.chooseChannel(game.id));

      const revert = el('button', { class: 'btn btn-ghost btn-sm btn-block' });
      revert.innerHTML = `${icon('refresh')} Roll back an update`;
      revert.addEventListener('click', () => BN.views.achievements.offerRollback(game.id));

      manage.append(verify, options, channel, revert, remove);
    }

    paintFitVerdict(body, game.id);

    if (focus === 'editions') {
      setTimeout(() => body.querySelector('#editions-head')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 260);
    }

    return sheet;
  }

  /**
   * The lights going down.
   *
   * Starting a game was a spinner and a toast. This gives it a beat: the key
   * art blooms up over the shell, the title's own sting plays, and the whole
   * launcher dims out of the way. It resolves on its own, and aborts cleanly
   * if the launch turns out to have failed.
   */
  function launchRitual(game) {
    if (BN.state.data.settings.launchRitual === false || BN.state.data.settings.reduceMotion) {
      BN.sound?.signature(game);
      return { abort() {} };
    }

    const layer = el('div', { class: 'ritual' });
    layer.innerHTML = `
      <div class="ritual-art">${BN.art.hero(game)}</div>
      <div class="ritual-body">
        <div class="ritual-eyebrow">Starting</div>
        <div class="ritual-title chrome-text">${esc(game.title)}</div>
        <div class="ritual-line"><i></i></div>
      </div>`;
    BN.util.coverSvg(layer.querySelector('.ritual-art'));
    document.body.appendChild(layer);

    // The title's signature, not the generic launch cue.
    BN.sound?.signature(game);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      layer.classList.add('out');
      layer.addEventListener('animationend', () => layer.remove(), { once: true });
      setTimeout(() => layer.remove(), 900);
    };

    const timer = setTimeout(finish, 2100);
    return {
      abort() {
        clearTimeout(timer);
        finish();
      }
    };
  }

  /**
   * Uninstall, asking the one question that actually matters.
   *
   * The main process has always supported keeping saves; nothing ever passed
   * the flag, so the choice was made silently on the player's behalf.
   */
  async function confirmUninstall(game) {
    const body = el('div');
    body.innerHTML = `
      <p style="color:var(--text-dim);line-height:1.7">
        This removes <strong>${esc(game.title)}</strong> and frees ${esc(bytes(game.sizeBytes))}.
        Your account still owns it, so you can reinstall at any time.
      </p>`;

    const keep = el('label', { class: 'ob-toggle', style: { marginTop: '10px' } });
    keep.innerHTML = `
      <span class="grow">
        <span class="ob-toggle-label">${esc(BN.t('saves.keepOnUninstall'))}</span>
        <span class="ob-toggle-desc">${esc(BN.t('saves.keepHint'))}</span>
      </span>
      <input type="checkbox" checked>`;
    body.append(keep);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      BN.ui.modal({
        title: `Uninstall ${game.title}?`,
        content: body,
        onClose: () => finish(null),
        footer: [
          { label: BN.t('action.cancel'), class: 'btn-ghost', onClick: ({ close }) => { finish(null); close(); } },
          {
            label: BN.t('action.uninstall'),
            class: 'btn-danger',
            onClick: ({ close }) => {
              finish({ keepSaves: keep.querySelector('input').checked });
              close();
            }
          }
        ]
      });
    });
  }

  /**
   * A game that exited badly gets a route to the fix rather than silence.
   */
  function reportCrash(game, result) {
    if (!result?.crashed) return;
    const exit = result.exit || {};
    BN.log?.warn('launch', `${game.title} exited abnormally`, exit);

    BN.ui.toast(
      BN.t('error.crashed', { title: game.title }),
      BN.t('error.crashedBody', { code: exit.code ?? exit.signal ?? exit.error ?? 'unknown', seconds: result.seconds ?? 0 }),
      {
        kind: 'error',
        ms: 12000,
        action: {
          label: BN.t('action.verify'),
          onClick: async () => {
            const r = await BN.state.verify(game.id);
            BN.ui.toast(r.ok ? 'Verification complete' : 'Verification failed', r.message || r.error, {
              kind: r.ok ? 'ok' : 'error',
              ms: 8000
            });
          }
        }
      }
    );
  }

  /**
   * "Not enough space" is a dead end. Turn it into a decision: say exactly how
   * short the drive is, offer another drive, and list what could go - the
   * never-played and long-idle titles first.
   */
  function showSpaceProblem(game, result) {
    const short = Math.max(0, result.needBytes - result.freeBytes);
    const candidates = (result.reclaimable || []).filter((r) => r.gameId !== game.id);

    const body = el('div');
    body.innerHTML = `
      <p style="color:var(--text-dim);line-height:1.7">
        <strong>${esc(game.title)}</strong> needs ${esc(bytes(result.needBytes))}, but
        <span class="mono">${esc(result.dir)}</span> has only ${esc(bytes(result.freeBytes))} free
        &mdash; ${esc(bytes(short))} short.
      </p>`;

    if (candidates.length) {
      const list = el('div', { class: 'col', style: { gap: '8px', marginTop: '16px' } });
      list.append(el('div', { class: 'eyebrow', text: 'Installed and idle' }));
      let freed = 0;

      for (const item of candidates.slice(0, 6)) {
        const row = el('label', { class: 'reclaim-row' });
        const idle =
          item.playtimeSeconds === 0
            ? 'never played'
            : item.idleDays === null
              ? 'not played recently'
              : `idle ${item.idleDays} days`;
        row.innerHTML = `
          <input type="checkbox" data-game="${esc(item.gameId)}" data-size="${item.sizeBytes}">
          <span class="grow">
            <span class="reclaim-title">${esc(item.title)}</span>
            <span class="reclaim-meta">${esc(idle)}</span>
          </span>
          <span class="mono">${esc(bytes(item.sizeBytes))}</span>`;
        list.append(row);
      }

      const tally = el('div', { class: 'reclaim-tally', text: 'Select titles to free space' });
      list.append(tally);
      body.append(list);

      list.addEventListener('change', () => {
        freed = [...list.querySelectorAll('input:checked')].reduce((sum, i) => sum + Number(i.dataset.size), 0);
        tally.textContent =
          freed >= short
            ? `Frees ${bytes(freed)} — enough to install ${game.title}`
            : `Frees ${bytes(freed)} — still ${bytes(short - freed)} short`;
        tally.classList.toggle('enough', freed >= short);
      });
    }

    BN.ui.modal({
      title: 'Not enough space',
      content: body,
      footer: [
        { label: 'Close', class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Change drive',
          class: 'btn-ghost',
          onClick: async ({ close }) => {
            const dir = await BN.api.app.chooseDirectory(result.dir);
            if (!dir) return;
            await BN.state.setSettings({ installDir: dir });
            close();
            BN.ui.toast('Install folder changed', dir, { kind: 'ok' });
          }
        },
        {
          label: 'Uninstall selected',
          class: 'btn-accent',
          onClick: async ({ close, body: root }) => {
            const picked = [...root.querySelectorAll('input:checked')].map((i) => i.dataset.game);
            if (!picked.length) return;
            close();
            for (const id of picked) await BN.state.uninstall(id);
            BN.ui.toast('Space reclaimed', `${picked.length} title${picked.length > 1 ? 's' : ''} removed.`, { kind: 'ok' });
          }
        }
      ]
    });
  }

  /* --------------------------------------------------------------------- */
  /* "Will it run?"                                                         */

  // Colour alone cannot carry the verdict: red and green are the same shape to
  // a colour-blind player, so each state gets a distinct glyph too.
  const FIT_COPY = {
    recommended: ['fit-good', 'Your PC clears the recommended spec', 'checkCircle'],
    minimum: ['fit-ok', 'Your PC clears the minimum spec', 'check'],
    below: ['fit-bad', 'Your PC is below the minimum spec', 'alert'],
    unknown: ['fit-unknown', 'Not enough is known about this machine to say', 'info']
  };

  /**
   * Answers the question the requirements table never does. The comparison
   * runs in the main process, where the real hardware is; anything it could
   * not measure is reported as unknown rather than guessed at.
   */
  async function paintFitVerdict(container, gameId) {
    const node = container.querySelector('#fit-verdict');
    if (!node) return;

    let result;
    try {
      result = await BN.api.hardware.check(gameId);
    } catch {
      result = { level: 'unknown' };
    }
    // The sheet is painted before the modal attaches it, so isConnected is not
    // a useful guard here; bail only if the node was replaced outright.
    if (!node.parentNode) return;

    const [cls, text, glyph] = FIT_COPY[result.level] || FIT_COPY.unknown;
    node.className = `fit ${cls}`;
    // role=status so the verdict is announced when it resolves, since it
    // arrives a moment after the sheet opens.
    node.setAttribute('role', 'status');
    node.innerHTML = `<span class="fit-glyph">${icon(glyph)}</span><span class="fit-text">${esc(text)}</span>`;

    // Name what actually falls short, so "below minimum" is actionable.
    const failing = (result.minimum?.rows || []).filter((r) => r.status === 'below');
    if (failing.length) {
      node.innerHTML += `<span class="fit-why">${esc(failing.map((r) => r.label).join(', '))}</span>`;
    }

    const detail = el('button', { class: 'fit-more', type: 'button' }, 'Compare');
    detail.addEventListener('click', () => showFitDetail(gameId, result));
    node.append(detail);
  }

  function showFitDetail(gameId, result) {
    const game = BN.state.game(gameId);
    const table = (label, tier) =>
      !tier
        ? ''
        : `<h3 class="display" style="margin:18px 0 10px;font-size:.82rem">${label}</h3>
           <table class="spec-table fit-table"><tbody>
             ${tier.rows
               .map(
                 (r) => `<tr class="fit-row-${r.status}">
                   <th>${esc(r.label)}</th>
                   <td>${esc(r.need)}</td>
                   <td>${esc(r.have)}</td>
                 </tr>`
               )
               .join('')}
           </tbody></table>`;

    BN.ui.modal({
      title: `Will ${game.title} run?`,
      wide: true,
      content:
        `<p class="dim" style="line-height:1.7;margin-bottom:4px">Required on the left, this machine on the right. ` +
        `Processor and graphics are matched by family and generation, so treat them as a guide rather than a benchmark.</p>` +
        table('Minimum', result.minimum) +
        table('Recommended', result.recommended),
      footer: [{ label: 'Close', class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  /* --------------------------------------------------------------------- */
  /* Checkout / acquire                                                     */

  async function checkout(game, edition) {
    const isPre = game.status !== 'released';

    // Nothing that costs money completes while the store is offline. Saying
    // so plainly beats granting the title and calling it a purchase.
    if (edition.usd > 0 && !BN.config.storeLive) {
      BN.sound?.play('error');
      BN.ui.modal({
        title: 'The store is not open yet',
        content:
          `<p style="color:var(--text-dim);line-height:1.7">` +
          `<strong>${esc(game.title)} - ${esc(edition.name)}</strong> is listed at ${esc(money(edition.usd))}, but the ` +
          `BlackNight store is not taking ${isPre ? 'pre-orders' : 'orders'} yet. Nothing has been charged and nothing ` +
          `has been added to your library.</p>` +
          `<p style="color:var(--text-dim);line-height:1.7;margin-top:14px">` +
          `Add it to your wishlist and the launcher will tell you when it goes on sale.</p>`,
        footer: [
          { label: 'Close', class: 'btn-ghost', onClick: ({ close }) => close() },
          {
            label: game.favorite ? 'Wishlisted' : 'Add to wishlist',
            class: 'btn-accent',
            onClick: async ({ close }) => {
              if (!game.favorite) await BN.state.toggleFavorite(game.id);
              close();
              BN.ui.toast('Added to wishlist', `We will let you know when ${game.title} is available.`, { kind: 'ok' });
            }
          }
        ]
      });
      return;
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
    // Profiles are named argument sets, so switching between a modded run and
    // a clean one does not mean retyping a flag string from memory.
    const profiles = (game.profiles || []).map((p) => ({ ...p }));
    let active = game.activeProfile || null;

    const body = el('div');
    body.innerHTML = `
      <div class="field">
        <label class="field-label">Profiles</label>
        <div id="lo-profiles" class="col" style="gap:8px"></div>
        <button type="button" class="btn btn-sm btn-ghost" id="lo-add" style="margin-top:8px">Add a profile</button>
        <span class="field-hint">Pick one to use it the next time this title launches.</span>
      </div>
      <div class="field" style="margin-top:18px">
        <label class="field-label" for="lo-args">Default arguments</label>
        <div class="input-wrap"><input class="input" id="lo-args" placeholder="-dx12 -windowed" value="${esc(game.launchArgs || '')}"></div>
        <span class="field-hint">Used when no profile is selected.</span>
      </div>
      <div class="field" style="margin-top:18px">
        <label class="field-label">Executable</label>
        <div class="path-box"><span id="lo-exe">${esc(game.executable || `${game.installPath || ''}\\${game.id}.exe`)}</span></div>
        <span class="field-hint">Point this at the game build once it is available.</span>
      </div>`;

    const host = body.querySelector('#lo-profiles');
    const paintProfiles = () => {
      host.innerHTML = '';
      if (!profiles.length) {
        host.append(el('div', { class: 'field-hint', text: 'No profiles yet. The default arguments are used.' }));
      }
      profiles.forEach((profile, index) => {
        const row = el('div', { class: 'profile-row' + (active === profile.name ? ' active' : '') });
        row.innerHTML = `
          <input type="radio" name="lo-active" ${active === profile.name ? 'checked' : ''} aria-label="Use ${esc(profile.name)}">
          <input class="input input-sm profile-name" value="${esc(profile.name)}" placeholder="Name" maxlength="40">
          <input class="input input-sm mono profile-args" value="${esc(profile.args || '')}" placeholder="-dx12" maxlength="500">
          <button type="button" class="btn btn-sm btn-ghost btn-icon profile-del" aria-label="Remove">${icon('x')}</button>`;

        row.querySelector('input[type=radio]').addEventListener('change', () => {
          active = profile.name;
          paintProfiles();
        });
        row.querySelector('.profile-name').addEventListener('input', (e) => {
          if (active === profile.name) active = e.target.value;
          profile.name = e.target.value;
        });
        row.querySelector('.profile-args').addEventListener('input', (e) => { profile.args = e.target.value; });
        row.querySelector('.profile-del').addEventListener('click', () => {
          if (active === profile.name) active = null;
          profiles.splice(index, 1);
          paintProfiles();
        });
        host.append(row);
      });
    };
    paintProfiles();

    body.querySelector('#lo-add').addEventListener('click', () => {
      profiles.push({ name: `Profile ${profiles.length + 1}`, args: '' });
      paintProfiles();
    });

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
            await BN.api.library.setLaunchOptions(game.id, {
              launchArgs: body.querySelector('#lo-args').value,
              executable: exe,
              profiles: profiles.filter((p) => p.name.trim()),
              activeProfile: active
            });
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
    gameCard, newsCard, openDetail, confirmUninstall, reportCrash, launchRitual, STATUS_LABEL
  };
})();
