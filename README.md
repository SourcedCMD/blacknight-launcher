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
| `npm run dev` | Same, with `--dev` (opens devtools, verbose logging) |
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
    views/           games, store, plus, downloads, settings, profile
    app.js           Boot sequence, routing, shortcuts, window chrome

scripts/
  dev-server.js      Static server for `npm run web`
  make-icon.js       Packs build/icons/*.png into build/icon.ico

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

## Status

The UI, the IPC surface and all six views are complete and driven by working
services. The catalogue is BlackNight's real slate; no title has shipped a build
yet, so installs run through the downloader's simulated mode until catalog
entries gain a `downloadUrl`. Account and code-redemption services are local
only — there is no remote BlackNight account backend connected in this build.
