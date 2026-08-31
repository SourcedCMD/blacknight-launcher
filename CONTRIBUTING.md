# Contributing

Thanks for looking. A few things worth knowing before you open a pull request.

## Running it

```bash
npm install
npm run dev
```

`npm run web` serves the renderer over plain HTTP with an in-memory mock
backend, which is usually the faster way to work on UI. No Electron needed.

## What the tests cover

```bash
npm test
```

Everything under `electron/services/` is plain Node with no Electron import,
specifically so it can be tested directly. If you add logic there, add a test
next to the existing ones in `test/`. Renderer code is verified by running it.

## House style

- No build step and no renderer dependencies. `src/` loads classic scripts in
  dependency order and everything hangs off one `window.BN` namespace.
- No new runtime dependencies without a good reason. The sound palette is
  synthesised and the art is generated precisely so nothing has to ship as a
  binary.
- Comments explain *why*, not *what*. If a line needs explaining, the comment
  should say what it is defending against.
- Match the surrounding code. It is consistent on purpose.

## Things that will get a PR sent back

- A setting that does not do anything. Several of these existed and each one
  was a small lie to the user; please do not add another.
- A message claiming something was verified when only a proxy for it was
  checked.
- Anything that puts game installs on a cloud-synced path.

## Reporting something

Use the issue templates. For a crash, the launcher writes a log you can attach:
**Settings → Privacy → Launcher logs → Open logs**.
