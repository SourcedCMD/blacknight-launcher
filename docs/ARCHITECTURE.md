# Architecture

How the BlackNight Launcher is put together, and why. For what it is and how to
install it, see the [README](../README.md).

Electron main process, zero-dependency renderer, no build step.

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
    chunks.js        Block-level delta patching: manifests, diffs, plans
    peers.js         LAN peer install over multicast discovery
    achievements.js  Local achievements, earned from play history
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
    views/journal.js Play journal, session insights, year in review
    views/achievements.js  Achievements, channels, rollback, recovery
    views/           games, store, plus, downloads, settings, profile
    app.js           Boot sequence, routing, shortcuts, window chrome

scripts/
  dev-server.js      Static server for `npm run web`
  make-icon.js       Packs build/icons/*.png into build/icon.ico
  check-catalog.js   Validates catalog.json before it can be published
  sync.js            Validate, commit, integrate the remote, push
  release.js         Bump, roll the changelog, tag, push
  release-notes.js   Extracts a version's CHANGELOG section for the release
  doctor.js          Prints a diagnostic report for a bug report

test/
  services.test.js       Store, settings, accounts and install rules
  requirements.test.js   Hardware tiers and the "will it run?" verdict
  scheduling.test.js     Download window, bandwidth yielding, ownership
  diagnostics.test.js    Logging, catalog fallback, checksums, saves, updates
  chunks.test.js         Delta patching, peer tokens, journal, year in review
  channels.test.js       Channels, rollback, recovery, usage, achievements

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

## The parts that make it feel like BlackNight

**Your library is the night sky.** The starfield behind every view used to be
random. It is now drawn from the library: one star per title, placed from its
art seed so it never moves, sized by playtime and brightened by how recently it
was played. Hovering names it, clicking opens it. The background stops being
decoration and becomes a picture of how someone actually plays.

**Every title has a voice.** The sound palette is synthesised rather than
sampled, so a per-title launch sting costs a handful of numbers instead of a
folder of audio. Hue picks the key and the motif picks the character, so a
game's colour and its sound agree.

**Launching is an event.** The key art blooms, the title's own sting plays, and
the shell dims out of the way for a beat before the process starts.

**The launcher follows the sun.** The ambient ground shifts from daylight
through dusk to deep night. Only the background tokens move, so it composes
with whichever accent the player chose.

**It knows your habits.** A journal line is written per session, and before a
launch the launcher can say how long sessions here usually run and where that
lands on the clock - computed from local history, never uploaded. At the end of
a year that becomes a generated poster, seeded from the year's own numbers.

**Achievements, earned from the launcher rather than inside a game.** Ten of
them, each a pure predicate over local history, each with a badge generated from
its own id. They are never revoked - uninstalling a game does not take one away.

**Data usage by month**, split into what was downloaded, what came from a LAN
peer, and what was reused locally by the delta patcher. The launcher throttles,
schedules and yields bandwidth; this is the number that says what any of it
achieved.

**There is exactly one secret**, which is the correct number for a studio
launcher.

## Channels, and getting out of a bad patch

**Playtest and beta channels.** BlackNight+ sells guaranteed playtest entry, so
the launcher has somewhere to put a playtest build. A catalog entry may carry
`channels`, each with its own version and digest; `stable` is implicit and never
declared. Entitlement is checked in the main process, because a paid perk
enforced only in the UI is not enforced at all.

**Update rollback.** The build being replaced is kept, so a patch that breaks a
game is a thirty-second revert rather than another full download of a version
that may not even still be published. The rollback is itself reversible, and a
kept build that has rotted on disk is refused and discarded rather than
installed.

**Installs the launcher has forgotten.** Every install writes a manifest, and
nothing used to read it except `verify()`. The library folders are scanned at
startup for builds with no entry, which recovers a reinstalled launcher, a moved
drive or a restored backup instead of downloading 90 GB that is already there.
Anything with a checksum is verified before it is adopted.

**Quiet background verification.** One title at a time, only while nothing is
playing, at most weekly per title. Bit-rot is silent until someone hits it
mid-session.

## Getting a 90 GB game to people

**Updates patch block by block.** A build is chunked and hashed; an update only
transfers the blocks that actually changed, and a block that merely moved is
copied locally rather than downloaded. Fixed-size chunking cannot follow an
insertion that shifts a whole file - that needs a rolling hash, which is not
worth its cost for game data that is rebuilt rather than edited in place.

**Installs can be shared across a LAN.** Launchers announce completed installs
over multicast and serve them to each other, so a household downloads a build
once. Announcements carry ids and versions only, a token derived from the build
gates every request, and everything a peer sends is checked against the
catalog's own digest - a hostile peer can waste time and nothing else. Off
unless enabled.

**Uninstalling need not throw the download away.** Optionally the verified
payload is kept, so reinstalling is a checksum pass rather than another 90 GB.

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
Releases from
[SourcedCMD/blacknight-launcher](https://github.com/SourcedCMD/blacknight-launcher)
(`build.publish` in `package.json`).

Checks run once a few seconds after startup, and again whenever the user
presses **Check now** under Settings → About. Downloads are explicit rather
than automatic — a launcher that saturates the connection while a game is
installing is a launcher people turn off — and the new version is applied on
the next quit.

Two commands do everything:

```bash
npm run sync                 # validate, commit, integrate the remote, push
npm run release -- patch     # bump, roll the changelog, tag, push
```

`sync` refuses rather than pushes when anything is wrong: a credential-shaped
string in the diff, a file that will not parse, a failing test, an invalid
catalog. It merges rather than rebases, so a README edited on github.com
survives. `release` additionally refuses from a dirty tree, a branch other than
main, or a branch out of step with the remote, then pushes the tag that starts
the release workflow. Both take `--dry-run`.

A `pre-push` hook runs the same tests, so even a plain `git push` cannot ship a
failing build. `npm install` points git at it; `git push --no-verify` overrides.

`npm run doctor` prints versions, paths, disk space, library state and the last
errors from the log — enough to act on a report without three round trips. It
also warns if the install folder has ended up somewhere cloud-synced.

Signing is wired but dormant: set the `WINDOWS_CERT_BASE64` and
`WINDOWS_CERT_PASSWORD` repository secrets and the release workflow produces a
signed build. Without them it still publishes, just unsigned, so a missing
certificate never blocks a release.

Crash reports are off by default and inert until `crashReportUrl` is set. Both
have to be true before anything leaves the machine, and what goes is the error,
the version and the platform — never logs, paths or account details.

`.github/workflows/release.yml` then runs the tests, rebuilds the icon from its
PNG masters so a stale `.ico` cannot ship, builds the installer and publishes
it with `latest.yml` and the `.blockmap` — which is what `electron-updater`
reads. `.github/workflows/ci.yml` runs the tests on every push and pull request.

Building by hand still works (`npm run dist:win`), but the artefacts then have
to be attached to the release manually.

The download page in `docs/` is served by GitHub Pages — enable it once under
**Settings → Pages → Deploy from a branch → main → /docs**. It links to
`releases/latest`, so it never needs editing when a release goes out.

Because the repository is public, updates need no credentials. A private
repository would mean shipping a GitHub token inside the app to every user, so
if it is ever made private the update feed should move to a generic HTTPS
provider on your own server instead.

## Accessibility

Toasts live in an assertive live region and background events - download
milestones, achievements, verification results - in a polite one, so a screen
reader hears what a sighted user sees. Modals trap focus and hand it back.
Status is never carried by colour alone: the "will it run?" verdict uses a
distinct glyph per state, so it survives greyscale. Interface scale, reduced
motion and the animated background are all switchable.

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
