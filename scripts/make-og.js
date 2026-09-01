'use strict';
/**
 * Builds a share page per title, so a link to a game unfurls properly.
 *
 *   npm run og
 *
 * `blacknight://game/eclipse-protocol` opens the launcher, but the matching
 * https link pasted into Discord or a message currently unfurls as nothing.
 * These pages carry Open Graph and Twitter card metadata, and redirect anyone
 * who actually visits them into the launcher - so one URL works both as a
 * preview and as a deep link.
 *
 * Written into docs/, which is what GitHub Pages serves.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'electron', 'data', 'catalog.json');
const OUT = path.join(ROOT, 'docs', 'g');
const SITE = 'https://sourcedcmd.github.io/blacknight-launcher';
const REPO = 'https://github.com/SourcedCMD/blacknight-launcher';

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STATUS = {
  released: 'Available now',
  preorder: 'Pre-order',
  announced: 'Announced',
  'coming-soon': 'Coming soon'
};

function page(game) {
  const title = `${game.title} - BlackNight Studios`;
  // The tagline is the line worth showing in a preview; the description is
  // several sentences and gets truncated into nonsense.
  const description = game.tagline || String(game.description || '').slice(0, 160);
  const url = `${SITE}/g/${game.id}.html`;
  const deepLink = `blacknight://game/${game.id}`;
  const status = STATUS[game.status] || game.status;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="BlackNight Studios">
<meta property="og:title" content="${esc(game.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/share.png">
<meta property="og:image:alt" content="BlackNight Studios">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(game.title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/share.png">

<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #05050a; color: #eef1f7;
    font: 16px/1.6 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    text-align: center; padding: 24px;
  }
  .wrap { max-width: 46ch; }
  .eyebrow { font-size: .68rem; letter-spacing: .3em; text-transform: uppercase; color: #626b7d; }
  h1 {
    font-size: clamp(2rem, 6vw, 3rem); margin: 14px 0 6px; letter-spacing: .03em;
    text-transform: uppercase; line-height: 1.05;
  }
  .tagline { color: #9aa3b5; font-size: 1.05rem; }
  .row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 30px; }
  a.btn {
    display: inline-block; padding: 12px 20px; border-radius: 10px;
    border: 1px solid #1e2029; color: #eef1f7; text-decoration: none; font-size: .9rem;
  }
  a.primary { background: linear-gradient(160deg, #fff 10%, #c9d2e4 48%, #94a0b8 100%); color: #0a0b10; border-color: transparent; font-weight: 600; }
  .note { color: #626b7d; font-size: .8rem; margin-top: 22px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">${esc(status)}</div>
    <h1>${esc(game.title)}</h1>
    <p class="tagline">${esc(game.tagline || '')}</p>
    <div class="row">
      <a class="btn primary" href="${esc(deepLink)}">Open in the launcher</a>
      <a class="btn" href="${SITE}/">Get the launcher</a>
      <a class="btn" href="${REPO}">Source</a>
    </div>
    <p class="note">
      If nothing happens, the launcher is not installed yet.
    </p>
  </div>
<script>
  // Try the launcher immediately for anyone who already has it. A failed
  // custom-scheme navigation is silent, so the page stays as the fallback.
  try { location.replace(${JSON.stringify(deepLink)}); } catch (e) {}
</script>
</body>
</html>
`;
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });

  // Anything removed from the catalog should stop being served.
  for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith('.html')) fs.rmSync(path.join(OUT, file));
  }

  for (const game of catalog.games) {
    fs.writeFileSync(path.join(OUT, `${game.id}.html`), page(game), 'utf8');
  }

  console.log(`share pages: ${catalog.games.length} written to docs/g/`);
  console.log(`  ${SITE}/g/${catalog.games[0].id}.html`);
}

main();
