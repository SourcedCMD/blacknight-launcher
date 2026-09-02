'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer gets. Every entry is an explicit, named call -
 * no generic `invoke(channel)` escape hatch, so a compromised renderer cannot
 * reach a channel this file does not list.
 */
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const on = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('blacknight', {
  isElectron: true,

  window: {
    minimize: () => call('window:minimize'),
    maximize: () => call('window:maximize'),
    close: () => call('window:close'),
    state: () => call('window:state'),
    onState: (handler) => on('window:state', handler)
  },

  auth: {
    signIn: (payload) => call('auth:sign-in', payload),
    signUp: (payload) => call('auth:sign-up', payload),
    signInOffline: () => call('auth:sign-in-offline'),
    session: () => call('auth:session'),
    signOut: () => call('auth:sign-out'),
    updateProfile: (userId, patch) => call('auth:update-profile', userId, patch),
    changePassword: (userId, payload) => call('auth:change-password', userId, payload),
    strength: (password) => call('auth:strength', password)
  },

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    reset: () => call('settings:reset')
  },

  catalog: {
    get: () => call('catalog:get'),
    refresh: () => call('catalog:refresh'),
    onChanged: (handler) => on('catalog:changed', handler)
  },

  // Only the passkey endpoints. The launcher's own accounts stay local; this
  // is dormant until `accountsUrl` points somewhere.
  account: {
    passkeyChallenge: (userId) => call('account:passkey-challenge', userId),
    passkeyRegister: (payload) => call('account:passkey-register', payload),
    passkeyLoginChallenge: () => call('account:passkey-login-challenge'),
    passkeyLogin: (payload) => call('account:passkey-login', payload),
    passkeyRemove: (token, credentialId) => call('account:passkey-remove', token, credentialId)
  },

  library: {
    list: () => call('library:list'),
    stats: () => call('library:stats'),
    reclaimable: () => call('library:reclaimable'),
    acquire: (id) => call('library:acquire', id),
    install: (id, options) => call('library:install', id, options),
    folders: () => call('library:folders'),
    addFolder: () => call('library:add-folder'),
    removeFolder: (dir) => call('library:remove-folder', dir),
    outdated: () => call('library:outdated'),
    updateAll: () => call('library:update-all'),
    channels: (id) => call('library:channels', id),
    channel: (id) => call('library:channel', id),
    setChannel: (id, channelId) => call('library:set-channel', id, channelId),
    rollbackAvailable: (id) => call('library:rollback-available', id),
    rollback: (id) => call('library:rollback', id),
    scan: () => call('library:scan'),
    adopt: (id) => call('library:adopt', id),
    dataUsage: () => call('library:data-usage'),
    journal: (gameId, options) => call('library:journal', gameId, options),
    setJournalNote: (id, note) => call('library:journal-note', id, note),
    insights: (gameId) => call('library:insights', gameId),
    yearInReview: (year) => call('library:year-in-review', year),
    playMap: (options) => call('library:play-map', options),
    foreign: () => call('library:foreign'),
    move: (gameId, folder) => call('library:move', gameId, folder),
    inspect: (gameId) => call('library:inspect', gameId),
    screenshots: (gameId) => call('library:screenshots', gameId),
    prerequisites: (gameId) => call('library:prerequisites', gameId),
    installPrerequisite: (gameId, installerPath) => call('library:install-prerequisite', gameId, installerPath),
    cloudStatus: () => call('saves:cloud-status'),
    cloudCheck: (gameId) => call('saves:cloud-check', gameId),
    cloudPush: (gameId) => call('saves:cloud-push', gameId),
    cloudPull: (gameId, versionId) => call('saves:cloud-pull', gameId, versionId),
    cloudUsage: () => call('saves:cloud-usage'),
    onSaveConflict: (handler) => on('saves:conflict', handler),
    ghost: (gameId) => call('library:ghost', gameId),
    saveBackups: (id) => call('library:save-backups', id),
    backupSaves: (id) => call('library:backup-saves', id),
    restoreSave: (id, snapshot) => call('library:restore-save', id, snapshot),
    uninstall: (id, opts) => call('library:uninstall', id, opts),
    verify: (id) => call('library:verify', id),
    launch: (id) => call('library:launch', id),
    endSession: (id) => call('library:end-session', id),
    setFavorite: (id, value) => call('library:favorite', id, value),
    setLaunchOptions: (id, opts) => call('library:launch-options', id, opts)
  },

  downloads: {
    list: () => call('downloads:list'),
    pause: (id) => call('downloads:pause', id),
    resume: (id) => call('downloads:resume', id),
    cancel: (id) => call('downloads:cancel', id),
    prioritise: (id) => call('downloads:prioritise', id),
    clearFinished: () => call('downloads:clear-finished'),
    onProgress: (handler) => on('downloads:progress', handler),
    onChanged: (handler) => on('downloads:changed', handler),
    reorder: (id, direction) => call('downloads:reorder', id, direction),
    onCompleted: (handler) => on('downloads:completed', handler)
  },

  hardware: {
    probe: () => call('hardware:probe'),
    check: (gameId) => call('hardware:check', gameId)
  },

  presence: {
    status: () => call('presence:status'),
    setEnabled: (enabled) => call('presence:set-enabled', enabled),
    setRoute: (route) => call('presence:route', route)
  },

  handoff: {
    start: () => call('handoff:start'),
    stop: () => call('handoff:stop'),
    status: () => call('handoff:status'),
    receive: (details) => call('handoff:receive', details)
  },

  overlay: {
    status: () => call('overlay:status'),
    setEnabled: (on) => call('overlay:set-enabled', on)
  },

  shell: {
    registerHotkey: () => call('shell:hotkey'),
    refreshJumpList: () => call('shell:refresh-jumplist')
  },

  achievements: {
    list: () => call('achievements:list'),
    progress: () => call('achievements:progress'),
    evaluate: () => call('achievements:evaluate')
  },

  peers: {
    list: () => call('peers:list'),
    nowPlaying: () => call('peers:now-playing'),
    readRange: (id, version, offset, length) => call('peers:read-range', id, version, offset, length),
    status: () => call('peers:status'),
    setEnabled: (on) => call('peers:set-enabled', on)
  },

  log: {
    write: (level, scope, message, detail) => call('log:write', level, scope, message, detail),
    location: () => call('log:location'),
    open: () => call('log:open')
  },

  updates: {
    get: () => call('updates:get'),
    check: () => call('updates:check'),
    download: () => call('updates:download'),
    install: () => call('updates:install'),
    onState: (handler) => on('updates:state', handler)
  },

  app: {
    info: () => call('app:info'),
    chooseDirectory: (current) => call('app:choose-directory', current),
    chooseExecutable: () => call('app:choose-executable'),
    openPath: (target) => call('app:open-path', target),
    showItem: (target) => call('app:show-item', target),
    openExternal: (url) => call('app:open-external', url),
    openLauncher: (url) => call('app:open-launcher', url),
    copy: (text) => call('app:copy', text),
    mediaUsage: () => call('media:usage'),
    clearMedia: () => call('media:clear'),
    setLaunchOnStartup: (enabled) => call('app:set-launch-on-startup', enabled),
    registerIcon: (dataUrl) => call('app:register-icon', dataUrl),
    setTrayIcon: (dataUrl) => call('app:set-tray-icon', dataUrl),
    savePoster: (dataUrl, name) => call('app:save-poster', dataUrl, name),
    saveText: (text, name) => call('app:save-text', text, name),
    saveJson: (text, name) => call('app:save-json', text, name),
    openJson: () => call('app:open-json'),
    changelog: () => call('app:changelog'),
    readDoc: (name) => call('app:read-doc', name),
    smokeReport: (line) => call('app:smoke-report', line),
    saveVideo: (dataUrl, name) => call('app:save-video', dataUrl, name),
    setProgress: (value) => call('app:set-progress', value),
    relaunch: () => call('app:relaunch'),
    quit: () => call('app:quit'),
    onNavigate: (handler) => on('nav:go', handler),
    onDeepLink: (handler) => on('deeplink', handler),
    onAchievement: (handler) => on('achievement', handler),
    onQuickLaunch: (handler) => on('quick-launch', handler),
    onSmoke: (handler) => on('smoke:run', handler)
  }
});
