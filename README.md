# LocalBrain

LocalBrain is a local OpenAI-compatible brain gateway for personal development and product prototyping.

It runs on `127.0.0.1`, exposes OpenAI-style endpoints, and lets local apps use one local base URL and one local API key instead of coupling themselves to a specific model provider.

## What It Provides

- macOS menu-bar app for local operation
- Local OpenAI-compatible HTTP gateway
- `/v1/chat/completions`, `/v1/responses`, and `/v1/models`
- Local API key generation and rotation
- Default model selection from the menu bar
- Codex ChatGPT local login provider for personal local testing
- Configurable provider boundary for future product integration

## macOS Install

Download the DMG from GitHub Releases, open it, then drag `LocalBrain.app` into `Applications`.

Start `LocalBrain.app`. A LocalBrain icon appears in the upper-right menu bar.

The menu contains:

- `配置 Codex`: checks whether local Codex ChatGPT login is available
- `模型`: selects the default model, currently `gpt-5.4-mini` or `gpt-5.4`
- `Key`: copies `OPENAI_BASE_URL`, copies local API keys, generates new keys, and rotates keys
- `其他`: opens the web console, config file, audit log, refreshes status, restarts/stops LocalBrain, or quits

On first launch, LocalBrain copies its runtime files to:

```text
~/Library/Application Support/LocalBrain/runtime
```

Local runtime config, generated keys, and logs stay on your machine and are not part of the app bundle.

## Local App Configuration

Use these values in any local app that supports OpenAI-compatible settings:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<copy from LocalBrain menu: Key>
```

Example model IDs:

```text
gpt-5.4-mini
gpt-5.4
```

## HTTP API

Health:

```bash
curl http://127.0.0.1:8787/health
```

Models:

```bash
curl -H "authorization: Bearer $OPENAI_API_KEY" \
  http://127.0.0.1:8787/v1/models
```

Chat completions:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [
      { "role": "user", "content": "Reply with OK only." }
    ]
  }'
```

Responses:

```bash
curl -X POST http://127.0.0.1:8787/v1/responses \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "input": "Reply with OK only."
  }'
```

## Development

Requirements:

- macOS for the menu-bar app and DMG packaging
- Node.js 22 or newer
- Codex CLI or Codex App with local ChatGPT login when using the Codex provider

Run from source:

```bash
npm start
```

Open the local console:

```text
http://127.0.0.1:8787/
```

Check local Codex login:

```bash
npm run brain-codex-status
```

Build the macOS app:

```bash
npm run build-app
```

Build a DMG:

```bash
npm run package-dmg
```

Run config validation:

```bash
npm run brain-config-check -- docs/brain.codex-chatgpt.config.example.json
```

## Security Boundary

LocalBrain is intended for local personal testing and development.

- It listens on `127.0.0.1` by default.
- It stores generated local API keys in local config files under `logs/`.
- It does not commit local runtime keys, audit logs, built app bundles, or DMG files.
- It reads local Codex auth state only when the Codex provider is used.
- Codex/ChatGPT subscription-backed behavior is for local testing, not for production redistribution.

Production apps should depend on the LocalBrain protocol boundary or an approved provider, not on personal subscription login behavior.

## Documentation

See:

- [`docs/BRAIN_MODULE_TECHNICAL_GUIDE.md`](docs/BRAIN_MODULE_TECHNICAL_GUIDE.md)
- [`docs/INSTALL_DMG.md`](docs/INSTALL_DMG.md)
