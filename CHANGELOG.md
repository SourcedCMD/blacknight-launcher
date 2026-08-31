# Changelog

All notable changes to this project are recorded here. Dates are the date of
the release tag.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.0.0]

First packaged release. Launcher shell, store, library, downloads with resume,
local accounts, and the Windows installer.
