# Contributing

Thanks for wanting to improve H3 Director Studio. The project is deliberately small and
local-first; the most valuable contributions are correctness, data safety and clearer
documentation.

---

## Development setup

```bash
git clone https://github.com/MassimoJJ/h3-director.git
cd h3-director
npm install
npm run build
npm run verify
```

For live development use two terminals:

```bash
npm run dev:backend   # tsx watch backend/src/main.ts
npm run dev:web       # Vite dev server
```

The backend still serves `web/dist`, so keep `npm run build` available for final checks.
`verify:timeline` can target the dev server with `H3_URL=http://127.0.0.1:5173/`.

---

## Before opening a pull request

Run:

```bash
npm run verify
npm run verify:timeline   # with the app running
```

Then do one real render smoke test if you changed `engine.ts`, `qwen.ts`, `queue.ts` or
`ffmpeg.ts`. Automation cannot tell whether a frame looks right.

Include in the PR:

- what problem you fixed and how you reproduced it;
- which checks you ran and their result;
- any change to the persisted project format or API;
- screenshots for UI changes.

---

## Conventions

| Area | Rule |
| --- | --- |
| Duration limits | Import `MIN_SHOT_SECONDS` / `MAX_SHOT_SECONDS` from `backend/src/types.ts`. Do not add a second constant. |
| Reference caps | Keep engine caps and UI caps in sync (9 images, 3 videos, 3 audio). |
| Persistence | Use `writeJsonAtomic` in `store.ts`. Never write directly onto a live JSON file. |
| Settings | Only fields in `VALID_SETTINGS_FIELDS` may be patched through `PUT /api/settings`. |
| Secrets | Never log or expose provider keys. The browser receives only metadata. |
| Data directory | `data/`, `logs/`, `tmp/` and `.tmp/` are git-ignored. Do not commit projects or outputs. |
| Telemetry | Do not add analytics, tracking or cloud calls to the core app. |
| ComfyUI | Treat the engine as an external service. Never modify its install; stage media under `input/h3director/`. |

---

## Good first issues

- Improve the error text when a model file is present but the wrong variant is selected.
- Add unit checks for prompt compilation edge cases (empty still prompt, audio-only `r2v`).
- Document a reproducible low-VRAM model combination and verify it end to end.
- Translate the UI copy while keeping prompt text in English for H3.

---

## Reporting bugs

Use a GitHub issue and include:

1. Node and ComfyUI versions, GPU model and VRAM.
2. The JSON from `http://127.0.0.1:8788/api/status`.
3. The relevant `data/logs/<jobId>.jsonl` and, for render bugs, the saved
   `graph_<promptId>.json`.
4. Steps to reproduce and what you expected.

**Never paste API keys or full `data/settings.json` into an issue.**

---

## License note

By contributing you agree that your contribution is licensed under the repository's MIT
license. Model weights, LoRAs and node packs each keep their own licenses.
