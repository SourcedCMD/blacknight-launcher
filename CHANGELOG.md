# Changelog

All notable changes to this project are recorded here. Dates are the date of
the release tag.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
