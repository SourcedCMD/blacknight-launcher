/* =========================================================================
   First run.

   Three decisions, asked once: where games go, what the launcher looks like,
   and whether it makes noise. Each one is a setting the user would otherwise
   have to go hunting for - and the accent step is the only chance most people
   will ever get to discover that six of them exist.

   Writes `onboarded` when it finishes, which is the flag that keeps it from
   ever showing again.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc } = BN.util;
  const icon = BN.icon;

  const ACCENTS = [
    { id: 'moonlight', label: 'Moonlight', color: '#8fb8ff' },
    { id: 'eclipse', label: 'Eclipse', color: '#d5dcec' },
    { id: 'bloodmoon', label: 'Blood Moon', color: '#ff5163' },
    { id: 'nebula', label: 'Nebula', color: '#a97bff' },
    { id: 'toxic', label: 'Toxic', color: '#7dffa8' },
    { id: 'ember', label: 'Ember', color: '#ffab3d' }
  ];

  let step = 0;

  const STEPS = [installStep, lookStep, soundStep];

  /* --- Steps ------------------------------------------------------------ */

  function installStep() {
    const dir = BN.state.data.settings.installDir || '';
    const node = el('div');
    node.innerHTML = `
      <p class="ob-lead">Games can be large. Pick the drive with room to spare &mdash;
      you can move this later in Settings.</p>
      <div class="field" style="margin-top:18px">
        <label class="field-label">Install folder</label>
        <div class="path-box"><span id="ob-dir">${esc(dir)}</span></div>
        <span class="field-hint">Avoid folders that sync to the cloud; games do not belong in OneDrive.</span>
      </div>`;

    const browse = el('button', { class: 'btn btn-sm btn-ghost', style: { marginTop: '12px' } });
    browse.innerHTML = `${icon('folder')} Choose another folder`;
    browse.addEventListener('click', async () => {
      const picked = await BN.api.app.chooseDirectory(dir);
      if (!picked) return;
      await BN.state.setSettings({ installDir: picked });
      node.querySelector('#ob-dir').textContent = picked;
    });
    node.append(browse);
    return { title: 'Where should games go?', node };
  }

  function lookStep() {
    const node = el('div');
    node.innerHTML = `<p class="ob-lead">Pick an accent. Everything from buttons to the
      background glow follows it, and you can change it any time.</p>`;

    const grid = el('div', { class: 'ob-accents' });
    const current = BN.state.data.settings.accent;

    for (const accent of ACCENTS) {
      const swatch = el('button', {
        class: `ob-accent${accent.id === current ? ' active' : ''}`,
        type: 'button',
        'data-accent': accent.id,
        'aria-label': accent.label
      });
      swatch.innerHTML = `<span class="dot" style="background:${accent.color}"></span><span>${esc(accent.label)}</span>`;
      swatch.addEventListener('click', async () => {
        grid.querySelectorAll('.ob-accent').forEach((n) => n.classList.remove('active'));
        swatch.classList.add('active');
        // Applied immediately: the point of this step is seeing the change.
        await BN.state.setSettings({ accent: accent.id });
        BN.sound?.play('click');
      });
      grid.append(swatch);
    }

    node.append(grid);
    return { title: 'Make it yours', node };
  }

  function soundStep() {
    const settings = BN.state.data.settings;
    const node = el('div');
    node.innerHTML = `<p class="ob-lead">The launcher has a quiet set of interface sounds
      and a live background. Both can be turned down if you would rather they were not there.</p>`;

    const row = (label, desc, key, value) => {
      const wrap = el('label', { class: 'ob-toggle' });
      wrap.innerHTML = `
        <span class="grow"><span class="ob-toggle-label">${esc(label)}</span>
        <span class="ob-toggle-desc">${esc(desc)}</span></span>
        <input type="checkbox" ${value ? 'checked' : ''}>`;
      wrap.querySelector('input').addEventListener('change', async (e) => {
        await BN.state.setSettings({ [key]: e.target.checked });
        if (key === 'uiSounds' && e.target.checked) BN.sound?.play('success');
      });
      return wrap;
    };

    node.append(
      row('Interface sounds', 'Soft clicks and confirmations.', 'uiSounds', settings.uiSounds),
      row('Animated background', 'The drifting night sky behind every view.', 'backgroundFx', settings.backgroundFx !== 'off')
    );
    return { title: 'Sound and motion', node };
  }

  /* --- Shell ------------------------------------------------------------ */

  function paint() {
    const { title, node } = STEPS[step]();
    const body = el('div', { class: 'ob' });

    const dots = el('div', { class: 'ob-dots' });
    STEPS.forEach((_, i) =>
      dots.append(el('span', { class: `ob-dot${i === step ? ' active' : ''}${i < step ? ' done' : ''}` }))
    );

    body.append(node, dots);

    BN.ui.modal({
      title,
      content: body,
      chrome: true,
      onClose: finish,
      footer: [
        step > 0
          ? { label: 'Back', class: 'btn-ghost', onClick: () => { step--; paint(); } }
          : { label: 'Skip', class: 'btn-ghost', onClick: finish },
        {
          label: step === STEPS.length - 1 ? 'Start playing' : 'Next',
          class: 'btn-accent',
          onClick: () => {
            if (step === STEPS.length - 1) {
              finish();
              BN.ui.closeModal();
              return;
            }
            step++;
            paint();
          }
        }
      ]
    });
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    BN.state.setSettings({ onboarded: true });
  }

  /** Runs the flow if this account has never seen it. */
  function maybeRun() {
    if (BN.state.data.settings.onboarded) return false;
    step = 0;
    finished = false;
    // Let the shell settle first, so the reveal animation is not fighting it.
    setTimeout(paint, 700);
    return true;
  }

  BN.onboarding = { maybeRun, run: () => { step = 0; finished = false; paint(); } };
})();
