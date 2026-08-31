/* =========================================================================
   Controller navigation.

   A launcher for a games studio should be drivable from the couch. This adds
   spatial focus movement over whatever is already on screen - no per-view
   wiring, no focus traps to maintain - so every button the mouse can reach a
   D-pad can reach too.

   Polling only runs while a pad is connected, so the idle cost is zero.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Standard mapping. Face buttons first, then shoulders, then the stick hats.
  const A = 0, B = 1, Y = 3, LB = 4, RB = 5, START = 9;
  const DPAD = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

  const REPEAT_FIRST = 420; // ms before a held direction starts repeating
  const REPEAT_NEXT = 130;
  const DEADZONE = 0.55;

  let raf = null;
  let active = false;
  const held = new Map(); // control -> { since, last }

  /* --------------------------------------------------------------------- */
  /* Focus movement                                                         */

  /** Everything on screen that can take focus, topmost layer only. */
  function candidates() {
    // A modal, palette or dropdown owns navigation while it is open.
    const layer =
      document.querySelector('.palette') ||
      document.querySelector('.overlay .modal') ||
      document.querySelector('.menu') ||
      document;

    return [...layer.querySelectorAll(FOCUSABLE)].filter((node) => {
      if (node.closest('.hidden')) return false;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      // Ignore anything scrolled fully out of view.
      return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    });
  }

  const centre = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

  /**
   * Picks the nearest element in a direction, preferring ones that line up
   * with the current element over ones that merely happen to be closer. That
   * keeps a column of cards feeling like a column instead of drifting
   * diagonally across the grid.
   */
  function nextInDirection(from, dir) {
    const list = candidates();
    if (!list.length) return null;
    if (!from || !list.includes(from)) return list[0];

    const origin = centre(from.getBoundingClientRect());
    let best = null;
    let bestScore = Infinity;

    for (const node of list) {
      if (node === from) continue;
      const point = centre(node.getBoundingClientRect());
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;

      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 8) continue; // not actually in that direction

      // Distance along the axis, plus a heavy penalty for drifting off it.
      const score = along + across * 2.4;
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  function move(dir) {
    const from = document.activeElement === document.body ? null : document.activeElement;
    const next = nextInDirection(from, dir);
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    document.documentElement.classList.add('pad-nav');
    BN.sound?.play('hover');
  }

  /* --------------------------------------------------------------------- */
  /* Buttons                                                                */

  function press(control) {
    switch (control) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        return move(control);

      case A: {
        const node = document.activeElement;
        if (node && node !== document.body) node.click();
        return;
      }
      case B:
        // Mirrors Escape: closes whatever layer is on top.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return;
      case Y:
      case START:
        return BN.app?.openPalette();
      case LB:
        return cycleRoute(-1);
      case RB:
        return cycleRoute(1);
    }
  }

  const ROUTES = ['games', 'store', 'plus', 'downloads', 'settings'];
  function cycleRoute(step) {
    const links = [...document.querySelectorAll('#nav-links .nav-link')];
    const current = links.findIndex((l) => l.getAttribute('aria-current') === 'page');
    const index = (current + step + ROUTES.length) % ROUTES.length;
    BN.app?.go(ROUTES[index]);
  }

  /* --------------------------------------------------------------------- */
  /* Polling                                                                */

  function poll() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (!pads.length) {
      stop();
      return;
    }

    const now = performance.now();
    const seen = new Set();

    const engage = (control) => {
      seen.add(control);
      const state = held.get(control);
      if (!state) {
        held.set(control, { since: now, last: now });
        press(control);
        return;
      }
      const due = now - state.since > REPEAT_FIRST && now - state.last > REPEAT_NEXT;
      // Only directions repeat; a held A must not fire twice.
      if (due && typeof control === 'string') {
        state.last = now;
        press(control);
      }
    };

    for (const pad of pads) {
      pad.buttons.forEach((button, index) => {
        if (!button.pressed) return;
        if (DPAD[index]) engage(DPAD[index]);
        else engage(index);
      });

      const [x = 0, y = 0] = pad.axes;
      if (x < -DEADZONE) engage('left');
      else if (x > DEADZONE) engage('right');
      if (y < -DEADZONE) engage('up');
      else if (y > DEADZONE) engage('down');
    }

    for (const control of [...held.keys()]) if (!seen.has(control)) held.delete(control);
    raf = requestAnimationFrame(poll);
  }

  function start() {
    if (active) return;
    active = true;
    document.documentElement.classList.add('pad-connected');
    raf = requestAnimationFrame(poll);
  }

  function stop() {
    active = false;
    cancelAnimationFrame(raf);
    raf = null;
    held.clear();
    document.documentElement.classList.remove('pad-connected');
  }

  function init() {
    if (!navigator.getGamepads) return;
    window.addEventListener('gamepadconnected', () => {
      BN.ui?.toast('Controller connected', 'D-pad to move, A to select, B to go back.', { kind: 'ok', ms: 4200 });
      start();
    });
    window.addEventListener('gamepaddisconnected', stop);

    // A pad paired before the launcher opened only appears once it reports an
    // input, so check for an already-live one at startup.
    if ([...(navigator.getGamepads?.() || [])].some(Boolean)) start();

    // Any mouse or keyboard use drops the controller focus ring again.
    for (const evt of ['pointerdown', 'keydown']) {
      document.addEventListener(evt, () => document.documentElement.classList.remove('pad-nav'));
    }
  }

  BN.gamepad = { init, move, start, stop };
})();
