/* =========================================================================
   UI sound design, synthesised at runtime with WebAudio.

   No audio files ship with the launcher - every cue is generated from
   oscillators and a noise buffer, so the whole sound palette costs zero bytes
   and retunes instantly if the studio wants a different character.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  let ctx = null;
  let master = null;
  let enabled = true;
  let volume = 0.45;
  let noiseBuffer = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume * 0.5;
    master.connect(ctx.destination);

    // Shared noise source for transient/impact layers.
    const len = ctx.sampleRate * 1.2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  const now = () => ctx.currentTime;

  /** A single enveloped oscillator voice. */
  function tone({ freq = 440, type = 'sine', dur = 0.14, gain = 0.3, attack = 0.004, glide = 0, delay = 0, filter = null }) {
    const t0 = now() + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + glide), t0 + dur);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.value = filter.freq || 1200;
      f.Q.value = filter.q || 1;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** A filtered noise burst - used for clicks, sweeps and impacts. */
  function noise({ dur = 0.12, gain = 0.16, freq = 2400, type = 'bandpass', q = 1.2, sweepTo = null, delay = 0 }) {
    const t0 = now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  const CUES = {
    hover: () => noise({ dur: 0.05, gain: 0.035, freq: 5200, q: 2.4 }),
    click: () => {
      noise({ dur: 0.06, gain: 0.09, freq: 3200, q: 1.6, sweepTo: 900 });
      tone({ freq: 620, type: 'triangle', dur: 0.07, gain: 0.06 });
    },
    toggle: () => tone({ freq: 880, type: 'square', dur: 0.06, gain: 0.05, filter: { freq: 2200 } }),
    nav: () => {
      tone({ freq: 320, type: 'sine', dur: 0.16, gain: 0.07, glide: 180 });
      noise({ dur: 0.22, gain: 0.05, freq: 900, type: 'highpass', sweepTo: 4200 });
    },
    open: () => {
      tone({ freq: 220, type: 'sine', dur: 0.3, gain: 0.09, glide: 300 });
      noise({ dur: 0.3, gain: 0.05, freq: 600, type: 'highpass', sweepTo: 5200 });
    },
    close: () => tone({ freq: 420, type: 'sine', dur: 0.16, gain: 0.07, glide: -240 }),
    success: () => {
      [523.25, 659.25, 783.99].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.34, gain: 0.09, delay: i * 0.07 }));
      noise({ dur: 0.4, gain: 0.04, freq: 1200, type: 'highpass', sweepTo: 6000 });
    },
    error: () => {
      tone({ freq: 180, type: 'sawtooth', dur: 0.24, gain: 0.1, glide: -60, filter: { freq: 900 } });
      tone({ freq: 120, type: 'square', dur: 0.3, gain: 0.06, delay: 0.06, filter: { freq: 600 } });
    },
    // The signature cue: pressing PLAY should feel like a machine spinning up.
    launch: () => {
      tone({ freq: 90, type: 'sawtooth', dur: 1.1, gain: 0.16, glide: 420, filter: { type: 'lowpass', freq: 1600, q: 6 } });
      tone({ freq: 180, type: 'sine', dur: 0.9, gain: 0.1, glide: 620, delay: 0.05 });
      noise({ dur: 1.2, gain: 0.07, freq: 320, type: 'bandpass', q: 0.8, sweepTo: 7000 });
      [392, 523.25, 659.25, 880].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.08, delay: 0.35 + i * 0.075 }));
    },
    boot: () => {
      tone({ freq: 55, type: 'sine', dur: 2.4, gain: 0.14, glide: 60 });
      [261.63, 392, 523.25].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 1.6, gain: 0.055, delay: 0.5 + i * 0.22 }));
      noise({ dur: 2, gain: 0.03, freq: 400, type: 'highpass', sweepTo: 3000, delay: 0.3 });
    },
    download: () => {
      tone({ freq: 700, type: 'sine', dur: 0.1, gain: 0.06, glide: -260 });
      noise({ dur: 0.18, gain: 0.05, freq: 2600, q: 1.2, sweepTo: 700 });
    },
    notify: () => [880, 1174.66].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.22, gain: 0.07, delay: i * 0.09 }))
  };

  /**
   * A launch sting derived from the title itself.
   *
   * Every game already carries `art.hue` and `art.seed`, and the whole sound
   * palette is synthesised rather than sampled - so giving each title its own
   * voice costs a handful of numbers rather than a folder of audio files.
   * Hollow Choir ends up close and detuned; Midnight Circuit bright and quick.
   *
   * Hue picks the key, so a title's colour and its sound agree.
   */
  function signature(game) {
    if (!enabled || !ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    // Falls back to the shared cue when a title has no art to derive from, or
    // when the player would rather every launch sounded the same.
    if (!game?.art || BN.state?.data?.settings?.titleSignatures === false) return play('launch');

    try {
      const rand = BN.util.rng(BN.util.hashString(game.id));
      const hue = game.art.hue ?? 210;

      // Map the colour wheel onto two octaves of a minor scale.
      const SCALE = [0, 3, 5, 7, 10, 12];
      const root = 110 * Math.pow(2, (hue / 360) * 1.5);
      const note = (step) => root * Math.pow(2, SCALE[step % SCALE.length] / 12) * (step >= SCALE.length ? 2 : 1);

      // Darker motifs sit lower and hold longer; brighter ones snap.
      const dark = ['ruins', 'city', 'sea'].includes(game.art.motif);
      const dur = dark ? 1.4 : 0.85;
      const wave = dark ? 'sawtooth' : 'triangle';

      tone({
        freq: root / 2,
        type: 'sawtooth',
        dur,
        gain: 0.15,
        glide: dark ? 180 : 460,
        filter: { type: 'lowpass', freq: dark ? 900 : 2200, q: 6 }
      });
      noise({ dur: dur * 1.1, gain: 0.06, freq: 300, type: 'bandpass', q: 0.8, sweepTo: dark ? 3200 : 7600 });

      // A short arpeggio picked from the title's own seed.
      const steps = dark ? [0, 2, 4] : [0, 3, 5, 7];
      steps.forEach((step, i) => {
        tone({
          freq: note(step + Math.floor(rand() * 2)),
          type: wave,
          dur: 0.5,
          gain: 0.075,
          delay: 0.28 + i * (dark ? 0.13 : 0.07)
        });
      });
    } catch {
      play('launch');
    }
  }

  function play(cue) {
    if (!enabled) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    try {
      CUES[cue]?.();
    } catch { /* audio is a garnish - never let it break an interaction */ }
  }

  BN.sound = {
    play,
    signature,
    configure({ enabled: on, volume: vol } = {}) {
      if (on !== undefined) enabled = !!on;
      if (vol !== undefined) {
        volume = Math.max(0, Math.min(100, vol)) / 100;
        if (master) master.gain.value = volume * 0.5;
      }
    },
    get enabled() { return enabled; },

    /** Wires hover/click cues to every interactive element, once. */
    bindGlobal(root = document) {
      root.addEventListener(
        'pointerenter',
        (e) => {
          const t = e.target;
          if (t?.matches?.('.btn, .nav-link, .side-item, .game-card, .chip, .menu-item, .palette-item, .swatch, .settings-nav button')) play('hover');
        },
        true
      );
      root.addEventListener(
        'click',
        (e) => {
          const t = e.target.closest?.('.btn, .nav-link, .side-item, .chip, .menu-item, .swatch, .switch, .check, .segmented button');
          if (!t) return;
          if (t.matches('.switch, .check')) play('toggle');
          else if (t.matches('.nav-link')) play('nav');
          else play('click');
        },
        true
      );
    }
  };
})();
