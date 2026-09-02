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
  // Shown to other launchers on the same network, alongside what is playing.
  peerName: '',
  sharePlaying: true,
  // Sharing beyond the local network needs somewhere for two launchers to
  // exchange connection details. Empty means the whole feature stays dormant.
  rendezvousUrl: '',
  remoteSharing: false,
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
  betaChannel: false,

  // Windows shell and streaming
  windowMaterial: 'mica',
  globalHotkeyEnabled: true,
  globalHotkey: 'Control+Shift+Space',
  streamerMode: false,
  overlayEnabled: false,
  handheldMode: 'auto', // auto | on | off
  viewTransitions: true,
  attractMode: true,
  // Empty until somebody deploys `server/`. While empty, passkey enrolment
  // reports that there is nowhere to keep a credential rather than failing.
  accountsUrl: '',
  // Off until asked for, and dormant without an account service and a session.
  cloudSaves: false,
  // The session token for the account service, kept apart from the local one.
  remoteToken: '',
  // gameId -> the version id this machine last synced, which is what makes a
  // conflict detectable rather than a silent overwrite.
  cloudSaveState: {},
  // gameId -> minutes. Empty unless somebody sets one for themselves.
  sessionGoals: {},
  // Year only, kept here and sent nowhere. Empty until somebody is asked.
  birthYear: 0,
  // Where to send "somebody is playing this" beats. Empty means the store
  // shows no player counts, which is what it has always done.
  presenceUrl: '',
  // Generated on first use, stored here, and meaningless outside this install.
  presenceClientId: '',

  // Off by default. Reads the install manifests Steam, Epic, GOG and Xbox
  // already wrote, so the library can show what is on the machine rather than
  // only what this launcher put there. Never leaves the machine.
  detectOtherLaunchers: false,
  // A quiet bar comparing the current run with this player's own median.
  sessionGhost: true,
  // Empty means the launcher never mentions the hour. A number is the hour
  // after which it says so once per session, and then stops.
  windDownHour: '',
  evolvingArt: true,
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
  // Off, and inert until an endpoint is set. Both have to be true before
  // anything leaves the machine.
  sendCrashReports: false,
  crashReportUrl: '',
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
