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
      ),
      group(
        'Save data',
        'Snapshots stay on this machine; nothing is uploaded.',
        toggle('backupSaves', 'Back up saves when a game closes', 'Keeps the most recent few versions, so a corrupt save is recoverable.'),
        slider('saveBackupsKept', 'Snapshots kept per title', null, { min: 1, max: 20, step: 1, format: (v) => `${v}` })
      ),
      group(
        'History',
        'Recorded on this machine, never uploaded.',
        toggle('playJournal', 'Keep a play journal', 'One line per session, with room for a note.'),
        toggle('sessionInsights', 'Show session insights', 'Tells you how long your sessions here usually run.'),
        row(
          'Play journal',
          'Every session recorded so far.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('clock')} Open`;
            b.addEventListener('click', () => BN.views.journal.open());
            return b;
          })()
        ),
        row(
          'Achievements',
          'Earned from how you use the launcher.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('award')} View`;
            b.addEventListener('click', () => BN.views.achievements.open());
            return b;
          })()
        ),
        row(
          'Your year in the dark',
          'A poster generated from this year of play.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('sparkles')} View`;
            b.addEventListener('click', () => BN.views.journal.yearInReview());
            return b;
          })()
        )
      ),
      group(
        'Launcher updates',
        'Applies to the launcher itself, not to games.',
        toggle(
          'betaChannel',
          'Take beta builds of the launcher',
          'Prerelease versions arrive first, so problems are found before everyone sees them. Restart to apply.'
        )
      ),
      group(
        'Move to another machine',
        'Over your local network. Accounts and passwords never travel.',
        row(
          'Send my setup',
          'Shows a code and a QR for the machine you are moving to.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('external')} Send`;
            b.addEventListener('click', () => BN.views.handoff.send());
            return b;
          })()
        ),
        row(
          'Bring my setup across',
          'Enter the code shown on the other machine.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('download')} Receive`;
            b.addEventListener('click', () => BN.views.handoff.receive());
            return b;
          })()
        )
      ),
      group('Setup', null, replayOnboardingRow())
    ];
  }

  /**
   * The two accents that have to be earned.
   *
   * Shown locked rather than hidden: an accent nobody knows exists is not a
   * reward, and the swatch says exactly what unlocks it.
   */
  function earnedAccents(swatches) {
    BN.ambient.accentState().then((accents) => {
      for (const accent of accents) {
        const swatch = el('button', {
          class: 'swatch' + (accent.unlocked ? '' : ' locked'),
          role: 'radio',
          'aria-checked': String(BN.state.data.settings.accent === accent.id),
          'aria-label': accent.unlocked ? accent.label : accent.label + ' - locked',
          'data-tip': accent.unlocked ? accent.label : accent.how,
          disabled: !accent.unlocked,
          style: { color: accent.color }
        });
        swatch.addEventListener('click', () => {
          if (!accent.unlocked) {
            BN.ui.toast(accent.label + ' is locked', accent.how, { kind: 'info', ms: 5000 });
            return;
          }
          BN.state.setSettings({ accent: accent.id });
          render();
        });
        swatches.append(swatch);
      }
    });
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

    // Appended after the six standard accents, so the earned ones read as
    // something beyond the set rather than gaps in it.
    earnedAccents(swatches);

    return [
      group('Theme', 'BlackNight is built for the dark. Pick the accent that carries it.', row('Accent colour', 'Used across highlights, progress and focus states.', swatches)),
      group(
        'Atmosphere',
        'The launcher draws itself from your library and the clock.',
        toggle('libraryConstellation', 'Show my library as a constellation', 'Each title becomes a star: brighter the more recently you played it.', () =>
          BN.fx.setLibrary(BN.state.data.library)
        ),
        toggle('timeOfDayTint', 'Follow the time of day', 'Shifts the background from dusk through to deep night.', () =>
          BN.app.paintTimeOfDay()
        ),
        toggle('launchRitual', 'Play the launch sequence', 'A short title card when a game starts.'),
        toggle('titleSignatures', 'Give each title its own sound', 'Derives a launch sting from the game, not a single shared cue.')
      ),
      group(
        'Window',
        'Windows 11 draws its own material behind the launcher.',
        select('windowMaterial', 'Background material', 'Takes effect when the launcher restarts.', [
          ['mica', 'Mica (follows your wallpaper)'],
          ['acrylic', 'Acrylic (blurred)'],
          ['none', 'Solid']
        ]),
        toggle('viewTransitions', 'Animate between pages', 'Cross-fades when moving between Games, Store and the rest.'),
        toggle('attractMode', 'Show a screensaver when idle', 'After a few quiet minutes the launcher becomes a dashboard.'),
        // Reads install manifests Steam, Epic, GOG and Xbox already wrote to
        // disk. Off until asked for, and the main process re-checks this
        // setting itself rather than trusting the request.
        toggle('detectOtherLaunchers', 'Show games from other launchers',
          'Finds what Steam, Epic, GOG and Xbox have installed so your library is the whole machine. Read only, and nothing leaves this PC.',
          () => BN.util.bus.emit('foreign-changed')),

        toggle('sessionGhost', 'Show how long this run is going',
          'A quiet bar comparing the session you are in with your own usual one for that title.'),

        // Empty is the default and means the launcher never raises it. Anyone
        // who wants the nudge can pick their own hour; nobody gets it uninvited.
        select('windDownHour', 'Mention the hour after',
          'Says once, gently, that it is late. It never stops you playing.',
          [['', 'Never'], ['21', '21:00'], ['22', '22:00'], ['23', '23:00'], ['0', 'Midnight'], ['1', '01:00']]),

        // Art is memoised by its options, and this setting changes what those
        // options are. Without dropping the drawn copies the change would only
        // show on titles that happened to have been evicted. Nothing needs
        // repainting here - no art is on screen - and the library redraws from
        // an empty cache the next time it is opened.
        toggle('evolvingArt', 'Let art grow with playtime', 'A title you have lived in gains sky the more you play it.',
          () => BN.art.keyArt.clearCache()),
        select('handheldMode', 'Handheld layout', 'Larger controls and fewer columns, for a Deck or a small screen.', [
          ['auto', 'Automatic'],
          ['on', 'Always on'],
          ['off', 'Off']
        ], () => BN.app.applyHandheldMode())
      ),
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
      group('Library folders', 'Install to more than one drive.', foldersRow()),
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
        toggle('pauseOnMetered', 'Pause on metered connections', 'Stops large downloads eating a mobile data allowance.'),
        toggle(
          'yieldWhilePlaying',
          'Slow downloads while a game is running',
          'A queue that starves the game you are playing is worse than a queue that finishes late.'
        ),
        slider('playingBandwidthPercent', 'Speed while playing', 'Share of the limit downloads may use mid-session.', {
          min: 5,
          max: 100,
          step: 5,
          format: (v) => `${v}%`
        })
      ),
      group('Schedule', 'Hold transfers until the small hours.', ...windowRows()),
      group(
        'Transfer savings',
        'Both trade a little local work for a lot less downloading.',
        toggle('deltaPatching', 'Patch updates block by block', 'An update transfers only the parts of a build that actually changed.'),
        toggle('keepPakOnUninstall', 'Keep game files after uninstalling', 'Reinstalling then costs a checksum pass instead of the whole download.'),
        toggle('keepRollback', 'Keep the previous build after an update', 'Lets a bad patch be rolled back in seconds instead of re-downloaded.'),
        lanRow(),
        toggle('sharePlaying', 'Show what I am playing on this network', 'Other launchers here see the title and how long, nothing else.'),
        remoteRow()
      ),
      group('Data used', 'Counted per month, on this machine only.', usageRows()),
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
        ),
        toggle(
          'backgroundVerify',
          'Check installed files in the background',
          'One title at a time while nothing is playing, so corruption is found before you hit it.'
        ),
        row(
          'Free up space',
          'Shows what is installed, least-played first.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('trash')} Review`;
            b.addEventListener('click', reviewStorage);
            return b;
          })()
        )
      )
    ];
  }

  /**
   * Standalone version of the reclaim picker, for when someone is tidying up
   * rather than reacting to a failed install.
   */
  async function reviewStorage() {
    const items = await BN.api.library.reclaimable();
    if (!items.length) {
      BN.ui.toast('Nothing installed', 'There is nothing taking up space yet.', { kind: 'info' });
      return;
    }

    const body = el('div');
    body.innerHTML = `<p class="dim" style="line-height:1.7">Never-played and long-idle titles first.</p>`;
    const list = el('div', { class: 'col', style: { gap: '8px', marginTop: '14px' } });

    for (const item of items) {
      const idle =
        item.playtimeSeconds === 0
          ? 'never played'
          : item.idleDays === null
            ? 'not played recently'
            : `idle ${item.idleDays} days`;
      const rowNode = el('label', { class: 'reclaim-row' });
      rowNode.innerHTML = `
        <input type="checkbox" data-game="${esc(item.gameId)}" data-size="${item.sizeBytes}">
        <span class="grow">
          <span class="reclaim-title">${esc(item.title)}</span>
          <span class="reclaim-meta">${esc(idle)}</span>
        </span>
        <span class="mono">${esc(bytes(item.sizeBytes))}</span>`;
      list.append(rowNode);
    }

    const tally = el('div', { class: 'reclaim-tally', text: 'Select titles to free space' });
    list.append(tally);
    list.addEventListener('change', () => {
      const freed = [...list.querySelectorAll('input:checked')].reduce((sum, i) => sum + Number(i.dataset.size), 0);
      tally.textContent = freed ? `Frees ${bytes(freed)}` : 'Select titles to free space';
      tally.classList.toggle('enough', freed > 0);
    });
    body.append(list);

    BN.ui.modal({
      title: 'Free up space',
      content: body,
      footer: [
        { label: 'Close', class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Uninstall selected',
          class: 'btn-danger',
          onClick: async ({ close, body: root }) => {
            const picked = [...root.querySelectorAll('input:checked')].map((i) => i.dataset.game);
            if (!picked.length) return;
            close();
            for (const id of picked) await BN.state.uninstall(id);
            BN.ui.toast('Space reclaimed', `${picked.length} title${picked.length > 1 ? 's' : ''} removed.`, { kind: 'ok' });
            render();
          }
        }
      ]
    });
  }

  /**
   * Every folder games may install into.
   *
   * A small SSD and a large HDD is the ordinary PC; one install path was never
   * going to be enough.
   */
  function foldersRow() {
    const node = el('div', { class: 'set-row stack' });

    const paint = (folders) => {
      node.innerHTML = '';
      const list = el('div', { class: 'col', style: { gap: '8px', width: '100%' } });

      for (const folder of folders) {
        const item = el('div', { class: 'folder-row' });
        const free = folder.freeBytes === null ? '' : BN.t('folders.freeSpace', { free: bytes(folder.freeBytes) });
        item.innerHTML = `
          ${icon('drive')}
          <span class="grow">
            <span class="folder-path mono">${esc(folder.dir)}</span>
            <span class="folder-meta">
              ${folder.primary ? `<span class="badge badge-accent">${esc(BN.t('folders.primary'))}</span>` : ''}
              ${esc(BN.t('folders.installedCount', { count: folder.installed }))}
              ${folder.usedBytes ? ` · ${esc(bytes(folder.usedBytes))} used` : ''}
              ${free ? ` · ${esc(free)}` : ''}
            </span>
          </span>`;

        if (!folder.primary) {
          const remove = el('button', { class: 'btn btn-sm btn-ghost btn-icon', 'aria-label': 'Remove folder' });
          remove.innerHTML = icon('x');
          remove.addEventListener('click', async () => {
            const result = await BN.api.library.removeFolder(folder.dir);
            if (!result.ok) return BN.ui.toast('Cannot remove that folder', result.error, { kind: 'warn' });
            paint(result.folders);
          });
          item.append(remove);
        }
        list.append(item);
      }

      const add = el('button', { class: 'btn btn-sm btn-ghost', style: { marginTop: '10px', alignSelf: 'flex-start' } });
      add.innerHTML = `${icon('folder')} ${esc(BN.t('folders.add'))}`;
      add.addEventListener('click', async () => {
        const result = await BN.api.library.addFolder();
        if (result.cancelled) return;
        if (!result.ok) return BN.ui.toast('Cannot use that folder', result.error, { kind: 'warn' });
        paint(result.folders);
        BN.ui.toast('Library folder added', '', { kind: 'ok', ms: 2600 });
      });

      node.append(list, add);
    };

    paint([]);
    BN.api.library.folders().then(paint);
    return node;
  }

  /**
   * What has actually crossed the connection, by month.
   *
   * The launcher throttles, schedules and yields bandwidth but never showed a
   * number - which is the one thing someone on a metered line wants. Blocks
   * reused from a previous build are shown separately, because they are the
   * bytes the delta patcher saved.
   */
  function usageRows() {
    const node = el('div', { class: 'set-row stack' });

    const paint = (months) => {
      node.innerHTML = '';
      if (!months.length) {
        node.append(el('div', { class: 'field-hint', text: 'Nothing downloaded yet.' }));
        return;
      }

      const peak = Math.max(...months.map((m) => (m.origin || 0) + (m.peer || 0) + (m.reused || 0)), 1);
      const list = el('div', { class: 'col', style: { width: '100%' } });

      for (const month of months) {
        const row = el('div', { class: 'usage-row' });
        const pct = (v) => ((v || 0) / peak) * 100;
        row.innerHTML = `
          <span class="usage-month">${esc(month.month)}</span>
          <span class="usage-bar">
            <i class="origin" style="width:${pct(month.origin)}%"></i>
            <i class="peer" style="width:${pct(month.peer)}%"></i>
            <i class="reused" style="width:${pct(month.reused)}%"></i>
          </span>
          <span class="usage-total">${esc(bytes(month.total || 0))}</span>`;
        list.append(row);
      }

      const key = el('div', { class: 'usage-key' });
      key.innerHTML = `
        <span><i style="background:var(--accent)"></i> Downloaded</span>
        <span><i style="background:var(--ok)"></i> From a peer</span>
        <span><i style="background:var(--text-faint)"></i> Reused locally</span>`;

      node.append(list, key);
    };

    paint([]);
    BN.api.library.dataUsage().then(paint);
    return node;
  }

  /**
   * LAN sharing, reporting how many machines it can actually see.
   *
   * It touches the network, so it stays opt-in and says plainly what it does.
   */
  function lanRow() {
    const node = el('div', { class: 'set-row' });

    const paint = (status) => {
      const found = status.peers
        ? `${status.peers} launcher${status.peers === 1 ? '' : 's'} on this network`
        : 'No other launchers found yet.';
      node.innerHTML = `
        <div class="grow">
          <div class="label">Share installs over the local network</div>
          <div class="desc">${status.enabled ? esc(found) : 'Downloads the same build twice when another machine here already has it.'}</div>
        </div>`;

      const control = el('div', { class: 'control' });
      const box = el('button', {
        class: 'switch',
        role: 'switch',
        'aria-checked': String(!!status.enabled),
        'aria-label': 'Share installs over the local network'
      });
      box.addEventListener('click', async () => {
        await BN.api.peers.setEnabled(!status.enabled);
        paint(await BN.api.peers.status());
      });
      control.append(box);
      node.append(control);
    };

    paint({ enabled: false, peers: 0 });
    BN.api.peers.status().then(paint);
    return node;
  }

  /**
   * Sharing beyond the local network.
   *
   * Needs a rendezvous for two launchers to exchange connection details. With
   * none configured the switch is disabled and the row says why, rather than
   * offering something that cannot work.
   */
  function remoteRow() {
    const node = el('div', { class: 'set-row' });

    const paint = (status) => {
      node.innerHTML = '';
      const desc = !status.configured
        ? 'No rendezvous is configured for this build, so this stays off.'
        : status.connected
          ? 'Connected. Builds can be shared with friends outside your network.'
          : 'Waiting for the rendezvous.';

      node.innerHTML = '<div class="grow"><div class="label">Share with friends anywhere</div>' +
        '<div class="desc">' + esc(desc) + '</div></div>';

      const control = el('div', { class: 'control' });
      const box = el('button', {
        class: 'switch',
        role: 'switch',
        'aria-checked': String(!!status.enabled),
        'aria-label': 'Share with friends anywhere',
        disabled: !status.configured
      });
      box.addEventListener('click', async () => {
        paint(await BN.rendezvous.setEnabled(!status.enabled));
      });
      control.append(box);
      node.append(control);
    };

    paint(BN.rendezvous.status());
    return node;
  }

  /** Download window controls, hidden until the window is switched on. */
  function windowRows() {
    const settings = BN.state.data.settings;
    const hours = Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, '0')}:00`]);

    const rows = [
      toggle('downloadWindowEnabled', 'Only download during a set window', 'Outside it the queue waits, and resumes on its own.', () => render())
    ];

    if (settings.downloadWindowEnabled) {
      rows.push(
        select('downloadWindowStart', 'Start', null, hours),
        select('downloadWindowEnd', 'End', 'A window that ends before it starts runs overnight.', hours)
      );
    }
    return rows;
  }

  /** Lets someone see the first-run flow again, mostly to change the accent. */
  function replayOnboardingRow() {
    const b = el('button', { class: 'btn btn-sm btn-ghost' });
    b.innerHTML = `${icon('sparkles')} Run setup`;
    b.addEventListener('click', () => BN.onboarding?.run());
    return row('First-run setup', 'Walk through install folder, accent and sound again.', b);
  }

  /**
   * The OBS browser source, with the URL to paste once it is running.
   */
  function overlayRow() {
    const node = el('div', { class: 'set-row stack' });

    const paint = (status) => {
      node.innerHTML = `
        <div class="between" style="margin-bottom:10px;width:100%">
          <div class="grow">
            <div class="label">Now-playing source for OBS</div>
            <div class="desc">A transparent page showing what you are playing, for a browser source.</div>
          </div>
        </div>`;

      const row = el('div', { class: 'row', style: { gap: '8px', width: '100%' } });
      const box = el('button', {
        class: 'switch',
        role: 'switch',
        'aria-checked': String(!!status.enabled),
        'aria-label': 'Now-playing source for OBS'
      });
      box.addEventListener('click', async () => {
        const next = await BN.api.overlay.setEnabled(!status.enabled);
        paint({ enabled: next.enabled, url: next.url });
      });
      row.append(box);

      if (status.enabled && status.url) {
        const field = el('div', { class: 'path-box', style: { flex: '1' } });
        field.innerHTML = `${icon('external')}<span class="mono">${esc(status.url)}</span>`;
        const copy = el('button', { class: 'btn btn-sm btn-ghost' });
        copy.innerHTML = `${icon('copy')} Copy`;
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(status.url);
            BN.ui.toast('Copied', 'Paste it into an OBS browser source.', { kind: 'ok', ms: 2600 });
          } catch {
            BN.ui.toast('Could not copy', status.url, { kind: 'warn' });
          }
        });
        row.append(field, copy);
      }

      node.append(row);
    };

    paint({ enabled: false });
    BN.api.overlay.status().then(paint);
    return node;
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
        row('Membership', user?.tier === 'plus' ? 'BlackNight+ is active on this account.' : 'You are on the Standard plan.', membership),
        passkeyRow()
      ),
      group('Session', null, row('Sign out', 'Ends this session on this machine.', outBtn))
    ];
  }

  /**
   * Passkeys, and an honest account of what they currently do.
   *
   * Three ways this can be unavailable and the row states the actual one. When
   * it is available, the description still says that signing in with a passkey
   * is not offered yet - because the server stores the credential but does not
   * verify a signature, and a button implying otherwise would be worse than no
   * button at all.
   */
  function passkeyRow() {
    const state = BN.passkeys.status();

    const button = el('button', { class: 'btn btn-ghost btn-sm' }, 'Add a passkey');
    button.disabled = !state.ok;

    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await BN.passkeys.add();
      button.disabled = false;

      if (result.cancelled) return;
      BN.ui.toast(
        result.ok ? 'Passkey added' : 'Could not add a passkey',
        result.ok ? 'It is stored, but sign-in still uses your password.' : result.error || '',
        { kind: result.ok ? 'ok' : 'error' }
      );
    });

    return row('Passkey', state.text, button);
  }

  /**
   * Crash reporting, which says plainly when it cannot do anything.
   *
   * Two things have to be true before anything leaves the machine: the switch
   * is on, and an endpoint is configured. With no endpoint the switch is
   * disabled and the row explains why, rather than offering a control that
   * silently does nothing.
   */
  function crashReportRow() {
    const settings = BN.state.data.settings;
    const configured = !!settings.crashReportUrl;
    const enabled = configured && settings.sendCrashReports === true;

    const node = el('div', { class: 'set-row' });
    node.innerHTML = `
      <div class="grow">
        <div class="label">Send crash reports</div>
        <div class="desc">${
          configured
            ? 'Sends the error and your launcher version when something crashes. Never your logs, paths or account details.'
            : 'No reporting endpoint is configured for this build, so nothing is ever sent.'
        }</div>
      </div>`;

    const control = el('div', { class: 'control' });
    const box = el('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(enabled),
      'aria-label': 'Send crash reports',
      disabled: !configured
    });
    box.addEventListener('click', async () => {
      const next = !BN.state.data.settings.sendCrashReports;
      await BN.state.setSettings({ sendCrashReports: next });
      box.setAttribute('aria-checked', String(next));
    });
    control.append(box);
    node.append(control);
    return node;
  }

  /**
   * Rich presence, reporting what it is actually doing.
   *
   * A toggle that silently does nothing is worse than no toggle, so this
   * reads the real connection state: whether a Discord application has been
   * configured, and whether the local client answered.
   */
  const PRESENCE_COPY = {
    unconfigured: 'No Discord application is configured for this build, so nothing is shared.',
    off: 'Your current title stays on this machine.',
    waiting: 'Waiting for Discord. Nothing is shared until it is running.',
    connected: 'Connected to Discord. Your current title shows on your profile.'
  };

  function presenceRow() {
    const node = el('div', { class: 'set-row' });

    const paint = (status) => {
      const enabled = BN.state.data.settings.richPresence && status.state !== 'unconfigured';
      node.innerHTML = `
        <div class="grow">
          <div class="label">Share what I am playing</div>
          <div class="desc">${esc(PRESENCE_COPY[status.state] || PRESENCE_COPY.off)}</div>
        </div>`;

      const control = el('div', { class: 'control' });
      const box = el('button', {
        class: 'switch',
        role: 'switch',
        'aria-checked': String(enabled),
        'aria-label': 'Share what I am playing',
        disabled: status.state === 'unconfigured'
      });
      box.addEventListener('click', async () => {
        const next = !BN.state.data.settings.richPresence;
        await BN.state.setSettings({ richPresence: next });
        paint(await BN.api.presence.setEnabled(next));
      });
      control.append(box);
      node.append(control);
    };

    paint({ state: 'off' });
    BN.api.presence.status().then(paint);
    return node;
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
        presenceRow(),
        toggle(
          'diagnosticLogs',
          'Include machine details in logs',
          'Adds your hardware and OS to the local log file so a support report is useful. Nothing is uploaded anywhere.'
        ),
        toggle('streamerMode', 'Streamer mode', 'Blurs your handle, email and library so they do not end up in a recording.', () =>
          BN.app.applyStreamerMode()
        ),
        overlayRow(),
        crashReportRow(),
        row(
          'Launcher logs',
          'What the launcher recorded on this run and the one before it.',
          (() => {
            const b = el('button', { class: 'btn btn-sm btn-ghost' });
            b.innerHTML = `${icon('folder')} Open logs`;
            b.addEventListener('click', () => BN.api.log.open());
            return b;
          })()
        ),
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
      else if (st.status === 'ready') {control.append(button('Restart now', 'btn-accent', async () => {
        await BN.api.updates.install();
        return st;
      }));}
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
