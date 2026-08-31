'use strict';
const { Store } = require('./store');

const DEFAULTS = {
  // Appearance
  accent: 'moonlight',
  reduceMotion: false,
  backgroundFx: 'full', // full | lite | off
  uiScale: 100,
  uiSounds: true,
  soundVolume: 45,
  // Downloads
  installDir: '',
  libraryFolders: [],
  concurrentDownloads: 1,
  bandwidthLimitMbps: 0, // 0 = unlimited
  pauseOnMetered: true,
  autoUpdateGames: true,
  yieldWhilePlaying: true,
  // Delta patching and LAN sharing: both trade a little local work for a lot
  // less transfer. Sharing touches the network, so it is opt-in.
  deltaPatching: true,
  lanSharing: false,
  peerId: '',
  keepPakOnUninstall: false,
  keepRollback: true,
  backgroundVerify: true,
  playingBandwidthPercent: 20,
  downloadWindowEnabled: false,
  downloadWindowStart: 1, // hour, 24h clock
  downloadWindowEnd: 7,
  // Launcher behaviour
  autoCheckUpdates: true,
  windowBounds: null,
  windowMaximized: false,
  launchOnStartup: false,
  startMinimized: false,
  minimizeToTray: true,
  closeAction: 'tray', // tray | quit
  exitOnGameLaunch: false,
  showPlaytime: true,
  // Account / privacy
  rememberMe: true,
  richPresence: true,
  // Whether diagnostic logs may include machine details. Nothing is uploaded
  // anywhere; this only controls what the local log file records.
  diagnosticLogs: true,
  backupSaves: true,
  saveBackupsKept: 5,
  // Interface
  lastRoute: 'games',
  locale: 'auto',
  // The starfield is drawn from your own library rather than at random.
  libraryConstellation: true,
  timeOfDayTint: true,
  launchRitual: true,
  titleSignatures: true,

  // Habits
  sessionInsights: true,
  playJournal: true,

  // Content
  // Empty means "use the copy that shipped with this build". Point it at a
  // hosted catalog.json to announce titles without shipping an installer.
  catalogUrl: '',

  // Meta
  onboarded: false
};

function createSettings(dir) {
  return new Store(dir, 'settings', DEFAULTS);
}

module.exports = { createSettings, SETTINGS_DEFAULTS: DEFAULTS };
