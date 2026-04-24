# LocalBrain DMG Install Guide

## Install

1. Open the DMG.
2. Drag `LocalBrain.app` into `Applications`.
3. Start `LocalBrain.app`.

After launch, LocalBrain appears as a menu-bar icon in the upper-right macOS status bar.

On first launch, the app copies its runtime files to:

```text
~/Library/Application Support/LocalBrain/runtime
```

Runtime config, generated local API keys, and logs are written under that runtime directory. They are not bundled into the app or committed to GitHub.

## Menu

- `配置 Codex`: checks or guides local Codex ChatGPT login setup
- `模型`: selects the default model, currently `gpt-5.4-mini` or `gpt-5.4`
- `Key`: copies `OPENAI_BASE_URL`, copies local API keys, generates new keys, or rotates keys
- `其他`: opens the console, config file, audit log, refreshes status, restarts/stops LocalBrain, or quits

## Local App Settings

Use these values in local OpenAI-compatible apps:

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<copy from LocalBrain menu: Key>
```

