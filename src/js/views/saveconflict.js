/* =========================================================================
   Resolving a save conflict.

   The server refuses a push that would overwrite work it has not seen, and
   returns both versions. That refusal was the whole point of the design, and
   until now nothing showed it to anybody - the launcher caught the failure and
   said nothing, which is worse than overwriting, because at least an overwrite
   is visible.

   This is the conversation. It states plainly what is on each side, it does
   not pick a default, and whichever way it goes the other version is still
   recoverable afterwards.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, duration } = BN.util;

  const when = (at) => {
    const date = new Date(at);
    return `${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  /**
   * One side of the conflict.
   *
   * Playtime is the number that actually decides this for most people - "the
   * one with more hours on it" is the question they are really asking.
   */
  function side({ title, subtitle, version, accent }) {
    const card = el('div', { class: `conflict-side${accent ? ' is-accent' : ''}` });
    card.innerHTML = `
      <div class="conflict-where">${esc(title)}</div>
      <div class="conflict-when">${esc(subtitle)}</div>
      <dl class="conflict-facts">
        ${version?.playtimeSeconds
          ? `<div><dt>Playtime</dt><dd>${esc(duration(version.playtimeSeconds))}</dd></div>`
          : ''}
        ${version?.sizeBytes ? `<div><dt>Size</dt><dd>${esc(bytes(version.sizeBytes))}</dd></div>` : ''}
        ${version?.machine ? `<div><dt>Machine</dt><dd>${esc(version.machine)}</dd></div>` : ''}
      </dl>`;
    return card;
  }

  /**
   * Asks which save to keep.
   *
   * Deliberately has no default and no "remember this choice". A conflict is
   * rare and consequential, and a remembered answer is how somebody loses a
   * save months later without ever being asked again.
   */
  function open(game, conflict) {
    const theirs = conflict?.theirs || null;
    const entry = BN.state.game(game.id);

    const body = el('div', { class: 'col', style: { gap: '16px' } });
    body.innerHTML = `
      <p style="margin:0;line-height:1.65">
        Another machine saved <strong>${esc(game.title)}</strong> after this one last synced.
        Both versions are kept either way — whichever you choose, the other can still be restored.
      </p>`;

    const pair = el('div', { class: 'conflict-pair' });
    pair.append(
      side({
        title: 'This machine',
        subtitle: entry?.lastPlayed ? `Played ${when(entry.lastPlayed)}` : 'Not played recently',
        version: { playtimeSeconds: entry?.playtimeSeconds || 0 },
        accent: true
      }),
      side({
        title: theirs?.machine || 'The other machine',
        subtitle: theirs?.at ? `Saved ${when(theirs.at)}` : 'Saved more recently',
        version: theirs
      })
    );
    body.append(pair);

    return new Promise((resolve) => {
      BN.ui.modal({
        title: 'Two saves, one game',
        wide: true,
        content: body,
        // No close button: this needs an answer, and dismissing it silently is
        // how the old behaviour lost people their progress.
        footer: [
          {
            label: 'Keep this machine’s',
            class: 'btn-ghost',
            onClick: async ({ close }) => {
              close();
              resolve(await keepLocal(game));
            }
          },
          {
            label: 'Take the other one',
            class: 'btn-accent',
            onClick: async ({ close }) => {
              close();
              resolve(await takeRemote(game, theirs));
            }
          }
        ]
      });
    });
  }

  /**
   * Keeps what is on this machine.
   *
   * Pulling first is what makes this safe: the local push is refused because
   * it is based on an older version, so the newer one is fetched (which
   * snapshots the local save on the way past), and then the local one is
   * pushed on top with the correct base.
   */
  async function keepLocal(game) {
    BN.ui.toast('Keeping this machine’s save', 'The other version stays recoverable.', { kind: 'info' });

    // Reading the newer version updates what this machine considers current,
    // so the next push is no longer based on something stale.
    const check = await BN.api.library.cloudCheck(game.id);
    if (check?.head) {
      const state = { ...(BN.state.data.settings.cloudSaveState || {}) };
      state[game.id] = check.head.id;
      await BN.state.setSettings({ cloudSaveState: state });
    }

    const result = await BN.api.library.cloudPush(game.id);
    BN.ui.toast(
      result?.ok ? 'Save uploaded' : 'Could not upload',
      result?.ok ? 'This machine’s version is now the current one.' : result?.error || '',
      { kind: result?.ok ? 'ok' : 'error' }
    );
    return result;
  }

  /** Takes the other machine's save, keeping a snapshot of this one first. */
  async function takeRemote(game, version) {
    BN.ui.toast('Fetching the other save', 'This machine’s version is snapshotted first.', { kind: 'info' });

    const result = await BN.api.library.cloudPull(game.id, version?.id || null);
    BN.ui.toast(
      result?.ok ? 'Save restored' : 'Could not restore',
      result?.ok
        ? `${result.files} file${result.files === 1 ? '' : 's'} written. The previous one is in your save snapshots.`
        : result?.error || '',
      { kind: result?.ok ? 'ok' : 'error', ms: 9000 }
    );
    return result;
  }

  BN.views = BN.views || {};
  BN.views.saveConflict = { open, keepLocal, takeRemote };
})();
