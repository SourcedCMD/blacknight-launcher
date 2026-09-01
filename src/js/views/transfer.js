/* =========================================================================
   Moving your settings to another machine, and reading what changed.

   Two small things that share a home because both are about the launcher
   talking about itself.

   Seventy-odd settings, and until now the only way to reproduce them on a
   second PC was to click through all seven tabs from memory. The handoff
   feature already moves installs; this moves the rest.

   And the changelog: written, maintained, shipped inside the app, and
   readable by nobody without opening the repository.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { el, esc } = BN.util;

  /**
   * Settings that must not travel.
   *
   * Three kinds: things that identify this machine, things that are secret,
   * and things that describe hardware the other machine does not have. A
   * settings file that carried a session token would turn "send me your
   * settings" into "send me your account".
   */
  const NEVER_EXPORT = [
    'presenceClientId',  // identifies this install
    'installDir',        // a path that will not exist there
    'libraryFolders',
    'peerName',
    'lastRoute',
    'windowBounds'
  ];

  const SECRET = /token|secret|password|key$/i;

  function exportable(settings) {
    const out = {};
    for (const [key, value] of Object.entries(settings)) {
      if (NEVER_EXPORT.includes(key)) continue;
      if (SECRET.test(key)) continue;
      // URLs point at services; they travel, because that is the point.
      out[key] = value;
    }
    return out;
  }

  /** What a file has to look like before any of it is applied. */
  function validate(doc) {
    if (!doc || typeof doc !== 'object') return 'That file is not a settings export.';
    if (doc.kind !== 'blacknight-settings') return 'That file is not a BlackNight settings export.';
    if (!doc.settings || typeof doc.settings !== 'object') return 'That export has no settings in it.';
    return null;
  }

  /**
   * Applies an import, keeping only keys this build actually knows.
   *
   * An export from a newer version can carry settings this one has never heard
   * of. Dropping them is right: writing an unknown key into the store would
   * persist something nothing reads and nothing can clear.
   */
  function reconcile(incoming, known) {
    const accepted = {};
    const ignored = [];

    for (const [key, value] of Object.entries(incoming)) {
      if (NEVER_EXPORT.includes(key) || SECRET.test(key)) {
        ignored.push(key);
        continue;
      }
      if (!(key in known)) {
        ignored.push(key);
        continue;
      }
      // A type that does not match what this build expects is a bad import,
      // not a migration.
      if (typeof value !== typeof known[key] && known[key] !== null && known[key] !== undefined) {
        ignored.push(key);
        continue;
      }
      accepted[key] = value;
    }

    return { accepted, ignored };
  }

  async function exportSettings() {
    const doc = {
      kind: 'blacknight-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      app: BN.state.data.appInfo?.version || null,
      settings: exportable(BN.state.data.settings)
    };

    const saved = await BN.api.app.saveJson?.(JSON.stringify(doc, null, 2), 'blacknight-settings.json');
    BN.ui.toast(
      saved?.ok ? 'Settings exported' : saved?.cancelled ? '' : 'Could not export',
      saved?.path || saved?.error || '',
      { kind: saved?.ok ? 'ok' : 'error' }
    );
  }

  async function importSettings() {
    const picked = await BN.api.app.openJson?.();
    if (!picked?.ok) {
      if (picked && !picked.cancelled) BN.ui.toast('Could not read that file', picked.error || '', { kind: 'error' });
      return;
    }

    let doc;
    try {
      doc = JSON.parse(picked.text);
    } catch {
      BN.ui.toast('Could not read that file', 'It is not valid JSON.', { kind: 'error' });
      return;
    }

    const problem = validate(doc);
    if (problem) {
      BN.ui.toast('Not a settings export', problem, { kind: 'error' });
      return;
    }

    const { accepted, ignored } = reconcile(doc.settings, BN.state.data.settings);
    const count = Object.keys(accepted).length;
    if (!count) {
      BN.ui.toast('Nothing to import', 'None of those settings apply to this version.', { kind: 'info' });
      return;
    }

    const ok = await BN.ui.confirm({
      title: 'Import these settings?',
      message:
        `${count} setting${count === 1 ? '' : 's'} will be replaced on this machine.` +
        (ignored.length ? ` ${ignored.length} were skipped as unknown, private to a machine, or secret.` : ''),
      confirmLabel: 'Import'
    });
    if (!ok) return;

    await BN.state.setSettings(accepted);
    BN.state.applyAppearance();
    BN.art.keyArt.clearCache();
    BN.ui.toast('Settings imported', `${count} applied.`, { kind: 'ok' });
    BN.views.settings.render();
  }

  /* --- What's new -------------------------------------------------------- */

  /**
   * The changelog, rendered from the file that ships with the build.
   *
   * Parsed rather than duplicated into the UI, so there is one copy and it
   * cannot drift. Only a light parse: headings, bullets and bold, which is all
   * the file uses.
   */
  function renderMarkdown(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let inList = false;

    const closeList = () => {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
    };

    // Inline: **bold**, `code`, and nothing else. Everything is escaped first,
    // so the markup here is the only markup that survives.
    const inline = (raw) =>
      esc(raw)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

    for (const line of lines) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = Math.min(4, heading[1].length + 1);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        if (!inList) {
          out.push('<ul>');
          inList = true;
        }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }

      if (!line.trim()) {
        closeList();
        continue;
      }

      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }

    closeList();
    return out.join('\n');
  }

  async function whatsNew() {
    const result = await BN.api.app.changelog?.();

    const body = el('div', { class: 'changelog' });
    if (!result?.ok) {
      body.innerHTML = '<p class="dim">The changelog could not be read from this build.</p>';
    } else {
      // Only the most recent entries: nobody opens this to read to the bottom.
      const trimmed = result.text.split(/\n(?=## )/).slice(0, 4).join('\n');
      body.innerHTML = renderMarkdown(trimmed);
    }

    BN.ui.modal({
      title: "What's new",
      wide: true,
      content: body,
      footer: [{ label: BN.t('action.close'), class: 'btn-accent', onClick: ({ close }) => close() }]
    });
  }

  BN.views = BN.views || {};
  BN.views.transfer = { exportSettings, importSettings, whatsNew, exportable, reconcile, validate, renderMarkdown };
})();
