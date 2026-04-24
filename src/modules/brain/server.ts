import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrainConfig, BrainProductRequest, BrainServerConfig } from './types.ts';
import type { BrainRuntime } from './brain-runtime.ts';
import type { BrainProviderRegistry } from './provider-registry.ts';
import {
  brainToOpenAIChatCompletion,
  brainToOpenAIChatStreamChunks,
  brainToOpenAIResponse,
  modelsResponse,
  openAIChatToBrainRequest,
  openAIResponsesToBrainRequest,
} from './openai-compat.ts';

export interface BrainServerOptions {
  config: BrainConfig;
  configPath?: string;
  runtime: BrainRuntime;
  registry: BrainProviderRegistry;
}

export class BrainServer {
  private readonly options: BrainServerOptions;
  private readonly serverConfig: BrainServerConfig;
  private server?: Server;

  constructor(options: BrainServerOptions) {
    this.options = options;
    this.serverConfig = normalizeServerConfig(options.config.server);
  }

  async listen(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.writeError(response, 500, 'internal_error', error instanceof Error ? error.message : String(error));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.serverConfig.port, this.serverConfig.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  url(): string {
    return `http://${this.serverConfig.host}:${this.serverConfig.port}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', this.url()).pathname;

    if (method === 'OPTIONS') {
      this.writeCorsPreflight(response);
      await this.audit(method, path, 204, startedAt);
      return;
    }

    if (method === 'GET' && path === '/health') {
      this.writeJson(response, 200, {
        ok: true,
        service: 'brain-server',
        defaultModel: this.options.config.defaultModel,
        providers: this.options.registry.list().map((provider) => provider.describe()),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'GET' && path === '/') {
      this.writeHtml(response, 200, renderConsoleHtml());
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'GET' && path === '/brain/local-state') {
      this.writeJson(response, 200, this.localState());
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/keys') {
      const body = await this.readJson<{ replace?: boolean }>(request);
      const key = await this.generateLocalApiKey(body.replace === true);
      this.writeJson(response, 200, {
        ok: true,
        key,
        state: this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/model') {
      const body = await this.readJson<{ model?: string }>(request);
      await this.setDefaultModel(body.model);
      this.writeJson(response, 200, {
        ok: true,
        state: this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (!this.isAuthorized(request)) {
      this.writeError(response, 401, 'unauthorized', 'missing or invalid local brain API key');
      await this.audit(method, path, 401, startedAt);
      return;
    }

    if (method === 'GET' && path === '/v1/models') {
      this.writeJson(response, 200, modelsResponse(this.options.registry, this.options.config.defaultModel, this.availableModels()));
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/run') {
      const body = await this.readJson<BrainProductRequest>(request);
      const result = await this.options.runtime.run(body);
      this.writeJson(response, 200, result);
      await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      return;
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      const body = await this.readJson<Record<string, unknown>>(request);
      const result = await this.options.runtime.run(openAIChatToBrainRequest(body));
      if (body.stream === true) {
        this.writeSse(response, brainToOpenAIChatStreamChunks(result));
        await this.audit(method, path, 200, startedAt, result.providerId, result.model);
        return;
      }
      this.writeJson(response, 200, brainToOpenAIChatCompletion(result));
      await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      return;
    }

    if (method === 'POST' && path === '/v1/responses') {
      const body = await this.readJson<Record<string, unknown>>(request);
      const result = await this.options.runtime.run(openAIResponsesToBrainRequest(body));
      this.writeJson(response, 200, brainToOpenAIResponse(result));
      await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      return;
    }

    this.writeError(response, 404, 'not_found', `no route for ${method} ${path}`);
    await this.audit(method, path, 404, startedAt);
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.serverConfig.requireAuth) {
      return true;
    }

    const header = request.headers.authorization ?? '';
    const token = Array.isArray(header) ? header[0] : header;
    const match = token.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return false;
    }

    return this.serverConfig.apiKeys.includes(match[1]);
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...corsHeaders(),
    });
    response.end(text);
  }

  private writeHtml(response: ServerResponse, statusCode: number, body: string): void {
    response.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      ...corsHeaders(),
    });
    response.end(body);
  }

  private writeSse(response: ServerResponse, chunks: string[]): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders(),
    });
    for (const chunk of chunks) {
      response.write(chunk);
    }
    response.end();
  }

  private writeError(response: ServerResponse, statusCode: number, code: string, message: string): void {
    this.writeJson(response, statusCode, {
      error: {
        message,
        type: code,
        code,
      },
    });
  }

  private writeCorsPreflight(response: ServerResponse): void {
    response.writeHead(204, corsHeaders());
    response.end();
  }

  private async audit(
    method: string,
    routePath: string,
    statusCode: number,
    startedAt: number,
    providerId?: string,
    model?: string,
  ): Promise<void> {
    if (!this.serverConfig.auditLogPath) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      method,
      path: routePath,
      statusCode,
      durationMs: Date.now() - startedAt,
      providerId,
      model,
    };

    await mkdir(path.dirname(this.serverConfig.auditLogPath), { recursive: true });
    await appendFile(this.serverConfig.auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private localState(): Record<string, unknown> {
    return {
      ok: true,
      service: 'LocalBrain',
      openAIBaseUrl: `${this.url()}/v1`,
      healthUrl: `${this.url()}/health`,
      configPath: this.options.configPath,
      defaultModel: this.options.config.defaultModel,
      availableModels: this.availableModels(),
      providers: this.options.registry.list().map((provider) => provider.describe()),
      requireAuth: this.serverConfig.requireAuth,
      apiKeys: this.serverConfig.apiKeys,
      auditLogPath: this.serverConfig.auditLogPath,
    };
  }

  private async generateLocalApiKey(replace: boolean): Promise<string> {
    if (!this.options.configPath) {
      throw new Error('cannot persist generated key because server was started without configPath');
    }

    const key = `brain-local-${randomBytes(24).toString('base64url')}`;
    const nextKeys = replace ? [key] : [...this.serverConfig.apiKeys, key];
    this.serverConfig.apiKeys = nextKeys;
    this.options.config.server = {
      ...this.serverConfig,
      apiKeys: nextKeys,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
    return key;
  }

  private async setDefaultModel(model?: string): Promise<void> {
    if (!model) {
      throw new Error('model is required');
    }
    const availableModels = this.availableModels();
    if (!availableModels.includes(model)) {
      throw new Error(`unsupported model: ${model}`);
    }
    if (!this.options.configPath) {
      throw new Error('cannot persist selected model because server was started without configPath');
    }

    this.options.config.defaultModel = model;
    this.options.config.routing = {
      ...this.options.config.routing,
      chat: {
        ...this.options.config.routing?.chat,
        model,
      },
      fast: {
        ...this.options.config.routing?.fast,
        model,
      },
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
  }

  private availableModels(): string[] {
    const models = new Set<string>();
    for (const model of this.options.config.models ?? []) {
      models.add(model);
    }
    if (this.options.config.defaultModel) {
      models.add(this.options.config.defaultModel);
    }
    for (const route of Object.values(this.options.config.routing ?? {})) {
      if (route?.model) {
        models.add(route.model);
      }
    }
    for (const providerConfig of Object.values(this.options.config.providers)) {
      if (providerConfig.type === 'codex-chatgpt-local') {
        models.add('gpt-5.4-mini');
        models.add('gpt-5.4');
      }
    }
    return [...models].sort();
  }
}

function normalizeServerConfig(config?: BrainServerConfig): BrainServerConfig {
  const envKey = process.env.BRAIN_API_KEY;
  const apiKeys = [
    ...(config?.apiKeys ?? []),
    ...(envKey ? [envKey] : []),
  ];

  return {
    host: config?.host ?? '127.0.0.1',
    port: config?.port ?? 8787,
    apiKeys,
    requireAuth: config?.requireAuth ?? true,
    publicBaseUrl: config?.publicBaseUrl,
    auditLogPath: config?.auditLogPath,
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '600',
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, filePath);
}

function renderConsoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LocalBrain</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f4;
      --text: #181a1f;
      --muted: #626872;
      --line: #d8d9d2;
      --panel: #ffffff;
      --accent: #176b55;
      --accent-2: #263f8f;
      --danger: #a33a2b;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111315;
        --text: #f1f2ee;
        --muted: #a8ada8;
        --line: #30343a;
        --panel: #191c20;
        --accent: #46b28f;
        --accent-2: #8aa4ff;
        --danger: #ff8d7b;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { max-width: 980px; margin: 0 auto; padding: 28px 20px 56px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
    p { color: var(--muted); margin: 8px 0 0; line-height: 1.5; }
    .status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); background: var(--panel); white-space: nowrap; }
    .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    section { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 16px; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; min-width: 0; }
    code, input { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    input { width: 100%; min-width: 0; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
    button { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; background: transparent; color: var(--text); cursor: pointer; white-space: nowrap; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; }
    button.secondary { border-color: var(--accent-2); color: var(--accent-2); }
    button.danger { border-color: var(--danger); color: var(--danger); }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .key { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--line); border-radius: 6px; padding: 10px; color: var(--muted); }
    .meta { display: grid; gap: 8px; color: var(--muted); font-size: 14px; }
    .notice { color: var(--muted); font-size: 13px; }
    @media (max-width: 760px) {
      header { display: block; }
      .status { margin-top: 16px; }
      .grid { grid-template-columns: 1fr; }
      .row, .key { grid-template-columns: 1fr; flex-wrap: wrap; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>LocalBrain</h1>
        <p>本地 OpenAI-compatible 大脑网关</p>
      </div>
      <div class="status"><span class="dot"></span><span id="status">Loading</span></div>
    </header>
    <div class="grid">
      <section>
        <h2>连接配置</h2>
        <label class="notice">OPENAI_BASE_URL</label>
        <div class="row">
          <input id="baseUrl" readonly>
          <button data-copy="baseUrl">复制</button>
        </div>
        <label class="notice">默认模型</label>
        <div class="row">
          <input id="model" readonly>
          <button data-copy="model">复制</button>
        </div>
      </section>
      <section>
        <h2>服务信息</h2>
        <div class="meta">
          <div>配置文件：<span id="configPath"></span></div>
          <div>审计日志：<span id="auditLogPath"></span></div>
          <div>Provider：<span id="providers"></span></div>
        </div>
      </section>
      <section class="wide">
        <h2>本地 API Key</h2>
        <ul id="keys"></ul>
        <div class="row">
          <button class="primary" id="newKey">生成新 Key</button>
          <button class="danger" id="replaceKey">替换为新 Key</button>
          <button class="secondary" id="toggleKeys">显示/隐藏</button>
        </div>
        <p class="notice">这是本地代理 Key，不是 Codex 或 OpenAI token。只用于访问 127.0.0.1 上的 LocalBrain。</p>
      </section>
    </div>
  </main>
  <script>
    let visible = false;
    let state = null;
    const $ = (id) => document.getElementById(id);
    async function refresh() {
      const res = await fetch('/brain/local-state');
      state = await res.json();
      $('status').textContent = state.ok ? 'Running' : 'Unavailable';
      $('baseUrl').value = state.openAIBaseUrl || '';
      $('model').value = state.defaultModel || '';
      $('configPath').textContent = state.configPath || '未提供';
      $('auditLogPath').textContent = state.auditLogPath || '未启用';
      $('providers').textContent = (state.providers || []).map((p) => p.id).join(', ');
      renderKeys();
    }
    function mask(key) {
      if (!key || key.length < 18) return '••••••';
      return key.slice(0, 14) + '••••••' + key.slice(-6);
    }
    function renderKeys() {
      const keys = state?.apiKeys || [];
      $('keys').innerHTML = keys.map((key, index) => '<li class="key"><div class="mono">' + (visible ? key : mask(key)) + '</div><button data-key="' + index + '">复制</button></li>').join('');
      document.querySelectorAll('[data-key]').forEach((button) => {
        button.addEventListener('click', () => navigator.clipboard.writeText(keys[Number(button.dataset.key)]));
      });
    }
    async function createKey(replace) {
      const res = await fetch('/brain/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replace })
      });
      const payload = await res.json();
      state = payload.state;
      visible = true;
      renderKeys();
    }
    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', () => navigator.clipboard.writeText($(button.dataset.copy).value));
    });
    $('newKey').addEventListener('click', () => createKey(false));
    $('replaceKey').addEventListener('click', () => createKey(true));
    $('toggleKeys').addEventListener('click', () => { visible = !visible; renderKeys(); });
    refresh().catch((error) => {
      $('status').textContent = 'Error';
      console.error(error);
    });
  </script>
</body>
</html>`;
}
