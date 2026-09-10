# Brain Module Technical Guide

## Goal

The Brain module provides the AI-driven layer for local or prototype AI applications. Product code calls the Brain through a protocol boundary and does not need to depend directly on model SDKs, login methods, or provider-specific APIs.

Module location:

```text
src/modules/brain
```

Main validation entry points:

```bash
npm run brain-smoketest
npm run brain-config-check -- docs/brain.config.example.json
npm start
```

## Boundary

The Brain module owns:

- provider registration and selection
- model routing
- request context construction
- tool-call protocol bridging
- session state return
- policy checks
- audit output
- OpenAI-compatible HTTP endpoints

The Brain module does not own:

- product UI
- product business state persistence
- production subscription-login workarounds
- hard-coded third-party OAuth client IDs for production
- direct product coupling to a provider SDK

Product code should depend on `BrainProductRequest` and `BrainProductResponse`, or on the local OpenAI-compatible HTTP API.

## File Structure

```text
src/modules/brain/
  index.ts
  types.ts
  brain-runtime.ts
  provider-registry.ts
  model-router.ts
  context-builder.ts
  tool-bridge.ts
  policy.ts
  config.ts
  provider-response.ts
  openai-compat.ts
  server.ts
  providers/
    codex-chatgpt-local-provider.ts
    custom-http-provider.ts
    mock-provider.ts
    openai-compatible-provider.ts
    experimental-subscription-provider.ts
```

Configuration examples:

```text
docs/brain.config.example.json
docs/brain.openai.config.example.json
docs/brain.codex-chatgpt.config.example.json
```

## Core Protocol

Product code calls the Brain with `BrainProductRequest`:

```ts
{
  input: 'User input',
  taskKind: 'chat',
  systemPrompt: 'Product-specific assistant instructions',
  appContext: {
    productName: 'MyApp',
    surface: 'chat',
    locale: 'en-US',
    state: {}
  },
  tools: []
}
```

The Brain returns `BrainProductResponse`:

```ts
{
  runId,
  providerId,
  model,
  message,
  toolResults,
  session,
  finishReason,
  usage,
  audit
}
```

Product code should persist `session` and pass it back on the next request.

## Minimal Embedded Integration

1. Load and validate config.

```ts
const config = await loadBrainConfigFile('docs/brain.config.example.json');
const validation = validateBrainConfig(config);
if (!validation.ok) throw new Error(validation.errors.join('; '));
```

2. Create the runtime.

```ts
const { runtime: brain } = createBrainRuntimeFromConfig(config);
```

3. Run the Brain.

```ts
const response = await brain.run({
  input: userInput,
  taskKind: 'chat',
  systemPrompt: productPrompt,
  appContext: {
    productName: 'MyApp',
    surface: 'chat',
  },
});
```

4. Read output and next session.

```ts
const assistantText = response.message.content;
const nextSession = response.session;
```

## Local HTTP Integration

LocalBrain exposes an OpenAI-compatible server on `127.0.0.1`.

Default settings:

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<copy from LocalBrain menu: Key>
```

Supported endpoints:

```text
GET  /health
GET  /brain/local-state
POST /brain/admin/keys
POST /brain/admin/model
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

Example:

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

## Providers

Provider implementations are the only boundary between the Brain and model services. Product code must not call model SDKs directly.

Built-in providers:

- `mock`: local test provider, no network calls
- `openai-api-key`: OpenAI-compatible upstream using `OPENAI_API_KEY`, with model discovery through `/models`
- `codex-chatgpt-local`: reads local Codex auth and calls the ChatGPT Codex backend
- `opencode-local`: uses the local OpenCode CLI and discovers free OpenCode models dynamically
- `agent-cli-local`: drives the agent CLI shipped by another installed AI IDE (Grok Bot, Qoder, WorkBuddy, WorkBuddy AI)
- `custom-http`: forwards standard Brain requests to an external AI gateway
- `chatgpt-subscription-experimental`: local testing adapter boundary, disabled by default

Production products should prefer API-key, AI gateway, or approved provider integrations. The Codex/ChatGPT and OpenCode local providers are for personal local testing.

## OpenAI-Compatible Provider

The OpenAI-compatible provider discovers models at runtime from the upstream endpoint:

```text
GET {baseUrl}/models
```

For the default OpenAI provider example, that means:

```text
GET https://api.openai.com/v1/models
```

The provider uses the configured `apiKeyEnv` value, usually `OPENAI_API_KEY`, for the bearer token. LocalBrain caches the discovered model list briefly so the menu stays responsive, then refreshes it again later. Static `models` in config are only a fallback and are not required for OpenAI-compatible providers.

## Codex ChatGPT Local Provider

Prerequisite:

```bash
codex --login
```

or an existing Codex CLI / Codex App login at:

```text
~/.codex/auth.json
```

Check login status without printing tokens:

```bash
npm run brain-codex-status
```

Start LocalBrain:

```bash
npm start
```

Security behavior:

- reads local `~/.codex/auth.json`
- does not print access tokens or refresh tokens
- refreshes access tokens only when necessary
- writes refreshed tokens back atomically
- intended for local personal testing, not production redistribution

## OpenCode Local Provider

Prerequisite:

```bash
~/.opencode/bin/opencode auth login
```

List the currently available OpenCode models:

```bash
opencode models opencode
```

LocalBrain uses that command for dynamic model discovery. The model menu is not hardcoded; model IDs returned by OpenCode are exposed through:

```text
GET /brain/local-state
GET /v1/models
```

When a local app selects a model whose ID starts with `opencode/`, LocalBrain routes that request to the `opencode-local` provider. Selecting the model from the macOS menu also persists `chat` and `fast` routing to the OpenCode provider.

For generation, LocalBrain first uses the OpenCode CLI directly:

```bash
opencode run --model opencode/gpt-5-nano --format json "..."
```

That avoids depending on a long-running OpenCode server. The `baseUrl` setting remains available as a fallback for machines that already run `opencode serve`.

The default provider configuration is:

```json
"opencode-local": {
  "type": "opencode-local",
  "displayName": "OpenCode Local Provider",
  "baseUrl": "http://127.0.0.1:4096",
  "localOnly": true,
  "experimental": true,
  "options": {
    "modelProvider": "opencode"
  }
}
```

## Agent CLI Local Providers

Several locally installed AI IDEs ship an agent CLI that copies the Claude Code
headless contract: `-p` for a single turn, `--output-format json`, a `--model`
flag, and a permission mode that never prompts. `agent-cli-local` covers all of
them with one implementation; a vendor profile in
`src/modules/brain/providers/agent-cli-local-provider.ts` supplies the parts that
differ.

| Vendor | CLI | Model prefix | Model discovery |
| --- | --- | --- | --- |
| `grok` | `grok` (Grok Bot) | `grok/` | `grok models` |
| `qoder` | `qodercli` (Qoder) | `qoder/` | `qodercli --list-models` |
| `workbuddy` | `codebuddy` inside `WorkBuddy.app` | `workbuddy/` | rejected-model probe |
| `workbuddy-ai` | `codebuddy` inside `WorkBuddy AI.app` | `workbuddy-ai/` | rejected-model probe |

The provider signs in through the vendor's own CLI, so LocalBrain never reads or
stores a token. Sign in once with that CLI (`grok login`, `qodercli login`, or
the WorkBuddy app) and the models appear in `/v1/models`.

The CLI's login is not always the IDE's login. Qoder keeps them separate:
signing in to Qoder IDE leaves `qodercli status` reporting `Not logged in`, and
the provider stays empty until `qodercli login` runs. Check the CLI, not the
app, when a vendor lists no models.

WorkBuddy has no list command, so discovery sends a model ID the account cannot
own; the CLI answers with the catalog it is entitled to. The probe fails before
any model call, so it costs nothing.

Model IDs carry the vendor prefix, which is how requests route without an
explicit `providerId`:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model": "workbuddy/glm-5.3", "messages": [{"role": "user", "content": "Reply with OK only."}]}'
```

The default provider configuration is:

```json
"workbuddy-local": {
  "type": "agent-cli-local",
  "displayName": "WorkBuddy Local Provider",
  "localOnly": false,
  "experimental": true,
  "options": {
    "vendor": "workbuddy",
    "timeoutMs": 900000,
    "modelCacheTtlMs": 60000,
    "forceProxy": false
  }
}
```

`options.vendor` is required and validated. `options.cliPath` overrides CLI
discovery; otherwise the provider checks the vendor's known install locations,
newest versioned copy first, and falls back to `PATH`.

Set `forceProxy` per vendor rather than globally: it decides whether the CLI's
traffic is pushed through the configured proxy when one can be found. It is a
preference, not a requirement - with no proxy discoverable the CLI runs on the
direct path rather than failing, because connectivity from a TUN-mode client
exposes no proxy endpoint to discover. Grok defaults to `true`; the others
reach their endpoints directly.

These CLIs refresh their access token lazily, so calls after an idle period fail
with `401` until a refresh lands. The provider retries twice for that reason,
sharing the caller's timeout budget rather than multiplying it; a CLI that is
genuinely signed out fails every attempt and reports the CLI's own message, such
as `Not logged in - Please run /login`.

Discovery does not inherit the generation timeout - it runs in front of ordinary
requests, so it uses `options.modelDiscoveryTimeoutMs` (45s by default) instead
of the 15 minutes a real agent run may need. A discovery that returns nothing is
cached for five minutes rather than the usual minute, because a signed-out CLI
stays signed out until the user acts and each probe costs seconds. After signing
in, models appear within that window, or immediately after a restart.

### Adding another vendor

Add an entry to `PROFILES` and to `AGENT_CLI_VENDORS`, then add the provider to
the example configs. No other file needs to change except the display-name maps
in `src/modules/brain/server.ts` and `app/LocalBrainStatusApp.swift`.

## macOS Menu-Bar App

Build:

```bash
npm run build-app
```

Package:

```bash
npm run package-dmg
```

The DMG contains:

```text
LocalBrain.app
Applications
README.txt
```

On first launch, `LocalBrain.app` copies the runtime into:

```text
~/Library/Application Support/LocalBrain/runtime
```

The menu contains:

- `Configure Codex`: checks local Codex ChatGPT login status
- `Model`: selects the default model, currently `gpt-5.4-mini` or `gpt-5.5`
- `Key`: shows/copies local API keys and `OPENAI_BASE_URL`
- `Settings`: switches language, opens console/config/audit log, refreshes status, or restarts/stops service
- `Quit`: exits LocalBrain from the bottom of the main menu

## Configuration Notes

Default Codex config:

```json
{
  "defaultProvider": "codex-chatgpt-local",
  "defaultModel": "gpt-5.4-mini",
  "models": ["gpt-5.4-mini", "gpt-5.5"]
}
```

Changing the selected model through the menu persists it into the local config file and updates the default chat route.

## Safety and Release Hygiene

The repository intentionally ignores:

```text
logs/*
LocalBrain.app/
*.dmg
.DS_Store
```

This prevents local API keys, audit logs, built app bundles, and release artifacts from being committed accidentally. Release DMGs are uploaded through GitHub Releases instead.
