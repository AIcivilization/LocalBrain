# LocalBrain

LocalBrain is a local OpenAI-compatible brain gateway for personal development and product prototyping.

It runs on `127.0.0.1`, exposes OpenAI-style endpoints, and lets local apps use one local base URL and one local API key instead of coupling themselves to a specific model provider.

## What It Provides

- macOS menu-bar app for local operation
- Local OpenAI-compatible HTTP gateway
- `/v1/chat/completions`, `/v1/responses`, and `/v1/models`
- Local API key generation and rotation
- Upstream OpenAI-compatible API key registration through LocalBrain
- Per-key model routing, so one local key can be pinned to one provider model
- Provider-level model source filters, including free-only mode
- Default model selection from the menu bar
- Codex ChatGPT local login provider for personal local testing
- OpenCode local provider with dynamically discovered free model options
- Antigravity local provider, including image generation through `/v1/images/generations`
- Configurable provider boundary for future product integration

## macOS Install

Download the DMG from GitHub Releases, open it, then drag `LocalBrain.app` into `Applications`.

Start `LocalBrain.app`. A LocalBrain icon appears in the upper-right menu bar.

The menu-bar app is a lightweight observer and quick-control surface. Its top rows show LocalBrain status, channel counts, and a recommended channel, such as `3 ready · 2 unstable` and `Recommended: GPT-5.4-Mini · Codex · 2.4s`.

The menu contains:

- `Needs Attention`: lists only abnormal or unstable channels
- `All Channels`: lists every local channel, with usable fast channels first
- `Common Actions`: copies `OPENAI_BASE_URL`, generates a channel, exports keys, or tests all channels with a quota warning
- `Model Sources`: enables/disables Codex, OpenCode, Antigravity, and upstream sources, including free-only mode
- `Advanced Settings`: changes the default fallback route, language, config/log shortcuts, service controls, and reset-all-key action
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
gpt-5.5
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

Use the bilingual console or the menu-bar `Model Sources > Upstream Key` item to add or change an upstream API key. Local apps still use LocalBrain's own `OPENAI_BASE_URL` and local proxy key; LocalBrain stores the upstream key in the local config file and uses it when routing to that provider. Upstream model choices are fetched from the upstream `/models` endpoint instead of being hardcoded.

Each local proxy key can also be assigned to a model from the console. When a key is assigned, LocalBrain forces requests made with that key to use the assigned model, even if the client sends a different `model` value. Calling `/v1/models` with that key returns only the assigned model, which makes the key suitable for giving one product one stable model route.

The console is organized around `Channel Management`. Each local proxy key is treated as one channel and stays compact on a single row with its source, assigned model, health status, latency, speed, and success rate. Expand a channel only when you need to rename it, inspect the full key/model, clear routing, or delete it. `Chat & Speed` keeps the quick chat tester and visible-model benchmark together, while model sources, upstream keys, and raw model lists live in collapsible advanced sections.

Use `Model Sources` to decide which providers LocalBrain is allowed to use. For example, turn off Codex and upstream keys, then choose OpenCode's free-only action when you want LocalBrain to expose and route only OpenCode models marked as free. Requests for disallowed models are moved to the first allowed model instead of escaping the filter.

List only free models through the OpenAI-compatible models endpoint:

```bash
curl -H "authorization: Bearer $OPENAI_API_KEY" \
  "http://127.0.0.1:8787/v1/models?free=true"
```

Check local Codex login:

```bash
npm run brain-codex-status
```

List discovered OpenCode models:

```bash
.opencode/bin/opencode models opencode
```

OpenAI-compatible providers discover models from their upstream `/models` endpoint when their API key environment variable is available.

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
- It asks OpenAI-compatible upstreams for their current `/models` list when an API key is configured.
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

菜单栏应用是轻量观察和快捷操作入口。顶部显示运行状态、通道数量和推荐通道，例如 `3 可用 · 2 不稳定`，下一行显示 `推荐：GPT-5.4-Mini · Codex · 2.4s`。

菜单包含：

- `需要处理`：只显示异常或不稳定通道
- `全部通道`：显示全部本地通道，可用且更快的通道排在前面
- `常用操作`：复制 Base URL、生成新通道、导出全部 Key、测试全部通道
- `模型来源`：控制 Codex、OpenCode、Antigravity 和上游来源，可启用/停用或只用免费模型
- `高级设置`：默认备用路由、语言、配置文件、审计日志、重启/停止服务和重置全部通道 Key
- `Quit`：退出 LocalBrain，位于主菜单最底部

本地 Key 可以绑定到指定模型。产品侧只需要使用不同的 LocalBrain Key，LocalBrain 会自动把请求固定路由到对应模型；如果开启了 `模型来源` 里的开关，请求会被限制在允许的模型范围内。例如只想用 OpenCode 免费模型时，关闭 Codex 和上游 Key，只保留 OpenCode，并对 OpenCode 选择“只用免费模型”。

控制台支持中英文切换。添加上游 Key 时，先填写 Base URL 和 API Key，然后点击“拉取模型”，LocalBrain 会从上游 `/models` 接口获取模型列表供选择。

控制台现在以 `通道管理` 为核心：每个本地 Key 就是一条通道，默认一行显示名称、来源、指定模型、状态、耗时、速度和成功率；需要改名、看完整 Key/模型、清除路由或删除时再展开。`试聊与测速` 放在通道管理下面，用于快速对话和测试当前可见模型；模型来源、上游 Key、完整模型列表等低频内容折叠进高级区域。自动体检仍支持 5/10/30 分钟间隔刷新通道状态。

本项目适合本地个人测试。Codex/ChatGPT 本地订阅模式不建议用于正式产品发布。
