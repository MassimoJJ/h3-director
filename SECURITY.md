# Security policy

## Supported versions

Security fixes are applied to the latest `main` branch. There are no backports to
older commits.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository rather than
a public issue. Include:

- affected component and version/commit;
- steps to reproduce;
- impact and any suggested fix.

Do not paste API keys, tokens, full `data/settings.json` files or private project data.

## Scope

The core app is designed to run locally:

- The HTTP server binds to `127.0.0.1` only.
- Provider keys stay in `data/settings.json` on disk. The browser receives only
  `last4`, a provider label, a base URL and a `configured` boolean.
- `data/`, `logs/` and generated media are git-ignored.
- ComfyUI is treated as an external service; its install is never modified.

Out of scope: vulnerabilities in ComfyUI, the MiniMax H3 / Qwen model weights, LoRAs,
node packs, ffmpeg or an LLM provider you choose to connect.

## User responsibilities

- Treat `data/settings.json` as a secret and never commit or publish it.
- Use environment variables for provider keys on shared machines.
- Do not expose port 8788 through a tunnel or reverse proxy without adding your own
  authentication layer - the API intentionally has none.
- Respect the licenses of the models and node packs you download.
