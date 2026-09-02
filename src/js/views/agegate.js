/* =========================================================================
   The age gate.

   The catalogue has carried an ESRB rating since it was written and the
   launcher has only just started showing it. Showing a rating without acting
   on it is arguably worse than not showing one at all, and in several markets
   a store selling to the public has to ask.

   Three decisions worth stating, because they are the ones that make an age
   gate tolerable rather than theatre:

   - It asks once, for the whole launcher, not per title. A dialog that
     appears every time somebody opens a game page is a dialog people learn to
     dismiss without reading.
   - It asks for a year of birth, not a full date. The year is all that is
     needed and the rest is personal information with no purpose.
   - The answer is kept on this machine and never sent anywhere. There is no
     endpoint that receives it, by construction.

   It is not identity verification and does not pretend to be. Anybody can
   type a different year. That is true of every age gate in this industry;
   the point is that the store asked and recorded an answer, not that it
   proved anything.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc } = BN.util;

  /** The minimum age each rating is intended for. */
  const MINIMUM = { E: 0, E10: 10, T: 13, M: 17, AO: 18, RP: 17 };

  const currentYear = () => new Date().getFullYear();

  /** The age recorded, or null when nobody has been asked yet. */
  function age() {
    const year = Number(BN.state.data.settings.birthYear) || 0;
    if (!year) return null;
    return currentYear() - year;
  }

  /** Whether a title needs asking about at all. */
  const restricted = (game) => (MINIMUM[game?.rating] || 0) >= 17;

  /**
   * Whether this title can be shown.
   *
   * Anything below the mature threshold is never gated: putting a dialog in
   * front of an E-rated game would train people to click through it.
   */
  function allowed(game) {
    if (!restricted(game)) return true;
    const years = age();
    if (years === null) return false;
    return years >= (MINIMUM[game.rating] || 17);
  }

  async function remember(year) {
    await BN.state.setSettings({ birthYear: year });
  }

  /**
   * Asks, once.
   *
   * Resolves true when the person may see the title. A refusal is not an
   * error and not a scolding - it says what happened and leaves.
   */
  function ask(game) {
    const body = el('div', { class: 'col', style: { gap: '14px' } });
    body.innerHTML = `
      <p style="margin:0;line-height:1.65">
        <strong>${esc(game.title)}</strong> is rated
        <span class="rating-badge">${esc(game.rating)}</span>.
        Please confirm the year you were born.
      </p>
      <label class="field">
        <span class="field-label">Year of birth</span>
        <input class="input" id="age-year" type="number" inputmode="numeric"
               min="1900" max="${currentYear()}" placeholder="e.g. 1995" style="max-width:160px">
      </label>
      <p class="dim" style="margin:0;font-size:0.78rem;line-height:1.55">
        Kept on this machine and never sent anywhere. Only the year is asked for.
      </p>`;

    const input = body.querySelector('#age-year');

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      BN.ui.modal({
        title: 'A quick check',
        content: body,
        onClose: () => finish(false),
        footer: [
          { label: 'Not now', class: 'btn-ghost', onClick: ({ close }) => { close(); finish(false); } },
          {
            label: 'Confirm',
            class: 'btn-accent',
            onClick: async ({ close }) => {
              const year = Number(input.value);
              if (!year || year < 1900 || year > currentYear()) {
                BN.ui.toast('That does not look like a year', '', { kind: 'info' });
                return;
              }

              await remember(year);
              close();

              const years = currentYear() - year;
              const needed = MINIMUM[game.rating] || 17;

              if (years < needed) {
                BN.ui.toast(
                  'Not available',
                  `${game.title} is rated for ${needed} and over.`,
                  { kind: 'info', ms: 7000 }
                );
                finish(false);
                return;
              }
              finish(true);
            }
          }
        ]
      });

      setTimeout(() => input.focus(), 60);
    });
  }

  /**
   * The one call sites use: may this title be opened?
   *
   * Asks if nobody has been asked, and returns the answer either way.
   */
  async function check(game) {
    if (allowed(game)) return true;
    if (age() !== null) {
      // Already answered, and the answer was no.
      BN.ui.toast('Not available', `${game.title} is rated ${game.rating}.`, { kind: 'info' });
      return false;
    }
    return ask(game);
  }

  BN.views = BN.views || {};
  BN.views.ageGate = { check, allowed, ask, age, restricted, MINIMUM };
})();
