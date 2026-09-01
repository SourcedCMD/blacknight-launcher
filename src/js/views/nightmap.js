/* =========================================================================
   The night map: when this player actually plays.

   A week by hour grid of the local journal. The point is the shape - a column
   of colour at 21:00 on weeknights, a broad Saturday afternoon, the 2am cell
   that only lights up in one particular fortnight. A list of sessions cannot
   show that; a small grid shows it instantly.

   Everything here is computed from the same journal the rest of the launcher
   already keeps on disk. Nothing is uploaded.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, duration } = BN.util;

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /**
   * Colour for a cell, from none to peak.
   *
   * Square-rooted rather than linear: one exceptional evening would otherwise
   * flatten every ordinary one to the same near-black, and the ordinary ones
   * are the pattern worth seeing.
   */
  function shade(seconds, peak) {
    if (!seconds) return 'var(--bg-3)';
    const intensity = Math.sqrt(seconds / peak);
    return `color-mix(in oklab, var(--accent) ${Math.round(18 + intensity * 82)}%, transparent)`;
  }

  function cell(seconds, peak, day, hour) {
    const box = el('div', {
      class: 'nm-cell',
      style: { background: shade(seconds, peak) },
      tabindex: '0',
      role: 'img',
      'aria-label': seconds
        ? `${DAYS[day]} ${String(hour).padStart(2, '0')}:00, ${duration(seconds)}`
        : `${DAYS[day]} ${String(hour).padStart(2, '0')}:00, no play`
    });
    // Title rather than a custom tooltip: it is the one case where the native
    // one is both sufficient and keyboard-reachable for free.
    box.title = seconds
      ? `${DAYS[day]} ${String(hour).padStart(2, '0')}:00 — ${duration(seconds)}`
      : `${DAYS[day]} ${String(hour).padStart(2, '0')}:00`;
    return box;
  }

  /**
   * Describes the grid in a sentence.
   *
   * A heatmap that only a sighted user can read is half a feature, and the
   * sentence turns out to be the thing most people quote back anyway.
   */
  function summarise({ grid, sessions, totalSeconds }) {
    if (!sessions) return 'No sessions recorded yet — play something and this fills in.';

    let best = { day: 0, hour: 0, seconds: 0 };
    const byDay = new Array(7).fill(0);
    let night = 0;

    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const seconds = grid[day][hour];
        byDay[day] += seconds;
        if (hour >= 22 || hour < 5) night += seconds;
        if (seconds > best.seconds) best = { day, hour, seconds };
      }
    }

    const busiestDay = DAYS[byDay.indexOf(Math.max(...byDay))];
    const nightShare = Math.round((night / totalSeconds) * 100);

    const parts = [
      `${duration(totalSeconds)} across ${sessions} session${sessions === 1 ? '' : 's'}.`,
      `Most of it lands ${busiestDay} around ${String(best.hour).padStart(2, '0')}:00.`
    ];
    // Only mention the small hours when there is something to mention.
    if (nightShare >= 10) parts.push(`${nightShare}% of it after 22:00.`);
    return parts.join(' ');
  }

  async function render(host, { weeks = 26, gameId = null } = {}) {
    const map = await BN.api.library.playMap({ weeks, gameId });
    host.innerHTML = '';

    const wrap = el('div', { class: 'nightmap' });

    // Hour ruler, labelled every six hours so it stays readable when small.
    const ruler = el('div', { class: 'nm-row nm-ruler' }, el('span', { class: 'nm-day' }, ''));
    for (let hour = 0; hour < 24; hour++) {
      ruler.append(el('span', { class: 'nm-tick' }, hour % 6 === 0 ? String(hour).padStart(2, '0') : ''));
    }
    wrap.append(ruler);

    for (let day = 0; day < 7; day++) {
      const row = el('div', { class: 'nm-row' }, el('span', { class: 'nm-day' }, DAYS[day]));
      for (let hour = 0; hour < 24; hour++) row.append(cell(map.grid[day][hour], map.peak, day, hour));
      wrap.append(row);
    }

    host.append(
      wrap,
      el('p', { class: 'nm-summary muted' }, summarise(map))
    );
    return map;
  }

  BN.views = BN.views || {};
  BN.views.nightmap = { render, summarise, shade };
})();
