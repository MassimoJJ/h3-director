# API

H3 Director exposes a small REST API on `127.0.0.1` plus a WebSocket event bus. The UI
uses exactly these endpoints, so they are also the easiest way to script or debug the
app.

- Base URL: `http://127.0.0.1:8788` (configurable via `port` in Settings)
- Bind address: `127.0.0.1` only - the app is not exposed to the network
- Auth: none (local-only by design)
- Content type: JSON, except file upload (`multipart/form-data`) and NDJSON streaming
- WebSocket: `ws://127.0.0.1:8788/ws`

> Treat `data/settings.json` as a secret: it can hold provider API keys. The API never
> returns full keys to the browser; `GET /api/settings` and `/api/status` return only
> provider metadata such as `configured`, `envVar` and `last4`.

---

## Status and engine

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Cached probe plus public settings |
| `POST` | `/api/status/refresh` | Force a fresh probe of ComfyUI, nodes, models and LLM |
| `POST` | `/api/comfy/start` | Start the local ComfyUI engine if it is down |
| `POST` | `/api/comfy/stop` | Stop the process on the configured ComfyUI port |
| `POST` | `/api/comfy/free` | Ask ComfyUI to unload models and free memory |
| `POST` | `/api/comfy/interrupt` | Interrupt the current ComfyUI job |

A probe result contains `comfyUp`, `comfyVersion`, `gpuName`, `comfyRoot`, `models`
(`fl2va`, `ref2va`, `textEncoder`, `loras`), `nodes`, `llmUp`, `llmProvider`,
`llmModel`, `ollamaUp` and optional `error`.

Render requests are rejected with HTTP **409** when ComfyUI does not answer, rather
than sitting in a queue forever.

---

## Settings and keys

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/settings` | Public, redacted settings |
| `PUT` | `/api/settings` | Patch allowed fields |
| `GET` | `/api/keys` | Provider metadata (no secrets) |
| `PUT` | `/api/keys/:id` | Store a provider key / base URL / model |
| `DELETE` | `/api/keys/:id` | Clear a stored key |
| `POST` | `/api/keys/:id/test` | Test a provider endpoint |
| `GET` | `/api/llm/ollama/models` | List Ollama models |
| `POST` | `/api/llm/ollama/test` | Test the Ollama endpoint |
| `GET` | `/api/llm/models/:provider` | List models for a configured provider |

`PUT /api/settings` accepts only:

```text
comfyUrl, comfyRoot, purgeBetweenShots, port, ollamaUrl, director,
renderTimeoutMin, imageTimeoutMin
```

Timeout values are clamped to 1-600 minutes. Changing `comfyUrl` rebuilds the ComfyUI
client immediately - the old address is not kept for the rest of the process.

---

## Projects and shots

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create a project |
| `GET` | `/api/projects/:id` | Read one project |
| `PUT` | `/api/projects/:id` | Replace/save a project |
| `DELETE` | `/api/projects/:id` | Delete a project |
| `POST` | `/api/projects/:id/shots` | Add a shot |
| `POST` | `/api/projects/:id/shots/:shotId/duplicate` | Duplicate a shot |
| `POST` | `/api/projects/:id/shots/:shotId/split` | Split a shot |
| `DELETE` | `/api/projects/:id/shots/:shotId` | Delete a shot and its media |
| `POST` | `/api/projects/:id/reorder` | Persist a new shot order |
| `POST` | `/api/projects/:id/shots/:shotId/takes/:takeId/accept` | Accept a take |
| `DELETE` | `/api/projects/:id/shots/:shotId/takes/:takeId` | Delete a take |

The canonical `Shot` object includes `kind`, `prompt`, `seconds`, `resolution`,
`aspect`, `fps`, `steps`, `sampler`, `scheduler`, `seed`, image/video/audio reference
ids, `continueFromPrev`, `still`, `takes` and the chosen `modelFl2va` / `modelRef2va` /
`modelTextEncoder` overrides. See `backend/src/types.ts` for the full shape.

---

## Library assets

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/assets` | List assets |
| `POST` | `/api/assets` | Upload a file (`multipart/form-data`, field `file`) |
| `POST` | `/api/assets/import` | Import files from an absolute path |
| `PATCH` | `/api/assets/:id` | Update name, role or tags |
| `DELETE` | `/api/assets/:id` | Delete an asset |
| `GET` | `/api/assets/:id/file` | Serve the underlying media file |

Supported extensions are defined in `backend/src/store.ts` and include PNG/JPG/WEBP,
WAV/MP3/FLAC/M4A, and MP4/MOV/WEBM/MKV.

---

## Still stage and Stills board

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/qwen/status` | Qwen Image 2.1 readiness and model choices |
| `POST` | `/api/projects/:id/shots/:shotId/still` | Create/update a shot's still stage |
| `POST` | `/api/projects/:id/shots/:shotId/still/render` | Render still variants |
| `POST` | `/api/projects/:id/shots/:shotId/still/takes/:takeId/use` | Choose which still the shot animates |
| `GET` | `/api/image-jobs` | List still/board jobs |
| `POST` | `/api/image-jobs/:id/cancel` | Cancel a still job |
| `POST` | `/api/projects/:id/boards` | Create a Stills board |
| `PATCH` | `/api/projects/:id/boards/:boardId` | Update a board |
| `DELETE` | `/api/projects/:id/boards/:boardId` | Delete a board |
| `POST` | `/api/projects/:id/boards/:boardId/render` | Render a board |
| `POST` | `/api/projects/:id/boards/:boardId/takes/:takeId/accept` | Accept a board take |
| `POST` | `/api/projects/:id/boards/:boardId/takes/:takeId/to-asset` | Promote a take to the Library |

---

## Render, export and jobs

```http
POST /api/projects/:id/render
Content-Type: application/json

{ "shotIds": ["..."], "forceChain": false }
```

- Empty `shotIds` means render the whole project.
- `forceChain: true` renders all shots as one chained run.
- Returns a `RenderJob` immediately; progress arrives over `/ws`.

```http
POST /api/projects/:id/export
Content-Type: application/json

{ "shotIds": [] }
```

Exports the accepted take of each shot in timeline order to `data/exports/`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/jobs` | Render and export job history |
| `POST` | `/api/jobs/render/:id/cancel` | Cancel a render job |
| `GET` | `/api/exports` | Export job history |

Durable logs are files, not endpoints: `data/logs/<jobId>.jsonl`.

---

## AI co-director

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects/:id/ai/direct` | Turn a brief into a shot list |
| `POST` | `/api/projects/:id/prompt/structure` | Structure one prompt into H3 sections |
| `POST` | `/api/projects/:id/prompt/structure-all` | Structure every shot, streams NDJSON |
| `POST` | `/api/projects/:id/prompt/structure-all/cancel` | Stop a structure-all run by `runId` |

Example:

```http
POST /api/projects/abc123/ai/direct
Content-Type: application/json

{
  "brief": "A courier crosses a rain-soaked city at night and misses a train.",
  "extra": "Cold blue palette, handheld camera."
}
```

The response contains `shots` (ready to insert), `raw`, `warnings`, `provider` and
`model`. `structure-all` instead streams one JSON line per shot and a final
`{ "type": "done", ... }` line; cancellation is checked between calls.

---

## WebSocket events

Connect to `ws://127.0.0.1:8788/ws`. The first message is:

```json
{ "type": "hello", "data": { "comfyUrl": "http://127.0.0.1:8188" } }
```

Every event has the envelope:

```json
{ "type": "...", "projectId": "...", "jobId": "...", "data": {} }
```

Common `type` values:

| Type | When |
| --- | --- |
| `job`, `jobDone` | Render job progress and completion |
| `shotDone` | One shot finished, with its take or error |
| `imageJob`, `imageJobDone` | Still/board job progress and completion |
| `shotStillDone` | A shot's still stage finished and a take was chosen |
| `project` | The project was changed externally and should be reloaded |
| `log` | Human-readable line for a job log |

A 30-second ping/pong heartbeat removes half-open clients, and clients whose send
buffer exceeds 4 MB are disconnected so a slow tab cannot stall the whole bus.

---

## Static UI

`GET /` and any non-API path serve `web/dist/index.html`. Run `npm run build` after
changing the frontend; an old cached `index.html` pointing at a replaced bundle looks
like a blank page. Hard-refresh with `Ctrl+F5` after rebuilds.
