# Screenshots

The README has no screenshots yet, which is the single biggest thing holding
this repository back: the launcher is the most visual part of the project and a
visitor currently sees only text.

These have to be captured by hand. Rasterising the running app from a script
does not work here — the page uses external fonts and canvas layers that SVG
`foreignObject` refuses to render — so a real screen capture is both easier and
better looking.

## What to capture

Run `npm run dev`, maximise the window, and take one shot of each:

| File | View | Worth having in frame |
| --- | --- | --- |
| `01-library.png` | Games | The hero, the sidebar, and the constellation in the background |
| `02-store.png` | Store | The generated posters — no two titles look alike |
| `03-detail.png` | A title's detail sheet | The "will it run?" verdict against real hardware |
| `04-downloads.png` | Downloads | A transfer in progress, with speed and ETA |
| `05-review.png` | Profile → Year in review | The generated poster |

On Windows, **Win + Shift + S** captures a region straight to the clipboard.
Save them here at 1440×900 or larger.

## Then paste this into the README

Under a `## Screenshots` heading, above Installation:

```markdown
<p align="center">
  <img src="docs/screenshots/01-library.png" alt="The games library, with the
  player's own titles drawn as a constellation in the background" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/02-store.png" alt="The store, with procedurally
  generated key art for every title" width="49%">
  <img src="docs/screenshots/03-detail.png" alt="A title's detail sheet,
  answering whether this PC can run it" width="49%">
</p>
```

Keep each file under about 500 kB. A 1440-wide PNG of a dark UI usually lands
well under that; if one does not, it is worth resizing before committing,
because images are the part of a repository that can never be made smaller
again once they are in its history.
