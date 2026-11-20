# Verification

There are three levels of verification. None of them require a real render, so they are
safe to run before a release or after a refactor.

```bash
npm run verify          # typecheck + web build + data-safety checks
npm run verify:store    # fast data-safety checks only
npm run verify:timeline # real-browser timeline geometry and drag checks
```

---

## 1. Typecheck

```bash
npm run typecheck
```

Runs `tsc --noEmit` in both workspaces (`backend` and `web`). It catches API drift
between the React client and the Express server as well as ordinary TypeScript errors.

---

## 2. Web build

```bash
npm run build
```

Builds `web/dist` with Vite. The backend serves that folder, so a green build is also
a check that the shipped UI bundle actually exists. After changing frontend code, a
hard refresh (`Ctrl+F5`) is needed if the browser cached the old `index.html`.

---

## 3. Data-safety regressions

```bash
npm run verify:store
```

Runs `scripts/store-safety.check.cjs` through `tsx` against a **temporary** data
directory (`.tmp/store-check/data`). It never touches real projects. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every check passed |
| `1` | A check failed |
| `2` | The harness could not run |

The checks cover failures that previously destroyed work:

- **No stale project writes.** A render that started before an edit must not write the
  pre-edit project object back after each take. Every take write re-reads the current
  project and appends to the fresh shot.
- **Atomic persistence.** `saveProject` writes `.tmp`, keeps a `.bak` generation and
  renames into place, so an interrupted save cannot truncate the live file.
- **Loud corruption handling.** A damaged JSON file is reported and counted instead of
  silently becoming "project not found".
- **Newest take wins.** `acceptedTakeOf` uses the most recent successful take, and the
  render path marks the chosen take as accepted. Re-rendering no longer exports the
  first attempt forever.
- **Accepted-take invariant.** A failed take cannot be accepted because it has no file
  to play or export.

---

## 4. Timeline regression

```bash
npm run verify:timeline
```

Runs `scripts/timeline-align.check.cjs` in a real Chromium browser via `playwright-core`.
The app must already be running. It checks:

1. Ruler and tile geometry agree at every zoom step (28-128 px/s): segment widths,
   tile x-offsets and tick label text.
2. A drag-reorder in a narrow viewport leaves `scrollLeft` legal and the moved tile in
   view.
3. The open project, zoom level and panel split survive a page reload.
4. No JavaScript console errors occur during the run.

It performs a reorder and then reverts it, so data is left as found. If the open project
has fewer than two shots, the harness creates a throwaway project, tests against it and
deletes it again.

To test a Vite dev server instead of the built app:

```powershell
$env:H3_URL = "http://127.0.0.1:5173/"
npm run verify:timeline
```

The harness tries Microsoft Edge, then Google Chrome, then Playwright's bundled
Chromium. If none can launch, install a browser or run `npx playwright install chromium`.

---

## Manual end-to-end smoke test

Automation cannot prove that ComfyUI actually rendered a good frame. For a release,
also do this once:

1. Start ComfyUI and confirm the status probe is green.
2. Create a project with one 3-second `t2v` shot.
3. Render a still with `t2i`, then render the shot.
4. Open the take in Gallery; confirm picture, motion and audio.
5. Accept it and export; open the MP4 and confirm it plays.
6. Add a second shot, enable **Continue from previous**, render and inspect the cut
   frame by frame.
7. Reload the page and confirm the project, takes and accepted flags survived.

Job diagnostics live in `data/logs/<jobId>.jsonl`; the exact submitted graph is saved
as `data/outputs/<project>/<shot>/graph_<promptId>.json`.

---

## Historical verification log

`TASK_HISTORY.md` is the original development log from the machine where this was
built. It records specific browser runs, PSNR measurements, fixed bugs and the
reasoning behind the current safeguards. It is useful context for contributors, but
use this document and `docs/INSTALLATION.md` for current setup instructions.
