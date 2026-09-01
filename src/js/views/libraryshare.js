/* =========================================================================
   A library page you can actually send someone.

   One self-contained HTML file: the art is inline SVG the launcher already
   generates, the styles are inline, and there are no requests to anywhere.
   Open it in a browser, put it on a USB stick, attach it to a message — it
   works the same in all three because it depends on nothing.

   What it deliberately does not include: playtime, session history, email,
   handle, or anything about when the machine is used. A library is a list of
   titles. The rest is nobody's business, and the surest way to keep it that
   way is to never put it in the file.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc } = BN.util;

  /**
   * Builds the page.
   *
   * Takes the titles rather than reading state directly so the caller decides
   * what is in it — which is what makes the checkbox list in the dialog real
   * rather than decorative.
   */
  function build(games, { title = 'My BlackNight library', note = '' } = {}) {
    const cards = games
      .map(
        (game) => `
      <li class="card">
        <div class="art">${BN.art.thumb(game)}</div>
        <div class="meta">
          <span class="name">${esc(game.title)}</span>
          ${game.tagline ? `<span class="tag">${esc(game.tagline)}</span>` : ''}
        </div>
      </li>`
      )
      .join('');

    // Written out rather than assembled from the app's stylesheet: this file
    // has to stand on its own on a machine that has never seen the launcher.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #08080c; --card: #12121a; --line: #23232e;
    --text: #e9ecf5; --dim: #8b90a3; --accent: #6f7cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 0 0 6px; letter-spacing: -0.02em; }
  .sub { color: var(--dim); margin: 0 0 8px; }
  .note { color: var(--text); margin: 0 0 32px; max-width: 62ch; }
  ul { list-style: none; padding: 0; margin: 0;
       display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 18px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .art { aspect-ratio: 1; overflow: hidden; }
  .art svg { width: 100%; height: 100%; display: block; }
  .meta { padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; }
  .name { font-weight: 600; }
  .tag { color: var(--dim); font-size: 0.82rem; }
  footer { margin-top: 44px; color: var(--dim); font-size: 0.82rem; }
  footer a { color: var(--accent); }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f6f7fb; --card: #fff; --line: #e2e4ee; --text: #14151c; --dim: #616677; }
    body { color-scheme: light; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(title)}</h1>
    <p class="sub">${games.length} title${games.length === 1 ? '' : 's'}</p>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <ul>${cards}</ul>
    <footer>
      Made with the <a href="${BN.share.SITE}">BlackNight launcher</a>.
      This page contains nothing but the titles above.
    </footer>
  </div>
</body>
</html>`;
  }

  /**
   * The dialog: pick what goes in, then save it.
   *
   * Everything is checked by default because the common case is "all of it",
   * and unchecking three is less work than checking twenty.
   */
  function open() {
    const games = BN.state.installedGames();
    if (!games.length) {
      BN.ui.toast('Nothing to share yet', 'Install something first.', { kind: 'info' });
      return;
    }

    const body = el('div', { class: 'col', style: { gap: '14px' } });
    body.innerHTML = `
      <p class="dim" style="line-height:1.6;margin:0">
        One self-contained HTML file — the art is generated, nothing is loaded from the internet,
        and no playtime or account details are included.
      </p>
      <label class="field">
        <span class="field-label">Heading</span>
        <input class="input" id="ls-title" value="My BlackNight library" maxlength="80">
      </label>
      <label class="field">
        <span class="field-label">A line about it (optional)</span>
        <input class="input" id="ls-note" placeholder="What you have been playing lately" maxlength="200">
      </label>
      <div class="field">
        <span class="field-label">Titles</span>
        <div class="col ls-list" id="ls-list" style="gap:6px;max-height:240px;overflow:auto"></div>
      </div>`;

    const list = body.querySelector('#ls-list');
    for (const game of games) {
      const row = el('label', { class: 'row', style: { gap: '10px', alignItems: 'center' } });
      row.innerHTML = `
        <input type="checkbox" class="check" value="${esc(game.id)}" checked>
        <span>${esc(game.title)}</span>`;
      list.append(row);
    }

    BN.ui.modal({
      title: 'Share your library',
      content: body,
      footer: [
        { label: BN.t('action.close'), class: 'btn-ghost', onClick: ({ close }) => close() },
        {
          label: 'Save page',
          class: 'btn-accent',
          onClick: async ({ close }) => {
            const chosen = [...list.querySelectorAll('input:checked')].map((input) => input.value);
            const picked = games.filter((game) => chosen.includes(game.id));
            if (!picked.length) {
              BN.ui.toast('Pick at least one title', '', { kind: 'info' });
              return;
            }

            const html = build(picked, {
              title: body.querySelector('#ls-title').value.trim() || 'My BlackNight library',
              note: body.querySelector('#ls-note').value.trim()
            });

            const saved = await BN.api.app.saveText?.(html, 'blacknight-library.html');
            close();
            BN.ui.toast(
              saved?.ok ? 'Library page saved' : 'Could not save the page',
              saved?.path || saved?.error || '',
              { kind: saved?.ok ? 'ok' : 'error' }
            );
          }
        }
      ]
    });
  }

  BN.views = BN.views || {};
  BN.views.libraryShare = { open, build };
})();
