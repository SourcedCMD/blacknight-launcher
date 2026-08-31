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
  concurrentDownloads: 1,
  bandwidthLimitMbps: 0, // 0 = unlimited
  pauseOnMetered: true,
  autoUpdateGames: true,
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
  shareStats: false,
  // Meta
  onboarded: false
};

function createSettings(dir) {
  return new Store(dir, 'settings', DEFAULTS);
}

module.exports = { createSettings, SETTINGS_DEFAULTS: DEFAULTS };
