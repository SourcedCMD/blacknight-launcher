/* =========================================================================
   Translation layer.

   `BN.t('key', { name: 'Ashfall' })` returns a string in the active locale,
   falling back to English and then to the key itself, so a missing entry shows
   up as an obviously-wrong string rather than an empty label.

   English is bundled. Other locales register themselves by calling
   BN.i18n.register('fr', { ... }) from their own file, which keeps the
   download cost of a language the launcher is not using at zero.

   Strings are migrated to keys incrementally: anything still written inline is
   simply English that has not moved yet. The plumbing being in place is what
   matters - retrofitting it after several thousand strings is far worse than
   growing the dictionary as views are touched.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const CATALOGS = { en: {} };
  let locale = 'en';

  /* --- English ---------------------------------------------------------- */

  CATALOGS.en = {
    // Actions shared across views
    'action.play': 'Play',
    'action.install': 'Install',
    'action.get': 'Get',
    'action.preload': 'Pre-load',
    'action.preorder': 'Pre-order',
    'action.pause': 'Pause',
    'action.resume': 'Resume',
    'action.cancel': 'Cancel',
    'action.close': 'Close',
    'action.save': 'Save',
    'action.confirm': 'Confirm',
    'action.wishlist': 'Wishlist',
    'action.wishlisted': 'Wishlisted',
    'action.running': 'Running',
    'action.locked': 'Unlocks soon',
    'action.verify': 'Verify files',
    'action.uninstall': 'Uninstall',
    'action.browse': 'Browse',
    'action.review': 'Review',
    'action.restore': 'Restore',

    // Status
    'status.released': 'Available now',
    'status.preorder': 'Pre-order',
    'status.announced': 'Announced',
    'status.comingSoon': 'Coming soon',
    'status.installed': 'Installed',
    'status.running': 'Running now',
    'status.paused': 'Paused',
    'status.downloading': 'Downloading',
    'status.updating': 'Updating',
    'status.preloaded': 'Pre-loaded - unlocks {date}',
    'status.download': '{size} download',
    'status.daysToLaunch': '{days} days to launch',

    // Navigation
    'nav.games': 'Games',
    'nav.store': 'Store',
    'nav.plus': 'BlackNight+',
    'nav.downloads': 'Downloads',
    'nav.settings': 'Settings',
    'nav.profile': 'My profile',

    // Updates
    'updates.available': '{count} update available',
    'updates.availablePlural': '{count} updates available',
    'updates.installAll': 'Update all',
    'updates.started': 'Updating {count} title',
    'updates.startedPlural': 'Updating {count} titles',
    'updates.upToDate': 'Everything is up to date',

    // Saves
    'saves.backedUp': 'Save data backed up',
    'saves.none': 'No save snapshots yet',
    'saves.restored': 'Save restored',
    'saves.keepOnUninstall': 'Keep my save data',
    'saves.keepHint': 'Saves are copied out before the install folder is removed.',

    // Storage
    'storage.free': 'Free up space',
    'storage.short': 'Frees {freed} - still {short} short',
    'storage.enough': 'Frees {freed} - enough to install {title}',
    'storage.select': 'Select titles to free space',
    'storage.neverPlayed': 'never played',
    'storage.idleDays': 'idle {days} days',
    'storage.notRecent': 'not played recently',

    // Library folders
    'folders.title': 'Library folders',
    'folders.add': 'Add a folder',
    'folders.primary': 'Primary',
    'folders.installedCount': '{count} installed',
    'folders.freeSpace': '{free} free',
    'folders.chooseTitle': 'Where should {title} go?',

    // Errors
    'error.generic': 'Something went wrong',
    'error.loggedTo': 'The details were written to the launcher log.',
    'error.openLogs': 'Open logs',
    'error.crashed': '{title} closed unexpectedly',
    'error.crashedBody': 'It exited with code {code} after {seconds}s. Verifying the files may help.',
    'error.noSpace': 'Not enough space'
  };

  /* --- Lookup ----------------------------------------------------------- */

  /** {name} placeholders are filled from `vars`; unknown ones are left alone. */
  function interpolate(template, vars) {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    );
  }

  /**
   * Looks a key up in the active locale, then English, then gives back the key.
   * A visible `saves.restored` in the UI is a bug report; an empty label is not.
   */
  function t(key, vars) {
    const active = CATALOGS[locale];
    const template =
      active && active[key] !== undefined && active[key] !== null
        ? active[key]
        : CATALOGS.en[key] !== undefined
          ? CATALOGS.en[key]
          : key;
    return interpolate(template, vars);
  }

  /** Picks the singular or plural key by count, English rules by default. */
  function plural(key, count, vars) {
    const candidate = count === 1 ? key : `${key}Plural`;
    const exists = CATALOGS[locale]?.[candidate] !== undefined || CATALOGS.en[candidate] !== undefined;
    return t(exists ? candidate : key, { count, ...vars });
  }

  function register(code, strings) {
    CATALOGS[code] = { ...(CATALOGS[code] || {}), ...strings };
  }

  /** `auto` follows the OS; anything else is used verbatim if it is known. */
  function setLocale(code) {
    if (!code || code === 'auto') {
      const system = (navigator.language || 'en').split('-')[0];
      locale = CATALOGS[system] ? system : 'en';
    } else {
      locale = CATALOGS[code] ? code : 'en';
    }
    document.documentElement.setAttribute('lang', locale);
    return locale;
  }

  const available = () => Object.keys(CATALOGS);

  BN.t = t;
  BN.i18n = { t, plural, register, setLocale, available, get locale() { return locale; } };
})();
