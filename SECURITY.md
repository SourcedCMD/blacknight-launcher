# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/SourcedCMD/blacknight-launcher/security/advisories/new).
It is private between you and the maintainers until a fix is published.

If that is unavailable to you, email **security@blacknightstudios.example** —
replace this with a real address before relying on it.

Please include what you were doing, what happened, and anything needed to
reproduce it. A proof of concept is welcome but never required.

We aim to acknowledge a report within three days and to keep you updated as it
is worked on. You will be credited in the advisory unless you would rather not
be.

## What is in scope

The launcher touches a few things worth a closer look:

- **The IPC bridge** between the renderer and the main process
  (`electron/preload.js`). It exposes a fixed set of named channels with no
  generic `invoke` escape hatch, deliberately.
- **The download engine** (`electron/services/downloader.js`), including
  resumable transfers and checksum verification.
- **LAN peer sharing** (`electron/services/peers.js`), which opens a local HTTP
  listener and joins a multicast group. It is off unless enabled.
- **Local accounts** (`electron/services/auth.js`): scrypt hashing, session
  handling, and what does or does not cross the bridge.
- **Deep links** (`blacknight://`), which route into the renderer.
- **The catalog fetch**, which parses a remote document.

## What is not

- The installer is not yet code-signed, so Windows SmartScreen warns on first
  run. This is known, and is a certificate we have not bought rather than a
  vulnerability.
- Anything requiring an attacker to already have code execution as the user.
- The mock backend in `src/js/bridge.js`, which only runs in the browser
  preview and never ships in the packaged app.

## Supported versions

The latest release is supported. Given the project's age, older versions are
not patched — please update before reporting.
