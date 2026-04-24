# LocalBrain

LocalBrain is a local OpenAI-compatible brain gateway for personal development.

It runs on `127.0.0.1`, exposes `/v1/chat/completions` and `/v1/responses`, and can use local providers such as your Codex ChatGPT login.

## Quick Start

Double-click startup on macOS:

```text
LocalBrain.command
```

This opens `LocalBrain.app` as a menu-bar app. Click the brain icon in the upper-right status bar to configure Codex, select the default model, view/copy local keys, open the console, restart the service, or quit.

One-command start:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8787/
```

Check local Codex login status:

```bash
npm run brain-codex-status
```

Generate a local config with a random local API key:

```bash
npm run brain-init-local -- logs/brain.codex.local.config.json docs/brain.codex-chatgpt.config.example.json
```

Start the gateway:

```bash
npm run brain-server -- logs/brain.codex.local.config.json
```

Configure local apps:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<key printed by brain-init-local>
```

The web console shows existing local API keys, can generate new keys, and shows the exact `OPENAI_BASE_URL` for local apps.

## Scripts

```bash
npm start
npm run build-app
npm run brain-config-check -- docs/brain.codex-chatgpt.config.example.json
npm run brain-smoketest
npm run brain-codex-status
npm run brain-server -- docs/brain.codex-chatgpt.config.example.json
```

## Docs

See `docs/BRAIN_MODULE_TECHNICAL_GUIDE.md`.
