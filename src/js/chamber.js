/* =========================================================================
   The Umbra test chamber.

   The easter egg used to be a static generated room, which is a picture of a
   secret rather than a secret. This makes it something you can actually play:
   steer a light through drifting debris, and the longer you last the further
   the sky opens up.

   It exists for three reasons beyond being fun. It proves Play works with
   nothing installed, it gives the store something to show that needs no
   download, and it exercises the gamepad layer with something that actually
   demands responsiveness.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const W = 900;
  const H = 560;
  const SHIP_R = 9;

  let raf = null;
  let state = null;

  function reset(seed) {
    const rand = BN.util.rng(seed);
    return {
      rand,
      seed,
      t: 0,
      ship: { x: W * 0.2, y: H / 2, vy: 0 },
      debris: [],
      motes: Array.from({ length: 70 }, () => ({
        x: rand() * W,
        y: rand() * H,
        z: rand() * 0.9 + 0.1
      })),
      score: 0,
      best: Number(localStorage.getItem('blacknight.chamber.best') || 0),
      over: false,
      // Held keys rather than key events: an event-driven ship feels sticky.
      up: false,
      down: false
    };
  }

  function spawn(s) {
    // The gap narrows slowly, so the difficulty comes from the room rather
    // than from anything speeding up to an unplayable rate.
    const gap = Math.max(120, 230 - s.score * 0.6);
    const centre = 90 + s.rand() * (H - 180);
    s.debris.push({ x: W + 40, gapY: centre, gap, passed: false });
  }

  function step(s, dt) {
    s.t += dt;

    // Movement: acceleration and drag, so it has weight without being floaty.
    const accel = 1400;
    if (s.up) s.ship.vy -= accel * dt;
    if (s.down) s.ship.vy += accel * dt;
    s.ship.vy *= Math.pow(0.0018, dt);
    s.ship.y += s.ship.vy * dt;

    if (s.ship.y < SHIP_R) { s.ship.y = SHIP_R; s.ship.vy = 0; }
    if (s.ship.y > H - SHIP_R) { s.ship.y = H - SHIP_R; s.ship.vy = 0; }

    const speed = 260 + Math.min(200, s.score * 3);
    for (const d of s.debris) {
      d.x -= speed * dt;
      if (!d.passed && d.x < s.ship.x) {
        d.passed = true;
        s.score++;
      }
      // The only way to lose: inside the column and outside the gap.
      const withinColumn = Math.abs(d.x - s.ship.x) < 26 + SHIP_R;
      const throughGap = Math.abs(s.ship.y - d.gapY) < d.gap / 2 - SHIP_R;
      if (withinColumn && !throughGap) s.over = true;
    }
    s.debris = s.debris.filter((d) => d.x > -60);

    if (!s.debris.length || s.debris[s.debris.length - 1].x < W - 260) spawn(s);

    for (const m of s.motes) {
      m.x -= (30 + m.z * 90) * dt;
      if (m.x < 0) { m.x = W; m.y = s.rand() * H; }
    }
  }

  function draw(ctx, s) {
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--accent') || '#8fb8ff').trim();

    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, W, H);

    // The sky opens the longer you survive - the same idea as art that grows.
    const openness = Math.min(1, s.score / 40);
    for (const m of s.motes) {
      ctx.globalAlpha = (0.15 + m.z * 0.5) * (0.4 + openness * 0.6);
      ctx.fillStyle = m.z > 0.7 ? '#ffffff' : '#8f9bb5';
      ctx.fillRect(m.x, m.y, 1.6 * m.z + 0.4, 1.6 * m.z + 0.4);
    }
    ctx.globalAlpha = 1;

    for (const d of s.debris) {
      ctx.fillStyle = 'rgba(20, 22, 32, 0.95)';
      ctx.strokeStyle = 'rgba(120, 135, 170, 0.35)';
      ctx.lineWidth = 1;
      ctx.fillRect(d.x - 26, 0, 52, d.gapY - d.gap / 2);
      ctx.strokeRect(d.x - 26, 0, 52, d.gapY - d.gap / 2);
      ctx.fillRect(d.x - 26, d.gapY + d.gap / 2, 52, H);
      ctx.strokeRect(d.x - 26, d.gapY + d.gap / 2, 52, H);
    }

    const glow = ctx.createRadialGradient(s.ship.x, s.ship.y, 0, s.ship.x, s.ship.y, 46);
    glow.addColorStop(0, `${accent}66`);
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(s.ship.x - 50, s.ship.y - 50, 100, 100);

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(s.ship.x, s.ship.y, SHIP_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#eef1f7';
    ctx.font = '600 30px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(String(s.score), 22, 44);
    ctx.font = '500 14px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#626b7d';
    ctx.fillText(`best ${s.best}`, 22, 66);

    if (s.over) {
      ctx.fillStyle = 'rgba(5, 5, 10, 0.82)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#eef1f7';
      ctx.font = '700 44px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(`${s.score}`, W / 2, H / 2 - 6);
      ctx.font = '500 16px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = '#9aa3b5';
      ctx.fillText(
        s.score >= s.best && s.score > 0 ? 'A new best. Space to go again.' : 'Space to go again.',
        W / 2,
        H / 2 + 30
      );
    }
  }

  function loop(ctx, last) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);

    if (!state.over) step(state, dt);
    draw(ctx, state);

    if (state.over && state.score > state.best) {
      state.best = state.score;
      try {
        localStorage.setItem('blacknight.chamber.best', String(state.best));
      } catch { /* a private window is not a reason to fail */ }
    }

    raf = requestAnimationFrame(() => loop(ctx, now));
  }

  /** Opens the chamber. Keyboard or a controller; Escape closes it. */
  function open() {
    const { el } = BN.util;
    const body = el('div', { class: 'chamber-game' });
    body.innerHTML = `
      <canvas id="chamber-canvas" width="${W}" height="${H}" aria-label="Umbra test chamber"></canvas>
      <p class="field-hint" style="margin-top:12px;text-align:center">
        Up and down, or the left stick. Nothing here is authored - the room is
        generated, like everything else in the launcher.
      </p>`;

    const canvas = body.querySelector('#chamber-canvas');
    const ctx = canvas.getContext('2d');
    state = reset(Math.floor(Math.random() * 1e9));

    const onKey = (e) => {
      if (e.key === 'ArrowUp' || e.key === 'w') state.up = e.type === 'keydown';
      if (e.key === 'ArrowDown' || e.key === 's') state.down = e.type === 'keydown';
      if (e.key === ' ' && e.type === 'keydown' && state.over) {
        state = { ...reset(Math.floor(Math.random() * 1e9)), best: state.best };
      }
      if (['ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    // The pad is polled rather than evented, same as the navigation layer.
    const pollPad = setInterval(() => {
      const pad = navigator.getGamepads?.()[0];
      if (!pad) return;
      const y = pad.axes[1] || 0;
      state.up = y < -0.35 || pad.buttons[12]?.pressed;
      state.down = y > 0.35 || pad.buttons[13]?.pressed;
      if (pad.buttons[0]?.pressed && state.over) {
        state = { ...reset(Math.floor(Math.random() * 1e9)), best: state.best };
      }
    }, 1000 / 60);

    loop(ctx, performance.now());
    BN.sound?.play('boot');

    BN.ui.modal({
      title: 'Umbra test chamber',
      wide: true,
      content: body,
      onClose: () => {
        cancelAnimationFrame(raf);
        clearInterval(pollPad);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        state = null;
      },
      footer: [{ label: 'Back to the dark', class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  BN.chamber = { open, reset, step, W, H };
})();
