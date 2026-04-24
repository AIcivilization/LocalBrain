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
- OpenCode local provider with dynamically discovered free model options
- Configurable provider boundary for future product integration

## macOS Install

Download the DMG from GitHub Releases, open it, then drag `LocalBrain.app` into `Applications`.

Start `LocalBrain.app`. A LocalBrain icon appears in the upper-right menu bar.

The menu contains:

- `Configure Codex`: checks whether local Codex ChatGPT login is available
- `Configure OpenCode`: opens OpenCode login/setup when the local OpenCode provider needs attention
- `Model`: selects the default model, including Codex models and discovered OpenCode free models
- `Key`: copies `OPENAI_BASE_URL`, copies local API keys, generates new keys, and rotates keys
- `Settings`: switches language, opens the web console, config file, audit log, refreshes status, or restarts/stops LocalBrain
- `Quit`: exits LocalBrain from the bottom of the main menu

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
opencode/gpt-5-nano
opencode/*-free
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
- OpenCode CLI when using the OpenCode local provider

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

List discovered OpenCode models:

```bash
/Users/wf/.opencode/bin/opencode models opencode
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
- It asks the OpenCode CLI for available free models when the OpenCode provider is configured.
- It uses the OpenCode CLI directly for OpenCode requests, with local server mode kept as a fallback.
- Codex/ChatGPT subscription-backed behavior is for local testing, not for production redistribution.

Production apps should depend on the LocalBrain protocol boundary or an approved provider, not on personal subscription login behavior.

## Documentation

See:

- [`docs/BRAIN_MODULE_TECHNICAL_GUIDE.md`](docs/BRAIN_MODULE_TECHNICAL_GUIDE.md)
- [`docs/INSTALL_DMG.md`](docs/INSTALL_DMG.md)

## 简体中文简介

LocalBrain 是一个本地运行的 OpenAI-compatible 大脑网关，用于个人开发、原型验证和本机 AI 应用测试。

它默认运行在：

```text
http://127.0.0.1:8787
```

本地应用只需要配置：

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<从 LocalBrain 菜单 Key 中复制>
```

macOS 使用方式：

1. 从 GitHub Releases 下载 DMG。
2. 打开 DMG，把 `LocalBrain.app` 拖到 `Applications`。
3. 启动 `LocalBrain.app`。
4. 在右上角菜单栏中配置 Codex / OpenCode、选择模型、复制本地 Key。

菜单包含：

- `Configure Codex`：检查本机 Codex ChatGPT 登录态
- `Configure OpenCode`：检查或打开本机 OpenCode 配置
- `Model`：选择默认模型，包含 Codex 模型和动态发现的 OpenCode 免费模型
- `Key`：复制 `OPENAI_BASE_URL`、复制/生成/替换本地 API Key
- `Settings`：切换中英文、打开控制台、配置文件、审计日志，或重启/停止 LocalBrain
- `Quit`：退出 LocalBrain，位于主菜单最底部

本项目适合本地个人测试。Codex/ChatGPT 本地订阅模式不建议用于正式产品发布。
