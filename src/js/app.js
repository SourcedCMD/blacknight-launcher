/* =========================================================================
   Application shell: boot sequence, window chrome, navigation, sidebar,
   global shortcuts and the command palette wiring.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { $, $$, el, esc, bytes, speed, duration, initials, bus } = BN.util;
  const icon = BN.icon;

  const ROUTES = ['games', 'store', 'plus', 'downloads', 'settings', 'profile'];
  const NAV = [
    { id: 'games', label: 'Games' },
    { id: 'store', label: 'Store' },
    { id: 'plus', label: 'BlackNight+' },
    { id: 'downloads', label: 'Downloads' },
    { id: 'settings', label: 'Settings' }
  ];

  let route = 'games';
  let sidebarCollapsed = false;
  let started = false;

  /* --------------------------------------------------------------------- */
  /* Boot                                                                   */

  const BOOT_STEPS = [
    'Waking the Umbra core',
    'Verifying launcher signature',
    'Loading account services',
    'Synchronising the catalogue',
    'Restoring your library',
    'Checking the download queue'
  ];

  async function boot() {
    const bar = $('#boot-bar i');
    const status = $('#boot-status');
    $('#boot-mark').innerHTML = BN.art.logo(132).replace('<svg ', '<svg class="boot-mark" ');

    $('#boot-word').textContent = 'BlackNight';

    // The canvas background comes up behind the boot screen so the reveal
    // lands on a live sky rather than a flat colour.
    BN.fx.initBackground($('#fx'));
    BN.fx.initPointer();

    // Settings decide how the rest of the sequence is paced, so they load
    // before the ceremony rather than inside it.
    await BN.state.loadSettings();
    BN.sound.configure({ enabled: !!BN.state.data.settings.uiSounds, volume: BN.state.data.settings.soundVolume });

    // The boot sequence is worth watching exactly once. After the first run it
    // resolves as fast as the work allows - a launcher people open daily
    // should not spend a second and a half admiring itself.
    const first = !BN.state.data.settings.onboarded;
    const beat = first ? () => BN.util.sleep(190 + Math.random() * 130) : () => Promise.resolve();

    const step = async (index, work) => {
      status.textContent = BOOT_STEPS[index];
      bar.style.width = `${((index + 1) / BOOT_STEPS.length) * 100}%`;
      const [result] = await Promise.all([work?.(), beat()]);
      return result;
    };

    await step(0);
    await step(1);
    await step(2);
    await step(3, () => BN.state.loadCatalog());
    const session = await step(4, () => BN.api.auth.session());
    await step(5, () => BN.state.refreshDownloads());

    status.textContent = 'Ready';
    if (first) await BN.util.sleep(240);

    registerAppIcon();

    const boot = $('#boot');
    boot.classList.add('done');
    setTimeout(() => boot.classList.add('hidden'), 820);

    if (session?.ok) {
      await BN.state.afterAuth(session.user);
      $('#auth').classList.add('hidden');
      start();
    } else {
      BN.views.auth.mount();
      $('#auth').classList.remove('hidden');
    }
  }

  /** Rasterises the vector mark and hands it to the main process for the
   *  taskbar and tray, so there is one source of truth for the brand. */
  function registerAppIcon() {
    try {
      const svg = BN.art.logo(256, { glow: false });
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 256, 256);
        BN.api.app.registerIcon(canvas.toDataURL('image/png'));
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch { /* cosmetic only */ }
  }

  /* --------------------------------------------------------------------- */
  /* Shell                                                                  */

  function start() {
    if (started) {
      go(route);
      return;
    }
    started = true;

    $('#app').classList.remove('hidden');
    $('#nav-mark').innerHTML = BN.art.logo(38);
    $('#tb-mark').innerHTML = BN.art.logo(17);

    buildNav();
    renderAccount();
    renderSidebar();
    wireWindowControls();
    wireShortcuts();
    wireDownloadEvents();
    BN.sound.bindGlobal(document);

    bus.on('library', () => {
      renderSidebar();
      if (route === 'games') BN.views.games.render();
      if (route === 'profile') BN.views.profile.render();
    });
    bus.on('user', renderAccount);
    bus.on('connectivity', renderConnectivity);
    renderConnectivity(BN.state.data.online);

    BN.api.app.onNavigate((target) => go(target));

    // blacknight://game/<id> and blacknight://store, from the site or a chat.
    BN.api.app.onDeepLink?.((target) => {
      if (!target) return;
      if (target.type === 'route') go(target.route);
      else if (target.type === 'game') {
        go('store');
        setTimeout(() => BN.components.openDetail(target.gameId), 160);
      }
    });

    BN.gamepad?.init();
    BN.i18n?.setLocale(BN.state.data.settings.locale);
    checkGameUpdates();

    // Pick up where they left off rather than always landing on Games.
    go(BN.state.data.settings.lastRoute || 'games');
    BN.sound.play('boot');
    BN.onboarding?.maybeRun();
  }

  function buildNav() {
    const host = $('#nav-links');
    host.innerHTML = '';
    for (const item of NAV) {
      const link = el('button', { class: 'nav-link', 'data-route': item.id });
      link.innerHTML = `<span class="plus-flare"></span>${esc(item.label)}`;
      link.addEventListener('click', () => go(item.id));
      host.appendChild(link);
    }
  }

  function renderConnectivity(online) {
    const node = $('#tb-status');
    node.classList.toggle('offline', !online);
    node.innerHTML = `<span class="dot"></span><span>${online ? 'Services online' : 'Offline mode'}</span>`;
  }

  /* --- Account chip ----------------------------------------------------- */

  function renderAccount() {
    const user = BN.state.data.user;
    const btn = $('#account-btn');
    if (!btn || !user) return;

    btn.innerHTML = `
      <span class="avatar">${esc(initials(user.displayName || user.handle))}</span>
      <span class="account-name">${esc(user.handle)}</span>
      ${icon('chevronDown', 'style="width:14px;height:14px;color:var(--text-mute)"')}`;
  }

  function accountMenu() {
    const user = BN.state.data.user;
    const menu = el('div', { class: 'menu' });
    menu.innerHTML = `
      <div class="menu-head">
        <div class="avatar avatar-lg" style="margin:0 auto 10px;width:52px;height:52px;font-size:1.2rem">${esc(initials(user.displayName || user.handle))}</div>
        <div class="handle">${esc(user.handle)}</div>
        <div class="email">${esc(user.email || 'Offline session')}</div>
        ${user.tier === 'plus' ? `<span class="badge badge-solid" style="margin-top:8px">${icon('crown')} BlackNight+</span>` : ''}
      </div>`;

    const item = (label, iconName, fn, cls = '') => {
      const b = el('button', { class: `menu-item ${cls}` });
      b.innerHTML = `${icon(iconName)}<span>${esc(label)}</span>`;
      b.addEventListener('click', () => {
        BN.ui.closeDropdown();
        fn();
      });
      return b;
    };

    menu.append(item('My profile', 'user', () => go('profile')));
    menu.append(item('Redeem a code', 'sparkles', redeemCode));
    menu.append(item('Membership', 'crown', () => go('plus')));
    menu.append(item('Downloads', 'download', () => go('downloads')));
    menu.append(item('Settings', 'settings', () => go('settings')));
    menu.append(el('div', { class: 'menu-sep' }));
    if (BN.util.hasLink('support')) {
      menu.append(item('Support', 'external', () => BN.api.app.openExternal(BN.util.link('support'))));
    }
    menu.append(item('Sign out', 'logout', signOut, 'danger'));
    return menu;
  }

  function redeemCode() {
    const body = el('div');
    body.innerHTML = `
      <p class="dim" style="margin-bottom:16px;line-height:1.7">
        Enter a BlackNight code to add a title, membership time or in-game content to your account.
      </p>
      <div class="field">
        <label class="field-label" for="rc-code">Code</label>
        <div class="input-wrap">${icon('sparkles')}
          <input class="input mono" id="rc-code" placeholder="XXXXX-XXXXX-XXXXX" maxlength="17" spellcheck="false" style="letter-spacing:.14em;text-transform:uppercase">
        </div>
      </div>
      <div id="rc-error"></div>`;

    const input = body.querySelector('#rc-code');
    input.addEventListener('input', () => {
      // Format as the user types: XXXXX-XXXXX-XXXXX
      const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
      input.value = raw.match(/.{1,5}/g)?.join('-') || '';
    });

    BN.ui.modal({
      title: 'Redeem a code',
      content: body,
      footer: [
        { label: 'Cancel', class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Redeem',
          class: 'btn-accent',
          onClick: ({ close }) => {
            const code = input.value.replace(/-/g, '');
            if (code.length !== 15) {
              body.querySelector('#rc-error').innerHTML = '<div class="field-error">Codes are 15 characters long.</div>';
              BN.sound.play('error');
              return;
            }
            close();
            BN.ui.toast(
              'Code service unavailable',
              'Redemption runs through the BlackNight account service, which is not connected in this build.',
              { kind: 'warn', ms: 6000 }
            );
          }
        }
      ]
    });
  }

  async function signOut() {
    const yes = await BN.ui.confirm({
      title: 'Sign out?',
      message: 'Downloads in progress are paused and resume next time you sign in.',
      confirmLabel: 'Sign out'
    });
    if (!yes) return;

    await BN.state.signOut();
    $('#app').classList.add('hidden');
    const auth = $('#auth');
    auth.classList.remove('hidden', 'out');
    BN.views.auth.mount();
    BN.views.auth.setMode('signin');
  }

  /* --- Sidebar ---------------------------------------------------------- */

  function renderSidebar() {
    const host = $('#side-scroll');
    if (!host) return;

    const library = BN.state.data.library;
    const available = library.filter((g) => g.status === 'released' && !g.owned && !g.installed);
    const owned = library.filter((g) => g.owned || g.installed);
    const upcoming = library.filter((g) => g.status !== 'released' && !g.owned);

    host.innerHTML = '';

    const section = (title, games, emptyText) => {
      if (!games.length && !emptyText) return;
      host.appendChild(el('div', { class: 'side-title side-label', text: title }));
      if (!games.length) {
        host.appendChild(
          el('div', { class: 'side-label mute', style: { padding: '4px 12px 10px', fontSize: '.74rem' }, text: emptyText })
        );
        return;
      }
      for (const game of games) host.appendChild(sideItem(game));
    };

    section('My library', owned, 'Nothing owned yet');
    section('Now available', available);
    section('In development', upcoming);

    // Storage meter
    const stats = BN.state.data.stats;
    const meter = el('div', { class: 'storage side-label' });
    meter.innerHTML = `
      <div class="between" style="font-size:.7rem;color:var(--text-faint)">
        <span style="letter-spacing:.16em;text-transform:uppercase">Installed</span>
        <span class="mono">${esc(bytes(stats.diskUsedBytes))}</span>
      </div>
      <div class="storage-bar"><i style="width:${Math.min(100, (stats.installed / Math.max(1, library.length)) * 100)}%"></i></div>`;
    host.appendChild(meter);
  }

  function sideItem(game) {
    const item = el('button', {
      class: 'side-item',
      'aria-current': String(BN.state.data.selectedGameId === game.id && route === 'games'),
      'data-tip': game.title,
      'data-tip-side': 'bottom'
    });
    item.innerHTML = `
      <span class="side-thumb">${BN.art.thumb(game)}</span>
      <span class="side-item-body side-label">
        <span class="side-item-name">${esc(game.title)}</span>
        <span class="side-item-meta">${esc(BN.components.statusLine(game))}</span>
      </span>`;
    item.addEventListener('click', () => BN.components.openDetail(game.id));
    return item;
  }

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    $('#sidebar').classList.toggle('collapsed', sidebarCollapsed);
    $('#side-collapse-label').textContent = sidebarCollapsed ? '' : 'Collapse';
  }

  /* --- Window chrome ---------------------------------------------------- */

  function wireWindowControls() {
    $('#win-min').addEventListener('click', () => BN.api.window.minimize());
    $('#win-max').addEventListener('click', async () => {
      const maximized = await BN.api.window.maximize();
      paintMaxButton(maximized);
    });
    $('#win-close').addEventListener('click', () => BN.api.window.close());
    BN.api.window.onState((state) => paintMaxButton(state.maximized));
    BN.api.window.state().then((state) => paintMaxButton(state.maximized));

    $('#tb-download').addEventListener('click', () => go('downloads'));
    $('#side-collapse').addEventListener('click', toggleSidebar);

    $('#nav-search').addEventListener('click', () => openPalette());

    const accountBtn = $('#account-btn');
    accountBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (accountBtn.getAttribute('aria-expanded') === 'true') BN.ui.closeDropdown();
      else BN.ui.dropdown(accountBtn, accountMenu());
    });
  }

  function paintMaxButton(maximized) {
    const btn = $('#win-max');
    btn.innerHTML = icon(maximized ? 'restore' : 'square');
    btn.dataset.tip = maximized ? 'Restore' : 'Maximise';
  }

  /* --- Downloads plumbing ----------------------------------------------- */

  function wireDownloadEvents() {
    BN.api.downloads.onProgress((list) => {
      BN.state.data.downloads = list;
      paintQueuePill();
      BN.views.downloads.tick(list);
    });

    BN.api.downloads.onChanged(async (list) => {
      BN.state.data.downloads = list;
      paintQueuePill();
      await BN.state.refreshLibrary();
      if (route === 'downloads') BN.views.downloads.paint();
    });

    BN.api.downloads.onCompleted(async (item) => {
      await BN.state.refreshLibrary();
      BN.sound.play('success');
      BN.ui.toast('Install complete', `${item.title} is ready to play.`, {
        kind: 'ok',
        ms: 8000,
        action: {
          label: 'Play',
          onClick: () => BN.components.runAction(BN.state.game(item.gameId))
        }
      });
      if (route === 'downloads') BN.views.downloads.paint();
    });

    paintQueuePill();
  }

  /**
   * Games whose catalog version has moved past what is installed.
   *
   * autoUpdateGames decides whether they start on their own; either way the
   * player is told, because a silent 40 GB download is its own kind of rude.
   */
  async function checkGameUpdates() {
    let pending = [];
    try {
      pending = await BN.api.library.outdated();
    } catch (err) {
      BN.log?.warn('updates', 'Could not check for game updates', err);
      return;
    }
    if (!pending.length) return;

    const auto = BN.state.data.settings.autoUpdateGames !== false;
    const label = BN.i18n.plural('updates.available', pending.length);

    if (auto) {
      const result = await BN.api.library.updateAll();
      await BN.state.refreshLibrary();
      await BN.state.refreshDownloads();
      BN.ui.toast(label, BN.i18n.plural('updates.started', result.started.length), {
        kind: 'ok',
        ms: 7000,
        action: { label: 'View queue', onClick: () => go('downloads') }
      });
    } else {
      BN.ui.toast(label, pending.map((p) => p.title).join(', '), {
        kind: 'info',
        ms: 9000,
        action: {
          label: BN.t('updates.installAll'),
          onClick: async () => {
            const result = await BN.api.library.updateAll();
            await BN.state.refreshLibrary();
            await BN.state.refreshDownloads();
            BN.ui.toast(BN.i18n.plural('updates.started', result.started.length), '', { kind: 'ok' });
            go('downloads');
          }
        }
      });
    }
  }

  function paintQueuePill() {
    const pill = $('#tb-download');
    const queue = BN.state.queueProgress();
    if (!queue) {
      pill.classList.remove('active');
      BN.api.app.setProgress(-1);
      return;
    }
    pill.classList.add('active');
    pill.innerHTML = `
      ${icon('download', 'style="width:13px;height:13px"')}
      <span class="mono">${Math.round(queue.progress * 100)}%</span>
      <span class="progress"><i style="width:${queue.progress * 100}%"></i></span>
      <span class="mono">${queue.downloading ? esc(speed(queue.speedBps)) : 'Paused'}</span>`;
    pill.dataset.tip = queue.etaSeconds ? `${duration(queue.etaSeconds)} remaining` : 'Download queue';
    BN.api.app.setProgress(queue.downloading ? queue.progress : -1);
  }

  /* --- Routing ---------------------------------------------------------- */

  function go(next, arg) {
    if (!ROUTES.includes(next)) next = 'games';
    const previous = route;
    if (previous !== next) BN.views[previous]?.onLeave?.();
    route = next;

    $$('#nav-links .nav-link').forEach((link) =>
      link.setAttribute('aria-current', link.dataset.route === next ? 'page' : 'false')
    );

    $$('.view').forEach((view) => {
      const active = view.id === `view-${next}`;
      view.classList.toggle('hidden', !active);
      view.classList.toggle('current', active);
      if (active) {
        view.classList.remove('enter');
        void view.offsetWidth;
        view.classList.add('enter');
        view.scrollTop = 0;
      }
    });

    if (next === 'settings' && arg) BN.views.settings.go(arg);
    else BN.views[next]?.render();
    BN.views[next]?.onEnter?.();

    // Remembered for the next launch. Profile is a detour rather than a home,
    // so it is not somewhere anyone wants to be dropped back into.
    if (next !== 'profile' && BN.state.data.settings.lastRoute !== next) {
      BN.state.setSettings({ lastRoute: next });
    }

    renderSidebar();
  }

  /* --- Shortcuts + palette ---------------------------------------------- */

  function commands() {
    const list = [
      { group: 'Navigate', label: 'Games', icon: 'home', hint: 'Ctrl 1', run: () => go('games') },
      { group: 'Navigate', label: 'Store', icon: 'store', hint: 'Ctrl 2', run: () => go('store') },
      { group: 'Navigate', label: 'BlackNight+', icon: 'crown', hint: 'Ctrl 3', run: () => go('plus') },
      { group: 'Navigate', label: 'Downloads', icon: 'download', hint: 'Ctrl 4', run: () => go('downloads') },
      { group: 'Navigate', label: 'My profile', icon: 'user', run: () => go('profile') },
      { group: 'Navigate', label: 'Settings', icon: 'settings', hint: 'Ctrl ,', run: () => go('settings') }
    ];

    for (const game of BN.state.data.library) {
      list.push({
        group: 'Library',
        label: game.title,
        icon: game.installed ? 'play' : 'package',
        hint: BN.components.statusLine(game),
        keywords: game.genre.join(' ') + ' ' + game.tags.join(' '),
        run: () => BN.components.openDetail(game.id)
      });
    }

    const installed = BN.state.installedGames();
    for (const game of installed) {
      list.push({
        group: 'Play',
        label: `Play ${game.title}`,
        icon: 'play',
        keywords: 'launch start run',
        run: () => BN.components.runAction(game)
      });
    }

    list.push(
      { group: 'Actions', label: 'Pause all downloads', icon: 'pause', run: async () => {
          for (const d of BN.state.activeDownloads()) await BN.api.downloads.pause(d.id);
          await BN.state.refreshDownloads();
          BN.ui.toast('Downloads paused', '', { kind: 'ok', ms: 2400 });
        } },
      { group: 'Actions', label: 'Resume all downloads', icon: 'play', run: async () => {
          for (const d of BN.state.activeDownloads()) await BN.api.downloads.resume(d.id);
          await BN.state.refreshDownloads();
        } },
      { group: 'Actions', label: 'Toggle interface sounds', icon: 'volume', run: async () => {
          const next = !BN.state.data.settings.uiSounds;
          await BN.state.setSettings({ uiSounds: next });
          BN.ui.toast(next ? 'Sounds on' : 'Sounds off', '', { kind: 'ok', ms: 2000 });
        } },
      { group: 'Actions', label: 'Toggle reduced motion', icon: 'zap', run: async () => {
          const next = !BN.state.data.settings.reduceMotion;
          await BN.state.setSettings({ reduceMotion: next });
          BN.ui.toast(next ? 'Reduced motion on' : 'Full motion on', '', { kind: 'ok', ms: 2000 });
        } },
      { group: 'Actions', label: 'Collapse the sidebar', icon: 'chevronLeft', hint: 'Ctrl B', run: toggleSidebar },
      { group: 'Actions', label: 'Redeem a code', icon: 'sparkles', run: redeemCode },
      { group: 'Actions', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: showShortcuts },
      { group: 'Account', label: 'Sign out', icon: 'logout', run: signOut }
    );

    for (const accent of ['moonlight', 'eclipse', 'bloodmoon', 'nebula', 'toxic', 'ember']) {
      list.push({
        group: 'Theme',
        label: `Accent: ${accent[0].toUpperCase()}${accent.slice(1)}`,
        icon: 'palette',
        keywords: 'colour color theme accent',
        run: () => BN.state.setSettings({ accent })
      });
    }

    return list;
  }

  const openPalette = () => BN.ui.commandPalette(commands());

  /* --- Shortcut cheatsheet ---------------------------------------------- */

  const SHORTCUTS = [
    ['Navigation', [
      ['Ctrl K', 'Search and commands'],
      ['Ctrl 1 - 4', 'Games, Store, BlackNight+, Downloads'],
      ['Ctrl ,', 'Settings'],
      ['Ctrl F', 'Search the store'],
      ['Ctrl B', 'Collapse the sidebar']
    ]],
    ['While a dialog is open', [
      ['Esc', 'Close it'],
      ['Tab', 'Move between controls'],
      ['Enter', 'Confirm']
    ]],
    ['Controller', [
      ['D-pad', 'Move focus'],
      ['A', 'Select'],
      ['B', 'Back'],
      ['LB / RB', 'Previous or next page'],
      ['Y / Start', 'Search and commands']
    ]]
  ];

  /**
   * Nobody opens Settings to learn a shortcut, so the list lives one keypress
   * away from wherever they already are.
   */
  function showShortcuts() {
    BN.ui.modal({
      title: 'Keyboard and controller',
      wide: true,
      content: `<div class="cheats">${SHORTCUTS.map(
        ([group, rows]) => `
          <section>
            <h3 class="eyebrow">${esc(group)}</h3>
            ${rows.map(([keys, what]) => `<div class="cheat"><kbd>${esc(keys)}</kbd><span>${esc(what)}</span></div>`).join('')}
          </section>`
      ).join('')}</div>`,
      footer: [{ label: 'Close', class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        return openPalette();
      }
      if (typing) return;

      // Unmodified '?' - the convention every app that has this uses.
      if (!mod && e.key === '?') { e.preventDefault(); return showShortcuts(); }

      if (mod && e.key === '1') { e.preventDefault(); go('games'); }
      else if (mod && e.key === '2') { e.preventDefault(); go('store'); }
      else if (mod && e.key === '3') { e.preventDefault(); go('plus'); }
      else if (mod && e.key === '4') { e.preventDefault(); go('downloads'); }
      else if (mod && e.key === ',') { e.preventDefault(); go('settings'); }
      else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
      else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); go('store'); setTimeout(() => $('#store-search')?.focus(), 120); }
    });
  }

  /* --------------------------------------------------------------------- */

  BN.app = { boot, start, go, signOut, openPalette, toggleSidebar, showShortcuts, checkGameUpdates };

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error('[boot]', err);
      const status = $('#boot-status');
      if (status) status.textContent = 'Startup failed - see the developer console';
    });
  });
})();
