/* =========================================================================
   BlackNight+ : the membership view.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, money } = BN.util;
  const icon = BN.icon;

  const TIERS = [
    {
      id: 'standard',
      name: 'Standard',
      price: 0,
      cadence: 'always free',
      perks: [
        'Full launcher, library and store',
        'Cloud saves for every BlackNight title',
        'Friends list and party invites',
        'Community events and playtest sign-ups'
      ]
    },
    {
      id: 'plus',
      name: 'BlackNight+',
      price: 5.99,
      cadence: 'per month',
      featured: true,
      perks: [
        'Everything in Standard',
        'Rotating games library at no extra cost',
        'Guaranteed entry to closed playtests',
        'Monthly in-game currency drop',
        'Priority download servers',
        'Members-only cosmetics and liveries'
      ]
    },
    {
      id: 'plus-annual',
      name: 'BlackNight+ Annual',
      price: 49.99,
      cadence: 'per year',
      perks: [
        'Everything in BlackNight+',
        'Two months free versus monthly',
        'Early access windows on new releases',
        'Exclusive Founders profile frame'
      ]
    }
  ];

  function render() {
    const view = document.getElementById('view-plus');
    if (!view) return;
    const user = BN.state.data.user;
    const isMember = user?.tier === 'plus';

    view.innerHTML = `
      <div class="view-pad">
        <section class="plus-hero">
          <div id="plus-mark" style="display:grid;place-items:center;margin-bottom:18px"></div>
          <span class="eyebrow">Membership</span>
          <h1 class="display chrome-text" style="font-size:3rem;margin:10px 0 14px">BlackNight+</h1>
          <p class="dim" style="max-width:60ch;margin:0 auto 22px;line-height:1.8">
            A rotating library, priority servers and guaranteed playtest access.
            One membership across every BlackNight title, now and everything still to come.
          </p>
          ${
            isMember
              ? `<span class="badge badge-solid" style="height:30px;padding:0 16px">${icon('crown')} Active member</span>`
              : `<div class="row" style="justify-content:center;gap:12px">
                   <button class="btn btn-chrome btn-lg" id="plus-join">${icon('crown')} Join BlackNight+</button>
                   <button class="btn btn-ghost btn-lg" id="plus-compare">${icon('info')} Compare plans</button>
                 </div>`
          }
        </section>

        <section class="section" data-reveal>
          <div class="section-head"><div><h2>Choose a plan</h2><div class="sub">Cancel any time. Prices in USD.</div></div></div>
          <div class="grid grid-wide stagger" id="plus-tiers"></div>
        </section>

        <section class="section" data-reveal>
          <div class="section-head"><div><h2>In the members library</h2><div class="sub">Rotating selection, playable at no extra cost</div></div></div>
          <div class="grid stagger" id="plus-games"></div>
        </section>

        <section class="section" data-reveal>
          <div class="section-head"><div><h2>Member benefits in detail</h2></div></div>
          <div class="grid grid-wide">
            ${[
              ['zap', 'Priority download servers', 'Members route to dedicated edge nodes, which in practice means the queue moves first and the pipe stays full.'],
              ['users', 'Guaranteed playtest entry', 'Every closed playtest reserves seats for members. No lottery, no waiting list.'],
              ['sparkles', 'Monthly drops', 'In-game currency and a members-only cosmetic set each month across all supported titles.'],
              ['shield', 'Founders standing', 'Annual members keep a permanent Founders frame on their profile, even if they later cancel.']
            ]
              .map(
                ([ic, title, body]) => `
              <div class="panel" style="padding:22px" data-reveal>
                <div style="width:38px;height:38px;display:grid;place-items:center;border-radius:10px;background:var(--accent-wash);color:var(--accent);margin-bottom:14px">${icon(ic)}</div>
                <h3 class="display" style="font-size:.92rem;margin-bottom:8px">${esc(title)}</h3>
                <p class="dim" style="font-size:.84rem;line-height:1.7">${esc(body)}</p>
              </div>`
              )
              .join('')}
          </div>
        </section>
      </div>`;

    view.querySelector('#plus-mark').innerHTML = BN.art.logo(76);

    const tiers = view.querySelector('#plus-tiers');
    for (const tier of TIERS) tiers.appendChild(tierCard(tier, user));

    const games = view.querySelector('#plus-games');
    for (const game of BN.state.data.library.filter((g) => g.price.usd === 0 || g.featured).slice(0, 4)) {
      games.appendChild(BN.components.gameCard(game));
    }

    view.querySelector('#plus-join')?.addEventListener('click', () => subscribe(TIERS[1]));
    view.querySelector('#plus-compare')?.addEventListener('click', () =>
      view.querySelector('#plus-tiers').scrollIntoView({ behavior: 'smooth', block: 'start' })
    );

    BN.fx.reveal(view);
  }

  function tierCard(tier, user) {
    const active = (user?.tier || 'standard') === (tier.id === 'plus-annual' ? 'plus' : tier.id);
    const card = el('div', { class: `tier${tier.featured ? ' featured' : ''}` });
    card.innerHTML = `
      <div>
        <div class="eyebrow">${esc(tier.name)}</div>
        <div class="cost">${tier.price === 0 ? 'Free' : money(tier.price)} <small>${esc(tier.cadence)}</small></div>
      </div>
      <ul>${tier.perks.map((p) => `<li>${icon('check')}<span>${esc(p)}</span></li>`).join('')}</ul>`;

    const btn = el('button', { class: `btn ${tier.featured ? 'btn-chrome' : 'btn-ghost'} btn-block`, style: { marginTop: 'auto' } });
    btn.innerHTML = active && tier.id !== 'plus-annual' ? `${icon('check')} Current plan` : `${icon('crown')} ${tier.price === 0 ? 'Included' : 'Choose plan'}`;
    btn.disabled = active && tier.id !== 'plus-annual';
    btn.addEventListener('click', () => subscribe(tier));
    card.appendChild(btn);
    return card;
  }

  async function subscribe(tier) {
    if (tier.price === 0) {
      await BN.state.updateProfile({ tier: 'standard' });
      BN.ui.toast('Switched to Standard', 'Your membership benefits end at the close of the billing period.', { kind: 'ok' });
      render();
      return;
    }

    const yes = await BN.ui.confirm({
      title: `Join ${tier.name}`,
      message:
        `${money(tier.price)} ${tier.cadence}. Billing runs through the BlackNight store service, which is not connected in this build. ` +
        `Continuing marks the account as a member so you can see the membership experience.`,
      confirmLabel: 'Start membership'
    });
    if (!yes) return;

    await BN.state.updateProfile({ tier: 'plus' });
    BN.sound?.play('success');
    BN.ui.toast('Welcome to BlackNight+', 'Priority servers and the members library are unlocked.', { kind: 'ok', ms: 6000 });
    render();
  }

  BN.views = BN.views || {};
  BN.views.plus = { render };
})();
