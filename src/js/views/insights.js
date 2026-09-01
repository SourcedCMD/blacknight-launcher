/* =========================================================================
   Three small things built entirely from data the launcher already has.

   The backlog: what you installed and never started. Every launcher makes it
   easy to buy and hard to notice you have not played. This is the other
   direction, and it is honest rather than nagging - no streaks, no guilt, just
   a list sorted by how long something has been sitting there.

   The art timeline: the key-art generator is deterministic and maturity is a
   pure function of playtime, so what a title will look like at fifty hours is
   already computable. Showing that is free.

   Session goals: an hour you set for yourself, drawn against the ghost bar
   that already exists. Local, no account, and it stops mattering the moment
   you close the game.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, duration } = BN.util;

  /* --- The backlog ------------------------------------------------------- */

  /**
   * Installed, and barely or never played.
   *
   * Ten minutes is the threshold for "started": below that is usually a launch
   * to check it runs, which is not the same as having played it.
   */
  function backlog() {
    const STARTED = 600;

    return BN.state.data.library
      .filter((game) => game.installed && (game.playtimeSeconds || 0) < STARTED)
      .map((game) => ({
        ...game,
        // Days since it was installed, or since it was last opened.
        waitingDays: Math.floor((Date.now() - (game.lastPlayed || game.installedAt || Date.now())) / 86400000),
        touched: (game.playtimeSeconds || 0) > 0
      }))
      .sort((a, b) => b.waitingDays - a.waitingDays);
  }

  function backlogRow(game) {
    const row = el('button', { class: 'backlog-row' });
    row.innerHTML = `
      <span class="backlog-art">${BN.art.thumb(game)}</span>
      <span class="backlog-body">
        <span class="backlog-title">${esc(game.title)}</span>
        <span class="backlog-meta">${
          game.touched
            ? `Opened once, ${esc(duration(game.playtimeSeconds))}`
            : 'Never started'
        }${game.waitingDays > 0 ? ` &middot; waiting ${game.waitingDays} day${game.waitingDays === 1 ? '' : 's'}` : ''}</span>
      </span>`;

    BN.util.coverSvg(row.querySelector('.backlog-art'));
    row.addEventListener('click', () => {
      BN.ui.closeModal();
      BN.components.openDetail(game.id);
    });
    return row;
  }

  function openBacklog() {
    const games = backlog();
    const body = el('div');

    if (!games.length) {
      body.innerHTML = `<p class="dim" style="line-height:1.7">
        Nothing is waiting. Everything you have installed, you have played.</p>`;
    } else {
      const oldest = games[0];
      body.append(
        el('p', { class: 'dim', style: { lineHeight: '1.6', marginTop: '0' } },
          `${games.length} title${games.length === 1 ? '' : 's'} installed and not really started.` +
          (oldest.waitingDays > 30 ? ` ${oldest.title} has been waiting ${oldest.waitingDays} days.` : ''))
      );

      const list = el('div', { class: 'col', style: { gap: '8px' } });
      for (const game of games) list.append(backlogRow(game));
      body.append(list);
    }

    BN.ui.modal({
      title: 'Your backlog',
      wide: true,
      content: body,
      footer: [{ label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  /* --- The art timeline -------------------------------------------------- */

  /**
   * What a title's art looks like now, and what it grows into.
   *
   * Rendered from the same generator the library uses, at fixed maturities, so
   * this is a preview rather than an illustration of one.
   */
  function artTimeline(game) {
    const now = BN.art.maturity(game);
    const stops = [
      { hours: 0, label: 'New' },
      { hours: 1, label: '1 hour' },
      { hours: 10, label: '10 hours' },
      { hours: 50, label: '50 hours' }
    ];

    const wrap = el('div', { class: 'timeline' });
    for (const stop of stops) {
      const maturity = BN.art.maturity({ playtimeSeconds: stop.hours * 3600 });
      const cell = el('figure', { class: 'timeline-cell' });
      // The stop closest to where this title actually is gets marked, so the
      // row says "you are here" rather than being an abstract scale.
      const here = Math.abs(maturity - now) < 0.12;
      if (here) cell.classList.add('is-here');

      cell.innerHTML = `
        <span class="timeline-art">${BN.art.keyArt({
          seed: game.art?.seed ?? BN.util.hashString(game.id),
          hue: game.art?.hue ?? 210,
          motif: game.art?.motif,
          w: 300, h: 200, detail: 0.5 + maturity * 0.45, maturity
        })}</span>
        <figcaption>${esc(stop.label)}${here ? ' &middot; you are here' : ''}</figcaption>`;

      BN.util.coverSvg(cell.querySelector('.timeline-art'));
      wrap.append(cell);
    }
    return wrap;
  }

  function openArtTimeline(gameId) {
    const game = BN.state.game(gameId);
    if (!game) return;

    const body = el('div');
    body.append(
      el('p', { class: 'dim', style: { lineHeight: '1.6', marginTop: '0' } },
        'Art grows with playtime. This is the same generator the library uses, run at four points along the way.'),
      artTimeline(game)
    );

    BN.ui.modal({
      title: `${game.title} — how the art grows`,
      wide: true,
      content: body,
      footer: [{ label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  /* --- Session goals ----------------------------------------------------- */

  const GOAL_KEY = 'sessionGoals';

  const goals = () => BN.state.data.settings[GOAL_KEY] || {};

  /** Minutes set for a title, or null. */
  const goalFor = (gameId) => goals()[gameId] || null;

  async function setGoal(gameId, minutes) {
    const next = { ...goals() };
    if (minutes) next[gameId] = minutes;
    else delete next[gameId];
    await BN.state.setSettings({ [GOAL_KEY]: next });
    BN.session?.tick();
  }

  /**
   * Asks how long you meant to play.
   *
   * Offered, never imposed: there is no default and no reminder to set one.
   * The point is that somebody who wants a stopping point can have one, not
   * that everybody should.
   */
  function askGoal(gameId) {
    const game = BN.state.game(gameId);
    const current = goalFor(gameId);

    const body = el('div', { class: 'col', style: { gap: '12px' } });
    body.innerHTML = `<p class="dim" style="margin:0;line-height:1.6">
      A line on the session bar for ${esc(game?.title || 'this title')}. It marks the point, and does nothing else —
      no alarm, no interruption, and it does not stop you playing.</p>`;

    const choices = el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } });
    for (const minutes of [30, 45, 60, 90, 120]) {
      const button = el('button', { class: `btn btn-sm ${current === minutes ? 'btn-accent' : 'btn-ghost'}` },
        `${minutes} min`);
      button.addEventListener('click', async () => {
        await setGoal(gameId, minutes);
        BN.ui.closeModal();
        BN.ui.toast('Goal set', `${minutes} minutes for ${game?.title || 'this title'}.`, { kind: 'ok' });
      });
      choices.append(button);
    }
    body.append(choices);

    BN.ui.modal({
      title: 'Set a session goal',
      content: body,
      footer: [
        ...(current
          ? [{
              label: 'Clear',
              class: 'btn-ghost',
              onClick: async ({ close }) => {
                await setGoal(gameId, null);
                close();
              }
            }]
          : []),
        { label: BN.t('action.close'), class: 'btn-ghost', onClick: ({ close }) => close() }
      ]
    });
  }

  BN.views = BN.views || {};
  BN.views.insights = { backlog, openBacklog, artTimeline, openArtTimeline, goalFor, setGoal, askGoal };
})();
