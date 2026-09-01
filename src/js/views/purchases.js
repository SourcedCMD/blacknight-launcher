/* =========================================================================
   Purchase history.

   The moment a store takes money, "where is my receipt" becomes the most
   common thing anybody asks it. A launcher that cannot answer sends every one
   of those to a human being.

   What this can honestly show today is what the launcher itself recorded when
   something was acquired: what, when, and what it cost at the time. It says
   so plainly rather than implying it is a bank statement — and when a real
   payment service exists, it becomes the thing that reconciles against it
   rather than something to throw away.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, money, date } = BN.util;

  /**
   * Everything the launcher recorded as acquired.
   *
   * Read from the library rather than a separate ledger: `addedAt` and the
   * price at the time are already stored per entry, and a second copy of that
   * is a second thing to keep in step.
   */
  function history() {
    return BN.state.data.library
      .filter((game) => game.owned && game.addedAt)
      .map((game) => ({
        id: game.id,
        title: game.title,
        at: game.addedAt,
        // What it cost when it was acquired, where that was recorded. A title
        // that arrived free stays free in the record even if it is sold later.
        paid: typeof game.paidUsd === 'number' ? game.paidUsd : null,
        listNow: game.price?.usd ?? null
      }))
      .sort((a, b) => b.at - a.at);
  }

  function row(entry) {
    const node = el('button', { class: 'purchase-row' });
    node.innerHTML = `
      <span class="purchase-body">
        <span class="purchase-title">${esc(entry.title)}</span>
        <span class="purchase-when">${esc(date(entry.at))}</span>
      </span>
      <span class="purchase-cost">${
        entry.paid === null
          ? '<span class="dim">not recorded</span>'
          : entry.paid === 0
            ? 'Free'
            : esc(money(entry.paid))
      }</span>`;

    node.addEventListener('click', () => {
      BN.ui.closeModal();
      BN.components.openDetail(entry.id);
    });
    return node;
  }

  function open() {
    const entries = history();
    const body = el('div', { class: 'col', style: { gap: '14px' } });

    if (!entries.length) {
      body.innerHTML = `<p class="dim" style="margin:0;line-height:1.7">
        Nothing here yet. Anything you acquire is listed with the date and what it cost at the time.</p>`;
    } else {
      const spent = entries.reduce((sum, e) => sum + (e.paid || 0), 0);

      body.append(
        el('p', { class: 'dim', style: { margin: '0', lineHeight: '1.6' } },
          `${entries.length} title${entries.length === 1 ? '' : 's'}` +
          (spent > 0 ? `, ${money(spent)} recorded in total.` : '.'))
      );

      const list = el('div', { class: 'col', style: { gap: '6px' } });
      for (const entry of entries) list.append(row(entry));
      body.append(list);

      body.append(
        el('p', { class: 'dim', style: { margin: '0', fontSize: '0.78rem', lineHeight: '1.55' } },
          'This is what this launcher recorded on this machine. It is not a payment receipt, ' +
          'and it will not include anything bought elsewhere.')
      );
    }

    BN.ui.modal({
      title: 'What you own',
      wide: true,
      content: body,
      footer: [
        ...(BN.util.hasLink('support')
          ? [{
              label: 'Get help with a purchase',
              class: 'btn-ghost',
              onClick: () => BN.api.app.openExternal(BN.util.link('support'))
            }]
          : []),
        { label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }
      ]
    });
  }

  BN.views = BN.views || {};
  BN.views.purchases = { open, history };
})();
