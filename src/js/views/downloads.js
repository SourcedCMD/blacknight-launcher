/* =========================================================================
   Downloads view: the queue, live throughput and per-item controls.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc, bytes, speed, duration, relative, countTo } = BN.util;
  const icon = BN.icon;

  const rowNodes = new Map();

  function render() {
    const view = document.getElementById('view-downloads');
    if (!view) return;

    view.innerHTML = `
      <div class="view-pad">
        <div class="section-head" style="margin-bottom:22px">
          <div><h2>Downloads</h2><div class="sub">Installs, updates and repairs</div></div>
          <div class="row" style="gap:8px">
            <button class="btn btn-sm btn-ghost" id="dl-pause-all">${icon('pause')} Pause all</button>
            <button class="btn btn-sm btn-ghost" id="dl-resume-all">${icon('play')} Resume all</button>
            <button class="btn btn-sm btn-ghost" id="dl-clear">${icon('trash')} Clear finished</button>
          </div>
        </div>

        <div class="dl-summary">
          <div><div class="n mono" id="sum-active">0</div><div class="l">In queue</div></div>
          <div><div class="n mono" id="sum-speed">--</div><div class="l">Throughput</div></div>
          <div><div class="n mono" id="sum-eta">--</div><div class="l">Time remaining</div></div>
          <div><div class="n mono" id="sum-installed">0</div><div class="l">Installed titles</div></div>
        </div>

        <div class="col" style="gap:12px" id="dl-list"></div>
      </div>`;

    view.querySelector('#dl-pause-all').addEventListener('click', async () => {
      for (const d of BN.state.activeDownloads()) if (d.status !== 'paused') await BN.api.downloads.pause(d.id);
      await BN.state.refreshDownloads();
      await BN.state.refreshLibrary();
    });

    view.querySelector('#dl-resume-all').addEventListener('click', async () => {
      for (const d of BN.state.activeDownloads()) if (d.status === 'paused') await BN.api.downloads.resume(d.id);
      await BN.state.refreshDownloads();
      await BN.state.refreshLibrary();
    });

    view.querySelector('#dl-clear').addEventListener('click', async () => {
      await BN.api.downloads.clearFinished();
      await BN.state.refreshDownloads();
      paint();
    });

    paint();
  }

  /* --------------------------------------------------------------------- */

  function paint() {
    const view = document.getElementById('view-downloads');
    if (!view) return;
    const list = view.querySelector('#dl-list');
    if (!list) return;

    const downloads = BN.state.data.downloads;
    rowNodes.clear();
    list.innerHTML = '';

    if (!downloads.length) {
      list.innerHTML = `
        <div class="empty">
          ${icon('download')}
          <h3>The queue is empty</h3>
          <p>Installs and updates show up here with live speed, progress and controls.</p>
        </div>`;
      const browse = el('button', { class: 'btn btn-ghost btn-sm' }, 'Browse the store');
      browse.addEventListener('click', () => BN.app.go('store'));
      list.querySelector('.empty').appendChild(browse);
    } else {
      for (const item of downloads) {
        const node = downloadRow(item);
        rowNodes.set(item.id, node);
        list.appendChild(node);
      }
    }

    updateSummary();
  }

  function downloadRow(item) {
    const game = BN.state.game(item.gameId);
    const row = el('div', { class: `dl-row${item.status === 'downloading' ? ' active' : ''}`, 'data-id': item.id });

    row.innerHTML = `
      <div class="dl-thumb">${game ? BN.art.thumb(game) : ''}</div>
      <div class="grow">
        <div class="between" style="margin-bottom:8px">
          <div>
            <div style="font-family:var(--font-display);letter-spacing:.08em;text-transform:uppercase;font-size:.92rem">${esc(item.title)}</div>
            <div class="mute" style="font-size:.74rem">
              ${esc(statusText(item))}${item.error ? ` · ${esc(item.error)}` : ''}
            </div>
          </div>
          <div class="row" style="gap:7px" data-controls></div>
        </div>
        <div class="progress${item.status === 'paused' ? ' paused' : ''}" data-progress><i style="width:${(item.progress * 100).toFixed(2)}%"></i></div>
        <div class="dl-stats" style="margin-top:9px">
          <span data-received><b>${esc(bytes(item.receivedBytes))}</b> of ${esc(bytes(item.totalBytes))}</span>
          <span data-speed>${item.status === 'downloading' ? esc(speed(item.speedBps)) : '--'}</span>
          <span data-eta>${item.status === 'downloading' ? esc(duration(item.etaSeconds)) + ' left' : ''}</span>
          <span class="grow" style="text-align:right" data-pct>${Math.round(item.progress * 100)}%</span>
        </div>
      </div>`;

    const controls = row.querySelector('[data-controls]');
    const button = (label, iconName, cls, fn) => {
      const b = el('button', { class: `btn btn-sm ${cls}`, 'data-tip': label });
      b.innerHTML = icon(iconName);
      b.addEventListener('click', fn);
      return b;
    };

    if (item.status === 'downloading' || item.status === 'queued') {
      controls.appendChild(button('Pause', 'pause', 'btn-ghost', () => BN.state.downloadAction('pause', item.id)));
    } else if (item.status === 'paused' || item.status === 'failed') {
      controls.appendChild(button('Resume', 'play', 'btn-accent', () => BN.state.downloadAction('resume', item.id)));
    }

    if (item.status === 'queued') {
      controls.appendChild(button('Move to front', 'chevronUp', 'btn-ghost', () => BN.state.downloadAction('prioritise', item.id)));
    }

    if (item.status === 'completed') {
      controls.appendChild(button('Play', 'play', 'btn-chrome', () => BN.components.runAction(BN.state.game(item.gameId))));
      controls.appendChild(button('Open folder', 'folder', 'btn-ghost', () => BN.api.app.openPath(item.dest)));
    } else {
      controls.appendChild(
        button('Cancel', 'x', 'btn-ghost', async () => {
          const yes = await BN.ui.confirm({
            title: `Cancel ${item.title}?`,
            message: 'The partially downloaded files are deleted. You can start the install again at any time.',
            confirmLabel: 'Cancel download',
            danger: true
          });
          if (yes) await BN.state.downloadAction('cancel', item.id);
        })
      );
    }

    return row;
  }

  const statusText = (item) =>
    ({
      queued: 'Waiting in queue',
      downloading: 'Downloading',
      paused: 'Paused',
      completed: `Installed ${relative(item.completedAt)}`,
      failed: 'Failed',
      cancelled: 'Cancelled'
    }[item.status] || item.status);

  /* --------------------------------------------------------------------- */
  /* Live updates - patch the existing rows rather than re-rendering        */

  function tick(list) {
    const view = document.getElementById('view-downloads');
    if (!view || !view.classList.contains('current')) {
      updateSummary();
      return;
    }

    for (const item of list) {
      const row = rowNodes.get(item.id);
      if (!row) return paint(); // queue shape changed - full repaint
      row.querySelector('[data-progress] i').style.width = `${(item.progress * 100).toFixed(2)}%`;
      row.querySelector('[data-progress]').classList.toggle('paused', item.status === 'paused');
      row.querySelector('[data-received]').innerHTML = `<b>${esc(bytes(item.receivedBytes))}</b> of ${esc(bytes(item.totalBytes))}`;
      row.querySelector('[data-speed]').textContent = item.status === 'downloading' ? speed(item.speedBps) : '--';
      row.querySelector('[data-eta]').textContent = item.status === 'downloading' ? `${duration(item.etaSeconds)} left` : '';
      row.querySelector('[data-pct]').textContent = `${Math.round(item.progress * 100)}%`;
    }
    updateSummary();
  }

  function updateSummary() {
    const view = document.getElementById('view-downloads');
    if (!view) return;
    const active = BN.state.activeDownloads();
    const queue = BN.state.queueProgress();

    const set = (id, value) => {
      const node = view.querySelector(id);
      if (node) node.textContent = value;
    };
    const counter = view.querySelector('#sum-active');
    if (counter) countTo(counter, active.length, { format: (n) => String(Math.round(n)) });
    set('#sum-speed', queue?.speedBps ? speed(queue.speedBps) : '--');
    set('#sum-eta', queue?.etaSeconds ? duration(queue.etaSeconds) : '--');
    const installed = view.querySelector('#sum-installed');
    if (installed) countTo(installed, BN.state.data.stats.installed || 0, { format: (n) => String(Math.round(n)) });
  }

  BN.views = BN.views || {};
  BN.views.downloads = { render, paint, tick };
})();
