/* =========================================================================
   Procedural art engine.

   Every piece of imagery in the launcher - the mark, hero key art, store
   posters, news thumbnails - is generated as inline SVG from a seed. Nothing
   is fetched, nothing ships as a binary, and each title keeps the exact same
   art on every machine because the PRNG is deterministic.

   When BlackNight has real key art, drop files in src/assets and point the
   catalog entries at them; the components fall back to these generators.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { rng, hashString } = BN.util;

  let uid = 0;
  const nextId = () => `bn${(uid++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  /* --------------------------------------------------------------------- */
  /* The BlackNight mark                                                    */

  /**
   * The studio mark: a moonlit chrome badge carrying the B and star.
   * Rebuilt in vector so it stays crisp at tray size and at 400px.
   */
  function logo(size = 64, { glow = true } = {}) {
    const id = nextId();
    return `
<svg viewBox="0 0 512 512" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="BlackNight Studios">
  <defs>
    <linearGradient id="${id}-chrome" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="16%" stop-color="#dfe5f0"/>
      <stop offset="38%" stop-color="#8d96aa"/>
      <stop offset="52%" stop-color="#ffffff"/>
      <stop offset="68%" stop-color="#6f7787"/>
      <stop offset="86%" stop-color="#e8ecf4"/>
      <stop offset="100%" stop-color="#9aa2b4"/>
    </linearGradient>
    <linearGradient id="${id}-edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".95"/>
      <stop offset="45%" stop-color="#7c8496" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity=".9"/>
    </linearGradient>
    <radialGradient id="${id}-body" cx="0.34" cy="0.26" r="0.95">
      <stop offset="0%" stop-color="#20222c"/>
      <stop offset="55%" stop-color="#0c0d13"/>
      <stop offset="100%" stop-color="#030305"/>
    </radialGradient>
    <radialGradient id="${id}-moon" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="62%" stop-color="#c8d2e4"/>
      <stop offset="100%" stop-color="#7b8598"/>
    </radialGradient>
    <radialGradient id="${id}-halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#cfdcf5" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#cfdcf5" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${id}-clip">
      <rect x="26" y="26" width="460" height="460" rx="104"/>
    </clipPath>
  </defs>

  <rect x="18" y="18" width="476" height="476" rx="112" fill="url(#${id}-edge)"/>
  <rect x="26" y="26" width="460" height="460" rx="104" fill="url(#${id}-body)"/>

  <g clip-path="url(#${id}-clip)">
    ${glow ? `<circle cx="336" cy="150" r="190" fill="url(#${id}-halo)"/>` : ''}
    <circle cx="336" cy="150" r="92" fill="url(#${id}-moon)" opacity=".92"/>
    <circle cx="304" cy="126" r="15" fill="#98a2b5" opacity=".35"/>
    <circle cx="360" cy="176" r="10" fill="#98a2b5" opacity=".3"/>
    <circle cx="352" cy="112" r="7" fill="#98a2b5" opacity=".28"/>

    <!-- cloud bank drifting across the moon -->
    <g fill="#0a0b11" opacity=".88">
      <ellipse cx="250" cy="196" rx="132" ry="42"/>
      <ellipse cx="358" cy="212" rx="118" ry="38"/>
      <ellipse cx="150" cy="118" rx="96" ry="32"/>
      <ellipse cx="420" cy="96" rx="86" ry="28"/>
    </g>
    <g fill="#161824" opacity=".7">
      <ellipse cx="300" cy="180" rx="104" ry="30"/>
      <ellipse cx="128" cy="150" rx="74" ry="24"/>
    </g>

    <!-- starfield -->
    <g fill="#e9eefb">
      <circle cx="118" cy="72" r="3.4" opacity=".9"/>
      <circle cx="196" cy="58" r="2" opacity=".55"/>
      <circle cx="440" cy="248" r="2.4" opacity=".5"/>
      <circle cx="86" cy="228" r="1.8" opacity=".45"/>
    </g>
    <path d="M118 56 L122 68 L134 72 L122 76 L118 88 L114 76 L102 72 L114 68 Z" fill="#ffffff" opacity=".95"/>
  </g>

  <!-- the B -->
  <text x="150" y="372" font-family="Bahnschrift, 'Segoe UI Semibold', Impact, sans-serif"
        font-size="330" font-weight="700" font-style="italic"
        fill="url(#${id}-chrome)" stroke="#f2f5fb" stroke-width="5" paint-order="stroke"
        text-anchor="middle">B</text>

  <!-- the star -->
  <g transform="translate(348 348) rotate(12)">
    <path d="M0 -78 L20 -22 L80 -22 L31 12 L50 70 L0 34 L-50 70 L-31 12 L-80 -22 L-20 -22 Z"
          fill="#0b0c12" stroke="url(#${id}-chrome)" stroke-width="11" stroke-linejoin="round"/>
  </g>
</svg>`.trim();
  }

  /* --------------------------------------------------------------------- */
  /* Key art                                                                */

  const MOTIFS = ['city', 'peaks', 'orbit', 'ruins', 'circuit', 'sea'];

  /**
   * Generates a piece of key art.
   * @param {object} opts
   * @param {number} opts.seed   deterministic seed
   * @param {number} opts.hue    base hue, 0-360
   * @param {string} opts.motif  city | peaks | orbit | ruins | circuit | sea
   * @param {number} opts.w      viewBox width
   * @param {number} opts.h      viewBox height
   */
  function keyArt({ seed = 1, hue = 210, motif = 'city', w = 1600, h = 900, detail = 1 } = {}) {
    const id = nextId();
    const r = rng(seed);
    const m = MOTIFS.includes(motif) ? motif : MOTIFS[Math.floor(r() * MOTIFS.length)];

    const skyTop = `hsl(${hue} 42% 9%)`;
    const skyMid = `hsl(${(hue + 12) % 360} 38% 14%)`;
    const skyLow = `hsl(${(hue + 26) % 360} 30% 6%)`;
    const glowCol = `hsl(${hue} 78% 66%)`;
    const horizon = h * 0.7;

    const moonX = w * (0.58 + r() * 0.28);
    const moonY = h * (0.16 + r() * 0.16);
    const moonR = Math.min(w, h) * (0.07 + r() * 0.05);

    /* Stars ------------------------------------------------------------- */
    let stars = '';
    const starCount = Math.round(120 * detail);
    for (let i = 0; i < starCount; i++) {
      const x = r() * w;
      const y = r() * horizon * 0.95;
      const rad = r() * 1.9 + 0.4;
      const op = 0.18 + r() * 0.7;
      stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}" opacity="${op.toFixed(2)}"/>`;
    }

    const body = {
      city: () => cityScape(r, w, h, horizon, hue),
      peaks: () => peakScape(r, w, h, horizon, hue),
      orbit: () => orbitScape(r, w, h, hue, id),
      ruins: () => ruinScape(r, w, h, horizon, hue),
      circuit: () => circuitScape(r, w, h, horizon, hue),
      sea: () => seaScape(r, w, h, horizon, hue)
    }[m]();

    return `
<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${skyTop}"/>
      <stop offset="46%" stop-color="${skyMid}"/>
      <stop offset="100%" stop-color="${skyLow}"/>
    </linearGradient>
    <radialGradient id="${id}-moonglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${glowCol}" stop-opacity=".55"/>
      <stop offset="45%" stop-color="${glowCol}" stop-opacity=".16"/>
      <stop offset="100%" stop-color="${glowCol}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}-moonface" cx="0.42" cy="0.38" r="0.62">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#d3dcec"/>
      <stop offset="100%" stop-color="#93a0b8"/>
    </radialGradient>
    <linearGradient id="${id}-haze" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${glowCol}" stop-opacity="0"/>
      <stop offset="100%" stop-color="${glowCol}" stop-opacity=".22"/>
    </linearGradient>
    <linearGradient id="${id}-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#04040a" stop-opacity=".9"/>
    </linearGradient>
    <filter id="${id}-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed % 100}"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <filter id="${id}-soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${Math.max(6, w * 0.012)}"/>
    </filter>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#${id}-sky)"/>
  <g fill="#eaf0ff">${stars}</g>

  <circle cx="${moonX}" cy="${moonY}" r="${moonR * 4.6}" fill="url(#${id}-moonglow)"/>
  <circle cx="${moonX}" cy="${moonY}" r="${moonR}" fill="url(#${id}-moonface)" opacity=".95"/>
  <circle cx="${moonX - moonR * 0.3}" cy="${moonY - moonR * 0.22}" r="${moonR * 0.17}" fill="#9aa6bd" opacity=".3"/>
  <circle cx="${moonX + moonR * 0.28}" cy="${moonY + moonR * 0.3}" r="${moonR * 0.11}" fill="#9aa6bd" opacity=".26"/>

  ${body}

  <rect width="${w}" height="${h}" fill="url(#${id}-fade)"/>
  <rect width="${w}" height="${h}" filter="url(#${id}-grain)" opacity=".07" style="mix-blend-mode:overlay"/>
</svg>`.trim();
  }

  /* --- Motif builders -------------------------------------------------- */

  function cityScape(r, w, h, horizon, hue) {
    let out = '';
    // Three depth layers, each darker and taller as it comes forward.
    for (let layer = 0; layer < 3; layer++) {
      const depth = layer / 2;
      const light = 16 - layer * 5;
      const baseY = horizon + layer * h * 0.05;
      const maxH = h * (0.2 + layer * 0.16);
      let path = `M0 ${h} L0 ${baseY}`;
      let x = 0;
      let windows = '';
      while (x < w) {
        const bw = w * (0.02 + r() * 0.05);
        const bh = maxH * (0.28 + r() * 0.72);
        const top = baseY - bh;
        path += ` L${x.toFixed(0)} ${top.toFixed(0)} L${(x + bw).toFixed(0)} ${top.toFixed(0)}`;
        // Lit windows only on the two nearest layers, so the horizon stays calm.
        if (layer > 0 && r() > 0.25) {
          const cols = Math.max(1, Math.floor(bw / (w * 0.011)));
          const rows = Math.max(1, Math.floor(bh / (h * 0.032)));
          for (let c = 0; c < cols; c++) {
            for (let ro = 0; ro < rows; ro++) {
              if (r() > 0.72) {
                const wx = x + bw * ((c + 0.5) / cols);
                const wy = top + bh * ((ro + 0.5) / rows);
                const on = r();
                windows += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="${(w * 0.0035).toFixed(1)}" height="${(h * 0.008).toFixed(1)}" fill="hsl(${(hue + 30) % 360} 90% ${on > 0.85 ? 82 : 62}%)" opacity="${(0.3 + on * 0.6).toFixed(2)}"/>`;
              }
            }
          }
        }
        x += bw;
      }
      path += ` L${w} ${baseY} L${w} ${h} Z`;
      out += `<path d="${path}" fill="hsl(${hue} 30% ${light}%)" opacity="${(0.62 + depth * 0.38).toFixed(2)}"/>${windows}`;
    }
    // A few aircraft beacons blinking above the skyline.
    for (let i = 0; i < 3; i++) {
      out += `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * horizon * 0.6).toFixed(0)}" r="${(2 + r() * 2).toFixed(1)}" fill="hsl(${(hue + 180) % 360} 90% 68%)" opacity=".8"/>`;
    }
    return out;
  }

  function peakScape(r, w, h, horizon, hue) {
    let out = '';
    for (let layer = 0; layer < 4; layer++) {
      const baseY = horizon + layer * h * 0.07;
      const amp = h * (0.3 - layer * 0.05);
      const light = 20 - layer * 4.5;
      let path = `M0 ${h} L0 ${baseY}`;
      const steps = 7 + Math.floor(r() * 5);
      for (let i = 0; i <= steps; i++) {
        const x = (w * i) / steps;
        const peak = baseY - amp * (0.35 + r() * 0.65);
        path += ` L${x.toFixed(0)} ${peak.toFixed(0)}`;
      }
      path += ` L${w} ${baseY} L${w} ${h} Z`;
      out += `<path d="${path}" fill="hsl(${(hue + layer * 4) % 360} 26% ${light}%)" opacity="${(0.55 + layer * 0.15).toFixed(2)}"/>`;
    }
    // Ash haze bands
    for (let i = 0; i < 4; i++) {
      const y = horizon - h * 0.1 + i * h * 0.07;
      out += `<ellipse cx="${(w * (0.2 + r() * 0.6)).toFixed(0)}" cy="${y.toFixed(0)}" rx="${(w * (0.3 + r() * 0.3)).toFixed(0)}" ry="${(h * 0.022).toFixed(0)}" fill="hsl(${hue} 40% 60%)" opacity="${(0.05 + r() * 0.07).toFixed(2)}"/>`;
    }
    return out;
  }

  function orbitScape(r, w, h, hue, id) {
    let out = '';
    const px = w * (0.18 + r() * 0.2);
    const py = h * (0.74 + r() * 0.14);
    const pr = Math.min(w, h) * (0.34 + r() * 0.12);
    out += `<circle cx="${px}" cy="${py}" r="${pr * 1.5}" fill="hsl(${hue} 70% 60%)" opacity=".08" filter="url(#${id}-soft)"/>`;
    out += `<circle cx="${px}" cy="${py}" r="${pr}" fill="hsl(${hue} 34% 12%)"/>`;
    out += `<circle cx="${px}" cy="${py}" r="${pr}" fill="none" stroke="hsl(${hue} 80% 70%)" stroke-width="2" opacity=".5"/>`;
    // Banding across the planet face
    for (let i = 0; i < 6; i++) {
      const yy = py - pr + (pr * 2 * (i + 0.5)) / 6;
      const half = Math.sqrt(Math.max(0, pr * pr - (yy - py) ** 2));
      out += `<rect x="${px - half}" y="${yy - pr * 0.035}" width="${half * 2}" height="${pr * 0.07}" fill="hsl(${(hue + i * 6) % 360} 45% ${18 + i * 3}%)" opacity=".5"/>`;
    }
    // Ring system
    out += `<g transform="rotate(-16 ${px} ${py})"><ellipse cx="${px}" cy="${py}" rx="${pr * 1.8}" ry="${pr * 0.34}" fill="none" stroke="hsl(${hue} 70% 74%)" stroke-width="${pr * 0.05}" opacity=".28"/><ellipse cx="${px}" cy="${py}" rx="${pr * 2.1}" ry="${pr * 0.4}" fill="none" stroke="hsl(${hue} 70% 80%)" stroke-width="${pr * 0.02}" opacity=".2"/></g>`;
    // Debris field
    for (let i = 0; i < 26; i++) {
      const x = r() * w;
      const y = h * (0.25 + r() * 0.5);
      out += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${(2 + r() * 7).toFixed(1)}" height="${(1 + r() * 2).toFixed(1)}" fill="hsl(${hue} 30% 72%)" opacity="${(0.15 + r() * 0.4).toFixed(2)}" transform="rotate(${(r() * 60 - 30).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`;
    }
    return out;
  }

  function ruinScape(r, w, h, horizon, hue) {
    let out = `<rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="hsl(${hue} 22% 7%)"/>`;
    const cols = 7;
    for (let i = 0; i < cols; i++) {
      const x = (w * (i + 0.5)) / cols + (r() * w) / cols / 3;
      const cw = w * (0.035 + r() * 0.02);
      const ch = h * (0.34 + r() * 0.3);
      const top = horizon - ch;
      const light = 11 + r() * 6;
      // Column with a gothic arch cut into it
      out += `<path d="M${x - cw} ${horizon} L${x - cw} ${top + cw} Q${x} ${top - cw * 0.6} ${x + cw} ${top + cw} L${x + cw} ${horizon} Z" fill="hsl(${hue} 20% ${light}%)" opacity=".9"/>`;
      out += `<path d="M${x - cw * 0.45} ${horizon} L${x - cw * 0.45} ${top + cw * 1.5} Q${x} ${top + cw * 0.4} ${x + cw * 0.45} ${top + cw * 1.5} L${x + cw * 0.45} ${horizon} Z" fill="hsl(${(hue + 20) % 360} 60% 62%)" opacity="${(0.06 + r() * 0.12).toFixed(2)}"/>`;
    }
    // Light shafts falling through the arches
    for (let i = 0; i < 4; i++) {
      const x = w * (0.15 + r() * 0.7);
      out += `<path d="M${x} ${h * 0.1} L${x + w * 0.06} ${h * 0.1} L${x + w * 0.16} ${horizon} L${x - w * 0.04} ${horizon} Z" fill="hsl(${(hue + 15) % 360} 70% 70%)" opacity="${(0.04 + r() * 0.05).toFixed(2)}"/>`;
    }
    return out;
  }

  function circuitScape(r, w, h, horizon, hue) {
    const vpX = w * 0.5;
    let out = `<rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="hsl(${hue} 20% 6%)"/>`;
    // Road converging on the vanishing point
    out += `<path d="M${vpX - w * 0.03} ${horizon} L${vpX + w * 0.03} ${horizon} L${w * 1.15} ${h} L${-w * 0.15} ${h} Z" fill="hsl(${hue} 12% 10%)"/>`;
    // Lane markers, spaced by perspective
    for (let i = 1; i < 14; i++) {
      const t = i / 14;
      const y = horizon + (h - horizon) * t * t;
      const half = w * 0.004 + (w * 0.05 - w * 0.004) * t * t;
      out += `<rect x="${vpX - half / 2}" y="${y}" width="${half}" height="${Math.max(2, h * 0.012 * t)}" fill="hsl(${(hue + 20) % 360} 90% 72%)" opacity="${(0.25 + t * 0.6).toFixed(2)}"/>`;
    }
    // Streetlight streaks either side
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      const y = horizon + (h - horizon) * t * t * 0.9;
      const spread = w * 0.06 + w * 0.55 * t * t;
      const op = (0.2 + t * 0.7).toFixed(2);
      const lw = Math.max(2, 10 * t);
      out += `<rect x="${vpX - spread}" y="${y}" width="${w * 0.09 * t + 6}" height="${lw}" rx="${lw / 2}" fill="hsl(${(hue + 340) % 360} 95% 66%)" opacity="${op}"/>`;
      out += `<rect x="${vpX + spread - w * 0.09 * t}" y="${y}" width="${w * 0.09 * t + 6}" height="${lw}" rx="${lw / 2}" fill="hsl(${(hue + 190) % 360} 95% 68%)" opacity="${op}"/>`;
    }
    // Distant skyline
    let path = `M0 ${horizon} `;
    let x = 0;
    while (x < w) {
      const bw = w * (0.03 + r() * 0.05);
      const bh = h * (0.05 + r() * 0.16);
      path += `L${x} ${horizon - bh} L${x + bw} ${horizon - bh} `;
      x += bw;
    }
    path += `L${w} ${horizon} Z`;
    out += `<path d="${path}" fill="hsl(${hue} 24% 9%)" opacity=".9"/>`;
    return out;
  }

  function seaScape(r, w, h, horizon, hue) {
    let out = `<rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="hsl(${hue} 44% 9%)"/>`;
    // Moon path on the water
    out += `<path d="M${w * 0.62} ${horizon} L${w * 0.72} ${horizon} L${w * 0.9} ${h} L${w * 0.44} ${h} Z" fill="hsl(${hue} 70% 72%)" opacity=".1"/>`;
    for (let i = 0; i < 26; i++) {
      const t = i / 26;
      const y = horizon + (h - horizon) * t * t;
      const len = w * (0.03 + r() * 0.16) * (0.3 + t);
      const x = r() * w;
      out += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${len.toFixed(0)}" height="${Math.max(1.5, 5 * t).toFixed(1)}" rx="2" fill="hsl(${(hue + 10) % 360} 70% ${60 + t * 20}%)" opacity="${(0.08 + r() * 0.22).toFixed(2)}"/>`;
    }
    // Island silhouettes on the horizon
    for (let i = 0; i < 3; i++) {
      const cx = w * (0.12 + r() * 0.76);
      const rw = w * (0.06 + r() * 0.1);
      const rh = h * (0.03 + r() * 0.07);
      out += `<path d="M${cx - rw} ${horizon} Q${cx - rw * 0.4} ${horizon - rh} ${cx} ${horizon - rh * 0.9} Q${cx + rw * 0.5} ${horizon - rh * 1.2} ${cx + rw} ${horizon} Z" fill="hsl(${hue} 26% 8%)"/>`;
    }
    return out;
  }

  /* --------------------------------------------------------------------- */
  /* Convenience wrappers                                                   */

  const artFor = (game, w, h, detail = 1) =>
    keyArt({ seed: game.art?.seed ?? hashString(game.id), hue: game.art?.hue ?? 210, motif: game.art?.motif, w, h, detail });

  // Hero art is drawn wide so the skyline survives the `slice` crop in a
  // short, full-width hero rather than being cut off below the fold.
  const hero = (game) => artFor(game, 1800, 780);
  const poster = (game) => artFor(game, 900, 1200);
  const thumb = (game) => artFor(game, 400, 400, 0.35);
  const banner = (game) => artFor(game, 1800, 700);

  function newsArt(item, games) {
    const game = games.find((g) => g.id === item.gameId);
    if (game) return artFor(game, 800, 500, 0.6);
    return keyArt({ seed: hashString(item.id), hue: 214, motif: 'orbit', w: 800, h: 500, detail: 0.6 });
  }

  BN.art = { logo, keyArt, hero, poster, thumb, banner, newsArt, MOTIFS };
})();
