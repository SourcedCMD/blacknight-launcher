/* =========================================================================
   Achievements, channels, rollback and install recovery.

   All four are things the launcher can now do that it had no surface for.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, date, relative } = BN.util;
  const icon = BN.icon;

  /* --------------------------------------------------------------------- */
  /* Achievements                                                           */

  /**
   * A badge drawn from the achievement's own id.
   *
   * The art engine is seeded, so every achievement gets a distinct mark for
   * free and nothing has to ship as an image.
   */
  function badge(achievement, size = 56) {
    const seed = BN.util.hashString(achievement.id);
    return BN.art.keyArt({
      seed,
      hue: seed % 360,
      motif: BN.art.MOTIFS[seed % BN.art.MOTIFS.length],
      w: size,
      h: size,
      detail: 0.4
    });
  }

  async function open() {
    const list = await BN.api.achievements.list();
    const earned = list.filter((a) => a.earned).length;

    const body = el('div');
    body.innerHTML = `
      <p class="dim" style="line-height:1.7;margin-bottom:18px">
        Earned from how you use the launcher, recorded on this machine.
        <b>${earned}</b> of ${list.length}.
      </p>`;

    const grid = el('div', { class: 'ach-grid' });
    for (const item of list) {
      const card = el('div', { class: `ach${item.earned ? ' earned' : ''}` });
      card.innerHTML = `
        <div class="ach-badge">${badge(item)}</div>
        <div class="grow">
          <div class="ach-name">${esc(item.name)}</div>
          <div class="ach-desc">${esc(item.description)}</div>
          ${item.earned && item.at ? `<div class="ach-when">${esc(relative(item.at))}</div>` : ''}
        </div>
        <div class="ach-state">${item.earned ? icon('checkCircle') : icon('lock')}</div>`;
      BN.util.coverSvg(card.querySelector('.ach-badge'));
      grid.append(card);
    }
    body.append(grid);

    BN.ui.modal({
      title: 'Achievements',
      wide: true,
      content: body,
      footer: [{ label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  /** Called when the main process reports something newly earned. */
  function celebrate(achievement) {
    BN.ui.toast(`Achievement: ${achievement.name}`, achievement.description, {
      kind: 'ok',
      ms: 8000,
      action: { label: 'View all', onClick: open }
    });
    BN.ui.announce(`Achievement earned: ${achievement.name}. ${achievement.description}`);
  }

  /* --------------------------------------------------------------------- */
  /* Channels                                                               */

  /**
   * Lets a player move a title onto a playtest build.
   *
   * BlackNight+ sells guaranteed playtest entry, so this is the surface for a
   * perk that is already being charged for. Entitlement is enforced in the
   * main process; this only reports what it decided.
   */
  async function chooseChannel(gameId) {
    const [channels, current] = await Promise.all([
      BN.api.library.channels(gameId),
      BN.api.library.channel(gameId)
    ]);
    const game = BN.state.game(gameId);
    const tier = BN.state.data.user?.tier;

    const body = el('div');
    body.innerHTML = `<p class="dim" style="line-height:1.7">
      Which build of <b>${esc(game.title)}</b> this machine should follow.</p>`;

    const list = el('div', { class: 'col', style: { gap: '8px', marginTop: '16px' } });
    let chosen = current?.id || 'stable';

    for (const channel of channels) {
      const locked = channel.requiresPlus && tier !== 'plus';
      const row = el('label', { class: `channel-row${locked ? ' locked' : ''}` });
      row.innerHTML = `
        <input type="radio" name="channel" value="${esc(channel.id)}"
               ${channel.id === chosen ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span class="grow">
          <span class="channel-name">${esc(channel.label)}
            ${channel.requiresPlus ? `<span class="badge badge-accent">${icon('crown')} Plus</span>` : ''}
          </span>
          <span class="channel-meta">
            <span class="mono">${esc(channel.version)}</span>
            ${channel.notes ? ` · ${esc(channel.notes)}` : ''}
            ${locked ? ' · requires BlackNight+' : ''}
          </span>
        </span>`;
      row.querySelector('input').addEventListener('change', () => { chosen = channel.id; });
      list.append(row);
    }

    if (channels.length === 1) {
      list.append(
        el('div', { class: 'field-hint', text: 'This title has no other channels published yet.' })
      );
    }
    body.append(list);

    BN.ui.modal({
      title: 'Build channel',
      content: body,
      footer: [
        { label: BN.t('action.cancel'), class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Use this channel',
          class: 'btn-accent',
          onClick: async ({ close }) => {
            const result = await BN.api.library.setChannel(gameId, chosen);
            if (!result.ok) {
              BN.ui.toast('Could not switch channel', result.error, { kind: result.requiresPlus ? 'warn' : 'error' });
              return;
            }
            close();
            await BN.state.refreshLibrary();
            if (result.needsSwap) {
              BN.ui.toast(
                `Now following ${result.channel.label}`,
                'The installed build is from another channel. Update to switch over.',
                { kind: 'ok', ms: 7000, action: { label: 'Update now', onClick: () => BN.app.checkGameUpdates() } }
              );
            } else if (result.changed) {
              BN.ui.toast(`Now following ${result.channel.label}`, '', { kind: 'ok' });
            }
          }
        }
      ]
    });
  }

  /* --------------------------------------------------------------------- */
  /* Rollback                                                               */

  /** Offers the previous build back when a patch has gone wrong. */
  async function offerRollback(gameId) {
    const available = await BN.api.library.rollbackAvailable(gameId);
    const game = BN.state.game(gameId);

    if (!available) {
      BN.ui.toast('Nothing to roll back to', `No previous build of ${game.title} was kept.`, { kind: 'info' });
      return;
    }

    const yes = await BN.ui.confirm({
      title: `Roll back ${game.title}?`,
      message:
        `This puts version ${available.version} back, replacing what is installed now. ` +
        'The current build is kept, so this can be undone.',
      confirmLabel: 'Roll back'
    });
    if (!yes) return;

    const result = await BN.api.library.rollback(gameId);
    await BN.state.refreshLibrary();
    BN.ui.toast(
      result.ok ? `Rolled back to ${result.version}` : 'Could not roll back',
      result.ok ? (result.canRedo ? 'The newer build was kept, so this is reversible.' : '') : result.error,
      { kind: result.ok ? 'ok' : 'error' }
    );
  }

  /* --------------------------------------------------------------------- */
  /* Install recovery                                                       */

  /**
   * Offers to adopt builds found on disk with no library entry.
   *
   * Runs quietly at startup: if there is nothing to recover, nobody hears
   * about it.
   */
  async function offerRecovery() {
    let found = [];
    try {
      found = await BN.api.library.scan();
    } catch {
      return;
    }
    if (!found.length) return;

    const total = found.reduce((sum, f) => sum + f.sizeBytes, 0);
    BN.ui.toast(
      found.length === 1 ? 'Found an install on disk' : `Found ${found.length} installs on disk`,
      `${found.map((f) => f.title).join(', ')} — ${bytes(total)} already downloaded.`,
      {
        kind: 'info',
        ms: 12000,
        action: { label: 'Recover', onClick: () => reviewRecovery(found) }
      }
    );
  }

  function reviewRecovery(found) {
    const body = el('div');
    body.innerHTML = `<p class="dim" style="line-height:1.7">
      These builds are on disk but not in your library. Adding them back avoids
      downloading what you already have.</p>`;

    const list = el('div', { class: 'col', style: { gap: '8px', marginTop: '14px' } });
    for (const item of found) {
      const row = el('label', { class: 'reclaim-row' });
      row.innerHTML = `
        <input type="checkbox" checked data-game="${esc(item.gameId)}">
        <span class="grow">
          <span class="reclaim-title">${esc(item.title)}</span>
          <span class="reclaim-meta">${esc(item.version || 'unknown version')} · ${esc(item.path)}
            ${item.hasChecksum ? '' : ' · no checksum, cannot be verified'}</span>
        </span>
        <span class="mono">${esc(bytes(item.sizeBytes))}</span>`;
      list.append(row);
    }
    body.append(list);

    BN.ui.modal({
      title: 'Recover installs',
      wide: true,
      content: body,
      footer: [
        { label: 'Ignore', class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Add to library',
          class: 'btn-accent',
          onClick: async ({ close, body: root }) => {
            const picked = [...root.querySelectorAll('input:checked')].map((i) => i.dataset.game);
            close();
            let added = 0;
            const failed = [];
            for (const id of picked) {
              const result = await BN.api.library.adopt(id);
              if (result.ok) added++;
              else failed.push(id);
            }
            await BN.state.refreshLibrary();
            BN.ui.toast(
              added ? `Recovered ${added} install${added === 1 ? '' : 's'}` : 'Nothing was recovered',
              failed.length ? `${failed.join(', ')} failed verification.` : '',
              { kind: added ? 'ok' : 'warn' }
            );
          }
        }
      ]
    });
  }

  BN.views = BN.views || {};
  BN.views.achievements = { open, celebrate, badge, chooseChannel, offerRollback, offerRecovery };
})();
