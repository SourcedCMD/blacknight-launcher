# Changelog

All notable changes to this project are recorded here. Dates are the date of
the release tag.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Discord rich presence now actually shows something.** The service was
  correct and connected fine; it was only ever asked to publish during a play
  session. On a machine with no games installed — or any evening somebody
  browsed without starting anything — Discord showed nothing, and a working
  feature looked broken. The launcher now publishes its own presence from
  startup and follows the screen you are on, a running game outranks it, and
  closing a game falls back to the launcher rather than going blank. Quitting
  clears it outright.
- **A sale would have displayed as pennies.** `price.sale` was read as a
  fraction in one place and rendered as money in another; every title shipped
  with `sale: 0`, so neither was ever visibly wrong. Settled on the discounted
  price in dollars, used everywhere prices appear including the sort order,
  enforced by the catalogue check, and defended at runtime — a value under a
  hundredth of the list price is treated as a mistake rather than advertising a
  seventy dollar game for twenty-five cents.

### Added
- `npm run check:perf`, measuring the generators and formatters that run on
  every screen, with budgets at roughly eight times their current cost so a
  doubling trips the build. Art memoisation is worth about 25x on a re-render.
- Presence writes to the launcher log — connected, what it is showing, and why
  it is not — so "my presence is not working" is answerable from a file.
- `test/wiring.test.js`, doing what a bundler would in a project that has no
  bundler: every script and stylesheet the page loads exists, every renderer
  file is actually loaded, nothing reads another module before it is defined,
  every preload channel has a handler, no channel is registered twice, the
  browser bridge answers everything the preload does, and no selector is
  defined in two stylesheets. It found ten bridge methods added this session
  that the browser preview would have thrown on.

### Changed
- Removed genuinely dead code found by an audit: `releasedGames`,
  `upcomingGames`, `throttle` and `frag` were exported and never called.
  `priceOf` was dead too — that one was fixed by wiring it up rather than
  deleting it, since the code that should have used it had the bug above.
- `.menu[popover]` and `.swatch.locked` moved to the stylesheets that define
  the elements they modify, rather than sitting a file away from them.
- The time-of-day `#ambient` rule moved from `tokens.css`, which is for
  variables, to `shell.css`, which is where the element lives.


### Added
- **Screenshots.** Every image in the launcher was generated until now, which
  made the store a place you could not see what you were buying. A catalogue
  entry can carry `media.screenshots` and `media.trailerUrl`; the main process
  fetches and caches them and hands the renderer data URIs, so the content
  security policy stays exactly as strict as it was and the window never talks
  to an image host. Titles without screenshots show generated art and say so
  rather than letting anyone mistake it for gameplay. The catalogue check warns
  on a released title that has none.
- **An age gate.** The rating has been in the catalogue since it was written
  and was displayed for the first time last release; showing it without acting
  on it was the worse of the two options. Asks once, for a year of birth only,
  keeps the answer on the machine, and never gates anything below the mature
  threshold.
- **Move a title to another drive**, copy-verify-then-remove, so a failure at
  any point leaves the original playable. Previously the answer to "I bought an
  SSD" was to download ninety gigabytes again.
- **Per-block inspection**, naming the exact byte ranges that are damaged
  rather than declaring a whole install bad. Says plainly when a build ships no
  block hashes, and says when a fresh download would genuinely be faster.
- **Per-title news**, from the `gameId` every news item has always carried and
  only the front page ever read.
- **Account switching**, and a note that each account already keeps its own
  library, playtime and journal.
- **`docs/TRUST.md`**, readable from inside the launcher: why Windows warns
  about an unsigned build, how to check the hash of what you downloaded, a
  table of everything that leaves the machine under every configuration, and
  what uninstalling does and does not remove.

### Fixed
- **A play session no longer dies with the launcher.** Sessions lived only in
  memory, so a crash, a kill, or a machine going down lost the whole thing —
  and the evolving art, night map, session ghost and achievements are all
  computed from playtime. The open session is now written to disk and credited
  on the next start, capped at six hours and marked in the journal as inferred
  rather than measured.
- **Uninstall can no longer race a download** for the same title, which left a
  transfer writing into a directory that had just been removed.
- **A game killed from Task Manager is noticed.** Its exit event never arrives,
  so the session used to sit open forever, blocking uninstall and quietly
  accruing playtime nobody spent.
- A control character had got into the art-snapshot id normaliser through a bad
  escape in a patch, which is why that test failed roughly one run in ten. The
  snapshot script also ran its command line when imported, printing a table of
  hashes into the test output.


### Fixed
- **Downloads are retried instead of abandoned.** A dropped connection used to
  mark a transfer failed and stop, stranding a 90 GB download until somebody
  noticed and pressed resume. Five attempts with growing backoff, only for
  failures that could come right — a 404 or a checksum mismatch still stops at
  once. Pausing cancels a pending retry; resuming by hand resets the budget.
- **A launch that cannot happen is reported as a failure.** With no executable
  present, `launch()` returned success, opened a session and accrued playtime
  for a game that never ran. It now fails and offers to verify the files. The
  old behaviour remains only in builds explicitly made with simulation on.
- **Save conflicts are shown.** The server has refused overwriting saves since
  it was written, and the launcher was swallowing the refusal in an empty
  catch — protecting the save and then losing it to silence. There is now a
  dialog naming both versions, with no default answer.
- A stray control character in the art-snapshot id normaliser made that test
  fail roughly one run in ten; the script also ran its CLI when imported,
  printing a table of hashes into the test output.
- `prioritise()` moved a download to index 0, displacing a transfer that was
  already part-way through a file. It now inserts ahead of the first item that
  has not started.

### Added
- **Library search, sort and filter** — by name, playtime, size, recency, and
  installed/owned/wishlisted/never-played. The store had all three; the screen
  people actually live in had none.
- **Queue reordering**: move up, move down, and download this one first.
- **Prerequisite checks** for the Visual C++ runtime, .NET and DirectX, with an
  offer to run the installer the build shipped. Only ever an installer from
  inside the title's own directory, always asked for, and never a hard block.
- **Empty states** that say why a list is empty and offer the one action that
  would fix it, rather than a line of grey text.
- **Purchase history** — what you own, when it arrived, and what it cost at the
  time, recorded when a title is acquired. Stated plainly as the launcher's own
  record rather than a payment receipt.
- **Age ratings** shown on a title, spelled out rather than left as a letter.
- **A bug report that carries its own diagnostics**, copied to the clipboard so
  the reporter can read exactly what they are about to share.
- Website and support links, which were empty — there was no route from a
  broken install to a human being.
- Prices are formatted for the reader's locale, and a discounted price is
  rounded to whole cents rather than carrying floating-point noise.


### Added
- **Rate limiting and account lockout** on the services. Sign-in hashes with
  scrypt, which is expensive by design — without a ceiling that endpoint is
  both brute-forceable and a cheap way to pin the CPU. A per-address sliding
  window plus a per-account backoff, and a lockout reply shaped exactly like a
  wrong password so it still cannot be used to enumerate accounts.
- **Passkey sign-in**, verified properly: a CBOR decoder, attestation parsing,
  ES256 and RS256 signature checks, challenge and origin pinning, single-use
  challenges, and a signature-counter check that catches a cloned
  authenticator. Attestation *statements* are still not verified, which is a
  deliberate choice recorded in the module.
- **Cloud saves.** A push carries the version it was based on, so a second
  machine cannot silently overwrite work the first one did — a conflict stops
  and asks, and both versions stay recoverable. The local snapshot is taken
  before anything is written over.
- **Live player counts.** `playersOnline` has been read by the store UI since
  it was written and never populated. A heartbeat carries a title id and a
  random client id, nothing else; counts below five are not reported at all.
- **A crash dashboard** at `/crash/dashboard`, behind the same token as the
  JSON. `/crash/summary` had grouped and ranked crashes for months with no way
  to read it but curl.
- **A real smoke test** (`npm run smoke`) that boots the app and drives it
  through every view, modal and generator, failing on any uncaught error. Runs
  on the Windows leg of CI.
- **Settings search** across all seven sections — 72 rows, previously findable
  only by clicking through every tab.
- **French**, the first locale other than English, with a test that fails the
  build when an English key has no translation. A translation layer with one
  language in it had never actually been tested.
- **Settings export and import**, leaving out anything machine-specific or
  secret, and dropping keys the receiving build does not know.
- **An in-app changelog**, read from the file that ships with the build.
- **A backlog view**: installed, never really started, oldest first.
- **An art timeline** showing what a title's art grows into, which the
  deterministic generator could already compute.
- **Session goals** — a mark on the ghost bar, set by the person playing.
- **Deep links for actions**: `blacknight://install/<id>` and `play/<id>`,
  always confirmed, because a link should never start a 90 GB download on its
  own.
- **Reduced-transparency and forced-colors support**, which the Mica chrome
  previously ignored.
- Last-played dates for games found in other launchers, read from the manifests
  Steam already writes.

### Fixed
- `PORT=0` bound port 8080 instead of an ephemeral one: `Number('0') || 8080`
  is falsy. Two test servers then fought over the same port, which is why
  running both suites together hung.
- The smoke runner spawned Electron through a shell, so killing it left
  `electron.exe` holding the single-instance lock and every later run silently
  hung.

### Changed
- The performance budget was raised deliberately, with the reason recorded in
  `scripts/check-budget.js`, once six features and a locale landed together.


### Added
- **Services** (`server/`), a zero-dependency Node backend for the three
  settings the launcher already had and could not point anywhere: catalog,
  crash reports, and WebRTC rendezvous. Accounts with scrypt hashing matching
  the launcher's own, password reset, and entitlements a user cannot grant
  themselves. Includes a hand-written RFC 6455 WebSocket server, because Node
  ships a client and no server and a signalling relay is about a hundred lines.
- **Night map**: a week-by-hour grid of when you actually play, drawn from the
  local journal. A session is spread across the hours it covered, so a long
  evening reads as an evening rather than landing in the hour it ended.
- **Session ghost**: a quiet bar comparing the run you are in with your own
  median for that title. Not a target and not a streak.
- **Wind-down**: optionally says once, gently, that it is late. Off by default,
  and it never stops you playing.
- **Games from other launchers**: reads the install manifests Steam, Epic, GOG
  and Xbox already wrote, so the library is the whole machine. Off by default,
  read-only, and nothing leaves the PC. Titles are handed back to the launcher
  that owns them through a whitelist of exactly two URL shapes.
- **Share a title**: the share pages have existed since the site went up and
  nothing in the launcher pointed at one.
- **Share your library**: one self-contained HTML file with generated art, no
  network requests, and no playtime or account details in it.
- `npm run check:budget`, a performance budget over the shipped source, checked
  in CI. The renderer has no build step and no dependencies; both are easy to
  give away one commit at a time.
- **Passkey enrolment**, against the account service. Signing in with a passkey
  is deliberately not offered: the server stores the credential but does not
  yet verify a signature, and a button implying otherwise would be worse than
  no button. The settings row says which of the three reasons applies.
- `npm run art:snapshots`, recording what the art engine draws so a tweak to
  one generator cannot silently change every title's key art.

### Changed
- Key art is memoised, so re-rendering the library is a map lookup rather than
  a few thousand string concatenations per thumbnail.
- Navigation, action buttons and status badges now resolve through the
  translation catalogue instead of hardcoded English. Sixty-eight keys had been
  defined and nineteen used; the visible chrome is migrated, and a test fails
  the build if a referenced key does not exist.
- The credential scanner in `npm run sync` reports line numbers, and has one
  deliberate per-line escape hatch (`sync-allow-secret`) so it does not get
  switched off wholesale the first time it is inconvenient.

### Fixed
- A stray control character had got into `foreign.js` through a bad escape in a
  patch; the launcher-URL whitelist is now tested directly.
- The styles added for the night map, session ghost and other-launcher cards
  had been written to a stylesheet the page never loaded.

### Tests
- 221 launcher tests, up from 161: the renderer's pure logic (formatters, the
  seeded PRNG, translation, art determinism) had one file covered out of
  twenty-nine, plus the night map, ghost sessions and the foreign scanner.
- 22 service tests, run in CI, against a real server on an ephemeral port —
  including the WebSocket relay through the browser's own client.
- Art snapshots, verified to fail on a one-character change to a generator.


## [1.0.1] - 2026-09-01

### Added
- Playtest and beta channels per title, with BlackNight+ entitlement enforced
  in the main process rather than the UI.
- Update rollback: the build being replaced is kept, so a bad patch is a revert
  instead of another full download.
- Recovery of installs the launcher has forgotten, by reading the manifests
  already written next to every build.
- Notification when a wishlisted title is released.
- Rolling background verification of installed files.
- Local achievements, earned from play history.
- Data usage by month, split by origin, LAN peer, and blocks reused locally.
- A command line (`--install`, `--launch`, `--list`).
- Portable Windows build and a Linux AppImage.
- Screen-reader announcements and non-colour status indicators.
- `npm run sync` and `npm run release`, which validate before they publish, and
  a pre-push hook so a plain `git push` cannot ship a failing build either.
- `npm run doctor`, which prints everything a bug report needs in one paste.
- A beta channel for the launcher itself, off by default.
- Opt-in crash reporting, inert until an endpoint is configured.
- SECURITY.md, CODEOWNERS, and GitHub Actions pinned to commit SHAs.
- Release notes taken from this file and put on the GitHub release.
- Code signing wired into the release workflow, active once the certificate
  secrets are set.
- Mica backdrop, View Transitions between pages, scroll-driven reveals, and
  native Popover menus with anchor positioning.
- Windows integration: a jump list of recent games, pause and resume on the
  taskbar thumbnail, and a global hotkey that reaches the launcher from inside
  a game.
- Streamer mode, and a now-playing browser source for OBS.
- Discord party fields, so a multiplayer session is joinable from chat.
- Share pages per title, so an https link unfurls and then opens the launcher.
- Handheld layout for a Deck or a small screen.
- Handoff: move settings, library records and history to another machine over
  the local network, with a pairing code and a QR of the same link.
- Installer trimmed from 106 MB to 90 MB: one Chromium locale instead of 55,
  and the graphics libraries this UI never calls removed after packing.
- Electron fuses, so a packaged build refuses runAsNode, NODE_OPTIONS and the
  inspector, and validates its own asar.
- A winget manifest generator, and ESLint wired into CI and into sync.
- Releases publish live rather than as an invisible draft.
- `npm run publish-title`, which chunks and hashes a build and writes the
  download url, digest and block manifest into the catalog. This is the step
  that makes the whole download path real rather than simulated.
- Multi-source downloads: byte ranges are shared across the origin and every
  peer that has the build, reassigned as connections finish at different
  speeds, degrading to the origin alone if every peer drops.
- Who is playing right now on your network, from the announcement peers were
  already sending.
- Attract mode, art that grows with playtime, wallpaper export, and two
  accents that have to be earned.
- The year in review as a few seconds of video.
- The test chamber is now something you can actually play.
- A WebRTC transport for sharing beyond the local network.
## [1.0.0]

First packaged release. Launcher shell, store, library, downloads with resume,
local accounts, and the Windows installer.
