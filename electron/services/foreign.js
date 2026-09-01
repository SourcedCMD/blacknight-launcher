'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Games installed by other launchers.
 *
 * A launcher that only shows its own seven titles is a folder with a skin on
 * it. Reading what else is installed lets the library be the place you
 * actually start from, which is the difference between something you open and
 * something you keep open.
 *
 * Three rules this module holds to:
 *
 *   - Read only. Nothing here writes to, launches through, or modifies
 *     another launcher's data. It parses files those launchers already wrote.
 *   - Local only. What it finds is returned to the renderer and stored on this
 *     machine. There is no endpoint that receives it, by construction.
 *   - Opt in. Nothing calls this until the setting is switched on, because
 *     enumerating somebody's library without asking is not a feature.
 *
 * The formats are read defensively: every one of them is undocumented and can
 * change, so a parse failure drops that entry rather than the whole scan.
 */

/**
 * Entries these launchers keep alongside games that are not games.
 *
 * Steam installs shared runtimes as ordinary apps with ordinary manifests, and
 * Xbox keeps a save folder next to the titles. Both would otherwise show up in
 * a library as something you could play.
 */
const NOT_A_GAME = [
  /^Steamworks Common Redistributables$/i,
  /^Steam Linux Runtime/i,
  /^Proton[ 0-9]/i,
  /^Steam Controller Configs$/i,
  /^GameSave$/i,
  /^SteamVR$/i
];

const looksLikeAGame = (title) => !NOT_A_GAME.some((pattern) => pattern.test(title));

/* --- Steam ---------------------------------------------------------------- */

/**
 * Valve's KeyValues format, enough of it.
 *
 * A tree of `"key" "value"` lines and `"key" { ... }` blocks. Not JSON, not
 * INI, and the only thing that reads it is Steam - so this parses the subset
 * that appears in libraryfolders.vdf and appmanifest files, and gives up
 * cleanly on anything else.
 */
function parseVdf(text) {
  const root = {};
  const stack = [root];
  // Matches `"key" "value"`, `"key"` opening a block, and a closing brace.
  const line = /^\s*(?:"([^"]*)"\s*(?:"([^"]*)")?|(\}))/;

  for (const raw of text.split(/\r?\n/)) {
    const match = line.exec(raw);
    if (!match) continue;
    const [, key, value, close] = match;

    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (key === undefined) continue;

    const top = stack[stack.length - 1];
    if (value === undefined) {
      // An opening brace may be on this line or the next; either way what
      // follows belongs inside.
      const child = {};
      top[key] = child;
      stack.push(child);
    } else {
      top[key] = value;
    }
  }
  return root;
}

/** Every disk Steam has been told to keep games on. */
function steamLibraries(steamRoot) {
  const folders = [path.join(steamRoot, 'steamapps')];
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const entries = vdf.libraryfolders || vdf.LibraryFolders || {};
    for (const value of Object.values(entries)) {
      const dir = typeof value === 'string' ? value : value?.path;
      if (dir) folders.push(path.join(dir, 'steamapps'));
    }
  } catch { /* one library, then */ }
  return [...new Set(folders)];
}

function steamRoot() {
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (!base) continue;
      const dir = path.join(base, 'Steam');
      if (fs.existsSync(dir)) return dir;
    }
    return null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Steam');
  }
  const linux = path.join(os.homedir(), '.steam', 'steam');
  return fs.existsSync(linux) ? linux : null;
}

function scanSteam() {
  const root = steamRoot();
  if (!root) return [];

  const found = [];
  for (const folder of steamLibraries(root)) {
    let files = [];
    try {
      files = fs.readdirSync(folder).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const app = parseVdf(fs.readFileSync(path.join(folder, file), 'utf8')).AppState;
        if (!app?.name || !app.installdir) continue;

        const dir = path.join(folder, 'common', app.installdir);
        if (!fs.existsSync(dir)) continue; // listed, but not actually there

        found.push({
          source: 'steam',
          id: `steam:${app.appid}`,
          title: app.name,
          path: dir,
          sizeBytes: Number(app.SizeOnDisk) || 0,
          lastPlayed: Number(app.LastPlayed) ? Number(app.LastPlayed) * 1000 : null,
          // Steam's own protocol handler: launching stays Steam's job.
          launch: `steam://rungameid/${app.appid}`
        });
      } catch { /* a manifest caught mid-write, or a format change */ }
    }
  }
  return found;
}

/* --- Epic ----------------------------------------------------------------- */

function scanEpic() {
  if (process.platform !== 'win32') return [];
  const programData = process.env.ProgramData || path.join('C:', 'ProgramData');
  const dir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.item'));
  } catch {
    return [];
  }

  const found = [];
  for (const file of files) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!item.DisplayName || !item.InstallLocation) continue;
      if (!fs.existsSync(item.InstallLocation)) continue;

      found.push({
        source: 'epic',
        id: `epic:${item.AppName}`,
        title: item.DisplayName,
        path: item.InstallLocation,
        sizeBytes: Number(item.InstallSize) || 0,
        lastPlayed: null,
        launch: `com.epicgames.launcher://apps/${item.AppName}?action=launch&silent=true`
      });
    } catch { /* skip it */ }
  }
  return found;
}

/* --- GOG ------------------------------------------------------------------ */

/**
 * GOG drops a `goggame-<id>.info` beside the game itself, so this looks in the
 * usual install roots rather than asking Galaxy - which may not be installed
 * at all, since GOG games run perfectly well without it.
 */
function scanGog() {
  const roots = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) roots.push(path.join(base, 'GOG Galaxy', 'Games'), path.join(base, 'GOG Games'));
    }
  } else {
    roots.push(path.join(os.homedir(), 'GOG Games'));
  }

  const found = [];
  for (const root of [...new Set(roots)]) {
    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const child of children) {
      const dir = path.join(root, child.name);
      try {
        const info = fs.readdirSync(dir).find((f) => /^goggame-\d+\.info$/.test(f));
        if (!info) continue;
        const doc = JSON.parse(fs.readFileSync(path.join(dir, info), 'utf8'));

        found.push({
          source: 'gog',
          id: `gog:${doc.gameId || child.name}`,
          title: doc.name || child.name,
          path: dir,
          // GOG does not record a size, and walking the tree is not worth the IO.
          sizeBytes: 0,
          lastPlayed: null,
          launch: null
        });
      } catch { /* skip it */ }
    }
  }
  return found;
}

/* --- Xbox / Microsoft Store ----------------------------------------------- */

/**
 * Xbox games live under a protected WindowsApps folder this process cannot
 * enumerate, and going around that protection would be exactly the wrong thing
 * for a launcher to do. What is readable is the sibling folder Xbox uses for
 * its own installs, which is where most of them actually are.
 */
function scanXbox() {
  if (process.platform !== 'win32') return [];

  const found = [];
  // Every fixed drive gets an XboxGames folder once a game is installed there.
  for (const drive of ['C', 'D', 'E', 'F']) {
    const root = path.join(`${drive}:`, path.sep, 'XboxGames');
    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const child of children) {
      found.push({
        source: 'xbox',
        id: `xbox:${child.name}`,
        title: child.name,
        path: path.join(root, child.name),
        sizeBytes: 0,
        lastPlayed: null,
        launch: null
      });
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */

const SOURCES = { steam: scanSteam, epic: scanEpic, gog: scanGog, xbox: scanXbox };

/**
 * Everything installed by another launcher, deduplicated by install path.
 *
 * Takes a few hundred milliseconds on a large Steam library, which is why the
 * caller is expected to cache it rather than call it on every render.
 */
function scan({ sources = Object.keys(SOURCES) } = {}) {
  const games = [];
  const errors = [];

  for (const name of sources) {
    const fn = SOURCES[name];
    if (!fn) continue;
    try {
      games.push(...fn());
    } catch (err) {
      // One launcher's format changing must not take the other three with it.
      errors.push({ source: name, message: err.message });
    }
  }

  // The same game can appear twice when a Steam library folder is nested
  // inside another scanned root.
  const byPath = new Map();
  for (const game of games) {
    if (!looksLikeAGame(game.title)) continue;
    const key = path.resolve(game.path).toLowerCase();
    if (!byPath.has(key)) byPath.set(key, game);
  }

  return {
    games: [...byPath.values()].sort((a, b) => a.title.localeCompare(b.title)),
    errors,
    scannedAt: Date.now()
  };
}

/**
 * Whether a URL is one this app is willing to hand to the shell.
 *
 * The general `openExternal` refuses custom schemes on purpose - a renderer
 * that can invoke arbitrary protocol handlers can reach a great deal of the
 * machine. This is the narrow exception: two schemes, each matched whole
 * against a pattern that admits nothing but an id, so there is no room for a
 * flag or a second argument to be smuggled through.
 *
 * Lives here rather than in the IPC handler so it can be tested directly,
 * which for a rule like this is the whole point.
 */
const LAUNCHER_URLS = [
  /^steam:\/\/rungameid\/\d{1,12}$/,
  /^com\.epicgames\.launcher:\/\/apps\/[A-Za-z0-9_-]{1,64}\?action=launch&silent=true$/
];

const isLauncherUrl = (url) => LAUNCHER_URLS.some((pattern) => pattern.test(String(url || '')));

/**
 * Reads back how long another launcher says a title has been played.
 *
 * Steam records total playtime in its own manifest, so this is a read of a
 * number that already exists rather than a stopwatch running in the
 * background. That distinction matters: the launcher does not watch other
 * people's processes, and it does not need to.
 *
 * Epic, GOG and Xbox record nothing readable, so a title from those sources
 * reports null - which the UI shows as "not recorded" rather than as zero.
 */
function playtimeFor(id) {
  const [source, appId] = String(id || '').split(':');
  if (source !== 'steam' || !/^\d+$/.test(appId || '')) return null;

  const root = steamRoot();
  if (!root) return null;

  for (const folder of steamLibraries(root)) {
    try {
      const file = path.join(folder, `appmanifest_${appId}.acf`);
      if (!fs.existsSync(file)) continue;

      const app = parseVdf(fs.readFileSync(file, 'utf8')).AppState;
      // Steam does not put playtime in the manifest; what it does put there is
      // when the title was last played, which is the honest thing to report.
      const lastPlayed = Number(app?.LastPlayed);
      return {
        lastPlayed: lastPlayed ? lastPlayed * 1000 : null,
        sizeBytes: Number(app?.SizeOnDisk) || 0,
        // Named so nobody mistakes this for a playtime the launcher measured.
        source: 'steam-manifest'
      };
    } catch { /* try the next library */ }
  }
  return null;
}

/**
 * Everything found, with whatever each launcher records about recency.
 *
 * Sorted by when a title was last played where that is known, so the list
 * opens on what somebody actually plays rather than alphabetically.
 */
function scanWithActivity(options) {
  const result = scan(options);

  for (const game of result.games) {
    const activity = playtimeFor(game.id);
    if (activity?.lastPlayed) game.lastPlayed = activity.lastPlayed;
  }

  result.games.sort((a, b) => {
    if (a.lastPlayed && b.lastPlayed) return b.lastPlayed - a.lastPlayed;
    if (a.lastPlayed) return -1;
    if (b.lastPlayed) return 1;
    return a.title.localeCompare(b.title);
  });

  return result;
}

module.exports = { scan, scanWithActivity, playtimeFor, parseVdf, looksLikeAGame, isLauncherUrl, SOURCES };
