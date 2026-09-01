# Changelog

All notable changes to this project are recorded here. Dates are the date of
the release tag.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
## [1.0.0]

First packaged release. Launcher shell, store, library, downloads with resume,
local accounts, and the Windows installer.
