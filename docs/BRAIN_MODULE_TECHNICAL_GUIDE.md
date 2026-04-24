# 大脑模块技术文档

## 目标

“大脑”模块为本地或产品原型中的 AI 驱动应用提供统一 AI 能力入口。产品只通过协议调用大脑，不直接依赖具体模型、登录方式或 SDK。

模块位置：

`src/modules/brain`

最小验证入口：

`npm run brain-smoketest`

配置诊断入口：

`npm run brain-config-check -- docs/brain.config.example.json`

本地服务入口：

`npm run brain-server -- docs/brain.config.example.json`

一键启动入口：

`npm start`

生成本地专用配置和随机代理 Key：

`npm run brain-init-local`

## 设计边界

大脑模块负责：

- 模型 Provider 注册与选择
- 请求上下文组装
- 工具调用协议
- 会话状态回传
- 调用策略护栏
- 审计信息输出

大脑模块不负责：

- 产品 UI
- 产品业务状态持久化
- 正式产品的订阅登录绕行
- 硬编码任何第三方 OAuth client id
- 在默认路径发起网络模型调用

正式产品发布时，可以移除 `src/modules/brain`，或者只保留产品侧 adapter，因为产品和大脑之间只通过 `BrainProductRequest` / `BrainProductResponse` 协议交互。

## 文件结构

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
  providers/
    custom-http-provider.ts
    mock-provider.ts
    experimental-subscription-provider.ts
```

配置样例：

`docs/brain.config.example.json`

真实 OpenAI-compatible 上游配置样例：

`docs/brain.openai.config.example.json`

Codex/ChatGPT 本地订阅配置样例：

`docs/brain.codex-chatgpt.config.example.json`

## 核心协议

产品调用大脑时只需要构造 `BrainProductRequest`：

```ts
{
  input: '用户输入',
  taskKind: 'chat',
  systemPrompt: '产品给大脑的角色说明',
  appContext: {
    productName: '你的产品名',
    surface: '当前页面或功能',
    locale: 'zh-CN',
    state: {}
  },
  tools: []
}
```

大脑返回 `BrainProductResponse`：

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

产品侧应该保存 `session`，下一轮请求再传回给大脑。

## 最小接入步骤

1. 读取并验证配置。

```ts
const config = await loadBrainConfigFile('docs/brain.config.example.json');
const validation = validateBrainConfig(config);
if (!validation.ok) throw new Error(validation.errors.join('; '));
```

2. 创建 Runtime。

```ts
const { runtime: brain } = createBrainRuntimeFromConfig(config);
```

如果产品需要自定义 Provider，可以手动创建 registry：

```ts
const registry = new BrainProviderRegistry();
registry.register(new CustomHttpBrainProvider({
  id: 'local-ai-gateway',
  endpoint: 'http://127.0.0.1:8787/brain/generate',
  localOnly: true
}));
const brain = new BrainRuntime(config, registry);
```

3. 调用大脑。

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

4. 读取输出。

```ts
const assistantText = response.message.content;
const nextSession = response.session;
```

5. 接入前运行诊断。

```bash
npm run brain-config-check -- docs/brain.config.example.json
npm run brain-smoketest
```

## Provider 配置

Provider 是大脑和模型服务之间的唯一边界。产品不得直接调用模型 SDK。

当前内置 Provider：

- `mock`：本地测试用，不发网络请求
- `openai-api-key`：通过 `OPENAI_API_KEY` 连接 OpenAI-compatible `/v1/chat/completions`
- `codex-chatgpt-local`：读取本机 `~/.codex/auth.json`，调用 ChatGPT Codex backend
- `custom-http`：把标准大脑请求转发给外部 AI 网关
- `chatgpt-subscription-experimental`：只作为本地测试适配器边界，默认不可用

预留 Provider 类型：

- `openai-api-key`
- `vercel-ai-sdk`

正式产品建议优先使用 API Key、Vercel AI SDK、AI Gateway 或自有合规 Provider。

真实 API Key 模式：

```bash
export OPENAI_API_KEY=你的真实上游key
npm run brain-server -- docs/brain.openai.config.example.json
```

这个模式会让本地产品仍然只调用：

```text
http://127.0.0.1:8787/v1
```

大脑服务在内部把请求转到配置的 OpenAI-compatible 上游。

## Codex/ChatGPT 本地订阅模式

前置条件：

```bash
codex --login
```

或者已经在 Codex CLI / Codex App 中完成 ChatGPT 登录，并且存在：

```text
~/.codex/auth.json
```

先检查登录态，不会打印 token：

```bash
npm run brain-codex-status
```

启动本地大脑：

```bash
npm run brain-server -- docs/brain.codex-chatgpt.config.example.json
```

产品仍然这样接：

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=local-brain-dev-key
```

安全边界：

- 只读取本机 `~/.codex/auth.json`
- 不把 access token / refresh token 打印到日志
- access token 未过期时不会刷新
- access token 接近过期时才刷新，并把新 token 原子写回原 Codex auth 文件
- 此模式只用于本地个人测试，不用于正式产品发布

## 本地大脑服务

macOS 状态栏启动：

```text
双击 LocalBrain.command
```

`LocalBrain.command` 会打开 `LocalBrain.app`。启动后右上角状态栏会出现 LocalBrain 图标，菜单包含：

- `配置 Codex`：检查本机 Codex ChatGPT 登录态；可用时显示绿色状态，不可用时打开终端引导运行 `codex` 登录
- `模型`：选择当前默认模型，默认 Codex 配置提供 `gpt-5.4-mini` 和 `gpt-5.4`
- `Key`：显示/隐藏已有本地 API Key、复制 Key、复制 `OPENAI_BASE_URL`、生成新 Key、替换 Key
- `其他`：打开控制台、打开配置文件、打开审计日志、刷新状态、重启/停止本次启动的服务、退出

重新打包状态栏 App：

```bash
npm run build-app
```

一键启动：

```bash
npm start
```

首次启动会自动创建：

```text
logs/brain.codex.local.config.json
```

启动后打开：

```text
http://127.0.0.1:8787/
```

这个控制台可以查看/隐藏已有本地 API Key、生成新 Key、复制 `OPENAI_BASE_URL`、查看当前 Provider 和配置路径。

启动：

```bash
npm run brain-server -- docs/brain.config.example.json
```

更推荐先生成本地配置：

```bash
npm run brain-init-local
npm run brain-server -- logs/brain.local.config.json
```

`brain-init-local` 会输出本地配置文件路径、`OPENAI_BASE_URL`、`OPENAI_API_KEY` 和启动命令。

如果要基于 Codex/ChatGPT 订阅配置生成本地随机 Key 配置：

```bash
npm run brain-init-local -- logs/brain.codex.local.config.json docs/brain.codex-chatgpt.config.example.json
npm run brain-server -- logs/brain.codex.local.config.json
```

默认监听：

```text
http://127.0.0.1:8787
```

给新产品配置：

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=local-brain-dev-key
```

支持端点：

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /brain/run
```

`/v1/*` 是 OpenAI 兼容接口，适合直接给 OpenAI SDK、Vercel AI SDK、LangChain、Electron、React Native 或其他本地产品使用。

`/brain/run` 是大脑原生协议，适合需要会话、审计、工具结果、策略细节的自有应用。

本地服务默认启用 CORS，方便浏览器本地应用接入。默认需要 Bearer Key：

```http
Authorization: Bearer local-brain-dev-key
```

长期使用时不要继续用示例 Key，改用 `brain-init-local` 生成的随机 Key。

OpenAI SDK 示例：

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'local-brain-dev-key',
  baseURL: 'http://127.0.0.1:8787/v1',
});

const completion = await client.chat.completions.create({
  model: 'local-mock-model',
  messages: [{ role: 'user', content: '你好' }],
});
```

Fetch 示例：

```ts
const res = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: {
    authorization: 'Bearer local-brain-dev-key',
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    model: 'local-mock-model',
    messages: [{ role: 'user', content: '你好' }]
  })
});
```

## Custom HTTP Provider

如果不想让产品直接混入大脑模块，推荐让产品或本地测试环境启动一个外部 AI 网关，然后大脑只调用 HTTP 协议。

注册方式：

```ts
registry.register(new CustomHttpBrainProvider({
  id: 'local-ai-gateway',
  endpoint: 'http://127.0.0.1:8787/brain/generate',
  localOnly: true
}));
```

网关接收 `BrainProviderRequest`，返回 `BrainProviderResponse`。这个网关内部可以接 OpenAI API、Vercel AI SDK、本地模型，或仅在本地测试时接实验订阅登录。

最小返回：

```json
{
  "providerId": "local-ai-gateway",
  "model": "configured-model",
  "message": {
    "role": "assistant",
    "content": "response text"
  },
  "toolCalls": [],
  "finishReason": "stop"
}
```

网关返回会被大脑校验：

- 必须有 `message.content`
- `message.role` 必须是 `system`、`user`、`assistant`、`tool` 之一
- `toolCalls` 必须是数组
- 每个 tool call 必须有 `id`、`name`、`arguments`

## 本地订阅登录实验边界

参考资料中提到 Codex CLI 可通过 ChatGPT 计划登录，适合研究本地 OAuth、token 管理和 Provider 封装思路。

本项目的大脑模块对这类能力只保留协议边界：

- 默认 `allowExperimentalSubscriptionLogin=false`
- 默认 `chatgpt-subscription-local-experimental.disabled=true`
- 内置 `ExperimentalSubscriptionBrainProvider` 不实现真实调用
- 真实本地实验实现必须放在产品外部或本地 adapter 中

禁止事项：

- 不要在正式产品中复用 Codex 的 OAuth client id
- 不要把本地 token 写入仓库
- 不要把订阅登录作为产品默认 Provider
- 不要把实验 Provider 混进发布构建

## 工具注册协议

工具通过 `BrainToolDefinition` 注册：

```ts
const tool = {
  name: 'searchLocalDocs',
  description: 'Search local docs',
  async execute(args, context) {
    return {
      callId: 'result-id',
      name: 'searchLocalDocs',
      ok: true,
      content: 'result text'
    };
  }
};
```

配置中建议开启 allowlist：

```json
{
  "tools": {
    "enabled": true,
    "allowlist": ["searchLocalDocs"],
    "maxToolCalls": 4
  },
  "policy": {
    "requireToolAllowlist": true
  }
}
```

## 策略护栏

`policy.ts` 会在调用前执行检查：

- `allowNetworkModelCalls`
- `allowExperimentalSubscriptionLogin`
- `allowProductStateInPrompt`
- `requireToolAllowlist`

如果策略阻止请求，`BrainRuntime.run()` 会抛错，并给出阻止原因。

## 会话和记忆

第一版只内置 session memory：

- 大脑返回 `response.session`
- 产品保存该对象
- 下一轮请求传入 `request.session`

长期记忆通过 `memory.mode='external'` 预留，由产品或外部模块实现。

如果配置：

```json
{
  "memory": {
    "mode": "none"
  }
}
```

大脑不会把历史消息写回 `response.session.messages`。这适合一次性任务、隐私敏感任务或产品自己管理上下文的场景。

## 产品侧 Adapter 模板

产品侧建议只保留一个很薄的 adapter：

```ts
export async function askBrain(input, productState, priorSession) {
  const response = await brain.run({
    input,
    taskKind: 'chat',
    session: priorSession,
    systemPrompt: PRODUCT_BRAIN_PROMPT,
    appContext: {
      productName: 'MyApp',
      surface: 'main-chat',
      locale: 'zh-CN',
      state: productState,
      constraints: ['do-not-execute-without-user-confirmation']
    },
    tools: PRODUCT_TOOLS
  });

  return {
    text: response.message.content,
    session: response.session,
    audit: response.audit
  };
}
```

产品代码不要 import 具体 Provider。Provider 只在启动层注册。

## 接入检查清单

- 产品只有一个 adapter 文件 import `src/modules/brain`
- 业务组件不 import Provider
- 配置文件里默认 Provider 不为 disabled
- 本地测试默认使用 `mock` 或 `custom-http` 到 localhost
- 网络 Provider 必须显式设置 `allowNetworkModelCalls=true`
- 实验订阅登录必须同时满足本地测试、显式启用、外部 adapter 承载
- 工具必须有 allowlist
- 产品保存 `response.session`，下一轮原样传回
- 发布构建不包含实验订阅登录 adapter

## 给其他大模型的配置指令

当你需要给某个产品配置大脑时，按以下顺序执行：

1. 读取 `docs/brain.config.example.json`
2. 确认产品是否允许网络模型调用
3. 注册一个符合环境的 Provider
4. 明确 `defaultProvider` 和 `routing`
5. 只注册产品需要的工具
6. 为工具配置 allowlist
7. 给产品侧保存和回传 `BrainSessionState`
8. 运行 `npm run brain-smoketest`
9. 不要启用实验订阅登录，除非用户明确说明这是本地测试

## 排错

`brain provider not registered`：

检查 `defaultProvider` 或 route 中的 `providerId` 是否已经 `registry.register()`。

`network-model-calls-disabled`：

当前策略不允许非本地 Provider。把 `allowNetworkModelCalls` 改成 `true`，或改用 mock/local Provider。

`experimental-subscription-login-disabled`：

实验订阅登录被禁用。仅本地测试时才可打开。

`tool-not-allowlisted`：

工具未加入 allowlist。把工具名加入 `tools.allowlist`。

## 参考

- Codex CLI: https://github.com/openai/codex
- Pi Mono: https://github.com/badlogic/pi-mono/
- Vercel AI SDK: https://ai-sdk.dev/docs/introduction
