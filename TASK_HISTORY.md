# H3 Director Studio - Task History

Running log of what we did, what broke, what is verified, and where to pick up next.
**Newest work is at the top of "Session log".** Add an entry at the top for every work
session, even a small one - a future session should start by reading the top two entries.

> Public-release note: this is a historical development log from the original machine.
> Absolute paths, account names and Chrome-profile defaults mentioned in old entries were
> generalized in the shipped scripts; the log is kept for the reasoning and verification
> trail, not as setup instructions. Use [docs/INSTALLATION.md](docs/INSTALLATION.md) to install.

| | |
| --- | --- |
| Project root | `E:\ComfyUI_windows_portable_nvidia\h3-director` |
| App URL | http://127.0.0.1:8788 (backend serves the built UI from `web\dist`) |
| Engine | ComfyUI at http://127.0.0.1:8188 (`E:\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable`) |
| Stack | Node/TS + Express (`backend/`), React + Vite (`web/`); no DB - JSON files under `data/` |
| Git repo | Initialised 2026-09-28 (`e972d3f` baseline). `data/`, `logs/`, `.tmp/`, `tmp/`, `dist/`, `node_modules/` are ignored - this file remains the narrative history. |
| Verify | `npm run typecheck` | `npm run build` | `npm run verify:timeline` (app must be running) | `npm run dev:backend` | `npm run dev:web` |

---

## CURRENT STATUS

**As of 2026-09-28 20:30**

- OK **The reference pickers' `＋` actually works now.** It was `disabled={!pending}`, so with
  nothing chosen in the dropdown it was inert — "I hit plus and nothing happens". It now either
  attaches the chosen Library item **or**, with nothing chosen, opens a file picker to upload
  straight into that slot. Caps (9 image / 3 video / 3 audio) are enforced and shown honestly.
  Verified in a real browser on all four paths; test data removed afterwards.

- OK **Drop an image straight onto a shot tile**: files dragged in from Explorer now attach to
  *that* shot instead of falling through to the Library. First frame for t2v/i2v/fl2v (and the
  kind flips t2v→i2v, `continueFromPrev` cleared), reference list for r2v. Hovering a tile
  highlights it and says which of the two will happen. Verified in a real browser on both
  branches; exactly one upload, no cross-shot leakage.

- OK **Timeline geometry re-verified** by a real pass/fail harness: every zoom step 28→128 px/s
  has each ruler label over its own tile, and a narrow-viewport drop leaves scroll legal with
  the moved tile in view. `npm run verify:timeline` → **RESULT: PASS**.
- OK **The open project now survives a reload** (was pending item 3). Verified by the harness's
  RELOAD check and by reading it back over the API.
- OK **Version control started** - repo initialised, baseline committed (`e972d3f`). Any change
  from here can be diffed or reverted.
- OK Backend answering on 8788, web build clean, `npm run typecheck` green for both workspaces.
- WARN **Stills/Images pipeline** still paused per user direction; untouched.

- OK **Backend running with all fixes live**: Supervisor smoothly restarted backend into new code.
- OK **Purge & leak fixes live**: `DELETE` routes clean up outputs, images, and cached frames cleanly.
- OK **Pre-flight guard live**: Verified live via direct HTTP `POST` that render attempts while ComfyUI is down reject immediately with HTTP 409 and clear instruction.
- OK **Configurable timeouts live**: Verified live via `/api/settings` that `renderTimeoutMin` (25) and `imageTimeoutMin` (20) are loaded and active.
- OK **UI build live**: Web client bundle includes all button disabling/hover tooltips and new Settings controls.
- OK **Chrome Profile**: Defaults to `Profile 1` (the secondary Chrome profile); works seamlessly with user's dual-profile Chrome setup.
- WARN **Stills/Images pipeline**: Paused per user direction ("stop about the image pipeline I will tell you"). Awaiting user instruction before making any changes.

---

## SESSION LOG

### 2026-09-28 (later, 2) — The reference picker's `＋` was inert

**Reported:** "i hit plus nothing happens - do these functions work?" with a screenshot of the
three REFERENCE IMAGES / VIDEOS / AUDIO panels.

**Diagnosed, not guessed.** A headless run that read the real DOM settled it:

```
1) btn disabled with empty selection: true
   imageIds after: []
2) selectable assets: 22
   btn disabled after selection: false
   preview row shown: 1
   AFTER imageIds: ["f8edc721-..."]      <- attach works
```

So `MultiPicker` was correct but unusable: `disabled={!pending}` meant the `＋` only woke up
after you chose an item from the dropdown. Press it first — which is what anyone does — and
nothing happens, with no hint why. `views.tsx:2043`.

**Fix — `＋` now always has a job:**
- A Library item chosen in the dropdown → attaches it (previous behaviour, kept).
- Nothing chosen → opens a file picker, uploads, and attaches to *this* slot. So the panel can
  be filled without a detour to the Library tab.
- Uploads attach in **one** `onAttach(ids)` call rather than repeated `onToggle` per file —
  each `onToggle` closes over the same `shot.imageIds`, so a multi-file selection would
  otherwise race itself and keep only the last one.
- Caps are now a `max` prop that the label, the dropdown and the button all read from, instead
  of the label hard-coding `" / 9"` while the code capped at 8.

**Caps corrected to match the engine.** `backend/src/engine.ts` uses `PICTURE_MAX = 9`,
`VIDEO_MAX = 3`, `AUDIO_MAX = 3` and silently drops anything past them at render time. The UI
was capping images at 8 while displaying 9 — one short. Now `REF_IMAGE_MAX = 9` etc., and the
still-stage editor keeps `MAX_REFS` of 8 to match `ImagesView`. `MAX_SHOT_REFS` was removed so
there is a single source of truth; the drop-onto-a-shot path from the previous session was
updated to the same constant (it was the 8).

**Four paths verified in a real browser, all PASS:**
1. `＋` with nothing chosen → not disabled, hidden file input present, uploaded file attached.
2. Choose a Library option → `＋` stays enabled, attaches, list grows by exactly 1.
3. A second upload → no duplicate **ids** in the list.
4. At 9/9 → `＋` disabled, dropdown disabled, `9 / 9` shown, nothing above the cap stored.

**Two things I got wrong first, both in the test rather than the app:**
- The panel locator filtered `.panel` by `hasText`, which matches every *ancestor* — so it kept
  grabbing the parent and clicking "Structure prompt" instead. Fixed by anchoring on the label
  and climbing to its own panel; the comment in the script says so.
- Test 3 initially asserted "no duplicate files". That premise is wrong: `POST /api/assets`
  always mints a new asset and never dedupes by content, which is why the Library already holds
  `Pulling up.jpg` ×2 and `Man_stealing_watch…` ×3 *from before this work*. The real invariant
  is no duplicate **ids**, which `mergeRefs` guarantees. I changed the assertion rather than
  "fixing" correct backend behaviour.

**Data restored and confirmed:** all 6 assets the tests uploaded were deleted through the API
(library 28 → 22, the captured baseline), `Shot 2` refs returned to 0, and all three shots read
back identical to `mp-base2.txt`. `npm run typecheck` and `npm run build` clean;
`verify:timeline` still PASS.

### 2026-09-28 (later) — Drag an image from Explorer onto a shot

**Requested:** "I should be able to drag and drop the images directly into the shots."

**Before:** tiles were not drop targets at all. A file dragged over the timeline hit the
app-wide window handler in `App.tsx` and landed in the Library with no link to the shot the
pointer was aimed at. The "use as first frame" flow only existed in the Images tab
(`ImagesView.tsx:130`).

**Now** (`web/src/views.tsx`, `TimelineTile`):
- The tile is a real drop target. The file is uploaded via `api.uploadAsset`, then attached
  to **that** shot: `firstFrameId` for `t2v`/`i2v`/`fl2v`, with `kind` flipped `t2v`→`i2v`
  and `continueFromPrev` cleared, because an explicit start image must beat seamless
  chaining. Those are the same two rules the server applies in `useStillAsFirstFrame`
  (`backend/src/queue.ts:609`).
- `r2v` shots get the images in `imageIds` instead — that kind drives the engine from its
  reference list, so a first frame would be the wrong slot. Capped at `REF_IMAGE_MAX` (9,
  matching `PICTURE_MAX` in the engine; this was `MAX_SHOT_REFS` = 8 until the next session
  found it was one short of what the label and the engine allow).
- Extra images in one drop fill the reference list rather than being silently dropped.
- Non-image files are refused by name instead of being quietly mis-filed.
- Hovering a tile highlights it with a ring and an explicit **"Set as first frame"** /
  **"Add as reference"** label, so the outcome is stated before you let go.

**Two details that are easy to get wrong and were handled explicitly:**
- `stopPropagation()` on dragenter/dragover/dragleave/drop. Without it the window-level
  handler in `<App>` uploads the same file a **second** time. Same reason `DropZone` stops
  it. The drop test asserts the library grew by exactly 1, which is what would catch a
  regression here.
- Because the tile stops propagation, the full-screen "Drop to add to the Library" veil
  never appears while you are over a tile — otherwise it covers the very tile that is about
  to receive the file and contradicts what will happen.

**Verified** with throwaway Playwright scripts driving real `DragEvent`s with a real `File`:
hover affordance appears; a drop on an `i2v` shot set its `firstFrameId` and left
`continueFromPrev` false; a drop on the `r2v` shot added a reference and left `firstFrameId`
null and `kind` `r2v`; library grew by exactly 1 in both cases; no other shot changed; a
`.mp4` drop produced a visible error toast; no page errors. **All test data was then removed
through the API** — both projects restored to their pre-test state and the library back to
its baseline of 10 assets, confirmed by reading both projects and the asset list back.
`npm run typecheck` (both workspaces) and `npm run build` clean, and `verify:timeline` still
PASSes.

### 2026-09-28 — Timeline verified for real, project sticks across reloads, git started

**Requested:** re-verify the timeline fixes after a silent harness failure, then tidy the dev
environment. Direction given: "do whatever you think helps our app."

- **Silent-failure lesson, first.** The previous verification reported nothing because the
  harness itself was broken (missing `playwright-core`, wrong `page.evaluate` arity, selectors
  that read the wrong DOM text). The app code was correct all along. The permanent harness now
  **exits non-zero on any failed check** and prints `RESULT: PASS|FAIL`, so "no output" can
  never again be mistaken for "verified".
- **New `scripts/timeline-align.check.cjs`** (run with `npm run verify:timeline`), promoted out
  of the throwaway `.tmp/pw/` and now covering four things: geometry at every zoom step
  28→128 px/s, drop-then-scroll legality in a narrow viewport, reload persistence of project +
  zoom, and absence of console/JS errors. `playwright-core@1.63.0` is a root devDependency now.
  Point it elsewhere with `$env:H3_URL='http://127.0.0.1:5173/'` for the dev server.
  It restores the exact original shot order through `POST /reorder` and **asserts the server
  agrees** before exiting. An earlier version of this harness tried to undo the drag with a
  second drag and only checked that the order had *changed* — that was wrong twice over (a
  drag-back is a rotation, not an inverse, and the check was inverted), so it silently
  permuted the real project on every run. See the correction note below.
- **Bugs found and fixed in the harness while writing it** (both would have produced false
  confidence, not false failure): a missing `path.sep` made screenshots land in `.tmp\`
  instead of `.tmp\shots\`; and `page.addInitScript` re-runs on *every* navigation, so the
  storage reset was wiping the very keys the new reload check had to verify - it now gates the
  reset behind a `sessionStorage` flag so it happens exactly once.
- **Pending item 3 closed: the open project now survives a reload.** `web/src/App.tsx` reads
  and writes `h3.projectId` (same best-effort `localStorage` pattern as the timeline keys),
  restored lazily once via a ref so the first paint is unchanged. A project deleted
  elsewhere is forgotten instead of retried on every 20 s poll.
- **Version control started.** `git init` + first commit `e972d3f` (41 files, source only).
  Before committing, `.gitignore` was tightened: added `logs/`, `tmp/`, `desktop.ini`,
  `comfy_history.json` (`dist/` already covered `web/dist/`). Confirmed no `data/`,
  `node_modules/`, `logs/` or `dist/` entered the index. **This file is still the history** -
  git is a safety net, not a replacement.
- **Verified:** `npm run typecheck` (backend + web) clean · `npm run build` clean ·
  `npm run verify:timeline` → **PASS** · backend answering on 8788.
- Cleaned up: the superseded `.tmp/pw/` copy and the stray `.tmp\shotsNN.png` files, plus 16
  dead scratch files from 9/7 and 9/26 (`.tmp` now holds only `vite-dev.log`, which the running
  Vite dev server holds open, plus whatever the harness regenerates). `.tmp\shots\` is
  regenerated by the harness and is gitignored.

**CORRECTION — the harness had been silently reordering real project data.**
This session's first harness claimed it reverted the reorder, and that claim was wrong:

- The drag commits for real: `onReorder` (`web/src/views.tsx:205`) PUTs the new order, and
  `POST /api/projects/:id/reorder` (`backend/src/app.ts:489`) writes it to disk.
- Undoing it by *dragging the tile back* is a **rotation, not an inverse** — each run
  cycled the shots instead of restoring them.
- The old assertion was also inverted: it failed when the order was *unchanged* and passed
  when it had been permuted, so it reported success while corrupting the sequence.
- Comparing the `DROP before` line across runs proves it: the project `c7503733` was seen
  as `2,4,1` → `4,1,2` → `1,2,4` → `2,4,1`, and the first run had left it at `4,1,2`.

**Fixed:** the original `shotIds` are captured before the drag and restored via
`POST /reorder`, then **read back from the server and compared** — the DOM is not trusted
because the browser keeps painting the dragged order until its next poll. A final safety net
after the reload phase restores again if the order still differs. Verified with **two
consecutive runs that both started at `2,4,1`, both PASS, and both ended at `2,4,1`.**
The project's data was restored to `Shot 2, Shot 4, Shot 1` (the order found at session
start). Shots themselves — prompts, frames, durations — were never touched; only sequence.

- **Lesson worth keeping (adds to the rules below):** a check that asserts "the DOM looks
  different" is not a check that "the data was restored". Verify the *persisted* state
  through the API, and make the assertion compare against the value captured **before** the
  test mutated anything.

### 2026-09-27 (later) — Boot opens the UI, ComfyUI no longer auto-starts

**Requested:** "when I login to my PC make boot open the browser automatically so it's
literally on screen — and don't run ComfyUI automatically, I will run it myself."

- `scripts/start-h3-director-hidden.vbs` (the logon entry point) now passes **`-Open`**, and
  the launcher opens http://127.0.0.1:8788 in the default browser **only after the UI answers
  HTTP** — a tab opened earlier would just show a connection error.
- New **`-WithComfy`** switch on `scripts/start-h3-director.ps1`, **off by default**: the
  launcher no longer starts the engine at all. The ComfyUI block is now: listening → say so ·
  `main.py` alive → say so (so it can never create a second engine) · otherwise **do nothing**
  unless `-WithComfy` was passed.
- New `Open-Ui` helper logs `opening http://127.0.0.1:8788/ in the default browser` before
  handing the URL to Windows, because a window appearing on screen is otherwise an invisible
  side effect of a hidden script.
- `start.bat` keeps `-Open`, so a double-click behaves exactly like logon. To include the
  engine: `.\scripts\start-h3-director.ps1 -Open -WithComfy`.
- **How ComfyUI gets started now:** the app's **▶ Start** button
  (`POST /api/comfy/start` → `backend/src/comfyctl.ts` spawns `run_nvidia_gpu.bat` through
  cmd.exe with `windowsHide: false`, so it appears in its own console window), or
  double-clicking `run_nvidia_gpu.bat` in the portable folder. The app's **Stop** button
  (`POST /api/comfy/stop` → `taskkill /T /F` on the pid holding 8188) is the matching way down.
- Verified by running the real logon chain (`wscript //B` on the VBS): the log showed
  `launcher started` → `ComfyUI auto-start is off (pass -WithComfy to start it) ...` →
  `backend already answering on 8788 - nothing to do` →
  `opening http://127.0.0.1:8788/ in the default browser`, the browser opened, and ComfyUI was
  **still down** afterwards (8188 closed, no `main.py` process) — i.e. nothing was started
  behind the user's back.

### 2026-09-27 (night) — Leak fix, engine-state loudness, configurable timeouts

**Requested:** the first three audit items. Explicitly **no renders and no engine start**, and
no browser windows (earlier chain tests each opened one - not repeated).

1. **Shot/project delete leaks fixed.** New `purgeShotMedia(projectId, shotId)` and
   `purgeProjectMedia(project)` in `store.ts` remove `data\outputs\<proj>\<shot>`,
   `data\images\<proj>\shot-<shot>` and `data\cache\<shot>_*.png`; wired into
   `DELETE /api/projects/:id/shots/:shotId` and `DELETE /api/projects/:id`, both of which now
   return `removed`. Library assets are deliberately untouched (user-owned, possibly referenced
   by other shots/boards). Verified with a throwaway script against the real data dir: shot
   media gone, **other shots survived**, project purge cleaned the rest, cleanup left nothing.
2. **Engine state is loud now.** `POST /api/projects/:id/render`,
   `.../boards/:boardId/render` and the shot-still render pre-flight `systemStats()` and answer
   **409** with "ComfyUI is offline. Start the engine first (the Start button in the top bar, or
   run_nvidia_gpu.bat in the portable folder), then render." instead of failing minutes later
   from inside the queue. One `ui.renderBlocked` string (computed in `App`) drives `disabled` +
   `title` on every render button: ShotTimeline's Render all / Seamless chain, the timeline
   tile's ▶, the inspector's Render this shot, the shot-still render, and Gallery's two buttons.
3. **Timeouts are settings.** `renderTimeoutMin` (default 25) and `imageTimeoutMin` (default 20)
   added to `AppSettings`, `DEFAULT_SETTINGS`, `publicSettings`, clamped to 1-600 in the settings
   PUT, threaded through `engine.renderShot` / `qwen.renderImage` (the error now names the actual
   limit) and editable in Settings → Render engine.

**Verified:** `npm run typecheck` clean, `npm run build` clean (bundle `index-DEErc4eQ.js`),
headless render of the live app → layout present, 3 projects, **0 console errors**; both new
strings confirmed inside the built bundle. The disabled-button *appearance* needs a selected
project, so that part is code-verified only.

**Not live yet:** those three backend changes need a **backend restart** — the process running
now still has the old code. The rebuilt front-end is already live (the backend serves `web\dist`
from disk).

**Audit correction:** `app.ts:498` does `fs.rmSync(req.file.path)` right after `addAsset`, so the
multer temp file IS cleaned up — audit item 8 was wrong.

### 2026-09-27 (evening, later) — UI opens in the secondary Chrome profile's Chrome profile + full app audit

**Requested:** "the app should open the chrome: the secondary Chrome profile secondary account and not the
other one".

- Chrome here has two profiles under `%LOCALAPPDATA%\Google\Chrome\User Data`: `Default` =
  "Your Chrome" (**primary account**) and **`Profile 1` = the secondary profile
  (secondary account)**; `last_used: Profile 1`.
- `scripts/start-h3-director.ps1` now launches Chrome explicitly with
  `--profile-directory="Profile 1"` (new `-ChromeProfile` parameter, default `"Profile 1"`;
  `none` = system default browser). New helpers: `Find-Chrome` (Program Files,
  Program Files (x86), LOCALAPPDATA, then the App Paths registry key), `Test-ChromeProfile`,
  `Get-RunningChromeProfiles`. Missing profile / missing Chrome → WARN + default-browser
  fallback rather than silently opening the wrong identity.
- **Chrome limitation, found by measurement:** `--profile-directory` is only honoured when
  Chrome starts a browser process itself. If Chrome is already open under another profile
  (the `Default` one here), the Windows singleton hand-off gives the URL to that running
  instance and the app lands in the wrong account. Measured with correct quoting while
  watching for a `Profile 1` browser process — none appeared. The launcher now says so:
  `WARN: Chrome is already running (profile(s): Default) - it will take the URL into that
  window, not 'Profile 1'. Close Chrome first (or at logon) and the app opens in 'Profile 1'.`
- At logon Chrome is normally closed, so the boot path opens the right profile. Final proof
  needs a real logon, or `start.bat` with Chrome shut.
- Also fixed two `catch { /* ... */ }` blocks in the launcher: `/* */` is JavaScript syntax,
  not PowerShell — it parses as a command and only fails when that branch runs.

### 2026-09-27 (evening, later) — Full app audit (read-only; nothing changed)

Verdict per subsystem, with the evidence that produced it. See "AUDIT" below for the details.

- **Solid:** H3 video render pipeline (8 real mp4 takes + 5 exports on disk), seam conform for
  chaining, serial job queues with orphan recovery, project save/merge that cannot drop takes,
  engine start/stop control, secrets handling, the UI shell, the autostart chain.
- **Half-built / never used:** the whole **Boards / Images tab** (`boards: []` in all three
  projects, zero board takes), the **AI co-director** (configured and reachable, but no project
  has an LLM-written shot list), **prompt structuring** (no structured prompt anywhere),
  **fl2v** first+last-frame mode, **r2v voice cloning**, LoRA / Spectrum / sigma shift (off in
  every saved shot), the Images-tab "Library / First frame" actions, and server-path import.
- **Broken / leaks:** deleting a shot leaves its rendered takes *and* its still images on disk
  forever (10 orphan files under `data\outputs\c7503733\{4db8d24e,88c8faee,96a30dd2}`);
  project selection is not remembered across reloads; Render buttons stay enabled while ComfyUI
  is offline so failures only appear at click time; `imageJobs` map grows unbounded per process;
  fixed 25 min / 20 min render timeouts can kill a legitimately slow render.

### 2026-09-27 (evening) — Black screen fixed + autorun fixed

**Reported:** "the app is now down: http://127.0.0.1:8788/ — I'm seeing a black screen",
plus "when I run my PC it should be up", plus "keep a task history file" (this file).

**Diagnosis**
- The backend *was* up and serving: `GET /` → 200, and `GET /assets/index-*.js` → 200 with
  `Content-Type: application/javascript`. Server down / wrong MIME / stale build were the
  obvious suspects and all three were ruled out with plain HTTP probes.
- Rendered the page in **headless Chrome** and captured its console:
  `Error: ui context missing` / `Uncaught Error: ui context missing`.
  The DOM came back as the raw shell with an **empty `<div id="root">`** → dark page.

**Root cause**
`web/src/App.tsx` called `useUploadFiles()`, which internally calls `useUi()`. But `App` is
the component that **renders** `UiCtx.Provider`, so it is not inside its own context →
`useUi()` throws → React unmounts the whole tree. It was introduced by the previous
session's *last* edit (14:31) and never seen in a browser, because `tsc --noEmit` and
`vite build` both accept it happily. **Typecheck-clean is not runtime-clean.**

**Fix**
- `web/src/DropZone.tsx` — split the uploader into a context-free
  `uploadFilesToLibrary(files, ui)` plus a thin `useUploadFiles()` wrapper (`useUi()` +
  `useCallback`) for components that really are inside the provider (`LibraryView`). One
  implementation, so the two paths cannot drift apart.
- `web/src/App.tsx` — `App` now calls `uploadFilesToLibrary(files, { toast, refreshAll })`
  built from its own local callbacks, and the whole drag & drop block moved **below** the
  `toast`/`refreshAll` definitions it uses (it referenced them before their `const`
  declarations — a TDZ error waiting to happen).
- `web/src/main.tsx` — added a root **error boundary**. A future render crash now shows the
  stack trace and a Reload button instead of an empty black page. Without it, this class of
  bug always looks like "the server is down".

**Autorun fixes** (`scripts/start-h3-director.ps1` — the file the Startup shortcut runs)
- **No duplicate ComfyUI engine.** Old behaviour: every launcher run saw "8188 closed" and
  started another engine — the log shows launches at 15:26 *and* 15:30 into a ComfyUI that
  was still booting. A start is now only issued when nothing listens on 8188, **no
  `ComfyUI\main.py` python process is alive**, and the last start is older than a 480 s boot
  window (tracked in `logs\comfyui-launch.stamp`).
- **ComfyUI output is now logged** to `logs\comfyui.log`. It used to run fully hidden with
  stdout discarded, so a failed start was undiagnosable — which is exactly why "ComfyUI
  offline" was a dead end before. The trailing `pause` in `run_nvidia_gpu.bat` is
  neutralised with `< NUL` so a dead engine can't wedge a console open.
- **Readiness is HTTP, not "the port is listening".** A process can hold a socket with a
  dead HTTP server; the launcher now waits (90 s) for `GET /` to return 200, logs
  `backend READY at http://127.0.0.1:8788`, and kills + retries a child that never serves.
- **Single-launcher guard** — a second supervisor (Startup entry + a manual run) exits with a
  log line instead of spawning a second backend against a busy port.
- **It keeps supervising after a successful start** (as the README promises) instead of
  exiting; the previous "supervisor exiting" branch also triggered on a live port.
- New **`-Open`** switch opens the browser once the UI answers; deliberately **off** for the
  boot path so nothing pops up at logon. `start.bat` will pass it (see Pending).
- Verified live with ComfyUI down: it started the engine, captured `logs\comfyui.log`, and
  reported `backend already answering on 8788 - nothing to do`; 8188 then came up
  (v0.37.0, H3 models detected, no missing nodes).

**Boot-chain verification** (what the *shortcut* does, not just the script)
- `H3 Director Studio.lnk` in the Startup folder → `wscript.exe` → `start-h3-director-hidden.vbs`
  → `powershell -File scripts\start-h3-director.ps1`. Read the shortcut back: target, arguments
  and working directory all resolve; the VBS and PS1 exist; the PS1 parses clean.
- Ran the **real chain** (`wscript` on the VBS) to prove it works end-to-end, with the
  boot-window stamp pre-set so ComfyUI was deliberately **not** started (the user had stopped
  it on purpose). Log recorded, in order: `launcher started`, `ComfyUI was started 1 s ago,
  still inside its 480 s boot window - not launching again`, `backend already answering on
  8788 - nothing to do`. The test stamp was then removed.
- Only the Startup shortcut is registered — the logon **Scheduled Task is NOT installed**
  (that needs an elevated installer run). Note it runs at **logon**, so you must actually sign
  in; and ComfyUI needs 1–3 min, so the UI shows "ComfyUI offline" for a while after boot.

### 2026-09-27 (afternoon) — Still-image boards, drag & drop, media viewer

**Status: implemented + typechecked + built. Not visually verified.** This batch is where the
black-screen bug above came from.

- `web/src/ImagesView.tsx` + boards API — a first-class **Qwen Image 2.1 stills stage**. A
  *board* is a reusable setup (prompt + mode `t2i`/`edit` + up to 8 reference images +
  sampler, steps, cfg, seed, KV-cache device/dtype, variants); rendering appends takes, and
  each take can be **Kept**, pushed to the **Library**, or sent straight to a shot's **first
  frame** (i2v). Endpoints: `GET /api/qwen/status`, `GET /api/image-jobs`,
  `POST /api/image-jobs/:id/cancel`, `POST|PATCH|DELETE /api/projects/:id/boards[/:boardId]`,
  `POST …/boards/:boardId/render`, `…/takes/:takeId/accept`, `…/takes/:takeId/to-asset`.
  Projects gained `boards: []`, and saving a project without a `boards` array no longer wipes
  the existing boards.
- `web/src/DropZone.tsx` — click-to-open-Explorer + drag-and-drop zone with file-type
  filtering (`accept`) and toasts on rejected files; `onDrop` calls `stopPropagation()` so a
  file dropped inside it isn't uploaded a second time by the app-wide handler.
- `web/src/App.tsx` — **drop files anywhere** in the app to add them to the Library, with a
  full-screen overlay and a drag-depth counter so child elements don't make it flicker.
- `web/src/MediaViewer.tsx` + `ui.tsx` `openMedia()` — one full-screen image/video lightbox
  for the whole app (Esc / backdrop closes) instead of per-view overlays.
- `LibraryView` lost dead state (`useState("")` whose setter was never called anywhere).
- Upload path exercised end-to-end over HTTP: `POST /api/assets` → 200, kind auto-detected,
  asset count 9 → 10 → deleted back to 9.

### 2026-09-26 — Queue/chaining, stills, autostart (reconstructed from the repo)

Reconstructed from files and logs, **not** from the old session transcript: sessions are not
shared between conversations, so the earlier chat itself is unrecoverable — only its
artifacts remain. That is why this file now exists.

- `scripts/install-autostart.ps1`, `start-h3-director.ps1`, `start-h3-director-hidden.vbs`
  written and installed: Startup-folder shortcut → `wscript` → hidden PowerShell launcher. A
  logon Scheduled Task is only registered when the installer runs elevated.
- `backend/src/store.ts` `reconcileOrphanJobs()` (+ its call in `main.ts`) — jobs left
  `queued`/`running` in `data\jobs.json` when the process died are marked cancelled at
  startup, so the UI stops showing a phantom render forever and the Render buttons unlock.
  Startup log line: `Recovered N interrupted job(s) from a previous run.`
- Seamless shot chaining, export assembly via ffmpeg (24 fps H.264/AAC), the AI co-director
  pane, and prompt-structuring passes.

---

## AUDIT — 2026-09-27 (read-only review of the whole app)

### Broken / leaking (real defects)
1. **Shot delete leaks files.** `data\outputs\c7503733\{4db8d24e,88c8faee,96a30dd2}` holds 10 files
   (~3.5 MB) for shots that no longer exist in any project, plus `data\images\c7503733\shot-96a30dd2\`.
   Board delete *does* remove its images dir (`app.ts`), shot delete does not; Library stills promoted
   from a deleted shot also stay.
2. **Chrome identity** (entry above) — correct at logon; when Chrome is already open under another
   profile the URL goes to that instance and only a WARN is logged.
3. **Project selection is not persisted** — every reload/restart lands on "Select a project above".
4. **Render buttons stay enabled while ComfyUI is offline**, so it only fails at click time.
   `data\jobs.json` shows both failure shapes: `ComfyUI unreachable at http://127.0.0.1:8188` and
   `Render timed out after 25 minutes`.
5. **Unbounded `imageJobs` map** in `queue.ts` — render/export logs are capped (60/20), image jobs are not.
6. **Hard-coded render timeouts** (25 min video, 20 min image). A legitimately slow 2K/long shot is
   killed: `96a30dd2` timed out at 50 % once and then succeeded on a retry.
7. **Staging is never pruned** — `ComfyUI\input\h3director` holds 7 files / 5.6 MB. Content-hashed, so
   bounded, but permanent.
8. ~~`data\tmp` (multer target) may leak the temp copy~~ — **checked, not a bug**: `app.ts:498`
   deletes `req.file.path` right after `addAsset` copies it, and `data\tmp` is empty.

### Half-built / never exercised (complete code, zero usage evidence)
1. **Boards / Images tab** — `boards: []` in all three projects, 0 board takes, while the shot's own
   still stage *has* usage (`data\images\c7503733\shot-*\`). Two stills UIs over one engine module
   (`qwen.ts` accepts both shapes). Decide: scratchpad (as the README frames it) or the single path
   that replaces `shot.still`.
2. **AI co-director** — reachable (`llmUp: true`, provider `cline`, 60+ models) but no project contains
   an LLM-written shot list; the saved prompts are hand-typed one-liners.
3. **Prompt structuring** (`/prompt/structure`, `/prompt/structure-all` + streaming cancel) — no
   structured four-section prompt in any saved project.
4. **fl2v** (first *and* last frame) — in the graph and the UI, never used in the data.
5. **r2v voice/dialogue** — the single r2v shot has no prompt and no audio reference; unproven.
6. **LoRA / Spectrum / sigma shift** — `spectrum: false`, `loraStrength: 0` in every saved shot.
7. **Images-tab actions** (Keep / Library / First frame) and **server-path import** (raw path textbox).

### Solid (verified by real usage, or by reading a small complete path)
- H3 video pipeline: 8 mp4 takes + thumbs on disk, node-presence pre-flight with a readable error,
  model resolution from live `object_info`; 5 exports assembled by ffmpeg.
- Seam conform: `conformFrame` swaps in the exact keyframe (H3 only conditions on keyframes);
  `prevShotFrame` lets one shot chain without re-rendering the project.
- Queues: separate render/image/export pumps, GPU contention handled, cancel → `interrupt`,
  orphan reconciliation at startup.
- Project persistence: server-side merge of takes on PUT; boards preserved when the payload omits them.
- Engine control: `comfyctl` (bat for 8188, python for custom ports), stop = `taskkill /T /F`.
- Secrets: keys never leave the server; env-var fallback; per-provider catalog.
- UI shell: WS live updates, toasts, one lightbox, root error boundary (new), tabs.
- Autostart: idempotent, HTTP readiness, single-launcher guard, ComfyUI output logged.

### Suggested order
1. Stop the data leaks (shot-delete cleanup) — cheap, stops silent disk growth.
2. Decide the stills story (Boards vs `shot.still`) before building on either.
3. Make engine state loud (disable/annotate Render while ComfyUI is down) and make the timeouts settings.
4. Then run one project end-to-end (co-director → structure → still → video → export) to turn the
   "never exercised" list into either proven or deleted.

---

## PENDING / KNOWN ISSUES

1. **Visual QA of the last two sessions** (highest priority): drag & drop upload, the Images
   tab, the lightbox, and the new error boundary. Typechecked, but never clicked by a human.
2. ~~`start.bat` started the backend by hand~~ — **done in this session**: it now calls
   `scripts\start-h3-director.ps1 -Open`, so double-clicking it and booting the PC take the
   same code path. Still worth one click-through to confirm the batch wrapper behaves.
3. ~~**The selected project is forgotten on reload**~~ — **done 2026-09-28**: `h3.projectId` in
   `web/src/App.tsx`; the reload check in `npm run verify:timeline` guards it against regressing.
4. ~~**No Playwright/Puppeteer** in `node_modules`~~ — **done 2026-09-28**:
   `playwright-core` is a devDependency and `npm run verify:timeline` drives a real browser
   (clicks, drags, reload) and returns a pass/fail exit code. It still cannot do everything —
   no visual-diff baseline, and it needs the app already running.
5. **ComfyUI boot was tested from a cold engine, not from a real Windows logon.** The
   duplicate-engine guard has never been exercised by two logon-style runs in a row.
6. The stale 15:26/15:30 entries in `logs\autostart.log` are the *pre-fix* duplicated-engine
   behaviour. They are left in place as a record of the bug rather than trimmed.

---

## REFERENCE — where everything lives

**Processes / ports**
- `8788` backend (Express: serves `web\dist`, plus `/api/*`, `/files/*`, `/ws`)
- `8188` ComfyUI engine — start it with the app's ▶ Start button, or let the launcher do it
- entries: `backend/src/main.ts` (run through `tsx`), `web/src/main.tsx` (UI)

**Logs** (all under `logs\`)
- `autostart.log` — launcher decisions, `backend READY` lines, restarts. **Look here first.**
- `backend.log` / `backend.error.log` — the backend's own stdout/stderr
- `comfyui.log` — the ComfyUI engine's output (added this session; was discarded before)
- `comfyui-launch.stamp` — when the engine was last started (the boot-window guard)

**Data** (under `data\`, plain JSON, no database)
- `settings.json` — ports, ComfyUI address/root, LLM provider + keys, director model
- `library.json` + `library\<uuid>.<ext>` — the asset library
- `projects\<id>.json` — shots, takes, still stage, `boards` (stills)
- `jobs.json` — render/export job log (orphans reconciled at startup)
- `images\`, `outputs\`, `exports\`, `cache\` — generated media

**Backend route groups** (`backend/src/app.ts`)
- settings / keys — `/api/settings`, `/api/keys`
- engine control — `/api/comfy/*` (free, interrupt, start, stop)
- projects + shots — `/api/projects…`
- assets — `/api/assets…`
- stills boards — `/api/projects/:id/boards…`, `/api/qwen/status`, `/api/image-jobs…`
- renders / exports / jobs — `/api/jobs…`, `/api/exports…`

**Verification recipe used this session** (no Playwright needed)

```powershell
npm run typecheck
npm run build
# Render the real page in a headless browser and capture console errors + the DOM:
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
Start-Process $chrome -ArgumentList @('--headless=new','--disable-gpu',"--user-data-dir=$env:TEMP\h3chk",
  '--enable-logging=stderr','--v=0','--virtual-time-budget=10000','--dump-dom',
  'http://127.0.0.1:8788/') -RedirectStandardOutput tmp\dom.html -RedirectStandardError tmp\dom.err -Wait
# tmp\dom.err shows "Uncaught Error: ..."; tmp\dom.html must contain the real app markup.
```

**Rules learned the hard way**
- A green `typecheck` + `build` proves nothing about whether the page renders. Render it.
- `useUi()` may only be called *inside* `UiCtx.Provider` — never in `App` itself, which
  provides it.
- "Up" must mean "HTTP answered", not "the port is listening".
- Start ComfyUI at most once per boot window: it needs 1–3 min to bind 8188, and treating
  "port closed" as "not running" starts a second engine on top of the first.
- A UI test that mutates real data must capture the pre-test value and **restore it through the
  API, then read the persisted state back**. Undoing a drag with another drag is a rotation,
  not an inverse — and an assertion that checks the DOM "changed" will happily pass while the
  stored order is wrong. The DOM also lags the server, so trust the API, not the painted tiles.
- **Never assume WHERE a drag lands.** The timeline auto-scrolls during a drag, so the drop
  can end at any index. Track the moved tile by name (stripping the "N. " prefix, which
  renumbers on move), never by a hardcoded index. That assumption caused two false failures.
- **A check that needs data must create it and clean it up.** `verify:timeline` used to bail
  out unless you happened to have a project with 2+ shots, so it guarded nothing. It now
  seeds a throwaway project via the API, selects it **by option value** (index 0 just picks
  whatever sorts first by updatedAt), and deletes it at the end. Give the seeded shots
  different durations, or the ruler's min-width floor is never exercised.
- Silence is not success. A verification step that prints nothing and exits 0 has verified
  nothing; every check needs a printed verdict and a non-zero exit on failure.

---

## SESSION - 2026-10-05, full audit + hardening (14:40-16:20)

Started from an audit of the whole app with a focus on the timeline. Fixes in the order they
were done; the first group is the one that actually loses work.

### Data safety

1. **A running render reverted every edit made while it ran.** `processRender` loaded the
   project once and called `saveProject(project)` on that stale object after each take. Start
   a render, fix a prompt on shot 12, and the render wrote the old prompt back. The
   take-reattach in the PUT handler cannot help: that is browser->server, this was
   queue->server. Fixed with three fresh-state store helpers - `appendShotTake`,
   `appendStillTake`, `mutateShotOnDisk` - that re-read the project and write only what
   changed. `processImage` already did this right; the render path now matches.

2. **A crash mid-write could make a project vanish.** `saveProject` wrote straight onto the
   live file, and `getProject`/`listProjects` swallowed the parse error, so a truncated
   project disappeared from the picker with nothing in any log. Now: write `.tmp`, keep a
   `.bak` generation, `renameSync` into place (atomic), and report corruption loudly via
   `corruptReadCount()`; a corrupt file falls back to its `.bak`. `jobs.json` is quarantined
   instead of silently reset. `library.json` is mtime-cached.

3. **No `unhandledRejection` handler** - only `uncaughtException` was registered. The
   persistence calls in `pumpRender` sit *outside* the try, so one failed save rejected
   `void this.pumpRender()` and Node exited mid-render. Two lines, whole class of deaths.

### Correctness

4. **Export used the OLDEST successful take.** `acceptedTakeOf` used a forward `find`, and
   nothing in the render path ever set `accepted: true`, so the fallback always picked take
   #1 - re-render five times and export still gave the first attempt. Now reverse-finds, plus
   a real accept endpoint for shot takes (there was none) and a take delete that unlinks the
   media. Bad takes used to be permanent.

5. **Still renders bypassed the GPU queue and could OOM the card.** The route awaited a
   multi-minute render on the request thread, and the only concurrency guard lives inside
   `pumpImage`, which it never touched - two clicks meant two simultaneous GPU jobs, plus a
   hung HTTP request. Now queued via `enqueueShotStill` and dispatched by `pumpImage` like
   everything else; the UI follows it over the bus. `imageJobs` is capped too.

6. **The duration cap was 12 in the UI and 15 in the engine**, so a 13-15s shot was
   unreachable by dragging while the tooltip asserted a limit the engine did not have. One
   `MAX_SHOT_SECONDS = 15` in `types.ts`, shipped to the UI as `settings.limits`; timeline,
   split route and engine all read it.

7. **Changing `comfyUrl` in Settings never took effect** - one client bound at startup. Now
   cached per URL and rebuilt on change.

8. `splitPromptText` could return the whole prompt for *both* halves, duplicating it across
   two shots. The split route now refuses instead.

### Daily-use feel

9. **Every keystroke PUT the whole project** (~200 KB per character on a 30-shot project,
   23 handlers doing it). Now debounced 500 ms, one in-flight write, newest state queued
   behind it, with `flushSave()` on blur, project switch, render queue, tab hide and unmount.
   The poll skips itself while a save is pending so it cannot clobber an unsaved edit.

10. **Undo** (Ctrl+Z and a toolbar button) for reorder, resize, delete, accept, chain and
    still mode. Snapshot-based rather than inverse-based on purpose: a reorder's inverse is
    another reorder, which is exactly how data gets lost. 40 deep, coalescing a burst on one
    shot into a single step. Undo writes immediately, not on the debounce.

11. **Shift-click multi-select** with a batch toolbar: chain, unchain, render N, structure,
    delete N, clear. Selection is a Set of ids, not an index range, so it survives reorders.

12. **Insert a shot at a position** (`+` on any tile) instead of only appending to the end.

13. **A playhead on the ruler**, fed by the Play-cut player, so you can see which shot you are
    reviewing without leaving the timeline. It walks the ruler segments rather than scaling
    `time * pxPerSec`, because the min-width floor draws short shots wider than their real
    duration - a naive scale drifts against the tick labels.

14. **Tile action buttons are keyboard-operable.** They are `role="button"` spans (real
    buttons would swallow the pointer events the drag handler needs), which left them
    focusable but inert; Enter and Space now activate them.

### Observability

15. **Failed renders are debuggable.** The submitted graph is dumped next to the shot's media
    on both the success and failure paths, ComfyUI's history entry is appended to it on
    failure, error takes record their `promptId`, and a timeout now interrupts the engine
    prompt instead of leaving a zombie render blocking the queue. Every job also writes a
    durable JSONL log at `data/logs/<jobId>.jsonl` - the only previous record was a
    WebSocket message to whichever browser happened to be open.

### Verification added

- `npm run verify:store` - regression checks for both data-loss bugs, the newest-take rule,
  the accept invariant and the duration clamp. Runs against a temp data dir (`H3_DATA_DIR`),
  never the live one. **Passes.**
- `npm run verify:timeline` - now self-seeding and self-cleaning. **Passes** (it was
  previously unrunnable without a suitable project).
- `npm run verify` - typecheck + build + verify:store.

Two bugs were caught by these checks rather than by reading: the seeding script used
`selectOption({index: 0})`, which picked the wrong project, and the drop assertion assumed
the moved tile always lands at index 1. Both were test bugs, not app bugs - which is the
point of the check running at all.