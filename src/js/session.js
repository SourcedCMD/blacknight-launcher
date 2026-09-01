/* =========================================================================
   The running session: a ghost of your usual one, and a way to stop.

   Two features that share a heartbeat.

   The ghost is a quiet bar in the sidebar showing how the current run
   compares with this player's own median for that title. Not a target, not a
   streak - the comparison is with yourself, and the launcher already has the
   history to make it without asking anyone anything.

   Wind-down is the other half. A launcher that only ever encourages you to
   keep going is being dishonest about what it wants. This one can be told an
   hour after which it will say, once, that it is late - and then leave you
   alone. Off by default, because a nag nobody asked for is worse than
   nothing.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { duration, $ } = BN.util;

  const TICK_MS = 30000;

  let timer = null;
  let noticedAt = 0; // when wind-down last spoke, so it speaks once per session

  /** The title currently running, if any. */
  function runningGame() {
    return (BN.state.data.library || []).find((entry) => entry.running) || null;
  }

  /**
   * How this run reads against the usual one.
   *
   * Below 0.8 is "settling in", around 1 is typical, past 1.5 is a long one.
   * The wording matters more than the number here: nobody needs to be told
   * they are at 1.37x of their median.
   */
  function describe(ghost) {
    if (!ghost) return null;
    if (ghost.median === null) return { text: duration(ghost.elapsed), fill: 0, tone: 'plain' };

    const ratio = ghost.ratio;
    const fill = Math.min(1, ratio / 2); // 2x median fills the bar
    if (ghost.personalBest) return { text: `${duration(ghost.elapsed)} · longest yet`, fill: 1, tone: 'best' };
    if (ratio < 0.6) return { text: `${duration(ghost.elapsed)} · just started`, fill, tone: 'plain' };
    if (ratio < 1.2) return { text: `${duration(ghost.elapsed)} · about usual`, fill, tone: 'usual' };
    if (ratio < 1.8) return { text: `${duration(ghost.elapsed)} · a long one`, fill, tone: 'long' };
    return { text: `${duration(ghost.elapsed)} · well past usual`, fill, tone: 'long' };
  }

  function paintGhost(entry, ghost) {
    const host = $('#session-ghost');
    if (!host) return;

    const shown = describe(ghost);
    if (!entry || !shown || BN.state.data.settings.sessionGhost === false) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }

    host.classList.remove('hidden');
    host.innerHTML = `
      <div class="side-title side-label">Playing now</div>
      <div class="ghost" data-tone="${shown.tone}">
        <div class="ghost-head">
          <span class="ghost-title">${BN.util.esc(entry.title || entry.gameId)}</span>
        </div>
        <div class="ghost-track" role="img" aria-label="${BN.util.esc(shown.text)}">
          <div class="ghost-fill" style="width:${Math.round(shown.fill * 100)}%"></div>
          ${ghost.median !== null ? '<div class="ghost-median" title="Your usual session here"></div>' : ''}
        </div>
        <div class="ghost-meta side-label">${BN.util.esc(shown.text)}</div>
      </div>`;
  }

  /**
   * Says once, gently, that it is late.
   *
   * Deliberately not a modal and not repeated: it is a remark, not a gate.
   * The launcher has no business stopping anybody from playing their own game.
   */
  function maybeWindDown(entry, ghost) {
    const hour = BN.state.data.settings.windDownHour;
    if (hour === '' || hour === null || hour === undefined) return;
    if (!entry || !ghost) return;

    // Once per session.
    if (noticedAt && Date.now() - noticedAt < 6 * 3600000) return;

    const now = new Date().getHours();
    const target = Number(hour);
    // A window from the chosen hour through to 5am, so "23" still fires at 1am.
    const late = target >= 18 ? now >= target || now < 5 : now >= target && now < 5;
    if (!late) return;

    noticedAt = Date.now();
    BN.ui.toast(
      'It is getting late',
      `You have been in ${entry.title || 'this'} for ${duration(ghost.elapsed)}. No rush — just noting the hour.`,
      { kind: 'info', ms: 9000 }
    );
  }

  async function tick() {
    const entry = runningGame();
    if (!entry) {
      noticedAt = 0; // a fresh session may be noted again
      paintGhost(null, null);
      return;
    }

    let ghost = null;
    try {
      ghost = await BN.api.library.ghost(entry.gameId);
    } catch (err) {
      BN.log?.warn('session', 'Could not read the session ghost', err);
    }

    paintGhost(entry, ghost);
    maybeWindDown(entry, ghost);
  }

  function start() {
    stop();
    tick();
    timer = setInterval(tick, TICK_MS);
    // A session ending is the moment the bar should clear, not thirty seconds
    // later.
    BN.util.bus.on('library', () => tick());
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  BN.session = { start, stop, tick, describe };
})();
