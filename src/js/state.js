/* =========================================================================
   Application state + actions.

   One store, one set of actions, and a bus event per change. Views never call
   the backend bridge directly - they call an action here and re-render when
   the matching bus event fires.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});
  const { bus } = BN.util;

  const state = {
    user: null,
    settings: {},
    catalog: { games: [], news: [] },
    library: [],
    downloads: [],
    stats: { owned: 0, installed: 0, totalPlaytimeSeconds: 0, diskUsedBytes: 0, recent: [] },
    route: 'games',
    selectedGameId: null,
    online: navigator.onLine
  };

  /* --------------------------------------------------------------------- */
  /* Theme                                                                  */

  function applyAppearance() {
    const root = document.documentElement;
    root.dataset.accent = state.settings.accent || 'moonlight';
    root.dataset.motion = state.settings.reduceMotion ? 'reduced' : 'full';
    root.style.setProperty('--ui-scale', (state.settings.uiScale || 100) / 100);
    // Lets the stylesheet thin the background so the Mica tint reads through.
    root.setAttribute('data-material', state.settings.windowMaterial || 'none');

    BN.sound?.configure({ enabled: !!state.settings.uiSounds, volume: state.settings.soundVolume ?? 45 });

    const fx = BN.fx?.background;
    if (fx) {
      const mode = state.settings.reduceMotion ? 'off' : state.settings.backgroundFx || 'full';
      fx.setMode(mode);
      fx.setAccent(getComputedStyle(root).getPropertyValue('--accent').trim());
    }
  }

  /* --------------------------------------------------------------------- */
  /* Loading                                                                */

  async function loadSettings() {
    state.settings = await BN.api.settings.get();
    applyAppearance();
    return state.settings;
  }

  async function loadCatalog() {
    state.catalog = await BN.api.catalog.get();
    return state.catalog;
  }

  async function refreshLibrary() {
    state.library = await BN.api.library.list();
    state.stats = await BN.api.library.stats();
    bus.emit('library', state.library);
    return state.library;
  }

  async function refreshDownloads(list) {
    state.downloads = list || (await BN.api.downloads.list());
    bus.emit('downloads', state.downloads);
    return state.downloads;
  }

  /* --------------------------------------------------------------------- */
  /* Actions                                                                */

  async function setSettings(patch) {
    state.settings = await BN.api.settings.set(patch);
    applyAppearance();
    bus.emit('settings', state.settings);
    return state.settings;
  }

  async function signIn(payload) {
    const result = await BN.api.auth.signIn(payload);
    if (result.ok) await afterAuth(result.user);
    return result;
  }

  async function signUp(payload) {
    const result = await BN.api.auth.signUp(payload);
    if (result.ok) await afterAuth(result.user);
    return result;
  }

  async function signInOffline() {
    const result = await BN.api.auth.signInOffline();
    if (result.ok) await afterAuth(result.user);
    return result;
  }

  async function afterAuth(user) {
    state.user = user;
    await refreshLibrary();
    await refreshDownloads();
    bus.emit('user', user);
  }

  async function signOut() {
    await BN.api.auth.signOut();
    state.user = null;
    bus.emit('user', null);
    bus.emit('signed-out');
  }

  async function updateProfile(patch) {
    const result = await BN.api.auth.updateProfile(state.user.id, patch);
    if (result.ok) {
      state.user = result.user;
      bus.emit('user', state.user);
    }
    return result;
  }

  /** Returns the merged catalog + install record for one title. */
  const game = (id) => state.library.find((g) => g.id === id) || state.catalog.games.find((g) => g.id === id) || null;

  async function install(id) {
    const result = await BN.api.library.install(id);
    await refreshLibrary();
    await refreshDownloads();
    if (result.ok) BN.sound?.play('download');
    return result;
  }

  async function acquire(id) {
    const result = await BN.api.library.acquire(id);
    await refreshLibrary();
    return result;
  }

  async function uninstall(id, options) {
    const result = await BN.api.library.uninstall(id, options);
    await refreshLibrary();
    return result;
  }

  async function verify(id) {
    const result = await BN.api.library.verify(id);
    await refreshLibrary();
    return result;
  }

  async function launch(id) {
    const result = await BN.api.library.launch(id);
    await refreshLibrary();
    return result;
  }

  async function endSession(id) {
    const result = await BN.api.library.endSession(id);
    await refreshLibrary();
    // A non-zero exit means the launcher has something useful to say.
    if (result?.crashed) BN.components?.reportCrash(game(id), result);
    return result;
  }

  async function toggleFavorite(id) {
    const current = game(id);
    await BN.api.library.setFavorite(id, !current?.favorite);
    await refreshLibrary();
  }

  const downloadAction = async (action, id) => {
    await BN.api.downloads[action](id);
    await refreshDownloads();
    await refreshLibrary();
  };

  /* --------------------------------------------------------------------- */
  /* Derived views                                                          */

  const installedGames = () => state.library.filter((g) => g.installed);
  const ownedGames = () => state.library.filter((g) => g.owned);
  const featuredGames = () => {
    const featured = state.library.filter((g) => g.featured);
    return featured.length ? featured : state.library.slice(0, 3);
  };
  // A transfer waiting out a backoff is still active: it has a partial file on
  // disk and it is coming back. Leaving it out would make the titlebar pill
  // vanish during a blip, which reads as the download having stopped.
  const activeDownloads = () =>
    state.downloads.filter((d) => ['downloading', 'queued', 'paused', 'retrying'].includes(d.status));

  /** Aggregate progress across the queue, for the titlebar pill + taskbar. */
  function queueProgress() {
    const active = activeDownloads();
    if (!active.length) return null;
    const total = active.reduce((s, d) => s + d.totalBytes, 0);
    const done = active.reduce((s, d) => s + d.receivedBytes, 0);
    const speed = active.reduce((s, d) => s + (d.speedBps || 0), 0);
    return {
      count: active.length,
      progress: total ? done / total : 0,
      speedBps: speed,
      etaSeconds: speed > 0 ? Math.round((total - done) / speed) : null,
      downloading: active.some((d) => d.status === 'downloading')
    };
  }

  /* --------------------------------------------------------------------- */

  window.addEventListener('online', () => { state.online = true; bus.emit('connectivity', true); });
  window.addEventListener('offline', () => { state.online = false; bus.emit('connectivity', false); });

  BN.state = {
    get data() { return state; },
    applyAppearance, loadSettings, loadCatalog, refreshLibrary, refreshDownloads,
    setSettings, signIn, signUp, signInOffline, signOut, updateProfile, afterAuth,
    game, install, acquire, uninstall, verify, launch, endSession, toggleFavorite, downloadAction,
    installedGames, ownedGames, featuredGames, activeDownloads, queueProgress
  };
})();
