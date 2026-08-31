# BlackNight Launcher

The official desktop game launcher for BlackNight Studios. Electron main process,
zero-dependency renderer, no build step.

## Requirements

- Node.js 18+
- Windows 10/11 to produce the installer (the app itself runs anywhere Electron does)

## Getting started

```bash
npm install
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm start` | Runs the packaged-style Electron app |
| `npm run dev` | Same, with `--dev` (devtools, its own data directory) |
| `npm test` | Service unit tests, no Electron required |
| `npm run web` | Static preview at <http://localhost:4173> — no Electron needed |
| `npm run icon` | Rebuilds `build/icon.ico` from `build/icons/*.png` |
| `npm run dist:win` | Builds the NSIS installer into `release/` |

### Previewing without Electron

`npm run web` serves the renderer over plain HTTP. When the Electron preload
bridge is absent, `src/js/bridge.js` swaps in an in-memory mock backend that
implements the entire IPC surface — accounts, catalog, library, and a running
download simulation. It is a real preview of the UI, not a screenshot.

## Layout

```
electron/            Main process
  main.js            Window, tray, IPC registration
  preload.js         contextBridge surface (no generic invoke escape hatch)
  services/
    store.js         Atomic per-document JSON store
    settings.js      Settings schema and defaults
    auth.js          Local accounts: scrypt hashing, 30-day sessions
    downloader.js    Download queue with resume; real HTTP or simulated
    library.js       Install records, playtime, process launching
    updates.js       Launcher self-update over electron-updater
    hardware.js      Reads this machine: CPU, GPU, memory, free space
    requirements.js  Compares a title's requirements against it
    presence.js      Discord rich presence over the local IPC socket
    logger.js        Rolling diagnostic log in the data directory
    catalog.js       Remote slate and news, with the bundled copy as fallback
  data/catalog.json  The title catalogue

src/                 Renderer (classic scripts, dependency-ordered in index.html)
  css/               tokens -> base -> components -> shell -> views
  js/
    util.js          DOM helpers, formatters, seeded PRNG, event bus
    art.js           Procedural SVG: the mark, key art, posters, thumbnails
    bridge.js        BN.api — real IPC, or the mock backend in a browser
    state.js         Client-side store and cache
    ui.js            Toasts, modals, confirm, command palette, dropdowns
    components.js    Shared cards, detail modal, action buttons
    fx.js / sound.js Canvas background, pointer glow, UI sounds
    gamepad.js       Controller navigation over whatever is on screen
    onboarding.js    First-run setup: install folder, accent, sound
    diagnostics.js   Catches renderer errors and reports them to the log
    i18n.js          Translation layer; English bundled
    views/           games, store, plus, downloads, settings, profile
    app.js           Boot sequence, routing, shortcuts, window chrome

scripts/
  dev-server.js      Static server for `npm run web`
  make-icon.js       Packs build/icons/*.png into build/icon.ico

test/
  services.test.js       Store, settings, accounts and install rules
  requirements.test.js   Hardware tiers and the "will it run?" verdict
  scheduling.test.js     Download window, bandwidth yielding, ownership
  diagnostics.test.js    Logging, catalog fallback, checksums, saves, updates

build/
  icons/             PNG masters, 16–256px
  icon.ico           Multi-resolution icon for the exe and installer
```

## Architecture notes

**No renderer dependencies, no bundler.** `src/index.html` loads classic scripts
in dependency order. Everything hangs off one `window.BN` namespace. This keeps
the renderer loadable straight from `file://`, where ES modules are blocked.

**All imagery is generated.** `art.js` draws the studio mark, hero key art,
store posters and thumbnails as inline SVG from a seeded PRNG, so nothing ships
as a binary and every machine renders each title identically. To use real key
art, drop files in `src/assets` and point the catalog entries at them — the
components fall back to the generators.

**One source of truth for the brand.** The app rasterises `BN.art.logo()` at
runtime and hands it to the main process for the taskbar and tray. The same
vector feeds `build/icons/*.png`, which `npm run icon` packs into the `.ico`
that electron-builder stamps onto the executable and the NSIS installer.

**Downloads survive restarts.** The queue persists on every state transition
and resumes from the byte it reached. Catalog entries with a `downloadUrl` use
a real ranged HTTP transfer; the rest use a paced writer that produces a real
file of the right size, so the UI, the progress events and the resume logic are
exercised by the same code path a shipping title would take.

That simulated writer is a development affordance only. A packaged build
refuses to install a title with no `downloadUrl` rather than write gigabytes of
nothing to someone's drive — see `allowSimulated` in `library.js`.

**Games never install into a synced folder.** `defaultInstallDir()` in
`main.js` deliberately avoids Documents: Windows redirects it into OneDrive on
most machines with Known Folder Move enabled, which would sync every
multi-gigabyte install to the user's cloud storage. Installs go to
`%LOCALAPPDATA%` instead.

**Nothing claims to have taken money.** `BN.config.storeLive` gates every paid
path. While it is false the launcher still shows what a title or membership
costs, but purchases and sign-ups stop with an explanation instead of granting
the item. Free titles are unaffected. Flip it when payment services are live.

**Outward-facing URLs live in one place.** `BN.links` in `util.js` holds the
website, support, careers, terms and privacy addresses. Callers check
`hasLink()` before rendering, so an unset destination is simply not offered —
the launcher never ships a link that goes nowhere.

**A dev run cannot corrupt an installed copy.** `--dev` moves `userData` to its
own directory, so testing never writes over real accounts, library or queue.

**Ownership is an explicit flag.** It used to be inferred from a library record
existing, which meant any bookkeeping touch — wishlisting a title, saving
launch options — silently granted the game. `entry.owned` is now set only by
`acquire()`, and older records are migrated on first run.

## Features worth knowing about

**Will it run?** The store answers the question the requirements table never
does. `hardware.js` reads the real CPU, GPU, memory and free space;
`requirements.js` compares them and reports `recommended`, `minimum`, `below`
or `unknown`. Memory, storage and OS version are measurable so they get a real
verdict; CPU and GPU are matched by family and generation, and anything that
does not parse reports `unknown` rather than guessing. A confident wrong answer
about a 90 GB install is worse than an honest "compare these yourself".

**Downloads get out of the way.** While a game is running, transfers drop to a
share of the limit (20% by default) rather than pausing, so a queue still
finishes over a long session without starving the thing the player sat down to
do. There is also an optional download window — "only between 01:00 and
07:00" — which handles wrapping past midnight and resumes on its own.

**Pre-orders pre-load.** A pre-ordered title with a release date can download
now and stays locked until midnight on release, so nobody spends launch night
watching a progress bar.

**Out of space is a decision, not a dead end.** A failed install reports how
much is missing, offers another drive, and lists what could go — never-played
and longest-idle titles first, with a running total of what each selection
frees. The same picker lives in Settings under Storage.

**Controller navigation.** `gamepad.js` adds spatial focus movement over
whatever is already on screen, so every button the mouse can reach a D-pad can
too. Polling only runs while a pad is connected.

**A mark that is yours.** Each account's `avatarSeed` feeds the same seeded
generator the key art uses, so every player gets a profile banner nobody else
has, identical on every machine they sign in from.

**Rich presence.** `presence.js` speaks Discord's local IPC protocol directly
— two frames, no dependency — and follows the play session the library
already tracks. Set `CLIENT_ID` to a Discord application ID to enable it; while
it is empty the settings row says so rather than offering a switch that does
nothing.

**Nothing fails silently.** The main process logs uncaught exceptions and
rejections; the renderer registers its handlers before any view code runs and
queues reports until the IPC bridge exists. Everything lands in a rolling log
under the data directory, reachable from Settings, and the user is told a
problem occurred rather than being left with a half-drawn view.

**The catalog and news come from the network when they can.** Both used to be
baked into the asar, so announcing a title meant shipping an installer. The
launcher now prefers a remote document, falls back to the last good fetch, then
to the bundled copy - correct offline and on first run, current otherwise. A
document that fails to parse, or carries an empty slate, is rejected rather
than replacing a working catalog.

**Downloads are checksummed.** Catalog entries may carry a `sha256`, verified
before anything is reported as installed, and recorded in the install manifest
so a later verify compares like for like. Without one, `verify()` says it only
checked file sizes instead of claiming a guarantee it cannot make.

**Games update themselves.** An update is a version mismatch between the
catalog and what is on disk - no separate patch feed to keep in step.
`autoUpdateGames` decides whether they start on their own; either way the
player is told, because a silent 40 GB download is its own kind of rude.

**Saves are snapshotted.** Cloud saves need a server; keeping the last few
local versions does not. A snapshot is taken when a session ends and before a
restore, and saves are copied out of the install folder before an uninstall
removes it - so "keep my saves" means something.

**A crash says so.** The exit code of a launched game is kept, so a title that
dies on startup no longer looks exactly like one somebody quit; the launcher
offers to verify the files instead.

**Deep links.** `blacknight://game/<id>` and `blacknight://store` open straight
into the launcher, so the site or a Discord message can point at a title.

**Multiple library folders.** A small SSD and a large HDD is the ordinary PC.
The primary folder always leads and cannot be removed, and a folder holding an
install cannot be dropped.

**First run asks three questions.** Install folder, accent and sound. The
accent step is the only chance most people get to discover that six exist.
Settings can replay it.

**Security posture.** The renderer runs sandboxed with `contextIsolation` on
and `nodeIntegration` off. The
preload exposes a fixed set of named channels with no generic `invoke(channel)`
escape hatch, so a compromised renderer cannot reach arbitrary IPC. The renderer
runs under a strict CSP (`default-src 'self'`, no remote origins). Passwords are
hashed with scrypt (N=16384, r=8, p=1) and compared in constant time; hashes and
salts never cross the bridge.

## Regenerating the app icon

`build/icons/*.png` are rasterised from `BN.art.logo()` — the same vector the
launcher draws at runtime. After changing the mark, re-export those PNGs at
16, 24, 32, 48, 64, 128 and 256px, then:

```bash
npm run icon
```

`make-icon.js` validates each PNG's dimensions and writes a multi-resolution
`.ico` with PNG-compressed entries (read natively by Windows Vista and later).

## Updates

The launcher updates itself through `electron-updater`, published to GitHub
Releases (`build.publish` in `package.json`). Set `owner` and `repo` to the
real repository before the first release.

Checks run once a few seconds after startup, and again whenever the user
presses **Check now** under Settings → About. Downloads are explicit rather
than automatic — a launcher that saturates the connection while a game is
installing is a launcher people turn off — and the new version is applied on
the next quit.

To cut a release: bump `version` in `package.json`, run `npm run dist:win`, and
publish `release/BlackNightLauncher-Setup-<version>.exe` together with
`latest.yml` and the `.blockmap` to the matching GitHub release tag.

## Status

The UI, the IPC surface and all six views are complete and driven by working
services. Still to connect before a public release:

- **The installer is unsigned**, so Windows SmartScreen warns on first run.
  Removing that needs a code-signing certificate.
- **No title has shipped a build.** No catalog entry carries a `downloadUrl`,
  so a packaged launcher currently has nothing it can install.
- **Accounts are local only.** Credentials live in `%APPDATA%` as scrypt
  hashes; there is no remote account service, so cloud saves, cross-device
  libraries and password recovery cannot work yet.
- **The store and memberships are closed** (`BN.config.storeLive`), and code
  redemption reports the service as unavailable.
- **`BN.links` is empty**, so site, support and legal links stay hidden until
  those pages exist.
- **Rich presence needs a Discord application ID** (`CLIENT_ID` in
  `presence.js`) before it can connect.
- **`catalogUrl` is empty**, so the slate and news come from the bundled copy
  until it points at a hosted `catalog.json`.
- **Live player counts are not populated.** The field exists but no service
  fills it, so nothing is displayed rather than a number being invented.
