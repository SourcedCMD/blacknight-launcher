# What this launcher does to your machine

Written because a game launcher asks for a lot of trust — it installs software,
it runs as you, and it stays resident. Here is what it actually does, in plain
terms, so you can check rather than hope.

## Why Windows warns about it

The installer is **not code-signed**, so Windows SmartScreen shows a blue
"Windows protected your PC" panel on first run, and some antivirus products
flag it as suspicious.

That warning is doing its job. It does not mean the file is malicious; it means
Windows has not seen this publisher before and cannot vouch for it. A signing
certificate is the fix, it costs money annually, and it has not been bought yet.

**If you want to install anyway:** click **More info**, then **Run anyway**. If
you would rather not, that is an entirely reasonable position and you should
wait until the builds are signed.

**How to check what you downloaded is what was published:** every release on
GitHub lists a SHA-256 for each file. Compare it:

```
certutil -hashfile BlackNight-Launcher-Setup.exe SHA256
```

If that does not match the hash on the release page, do not run it.

### If your antivirus quarantines it

Electron applications are flagged more often than most, because the same
runtime is used by both ordinary software and occasionally by malware. If it
happens:

- Do not add a blanket exclusion for your whole downloads folder.
- Check the hash against the release page first.
- Report the false positive to your antivirus vendor — that is what actually
  fixes it for everybody.

## What leaves your machine

By default: **nothing**.

Every service the launcher can talk to is switched off until you fill in a URL,
and each one says so in Settings rather than pretending to work. With a fresh
install and no configuration, the launcher makes no network requests except
checking for its own updates.

When you do configure them, this is the complete list:

| Feature | What is sent | When |
| --- | --- | --- |
| Catalogue | Nothing. A plain GET. | On start, and every few minutes |
| Launcher updates | Your launcher version and platform | On start |
| Crash reports | The error, the version, the platform | Only if you switch it on |
| Player counts | A title id and a random client id | While a game is running, if switched on |
| Cloud saves | Your save files, for titles you enable | When a session ends |
| Accounts | Your email, handle, and a password hash | Only if you create a remote account |
| Screenshots | Nothing. Images are fetched, not uploaded. | When you open a game page |

What is **never** sent, under any configuration: your local library contents,
your file paths, your playtime, your journal, your night map, your hardware
details, or anything found by the other-launcher scan.

### The local data

Everything else stays in `%APPDATA%\BlackNight Launcher\data`:

- `library.json` — what you own, playtime, last played
- `journal.json` — one line per session
- `settings.json` — your settings
- `accounts.json` — local accounts, passwords as scrypt hashes
- `logs/` — a rolling diagnostic log
- `media/` — cached screenshots
- `saves/` — local save snapshots

You can read all of it. It is plain JSON.

## Games found from other launchers

Off by default. When switched on, the launcher reads the install manifests
Steam, Epic, GOG and Xbox have already written to disk, so your library can
show everything on the machine rather than only what this launcher installed.

It is read-only, it never modifies another launcher's data, and what it finds
is never sent anywhere — there is no endpoint that receives it.

Starting one of those games hands it back to the launcher that owns it, through
that launcher's own protocol handler. This app does not run other people's
games behind their launcher's back, because that is how saves get corrupted.

## Uninstalling

Removing the launcher removes **the launcher**. It does not remove:

- **Your games.** They stay wherever you installed them. If you want the disk
  space back, uninstall the titles first, or delete the install folders.
- **Your saves.** Both the games' own saves and the launcher's snapshots stay
  where they are.
- **Your settings and library records** in `%APPDATA%\BlackNight Launcher`.

This is deliberate. An uninstaller that silently deletes a hundred gigabytes of
games and every save with them is an uninstaller that ruins somebody's week.

To remove everything, delete `%APPDATA%\BlackNight Launcher` and your library
folders by hand after uninstalling.

## Reporting a problem

Settings → About → **Report a problem** copies your version, platform and
catalogue state to the clipboard and opens the issue tracker. Nothing is sent
automatically — you can read exactly what you are about to share before you
paste it.
