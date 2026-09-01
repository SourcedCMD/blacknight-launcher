'use strict';

/**
 * The studio-facing crash page.
 *
 * `/crash/summary` has grouped and ranked crashes since the day it was
 * written and nothing rendered it, which meant the only way to read it was
 * curl. This is that endpoint with a face on it.
 *
 * Served as one self-contained page, matching how the rest of this project
 * treats HTML: no framework, no build, no requests to anywhere. It is behind
 * the same admin token as the JSON, because a list of what is breaking and in
 * which version is not something to leave open.
 */

const escape = (text) =>
  String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** "3 minutes ago", down to the granularity anybody cares about. */
function ago(at) {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * A bar showing how much of the total each group accounts for.
 *
 * The ranked list already says which crash is most common; the bar says
 * whether the top one is most of them or merely first, which is the thing
 * that decides what gets fixed on a Monday.
 */
function bar(count, top) {
  const share = Math.max(2, Math.round((count / top) * 100));
  return `<div class="bar"><span style="width:${share}%"></span></div>`;
}

function render({ total, groups }) {
  const top = groups[0]?.count || 1;

  const rows = groups.length
    ? groups
        .map(
          (group) => `
      <tr>
        <td class="count">${group.count}</td>
        <td class="barcell">${bar(group.count, top)}</td>
        <td class="msg">${escape(group.message) || '<span class="dim">(no message)</span>'}</td>
        <td class="ver mono">${escape(group.version) || '<span class="dim">—</span>'}</td>
        <td class="when dim">${escape(ago(group.lastAt))}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">Nothing has crashed. That is the good outcome.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Crashes — BlackNight</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#08080c; --card:#12121a; --line:#23232e;
    --text:#e9ecf5; --dim:#8b90a3; --accent:#6f7cff; --warn:#e6a44b;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7fb; --card:#fff; --line:#e2e4ee; --text:#14151c; --dim:#616677; }
    body { color-scheme: light; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 24px; background:var(--bg); color:var(--text);
         font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; }
  h1 { font-size:1.6rem; margin:0 0 4px; letter-spacing:-0.02em; }
  .sub { color:var(--dim); margin:0 0 28px; }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th { text-align:left; font-size:.7rem; text-transform:uppercase; letter-spacing:.07em;
       color:var(--dim); padding:12px 14px; border-bottom:1px solid var(--line); font-weight:600; }
  td { padding:12px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .count { font-variant-numeric:tabular-nums; font-weight:700; width:56px; }
  .barcell { width:120px; }
  .bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; }
  .bar span { display:block; height:100%; background:var(--warn); border-radius:3px; }
  .msg { word-break:break-word; }
  .ver, .when { white-space:nowrap; }
  .mono { font-family:ui-monospace,'Cascadia Code',Consolas,monospace; font-size:.86rem; }
  .dim { color:var(--dim); }
  .empty { text-align:center; padding:40px; color:var(--dim); }
  footer { margin-top:22px; color:var(--dim); font-size:.8rem; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Crashes</h1>
    <p class="sub">${total} report${total === 1 ? '' : 's'} held, grouped by message and version, most common first.</p>
    <table>
      <thead>
        <tr><th>Count</th><th></th><th>Message</th><th>Version</th><th>Last seen</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <footer>
      Reports are capped at 2,000 and carry no account details, paths or logs —
      only what the launcher's reporter is built to send.
    </footer>
  </div>
</body>
</html>`;
}

module.exports = { render, ago, escape };
