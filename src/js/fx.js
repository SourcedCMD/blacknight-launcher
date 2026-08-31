/* =========================================================================
   Ambient effects: the living background, cursor glow, card tilt and
   scroll reveals. All of it degrades cleanly to nothing when the user picks
   reduced motion or turns background effects off.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { clamp } = BN.util;

  /* --------------------------------------------------------------------- */
  /* Background field                                                       */

  class Background {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.mode = 'full';
      this.raf = null;
      this.stars = [];
      this.dust = [];
      this.shooting = [];
      this.t = 0;
      this.pointer = { x: 0.5, y: 0.5 };
      this.accent = [143, 184, 255];
      this.resize = this.resize.bind(this);
      this.loop = this.loop.bind(this);
      window.addEventListener('resize', this.resize);
      this.resize();
    }

    setAccent(cssColor) {
      // Resolve the live accent to RGB so particles pick up the theme.
      const probe = document.createElement('span');
      probe.style.color = cssColor;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color.match(/\d+/g);
      probe.remove();
      if (rgb) this.accent = rgb.slice(0, 3).map(Number);
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = this.canvas.clientWidth || window.innerWidth;
      this.h = this.canvas.clientHeight || window.innerHeight;
      this.canvas.width = this.w * dpr;
      this.canvas.height = this.h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.seed();
    }

    seed() {
      const area = this.w * this.h;
      const starCount = this.mode === 'lite' ? Math.round(area / 14000) : Math.round(area / 5200);
      const dustCount = this.mode === 'lite' ? 0 : Math.round(area / 42000);

      this.stars = Array.from({ length: starCount }, () => ({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        r: Math.random() * 1.3 + 0.25,
        depth: Math.random() * 0.9 + 0.1,
        tw: Math.random() * Math.PI * 2,
        twSpeed: 0.4 + Math.random() * 1.6
      }));

      this.dust = Array.from({ length: dustCount }, () => ({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        r: 40 + Math.random() * 150,
        vx: (Math.random() - 0.5) * 0.06,
        vy: -0.02 - Math.random() * 0.06,
        a: 0.012 + Math.random() * 0.03
      }));

      this.seedConstellation();
    }

    /**
     * Turns the player's own library into the brightest stars in the sky.
     *
     * Position comes from each title's art seed, so a game always sits in the
     * same place; size follows how long it has been played and brightness how
     * recently. The background stops being decoration and becomes a picture of
     * how someone actually plays - which is the whole point of a launcher that
     * calls itself BlackNight.
     */
    seedConstellation(library) {
      if (library) this.library = library;
      this.constellation = [];
      if (!this.library?.length) return;
      if (BN.state?.data?.settings?.libraryConstellation === false) return;

      const owned = this.library.filter((g) => g.owned || g.installed);
      const source = owned.length ? owned : this.library;
      const now = Date.now();
      const mostPlayed = Math.max(60, ...source.map((g) => g.playtimeSeconds || 0));

      this.constellation = source.map((game) => {
        // Deterministic placement: the same title lands in the same patch of
        // sky on every machine, kept off the edges where the UI sits.
        const rand = BN.util.rng(BN.util.hashString(game.id));
        const played = (game.playtimeSeconds || 0) / mostPlayed;
        const idleDays = game.lastPlayed ? (now - game.lastPlayed) / 86400000 : null;
        // Never played is faint but present; recently played burns brightest.
        const recency = idleDays === null ? 0.28 : Math.max(0.3, 1 - idleDays / 45);

        return {
          gameId: game.id,
          title: game.title,
          x: (0.08 + rand() * 0.84) * this.w,
          y: (0.1 + rand() * 0.72) * this.h,
          r: 1.5 + played * 2.6,
          depth: 0.55 + rand() * 0.45,
          tw: rand() * Math.PI * 2,
          twSpeed: 0.25 + rand() * 0.5,
          glow: recency,
          installed: !!game.installed
        };
      });
    }

    /**
     * The library's own stars, drawn over the ambient ones: brighter, tinted
     * with the accent, and joined by faint lines so it reads as a constellation
     * rather than a handful of dots.
     */
    drawConstellation(ctx, dt, ox, oy) {
      const stars = this.constellation;
      if (!stars?.length) return;
      const [ar, ag, ab] = this.accent;

      // Link each star to its nearest neighbour. Cheap at library sizes, and
      // it is what turns scattered points into a shape.
      if (this.mode === 'full') {
        ctx.strokeStyle = `rgba(${ar}, ${ag}, ${ab}, 0.09)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < stars.length; i++) {
          let best = null;
          let bestDist = Infinity;
          for (let j = 0; j < stars.length; j++) {
            if (i === j) continue;
            const dx = stars[i].x - stars[j].x;
            const dy = stars[i].y - stars[j].y;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) { bestDist = dist; best = stars[j]; }
          }
          if (best && bestDist < 420 * 420) {
            ctx.moveTo(stars[i].x + ox * stars[i].depth, stars[i].y + oy * stars[i].depth);
            ctx.lineTo(best.x + ox * best.depth, best.y + oy * best.depth);
          }
        }
        ctx.stroke();
      }

      for (const s of stars) {
        s.tw += (dt / 1000) * s.twSpeed;
        const x = s.x + ox * s.depth;
        const y = s.y + oy * s.depth;
        const pulse = 0.72 + Math.sin(s.tw) * 0.28;
        const alpha = clamp(s.glow * pulse, 0, 1);
        const hot = s.gameId === this.hovered;

        // A soft halo makes the library stars read as nearer than the rest.
        if (this.mode === 'full') {
          const halo = ctx.createRadialGradient(x, y, 0, x, y, s.r * (hot ? 14 : 8));
          halo.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, ${alpha * (hot ? 0.5 : 0.28)})`);
          halo.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(x, y, s.r * (hot ? 14 : 8), 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.installed ? '#ffffff' : `rgb(${ar}, ${ag}, ${ab})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r * (hot ? 1.7 : 1), 0, Math.PI * 2);
        ctx.fill();

        if (hot) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#eef1f7';
          ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(s.title, x, y - s.r * 2.4 - 8);
        }
      }
      ctx.globalAlpha = 1;
    }

    /** The library star under a point, if the pointer is close enough. */
    starAt(px, py) {
      if (!this.constellation?.length) return null;
      for (const s of this.constellation) {
        const dx = s.x - px;
        const dy = s.y - py;
        if (dx * dx + dy * dy < 18 * 18) return s;
      }
      return null;
    }

    setMode(mode) {
      this.mode = mode;
      this.stop();
      this.ctx.clearRect(0, 0, this.w, this.h);
      if (mode === 'off') return;
      this.seed();
      this.start();
    }

    start() {
      if (!this.raf && this.mode !== 'off') this.raf = requestAnimationFrame(this.loop);
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    }

    loop(now) {
      this.raf = requestAnimationFrame(this.loop);
      const dt = Math.min(50, now - (this.last || now));
      this.last = now;
      this.t += dt / 1000;

      const { ctx, w, h } = this;
      ctx.clearRect(0, 0, w, h);

      // Parallax offset driven by the pointer, kept subtle.
      const ox = (this.pointer.x - 0.5) * 26;
      const oy = (this.pointer.y - 0.5) * 18;

      if (this.mode === 'full') {
        ctx.globalCompositeOperation = 'screen';
        for (const d of this.dust) {
          d.x += d.vx * dt * 0.06;
          d.y += d.vy * dt * 0.06;
          if (d.y + d.r < 0) { d.y = h + d.r; d.x = Math.random() * w; }
          if (d.x < -d.r) d.x = w + d.r;
          if (d.x > w + d.r) d.x = -d.r;
          const g = ctx.createRadialGradient(d.x + ox * 0.4, d.y + oy * 0.4, 0, d.x + ox * 0.4, d.y + oy * 0.4, d.r);
          const [r, gr, b] = this.accent;
          g.addColorStop(0, `rgba(${r},${gr},${b},${d.a})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(d.x + ox * 0.4, d.y + oy * 0.4, d.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      for (const s of this.stars) {
        s.tw += (dt / 1000) * s.twSpeed;
        const alpha = (0.28 + Math.sin(s.tw) * 0.24 + s.depth * 0.34) * (this.mode === 'lite' ? 0.7 : 1);
        ctx.globalAlpha = clamp(alpha, 0, 1);
        ctx.fillStyle = s.depth > 0.75 ? '#ffffff' : '#c8d6f0';
        ctx.beginPath();
        ctx.arc(s.x + ox * s.depth, s.y + oy * s.depth, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      this.drawConstellation(ctx, dt, ox, oy);
      ctx.globalAlpha = 1;

      if (this.mode === 'full') {
        // Occasional shooting star, because the sky should reward staring.
        if (Math.random() < 0.0016 && this.shooting.length < 2) {
          this.shooting.push({
            x: Math.random() * w * 0.8,
            y: Math.random() * h * 0.4,
            vx: 5 + Math.random() * 5,
            vy: 1.6 + Math.random() * 1.8,
            life: 1
          });
        }
        for (let i = this.shooting.length - 1; i >= 0; i--) {
          const s = this.shooting[i];
          s.x += s.vx * (dt / 16);
          s.y += s.vy * (dt / 16);
          s.life -= dt / 900;
          if (s.life <= 0 || s.x > w + 200) { this.shooting.splice(i, 1); continue; }
          const tail = 90 * s.life;
          const g = ctx.createLinearGradient(s.x, s.y, s.x - tail, s.y - tail * (s.vy / s.vx));
          g.addColorStop(0, `rgba(255,255,255,${0.85 * s.life})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - tail, s.y - tail * (s.vy / s.vx));
          ctx.stroke();
        }
      }
    }

    destroy() {
      this.stop();
      window.removeEventListener('resize', this.resize);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Pointer-driven effects                                                 */

  let bg = null;
  let glowNode = null;
  let glowTarget = { x: 0, y: 0 };
  let glowPos = { x: 0, y: 0 };
  let glowRaf = null;

  function glowLoop() {
    glowPos.x += (glowTarget.x - glowPos.x) * 0.09;
    glowPos.y += (glowTarget.y - glowPos.y) * 0.09;
    if (glowNode) glowNode.style.transform = `translate3d(${glowPos.x}px, ${glowPos.y}px, 0)`;
    glowRaf = requestAnimationFrame(glowLoop);
  }

  function initPointer() {
    glowNode = document.getElementById('cursor-glow');
    window.addEventListener('pointermove', (e) => {
      glowTarget.x = e.clientX;
      glowTarget.y = e.clientY;
      document.body.classList.add('pointer-active');
      if (bg) {
        bg.pointer.x = e.clientX / window.innerWidth;
        bg.pointer.y = e.clientY / window.innerHeight;
      }
    });
    window.addEventListener('pointerleave', () => document.body.classList.remove('pointer-active'));
    if (!glowRaf) glowLoop();
  }

  /* --------------------------------------------------------------------- */
  /* Card tilt + sheen                                                      */

  /** Adds a subtle 3D tilt and a pointer-tracking sheen to a card. */
  function tilt(node, { max = 7, scale = 1.02 } = {}) {
    if (document.documentElement.dataset.motion === 'reduced') return;
    let raf = null;
    const onMove = (e) => {
      const rect = node.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      node.style.setProperty('--mx', `${px * 100}%`);
      node.style.setProperty('--my', `${py * 100}%`);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        node.style.transform =
          `perspective(900px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg) scale(${scale}) translateY(-4px)`;
      });
    };
    const reset = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      node.style.transform = '';
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', reset);
  }

  /* --------------------------------------------------------------------- */
  /* Scroll reveal                                                          */

  let observer = null;
  function reveal(root) {
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.style.animation = 'rise-in 560ms var(--ease-out) forwards';
            observer.unobserve(entry.target);
          }
        },
        { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
      );
    }
    for (const node of root.querySelectorAll('[data-reveal]')) {
      if (document.documentElement.dataset.motion === 'reduced') {
        node.style.opacity = 1;
        continue;
      }
      node.style.opacity = 0;
      observer.observe(node);
    }
  }

  /** Fires a burst of accent particles from an element - used on launch. */
  function burst(node, count = 22) {
    if (document.documentElement.dataset.motion === 'reduced') return;
    const rect = node.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999';
    document.body.appendChild(layer);
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 60 + Math.random() * 180;
      p.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:3px;height:3px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);opacity:1;`;
      layer.appendChild(p);
      p.animate(
        [
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
          {
            transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`,
            opacity: 0
          }
        ],
        { duration: 700 + Math.random() * 500, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      );
    }
    setTimeout(() => layer.remove(), 1400);
  }

  /**
   * Makes the library stars respond to the pointer.
   *
   * The canvas sits behind everything and is not interactive, so this listens
   * on the window and only claims a click when one actually lands on a star -
   * the UI on top always wins.
   */
  function bindConstellation() {
    if (!bg) return;

    window.addEventListener('pointermove', (e) => {
      if (!bg.constellation?.length) return;
      // Anything over real UI is not a sky interaction.
      const overUi = e.target.closest('.view-host, .sidebar, .topnav, .titlebar, .overlay, .palette-overlay');
      const hit = overUi ? null : bg.starAt(e.clientX, e.clientY);
      const next = hit?.gameId || null;
      if (next !== bg.hovered) {
        bg.hovered = next;
        document.body.style.cursor = next ? 'pointer' : '';
        if (next) BN.sound?.play('hover');
      }
    });

    window.addEventListener('click', (e) => {
      if (!bg.hovered) return;
      const overUi = e.target.closest('.view-host, .sidebar, .topnav, .titlebar, .overlay, .palette-overlay');
      if (overUi) return;
      BN.components?.openDetail(bg.hovered);
    });
  }

  BN.fx = {
    initBackground(canvas) {
      bg = new Background(canvas);
      bindConstellation();
      return bg;
    },
    get background() { return bg; },
    /** Called whenever the library changes so the sky follows it. */
    setLibrary(library) {
      bg?.seedConstellation(library);
    },
    initPointer,
    tilt,
    reveal,
    burst
  };
})();
