/* =========================================================================
   Settings view. Every control writes straight through to the settings store
   and applies immediately - there is no save button to forget.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, date } = BN.util;
  const icon = BN.icon;

  const SECTIONS = [
    { id: 'general', label: 'General', icon: 'sliders' },
    { id: 'appearance', label: 'Appearance', icon: 'palette' },
    { id: 'downloads', label: 'Downloads', icon: 'download' },
    { id: 'account', label: 'Account', icon: 'user' },
    { id: 'privacy', label: 'Privacy', icon: 'shield' },
    { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
    { id: 'about', label: 'About', icon: 'info' }
  ];

  const ACCENTS = [
    { id: 'moonlight', label: 'Moonlight', color: '#8fb8ff' },
    { id: 'eclipse', label: 'Eclipse', color: '#d5dcec' },
    { id: 'bloodmoon', label: 'Blood Moon', color: '#ff5163' },
    { id: 'nebula', label: 'Nebula', color: '#a97bff' },
    { id: 'toxic', label: 'Toxic', color: '#7dffa8' },
    { id: 'ember', label: 'Ember', color: '#ffab3d' }
  ];

  let section = 'general';
  let appInfo = null;

  /* --- Row builders ----------------------------------------------------- */

  function row(label, desc, control) {
    const node = el('div', { class: 'set-row' });
    node.innerHTML = `<div class="grow"><div class="label">${esc(label)}</div>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div>`;
    const wrap = el('div', { class: 'control' });
    wrap.append(control);
    node.append(wrap);
    return node;
  }

  function toggle(key, label, desc, onChange) {
    const value = !!BN.state.data.settings[key];
    const sw = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(value), 'aria-label': label });
    sw.addEventListener('click', async () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      await BN.state.setSettings({ [key]: next });
      onChange?.(next);
    });
    return row(label, desc, sw);
  }

  function select(key, label, desc, options, onChange) {
    const sel = el('select', { class: 'select', 'aria-label': label });
    for (const [value, text] of options) sel.append(el('option', { value }, text));
    sel.value = String(BN.state.data.settings[key]);
    sel.addEventListener('change', async () => {
      const raw = sel.value;
      const value = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      await BN.state.setSettings({ [key]: value });
      onChange?.(value);
    });
    return row(label, desc, sel);
  }

  function slider(key, label, desc, { min, max, step = 1, format }) {
    const value = Number(BN.state.data.settings[key] ?? min);
    const wrap = el('div', { class: 'row', style: { gap: '14px', width: '260px' } });
    const input = el('input', { type: 'range', class: 'slider', min, max, step, value, 'aria-label': label });
    const readout = el('span', { class: 'mono', style: { minWidth: '68px', textAlign: 'right', fontSize: '.8rem' } }, format(value));
    const paintFill = (v) => input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    paintFill(value);

    input.addEventListener('input', () => {
      readout.textContent = format(Number(input.value));
      paintFill(Number(input.value));
    });
    input.addEventListener('change', () => BN.state.setSettings({ [key]: Number(input.value) }));
    wrap.append(input, readout);
    return row(label, desc, wrap);
  }

  const group = (title, desc, ...rows) => {
    const node = el('div', { class: 'set-group' });
    node.innerHTML = `<header><h3>${esc(title)}</h3>${desc ? `<p>${esc(desc)}</p>` : ''}</header>`;
    node.append(...rows.filter(Boolean));
    return node;
  };

  /* --- Sections --------------------------------------------------------- */

  function generalSection() {
    return [
      group(
        'Startup',
        'How the launcher behaves when Windows starts and when you close the window.',
        toggle('launchOnStartup', 'Launch on system startup', 'Start BlackNight when you sign in to Windows.', (on) =>
          BN.api.app.setLaunchOnStartup(on)
        ),
        toggle('startMinimized', 'Start minimised', 'Open straight to the tray instead of showing the window.'),
        select('closeAction', 'When I close the window', 'Keep downloads running in the background, or quit outright.', [
          ['tray', 'Minimise to the tray'],
          ['quit', 'Quit the launcher']
        ]),
        toggle('minimizeToTray', 'Show a tray icon', 'Keeps the launcher reachable from the notification area.')
      ),
      group(
        'Games',
        null,
        toggle('exitOnGameLaunch', 'Close the launcher when a game starts', 'Frees memory while you play.'),
        toggle('showPlaytime', 'Track playtime', 'Records how long each session lasts and shows it in your library.'),
        toggle('autoUpdateGames', 'Update games automatically', 'Downloads patches as soon as they are published.')
      )
    ];
  }

  function appearanceSection() {
    const swatches = el('div', { class: 'accent-swatches' });
    for (const accent of ACCENTS) {
      const swatch = el('button', {
        class: 'swatch',
        role: 'radio',
        'aria-checked': String(BN.state.data.settings.accent === accent.id),
        'aria-label': accent.label,
        'data-tip': accent.label,
        style: { color: accent.color }
      });
      swatch.addEventListener('click', async () => {
        await BN.state.setSettings({ accent: accent.id });
        swatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === swatch)));
        BN.ui.toast('Accent updated', accent.label, { kind: 'ok', ms: 2200 });
      });
      swatches.append(swatch);
    }

    return [
      group('Theme', 'BlackNight is built for the dark. Pick the accent that carries it.', row('Accent colour', 'Used across highlights, progress and focus states.', swatches)),
      group(
        'Motion and effects',
        'Turn the ambience down on lower-powered machines.',
        select('backgroundFx', 'Background effects', 'The animated starfield behind the interface.', [
          ['full', 'Full - stars, dust and shooting stars'],
          ['lite', 'Lite - stars only'],
          ['off', 'Off - static background']
        ]),
        toggle('reduceMotion', 'Reduce motion', 'Disables transitions, parallax and the ambient background.'),
        slider('uiScale', 'Interface scale', 'Scales every element in the launcher.', {
          min: 80,
          max: 130,
          step: 5,
          format: (v) => `${v}%`
        })
      ),
      group(
        'Sound',
        'Interface cues are synthesised at runtime, so they cost nothing to ship.',
        toggle('uiSounds', 'Interface sounds', 'Clicks, navigation sweeps and the launch cue.'),
        slider('soundVolume', 'Volume', null, { min: 0, max: 100, step: 5, format: (v) => `${v}%` }),
        row(
          'Preview',
          'Play the launch cue.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('volume')} Play`;
            b.addEventListener('click', () => BN.sound.play('launch'));
            return b;
          })()
        )
      )
    ];
  }

  function downloadsSection() {
    const settings = BN.state.data.settings;

    const pathRow = el('div', { class: 'set-row stack' });
    pathRow.innerHTML = `
      <div class="between" style="margin-bottom:10px">
        <div><div class="label">Install location</div><div class="desc">Where games are downloaded and installed.</div></div>
      </div>`;
    const pathBox = el('div', { class: 'path-box' });
    pathBox.innerHTML = `${icon('folder')}<span id="install-path">${esc(settings.installDir || 'Not set')}</span>`;
    const pathActions = el('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } });

    const browse = el('button', { class: 'btn btn-sm btn-ghost' });
    browse.innerHTML = `${icon('folder')} Change`;
    browse.addEventListener('click', async () => {
      const picked = await BN.api.app.chooseDirectory(settings.installDir);
      if (!picked) return;
      await BN.state.setSettings({ installDir: picked });
      pathBox.querySelector('#install-path').textContent = picked;
      BN.ui.toast('Install location updated', picked, { kind: 'ok' });
    });

    const open = el('button', { class: 'btn btn-sm btn-ghost' });
    open.innerHTML = `${icon('external')} Open`;
    open.addEventListener('click', () => BN.api.app.openPath(settings.installDir));

    pathActions.append(browse, open);
    pathRow.append(pathBox, pathActions);

    return [
      group('Location', null, pathRow),
      group(
        'Bandwidth',
        'Applies to every active transfer in the queue.',
        select('concurrentDownloads', 'Simultaneous downloads', 'More at once is not always faster on a shared line.', [
          [1, '1 (recommended)'],
          [2, '2'],
          [3, '3']
        ]),
        slider('bandwidthLimitMbps', 'Speed limit', 'Set to zero to use the full connection.', {
          min: 0,
          max: 500,
          step: 10,
          format: (v) => (v === 0 ? 'Unlimited' : `${v} Mbps`)
        }),
        toggle('pauseOnMetered', 'Pause on metered connections', 'Stops large downloads eating a mobile data allowance.')
      ),
      group(
        'Storage',
        null,
        row(
          'Installed titles',
          `${BN.state.data.stats.installed} installed, ${bytes(BN.state.data.stats.diskUsedBytes)} on disk.`,
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('drive')} Manage`;
            b.addEventListener('click', () => BN.app.go('profile'));
            return b;
          })()
        )
      )
    ];
  }

  function accountSection() {
    const user = BN.state.data.user;

    const profileRow = el('div', { class: 'set-row' });
    profileRow.innerHTML = `
      <div class="row" style="gap:16px">
        <div class="avatar avatar-lg" style="width:56px;height:56px;font-size:1.3rem">${esc(BN.util.initials(user?.displayName || user?.handle))}</div>
        <div>
          <div class="label" style="font-family:var(--font-display);letter-spacing:.1em;text-transform:uppercase">${esc(user?.handle || 'Guest')}</div>
          <div class="desc">${esc(user?.email || 'Signed in offline')} · joined ${esc(date(user?.createdAt))}</div>
        </div>
      </div>`;
    const editBtn = el('button', { class: 'btn btn-sm btn-ghost' });
    editBtn.innerHTML = `${icon('user')} Edit profile`;
    editBtn.addEventListener('click', editProfile);
    profileRow.append(el('div', { class: 'control' }, editBtn));

    const pwBtn = el('button', { class: 'btn btn-sm btn-ghost' });
    pwBtn.innerHTML = `${icon('lock')} Change`;
    pwBtn.addEventListener('click', changePassword);

    const outBtn = el('button', { class: 'btn btn-sm btn-danger' });
    outBtn.innerHTML = `${icon('logout')} Sign out`;
    outBtn.addEventListener('click', () => BN.app.signOut());

    const membership = el('button', { class: 'btn btn-sm btn-chrome' });
    membership.innerHTML = `${icon('crown')} ${user?.tier === 'plus' ? 'Manage' : 'Join BlackNight+'}`;
    membership.addEventListener('click', () => BN.app.go('plus'));

    return [
      group('Profile', null, profileRow),
      group(
        'Security',
        null,
        user?.offline
          ? row('Password', 'Offline sessions do not use a password.', el('span', { class: 'badge' }, 'Offline mode'))
          : row('Password', 'Change the password used to sign in to this launcher.', pwBtn),
        row('Membership', user?.tier === 'plus' ? 'BlackNight+ is active on this account.' : 'You are on the Standard plan.', membership)
      ),
      group('Session', null, row('Sign out', 'Ends this session on this machine.', outBtn))
    ];
  }

  function privacySection() {
    const resetBtn = el('button', { class: 'btn btn-sm btn-danger' });
    resetBtn.innerHTML = `${icon('refresh')} Reset settings`;
    resetBtn.addEventListener('click', async () => {
      const yes = await BN.ui.confirm({
        title: 'Reset all settings?',
        message: 'Every preference returns to its default. Your account, library and installed games are untouched.',
        confirmLabel: 'Reset',
        danger: true
      });
      if (!yes) return;
      await BN.api.settings.reset();
      await BN.state.loadSettings();
      BN.ui.toast('Settings reset', 'Defaults restored.', { kind: 'ok' });
      render();
    });

    return [
      group(
        'Presence and data',
        'BlackNight keeps this local unless you turn it on.',
        toggle('richPresence', 'Share what I am playing', 'Shows your current title to friends.'),
        toggle('shareStats', 'Send anonymous usage data', 'Crash reports and performance counters only. Never account details.'),
        toggle('rememberMe', 'Stay signed in', 'Keeps your session on this machine between launches.')
      ),
      group(
        'Local data',
        `Accounts, settings and install records are stored on this machine${appInfo?.dataDir ? ` at ${appInfo.dataDir}` : ''}.`,
        row(
          'Open data folder',
          'Inspect or back up the launcher data directory.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('folder')} Open`;
            b.addEventListener('click', () => BN.api.app.openPath(appInfo?.dataDir));
            return b;
          })()
        ),
        row('Reset preferences', 'Restores every setting to its default value.', resetBtn)
      )
    ];
  }

  function shortcutsSection() {
    const KEYS = [
      ['Ctrl K', 'Open the command palette'],
      ['Ctrl 1', 'Go to Games'],
      ['Ctrl 2', 'Go to Store'],
      ['Ctrl 3', 'Go to BlackNight+'],
      ['Ctrl 4', 'Go to Downloads'],
      ['Ctrl ,', 'Open Settings'],
      ['Ctrl B', 'Collapse or expand the sidebar'],
      ['Ctrl F', 'Search the store'],
      ['F11', 'Toggle fullscreen'],
      ['Esc', 'Close the current dialog']
    ];
    const table = el('div');
    for (const [key, label] of KEYS) {
      table.append(
        row(
          label,
          null,
          el(
            'div',
            { class: 'row', style: { gap: '5px' } },
            ...key.split(' ').map((k) => el('kbd', {}, k))
          )
        )
      );
    }
    return [group('Keyboard shortcuts', 'Everything reachable without the mouse.', table)];
  }

  function aboutSection() {
    const node = el('div', { class: 'set-group' });
    node.innerHTML = `
      <div style="padding:34px;text-align:center">
        <div id="about-mark" style="display:grid;place-items:center;margin-bottom:18px"></div>
        <h2 class="display chrome-text" style="font-size:1.6rem;letter-spacing:.22em">BlackNight</h2>
        <div class="eyebrow" style="margin-top:6px">Launcher ${esc(appInfo?.version || '1.0.0')}</div>
        <p class="mute" style="max-width:44ch;margin:18px auto 0;font-size:.84rem;line-height:1.7">
          Built for BlackNight Studios. One launcher for every title the studio ships,
          designed to stay out of the way until the moment you press play.
        </p>
      </div>
      <div style="padding:0 22px 22px">
        <dl class="kv" style="max-width:420px;margin:0 auto">
          <dt>Launcher</dt><dd>${esc(appInfo?.version || '1.0.0')}</dd>
          <dt>Runtime</dt><dd>Electron ${esc(appInfo?.electron || 'n/a')}</dd>
          <dt>Chromium</dt><dd>${esc(appInfo?.chrome || 'n/a')}</dd>
          <dt>Node</dt><dd>${esc(appInfo?.node || 'n/a')}</dd>
          <dt>Platform</dt><dd>${esc(appInfo?.platform || '')} ${esc(appInfo?.arch || '')}</dd>
          <dt>Catalogue</dt><dd>${BN.state.data.catalog.games.length} titles · updated ${esc(BN.state.data.catalog.updated || '')}</dd>
        </dl>
      </div>`;

    const entries = [
      ['Website', 'website'],
      ['Support', 'support'],
      ['Careers', 'careers']
    ].filter(([, key]) => BN.util.hasLink(key));

    if (entries.length) {
      const links = el('div', { class: 'row', style: { gap: '8px', justifyContent: 'center', padding: '0 22px 26px' } });
      for (const [label, key] of entries) {
        const b = el('button', { class: 'btn btn-sm btn-ghost' });
        b.innerHTML = `${icon('external')} ${esc(label)}`;
        b.addEventListener('click', () => BN.api.app.openExternal(BN.util.link(key)));
        links.append(b);
      }
      node.append(links);
    }

    setTimeout(() => {
      const mark = node.querySelector('#about-mark');
      if (mark) mark.innerHTML = BN.art.logo(108).replace('<svg ', '<svg class="about-mark" ');
    }, 0);

    return [node, updatesGroup()];
  }

  /* --- Launcher updates ------------------------------------------------- */

  /** Wording for each state the updater can report. */
  const UPDATE_COPY = {
    unsupported: () => ['Updates', 'Automatic updates apply to installed builds only.'],
    idle: () => ['Up to date', 'The launcher checks for a new version shortly after it starts.'],
    checking: () => ['Checking...', 'Asking the update server what the latest version is.'],
    none: () => ['Up to date', 'You are running the newest version.'],
    available: (st) => [`Version ${st.version} is available`, 'Download it now and it installs the next time you quit.'],
    downloading: (st) => ['Downloading update', `${Math.round((st.progress || 0) * 100)}% complete.`],
    ready: (st) => [`Version ${st.version} is ready`, 'Restart the launcher to finish installing.'],
    error: (st) => ['Could not check for updates', st.error || 'The update server did not respond.']
  };

  function updatesGroup() {
    const node = el('div', { class: 'set-group' });
    node.innerHTML = `<header><h3>Launcher updates</h3></header>`;
    const row = el('div', { class: 'set-row' });
    node.append(row);

    const paint = (st) => {
      const [title, desc] = (UPDATE_COPY[st.status] || UPDATE_COPY.idle)(st);
      row.innerHTML = `<div class="grow"><div class="label">${esc(title)}</div><div class="desc">${esc(desc)}</div></div>`;
      const control = el('div', { class: 'control' });

      const button = (label, cls, fn) => {
        const b = el('button', { class: `btn btn-sm ${cls}` }, label);
        b.addEventListener('click', async () => {
          b.disabled = true;
          paint(await fn());
        });
        return b;
      };

      if (st.status === 'available') control.append(button('Download', 'btn-accent', () => BN.api.updates.download()));
      else if (st.status === 'ready') control.append(button('Restart now', 'btn-accent', async () => {
        await BN.api.updates.install();
        return st;
      }));
      else if (st.status !== 'unsupported' && st.status !== 'checking' && st.status !== 'downloading') {
        control.append(button('Check now', 'btn-ghost', () => BN.api.updates.check()));
      }

      row.append(control);
    };

    BN.api.updates.get().then(paint);
    // Progress and background checks arrive without anyone pressing a button.
    BN.api.updates.onState(paint);
    return node;
  }

  /* --- Dialogs ---------------------------------------------------------- */

  function editProfile() {
    const user = BN.state.data.user;
    const body = el('div');
    body.innerHTML = `
      <div class="field">
        <label class="field-label" for="pf-name">Display name</label>
        <div class="input-wrap"><input class="input" id="pf-name" value="${esc(user?.displayName || '')}" maxlength="40"></div>
      </div>`;
    BN.ui.modal({
      title: 'Edit profile',
      content: body,
      footer: [
        { label: 'Cancel', class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Save',
          class: 'btn-accent',
          onClick: async ({ close }) => {
            const result = await BN.state.updateProfile({ displayName: body.querySelector('#pf-name').value });
            BN.ui.toast(result.ok ? 'Profile updated' : 'Could not save', result.error || '', { kind: result.ok ? 'ok' : 'error' });
            if (result.ok) {
              close();
              render();
            }
          }
        }
      ]
    });
  }

  function changePassword() {
    const body = el('div', { class: 'col', style: { gap: '16px' } });
    body.innerHTML = `
      <div class="field">
        <label class="field-label" for="cp-current">Current password</label>
        <div class="input-wrap">${icon('lock')}<input class="input" id="cp-current" type="password" autocomplete="current-password"></div>
      </div>
      <div class="field">
        <label class="field-label" for="cp-next">New password</label>
        <div class="input-wrap">${icon('lock')}<input class="input" id="cp-next" type="password" autocomplete="new-password"></div>
      </div>
      <div id="cp-error"></div>`;

    BN.ui.modal({
      title: 'Change password',
      content: body,
      footer: [
        { label: 'Cancel', class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Update',
          class: 'btn-accent',
          onClick: async ({ close }) => {
            const result = await BN.api.auth.changePassword(BN.state.data.user.id, {
              current: body.querySelector('#cp-current').value,
              next: body.querySelector('#cp-next').value
            });
            if (!result.ok) {
              body.querySelector('#cp-error').innerHTML = `<div class="field-error">${esc(result.error)}</div>`;
              BN.sound?.play('error');
              return;
            }
            BN.ui.toast('Password updated', 'Use the new password next time you sign in.', { kind: 'ok' });
            close();
          }
        }
      ]
    });
  }

  /* --- Render ----------------------------------------------------------- */

  async function render() {
    const view = document.getElementById('view-settings');
    if (!view) return;
    if (!appInfo) appInfo = await BN.api.app.info();

    view.innerHTML = `
      <div class="view-pad">
        <div class="section-head" style="margin-bottom:24px">
          <div><h2>Settings</h2><div class="sub">Changes apply immediately</div></div>
        </div>
        <div class="settings-layout">
          <nav class="settings-nav">
            ${SECTIONS.map(
              (s) => `<button data-section="${s.id}" aria-current="${s.id === section}">${icon(s.icon)} ${esc(s.label)}</button>`
            ).join('')}
          </nav>
          <div class="settings-panel" id="settings-panel"></div>
        </div>
      </div>`;

    view.querySelectorAll('[data-section]').forEach((btn) =>
      btn.addEventListener('click', () => {
        section = btn.dataset.section;
        view.querySelectorAll('[data-section]').forEach((b) => b.setAttribute('aria-current', String(b === btn)));
        paintPanel();
      })
    );

    paintPanel();
  }

  function paintPanel() {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    const builders = {
      general: generalSection,
      appearance: appearanceSection,
      downloads: downloadsSection,
      account: accountSection,
      privacy: privacySection,
      shortcuts: shortcutsSection,
      about: aboutSection
    };
    panel.innerHTML = '';
    panel.style.animation = 'none';
    void panel.offsetWidth;
    panel.style.animation = 'rise-in-sm 340ms var(--ease-out)';
    for (const node of builders[section]()) panel.append(node);
  }

  BN.views = BN.views || {};
  BN.views.settings = {
    render,
    go(next) {
      section = next || 'general';
      render();
    }
  };
})();
