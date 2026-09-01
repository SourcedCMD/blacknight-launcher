'use strict';
const http = require('http');

/**
 * A now-playing page for OBS.
 *
 * Streamers build these by hand for every game they play - a little browser
 * source showing what is running and for how long. Serving one costs a route
 * on a local HTTP server, and it is the kind of thing that gets a launcher
 * recommended rather than merely used.
 *
 * Bound to loopback only, so it is reachable from OBS on the same machine and
 * from nowhere else. Off unless enabled.
 *
 * The page polls a JSON endpoint rather than holding a socket open: OBS
 * browser sources are reloaded and hidden constantly, and a poll survives that
 * without any reconnection logic.
 */
class Overlay {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
    this.server = null;
    this.port = 0;
    this.state = { playing: null };
  }

  get enabled() {
    return this.settings.get('overlayEnabled') === true;
  }

  /** Called by the library when a session starts or ends. */
  setPlaying(game, startedAt) {
    this.state.playing = game
      ? {
          title: game.title,
          tagline: game.tagline || '',
          startedAt,
          art: game.art || null
        }
      : null;
  }

  url() {
    return this.port ? `http://127.0.0.1:${this.port}/` : null;
  }

  start() {
    if (this.server) return { ok: true, url: this.url() };
    if (!this.enabled) return { ok: false, reason: 'disabled' };

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._serve(req, res));
      this.server.on('error', (err) => {
        this.log?.warn('overlay', 'Could not start the overlay server', err);
        this.server = null;
        resolve({ ok: false, error: err.message });
      });
      // A fixed port would be friendlier to paste, but it would also collide;
      // the settings panel shows whatever the OS handed out.
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.log?.info('overlay', `Now-playing source on ${this.url()}`);
        resolve({ ok: true, url: this.url() });
      });
    });
  }

  stop() {
    try {
      this.server?.close();
    } catch {
      /* already gone */
    }
    this.server = null;
    this.port = 0;
  }

  async setEnabled(on) {
    this.settings.set('overlayEnabled', !!on);
    if (!on) {
      this.stop();
      return { ok: true, enabled: false };
    }
    const started = await this.start();
    return { ...started, enabled: true };
  }

  _serve(req, res) {
    if (req.url.startsWith('/state')) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // The source is polled; a cached response would freeze the timer.
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(this.state));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  }
}

/**
 * Transparent by design: OBS composites it over the capture, so the page must
 * paint nothing where there is nothing to say. It also hides itself entirely
 * when no game is running, rather than showing an empty card.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BlackNight - now playing</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body {
    font: 16px/1.4 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    color: #eef1f7;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 20px 14px 16px;
    border-radius: 14px;
    background: rgba(8, 9, 14, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(14px);
    width: max-content;
    max-width: 460px;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 400ms ease, transform 400ms ease;
  }
  .card.on { opacity: 1; transform: none; }
  .dot {
    width: 9px; height: 9px; border-radius: 50%; flex: none;
    background: #7dffa8; box-shadow: 0 0 12px #7dffa8;
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.45; } }
  .body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .eyebrow { font-size: 0.62rem; letter-spacing: 0.26em; text-transform: uppercase; color: #626b7d; }
  .title { font-size: 1.05rem; letter-spacing: 0.01em; white-space: nowrap; }
  .meta { font-size: 0.76rem; color: #9aa3b5; font-variant-numeric: tabular-nums; }
</style></head>
<body>
  <div class="card" id="card">
    <span class="dot"></span>
    <span class="body">
      <span class="eyebrow">Playing now</span>
      <span class="title" id="title"></span>
      <span class="meta" id="meta"></span>
    </span>
  </div>
<script>
  const card = document.getElementById('card');
  const title = document.getElementById('title');
  const meta = document.getElementById('meta');
  let startedAt = null;

  const elapsed = () => {
    if (!startedAt) return '';
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's';
  };

  async function poll() {
    try {
      const state = await (await fetch('/state', { cache: 'no-store' })).json();
      if (state.playing) {
        startedAt = state.playing.startedAt;
        title.textContent = state.playing.title;
        card.classList.add('on');
      } else {
        startedAt = null;
        card.classList.remove('on');
      }
    } catch { /* the launcher closed; keep the last frame rather than flicker */ }
  }

  setInterval(poll, 2000);
  setInterval(() => { meta.textContent = elapsed(); }, 1000);
  poll();
</script>
</body></html>`;

module.exports = { Overlay };
