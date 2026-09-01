/* =========================================================================
   The play journal, session insights, and the year in review.

   Everything here is computed from data the launcher already records locally.
   Nothing is uploaded, and nothing needs a backend - which is exactly why a
   studio launcher can ship it on day one.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, duration } = BN.util;

  const HOUR = (h) => `${String(h).padStart(2, '0')}:00`;

  /* --------------------------------------------------------------------- */
  /* Session insights                                                       */

  /**
   * The line shown before launching: how long this usually takes, and where
   * that lands on the clock. It is the player's own history, not a guess.
   */
  async function insightLine(gameId) {
    if (BN.state.data.settings.sessionInsights === false) return null;
    const insights = await BN.api.library.insights(gameId);
    if (!insights || insights.sessions < 3) return null;

    const median = insights.medianSeconds;
    const endsAt = new Date(Date.now() + median * 1000);
    return {
      insights,
      text: `Your sessions here usually run about ${duration(median)} — that puts you at ${endsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    };
  }

  /** Shows the insight as a toast when it is worth mentioning. */
  async function noteBeforeLaunch(gameId) {
    const line = await insightLine(gameId);
    if (!line) return;
    BN.ui.toast('Before you start', line.text, { kind: 'info', ms: 7000 });
  }

  /* --------------------------------------------------------------------- */
  /* Journal                                                                */

  async function open(gameId = null) {
    const entries = await BN.api.library.journal(gameId, { limit: 120 });
    const body = el('div');

    if (!entries.length) {
      body.innerHTML = `<p class="dim" style="line-height:1.7">
        Nothing recorded yet. A line is written here each time you finish a session.</p>`;
    } else {
      const list = el('div', { class: 'col', style: { gap: '8px' } });
      for (const entry of entries) list.append(journalRow(entry));
      body.append(list);
    }

    BN.ui.modal({
      title: gameId ? `${esc(BN.state.game(gameId)?.title || '')} — journal` : 'Play journal',
      wide: true,
      content: body,
      footer: [{ label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  function journalRow(entry) {
    const row = el('div', { class: 'journal-row' });
    row.innerHTML = `
      <div class="journal-when">
        <span class="journal-date">${esc(new Date(entry.at).toLocaleDateString())}</span>
        <span class="journal-time">${esc(new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
      </div>
      <div class="grow">
        <div class="journal-head">
          <span class="journal-title">${esc(entry.title)}</span>
          <span class="journal-dur">${esc(duration(entry.seconds))}</span>
          ${entry.crashed ? '<span class="badge badge-warn">ended badly</span>' : ''}
        </div>
        <input class="input input-sm journal-note" placeholder="Add a note…" value="${esc(entry.note || '')}">
      </div>`;

    // Saved on blur rather than per keystroke: this is a scratchpad, not a form.
    const note = row.querySelector('.journal-note');
    note.addEventListener('blur', async () => {
      if (note.value === (entry.note || '')) return;
      await BN.api.library.setJournalNote(entry.id, note.value);
      entry.note = note.value;
      BN.sound?.play('click');
    });
    return row;
  }

  /* --------------------------------------------------------------------- */
  /* Year in review                                                         */

  /**
   * A poster generated from a year of local play.
   *
   * The art comes from the same seeded engine the store uses, keyed off the
   * year's own numbers - so two players never get the same image, and nobody
   * needs a server to produce it.
   */
  async function yearInReview(year = new Date().getFullYear()) {
    const review = await BN.api.library.yearInReview(year);

    if (!review.sessions) {
      BN.ui.toast('Nothing to show yet', `No sessions recorded in ${year}.`, { kind: 'info' });
      return;
    }

    const seedGame = {
      id: `review-${year}-${review.sessions}`,
      art: { motif: 'orbit', hue: 200 + ((review.peakHour * 7) % 140), seed: review.totalSeconds }
    };

    const nightPercent = Math.round(review.nightFraction * 100);
    const body = el('div', { class: 'review' });
    body.innerHTML = `
      <div class="review-poster" id="review-poster">
        <div class="review-art">${BN.art.keyArt({ seed: review.totalSeconds, hue: seedGame.art.hue, motif: 'orbit', w: 900, h: 1200, detail: 0.7 })}</div>
        <div class="review-content">
          <div class="review-eyebrow">BlackNight ${esc(String(year))}</div>
          <div class="review-hero chrome-text">${esc(duration(review.totalSeconds))}</div>
          <div class="review-sub">across ${review.sessions} session${review.sessions === 1 ? '' : 's'}</div>

          <div class="review-grid">
            <div><div class="k">Most played</div><div class="v">${esc(review.topTitle?.title || '—')}</div></div>
            <div><div class="k">Longest night</div><div class="v">${esc(duration(review.longestSession.seconds))}</div></div>
            <div><div class="k">Peak hour</div><div class="v">${esc(HOUR(review.peakHour))}</div></div>
            <div><div class="k">After dark</div><div class="v">${nightPercent}%</div></div>
          </div>

          <div class="review-titles">
            ${review.titles
              .slice(0, 5)
              .map(
                (t) => `<div class="review-title-row">
                  <span>${esc(t.title)}</span>
                  <span class="mono">${esc(duration(t.seconds))}</span>
                </div>`
              )
              .join('')}
          </div>
          <div class="review-mark">${BN.art.logo(30)}</div>
        </div>
      </div>`;

    BN.util.coverSvg(body.querySelector('.review-art'));

    BN.ui.modal({
      title: `Your year in the dark — ${year}`,
      wide: true,
      content: body,
      footer: [
        { label: BN.t('action.close'), class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Save as image',
          class: 'btn-accent',
          onClick: ({ body: root }) => exportPoster(root.querySelector('#review-poster'), year)
        }
      ]
    });
  }

  /**
   * Rasterises the poster so it can be kept or shared.
   *
   * The whole thing is inline SVG and CSS, so it is drawn through an SVG
   * foreignObject onto a canvas rather than needing a screenshot API.
   */
  async function exportPoster(node, year) {
    if (!node) return;
    try {
      const rect = node.getBoundingClientRect();
      const scale = 2;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);

      // Inline the computed styles the clone depends on; a detached copy has
      // no stylesheet to inherit from.
      const clone = node.cloneNode(true);
      clone.style.margin = '0';
      const styles = [...document.styleSheets]
        .flatMap((sheet) => {
          try {
            return [...sheet.cssRules].map((rule) => rule.cssText);
          } catch {
            return [];
          }
        })
        .join('\n');

      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<foreignObject width="100%" height="100%">` +
        `<div xmlns="http://www.w3.org/1999/xhtml"><style>${styles}</style>${clone.outerHTML}</div>` +
        `</foreignObject></svg>`;

      const img = new Image();
      // A data: URL rather than a blob: one. The launcher's CSP allows
      // `img-src 'self' data:`, so a blob URL is refused outright and this
      // failed silently in the packaged app while working in a plain browser.
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('could not rasterise the poster'));
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      const dataUrl = canvas.toDataURL('image/png');
      const saved = await BN.api.app.savePoster?.(dataUrl, `BlackNight-${year}.png`);
      BN.ui.toast(
        saved?.ok ? 'Poster saved' : 'Could not save the poster',
        saved?.path || saved?.error || '',
        { kind: saved?.ok ? 'ok' : 'error' }
      );
    } catch (err) {
      BN.log?.warn('review', 'Poster export failed', err);
      BN.ui.toast('Could not save the poster', err.message, { kind: 'error' });
    }
  }

  BN.views = BN.views || {};
  BN.views.journal = { open, yearInReview, insightLine, noteBeforeLaunch };
})();
