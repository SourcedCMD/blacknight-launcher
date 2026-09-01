/* =========================================================================
   The year in review, as a few seconds of video.

   A still gets posted. A clip gets posted and watched. Everything needed is
   already here: the numbers are local, the art is generated, and the browser
   can record a canvas without any encoder shipping in the app.

   Drawn frame by frame onto a canvas rather than by animating the DOM,
   because MediaRecorder can capture a canvas stream directly and cannot
   capture a page.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const W = 1080;
  const H = 1350; // 4:5, which is what most feeds crop to
  const SECONDS = 8;
  const FPS = 30;

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /** Progress of one stage of the animation, 0 to 1. */
  const stage = (t, from, to) => clamp01((t - from) / (to - from));

  function palette() {
    const css = getComputedStyle(document.documentElement);
    const read = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
    return {
      bg: read('--bg', '#05050a'),
      text: read('--text', '#eef1f7'),
      dim: read('--text-dim', '#9aa3b5'),
      faint: read('--text-faint', '#626b7d'),
      accent: read('--accent', '#8fb8ff')
    };
  }

  /**
   * Stars placed from the year's own numbers, so two people never get the
   * same sky and the same person always gets theirs.
   */
  function makeStars(review) {
    const rand = BN.util.rng(BN.util.hashString(`${review.year}:${review.totalSeconds}`));
    return Array.from({ length: 150 }, () => ({
      x: rand() * W,
      y: rand() * H,
      r: rand() * 1.8 + 0.3,
      phase: rand() * Math.PI * 2
    }));
  }

  function drawFrame(ctx, review, colors, stars, t) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);

    // Sky, fading up first.
    const skyIn = stage(t, 0, 0.25);
    for (const star of stars) {
      const twinkle = 0.55 + Math.sin(t * 8 + star.phase) * 0.35;
      ctx.globalAlpha = skyIn * twinkle;
      ctx.fillStyle = star.r > 1.4 ? '#ffffff' : colors.dim;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // A moon rising through the first half.
    const rise = easeOut(stage(t, 0.05, 0.6));
    const moonY = H * 0.42 - rise * H * 0.08;
    const glow = ctx.createRadialGradient(W * 0.72, moonY, 0, W * 0.72, moonY, 320);
    glow.addColorStop(0, `${colors.accent}33`);
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    ctx.globalAlpha = rise;
    ctx.fillStyle = '#c8d2e4';
    ctx.beginPath();
    ctx.arc(W * 0.72, moonY, 92, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    /* --- Text ----------------------------------------------------------- */

    const pad = 90;
    ctx.textAlign = 'left';

    ctx.globalAlpha = stage(t, 0.15, 0.3);
    ctx.fillStyle = colors.faint;
    ctx.font = '600 26px ui-sans-serif, system-ui, sans-serif';
    ctx.letterSpacing = '8px';
    ctx.fillText(`BLACKNIGHT ${review.year}`, pad, H * 0.58);
    ctx.letterSpacing = '0px';

    // The headline number counts up rather than appearing, because the
    // counting is the part people watch.
    const counting = stage(t, 0.25, 0.62);
    const hours = Math.round((review.totalSeconds / 3600) * easeOut(counting));
    ctx.globalAlpha = stage(t, 0.25, 0.35);
    ctx.fillStyle = colors.text;
    ctx.font = '700 132px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${hours}`, pad, H * 0.7);
    const width = ctx.measureText(`${hours}`).width;
    ctx.font = '500 44px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = colors.dim;
    ctx.fillText('hours', pad + width + 18, H * 0.7);

    ctx.globalAlpha = stage(t, 0.4, 0.55);
    ctx.font = '400 30px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`across ${review.sessions} sessions`, pad, H * 0.7 + 52);

    // The rows arrive one after another.
    const rows = [
      ['Most played', review.topTitle ? review.topTitle.title : '-'],
      ['Longest night', BN.util.duration(review.longestSession.seconds)],
      ['Peak hour', `${String(review.peakHour).padStart(2, '0')}:00`],
      ['After dark', `${Math.round(review.nightFraction * 100)}%`]
    ];

    rows.forEach(([label, value], i) => {
      const appear = stage(t, 0.55 + i * 0.06, 0.65 + i * 0.06);
      if (!appear) return;
      const y = H * 0.79 + i * 62;
      ctx.globalAlpha = appear;
      ctx.fillStyle = colors.faint;
      ctx.font = '600 20px ui-sans-serif, system-ui, sans-serif';
      ctx.letterSpacing = '3px';
      ctx.fillText(label.toUpperCase(), pad, y);
      ctx.letterSpacing = '0px';
      ctx.fillStyle = colors.text;
      ctx.font = '500 32px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(value, W - pad, y);
      ctx.textAlign = 'left';
    });

    ctx.globalAlpha = 1;
  }

  /**
   * Records the animation and hands the result to the main process to save.
   *
   * WebM because that is what a Chromium canvas records without any encoder
   * being shipped; it is what every platform accepts for an upload.
   */
  async function record(year = new Date().getFullYear()) {
    const review = await BN.api.library.yearInReview(year);
    if (!review.sessions) {
      BN.ui.toast('Nothing to show yet', `No sessions recorded in ${year}.`, { kind: 'info' });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      BN.ui.toast('Cannot record here', 'This build has no media recorder.', { kind: 'warn' });
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const colors = palette();
    const stars = makeStars(review);

    const dismiss = BN.ui.toast('Making your reel', 'A few seconds.', { kind: 'info', ms: 12000 });

    try {
      const stream = canvas.captureStream(FPS);
      const chunks = [];
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

      const finished = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();

      const started = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          const elapsed = (performance.now() - started) / 1000;
          drawFrame(ctx, review, colors, stars, Math.min(1, elapsed / SECONDS));
          if (elapsed >= SECONDS) return resolve();
          requestAnimationFrame(tick);
        };
        tick();
      });

      recorder.stop();
      await finished;

      // A Blob cannot cross the bridge, and a data: URL of several megabytes
      // is unpleasant but works and keeps the CSP happy.
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buffer = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

      dismiss?.();
      const saved = await BN.api.app.saveVideo(
        `data:video/webm;base64,${base64}`,
        `BlackNight-${year}.webm`
      );
      BN.ui.toast(
        saved?.ok ? 'Reel saved' : saved?.cancelled ? 'Cancelled' : 'Could not save the reel',
        saved?.path || saved?.error || '',
        { kind: saved?.ok ? 'ok' : 'info' }
      );
    } catch (err) {
      dismiss?.();
      BN.log?.warn('reel', 'Could not record the year in review', err);
      BN.ui.toast('Could not make the reel', err.message, { kind: 'error' });
    }
  }

  BN.reel = { record, drawFrame, W, H, SECONDS };
})();
