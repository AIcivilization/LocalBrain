import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { registerConfiguredProvider } from './config.ts';
import type { BrainConfig, BrainModelDescriptor, BrainProductRequest, BrainProviderConfig, BrainServerConfig } from './types.ts';
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

interface UpstreamApiKeyRequest {
  providerId?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  makeDefault?: boolean;
}

interface UpstreamModelsRequest {
  baseUrl?: string;
  apiKey?: string;
}

interface LocalApiKeyRouteRequest {
  apiKey?: string;
  providerId?: string;
  model?: string;
  clear?: boolean;
}

interface ProviderModelFilterRequest {
  providerId?: string;
  enabled?: boolean;
  freeOnly?: boolean;
  only?: boolean;
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
    const requestUrl = new URL(request.url ?? '/', this.url());
    const path = requestUrl.pathname;

    if (method === 'OPTIONS') {
      this.writeCorsPreflight(response);
      await this.audit(method, path, 204, startedAt);
      return;
    }

    if (method === 'GET' && path === '/health') {
      const models = await this.availableModelDescriptors();
      this.writeJson(response, 200, {
        ok: true,
        service: 'brain-server',
        defaultModel: this.options.config.defaultModel,
        availableModels: models.map((model) => model.id),
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
      this.writeJson(response, 200, await this.localState());
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/keys') {
      const body = await this.readJson<{ replace?: boolean }>(request);
      const key = await this.generateLocalApiKey(body.replace === true);
      this.writeJson(response, 200, {
        ok: true,
        key,
        state: await this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/model') {
      const body = await this.readJson<{ model?: string }>(request);
      await this.setDefaultModel(body.model);
      this.writeJson(response, 200, {
        ok: true,
        state: await this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/key-model') {
      const body = await this.readJson<LocalApiKeyRouteRequest>(request);
      await this.setLocalApiKeyRoute(body);
      this.writeJson(response, 200, {
        ok: true,
        state: await this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/provider-model-filter') {
      const body = await this.readJson<ProviderModelFilterRequest>(request);
      await this.setProviderModelFilter(body);
      this.writeJson(response, 200, {
        ok: true,
        state: await this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/upstream-api-keys') {
      const body = await this.readJson<UpstreamApiKeyRequest>(request);
      const result = await this.addUpstreamApiKeyProvider(body);
      this.writeJson(response, 200, {
        ok: true,
        ...result,
        state: await this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/upstream-models') {
      const body = await this.readJson<UpstreamModelsRequest>(request);
      const models = await fetchOpenAICompatibleModelIds(body.baseUrl, body.apiKey);
      this.writeJson(response, 200, {
        ok: true,
        models,
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    const localApiKey = this.authorizedApiKey(request);
    if (localApiKey === undefined) {
      this.writeError(response, 401, 'unauthorized', 'missing or invalid local brain API key');
      await this.audit(method, path, 401, startedAt);
      return;
    }

    if (method === 'GET' && path === '/v1/models') {
      const models = this.filterModelsForLocalApiKey(
        await this.availableModelDescriptors(requestUrl.searchParams.get('free') === 'true'),
        localApiKey,
      );
      this.writeJson(response, 200, modelsResponse(this.options.registry, this.options.config.defaultModel, models.map((model) => model.id)));
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/run') {
      const body = await this.readJson<BrainProductRequest>(request);
      const result = await this.options.runtime.run(await this.constrainToAllowedModels(this.applyLocalApiKeyRoute(body, localApiKey)));
      this.writeJson(response, 200, result);
      await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      return;
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      const body = await this.readJson<Record<string, unknown>>(request);
      const result = await this.options.runtime.run(await this.constrainToAllowedModels(this.applyLocalApiKeyRoute(openAIChatToBrainRequest(body), localApiKey)));
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
      const result = await this.options.runtime.run(await this.constrainToAllowedModels(this.applyLocalApiKeyRoute(openAIResponsesToBrainRequest(body), localApiKey)));
      this.writeJson(response, 200, brainToOpenAIResponse(result));
      await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      return;
    }

    this.writeError(response, 404, 'not_found', `no route for ${method} ${path}`);
    await this.audit(method, path, 404, startedAt);
  }

  private isAuthorized(request: IncomingMessage): boolean {
    return this.authorizedApiKey(request) !== undefined;
  }

  private authorizedApiKey(request: IncomingMessage): string | undefined {
    if (!this.serverConfig.requireAuth) {
      return '';
    }

    const header = request.headers.authorization ?? '';
    const token = Array.isArray(header) ? header[0] : header;
    const match = token.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return undefined;
    }

    return this.serverConfig.apiKeys.includes(match[1]) ? match[1] : undefined;
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

  private async localState(): Promise<Record<string, unknown>> {
    const models = await this.availableModelDescriptors();
    const apiKeyRoutes = this.serverConfig.apiKeyRoutes ?? {};
    const modelProviderFilters = this.serverConfig.modelProviderFilters ?? {};
    const apiKeyDetails = this.serverConfig.apiKeys.map((key) => ({
      key,
      route: apiKeyRoutes[key],
    }));
    const upstreamProviders = Object.entries(this.options.config.providers)
      .filter(([_providerId, provider]) => provider.type === 'openai-api-key' || provider.type === 'vercel-ai-sdk')
      .map(([providerId, provider]) => ({
        id: providerId,
        type: provider.type,
        displayName: provider.displayName ?? providerId,
        baseUrl: provider.baseUrl ?? 'https://api.openai.com/v1',
        disabled: provider.disabled === true,
        hasStoredApiKey: Boolean(provider.apiKey),
        apiKeyEnv: provider.apiKeyEnv,
      }));
    return {
      ok: true,
      service: 'LocalBrain',
      openAIBaseUrl: `${this.url()}/v1`,
      healthUrl: `${this.url()}/health`,
      configPath: this.options.configPath,
      defaultModel: this.options.config.defaultModel,
      availableModels: models.map((model) => model.id),
      availableFreeModels: models.filter((model) => model.free === true).map((model) => model.id),
      availableModelDetails: models,
      providers: this.options.registry.list().map((provider) => provider.describe()),
      modelProviderFilters,
      upstreamProviders,
      requireAuth: this.serverConfig.requireAuth,
      apiKeys: this.serverConfig.apiKeys,
      apiKeyDetails,
      apiKeyRoutes,
      auditLogPath: this.serverConfig.auditLogPath,
    };
  }

  private async generateLocalApiKey(replace: boolean): Promise<string> {
    if (!this.options.configPath) {
      throw new Error('cannot persist generated key because server was started without configPath');
    }

    const key = `brain-local-${randomBytes(24).toString('base64url')}`;
    const nextKeys = replace ? [key] : [...this.serverConfig.apiKeys, key];
    const nextApiKeyRoutes = replace ? {} : { ...this.serverConfig.apiKeyRoutes };
    const modelProviderFilters = { ...this.serverConfig.modelProviderFilters };
    this.serverConfig.apiKeys = nextKeys;
    this.serverConfig.apiKeyRoutes = nextApiKeyRoutes;
    this.options.config.server = {
      ...this.serverConfig,
      apiKeys: nextKeys,
      apiKeyRoutes: nextApiKeyRoutes,
      modelProviderFilters,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
    return key;
  }

  private async setLocalApiKeyRoute(body: LocalApiKeyRouteRequest): Promise<void> {
    if (!this.options.configPath) {
      throw new Error('cannot persist key model assignment because server was started without configPath');
    }

    const apiKey = body.apiKey?.trim();
    if (!apiKey || !this.serverConfig.apiKeys.includes(apiKey)) {
      throw new Error('apiKey must be an existing local API key');
    }

    const nextRoutes = { ...(this.serverConfig.apiKeyRoutes ?? {}) };
    if (body.clear === true) {
      delete nextRoutes[apiKey];
      this.serverConfig.apiKeyRoutes = nextRoutes;
      this.options.config.server = {
        ...this.serverConfig,
        apiKeyRoutes: nextRoutes,
      };
      await atomicWriteJson(this.options.configPath, this.options.config);
      return;
    }

    const model = body.model?.trim();
    if (!model) {
      throw new Error('model is required');
    }

    const availableModels = await this.availableModelDescriptors();
    const selectedModel = availableModels.find((candidate) => candidate.id === model);
    if (!selectedModel) {
      throw new Error(`unsupported model: ${model}`);
    }

    nextRoutes[apiKey] = {
      providerId: body.providerId?.trim() || selectedModel.providerId,
      model,
    };
    this.serverConfig.apiKeyRoutes = nextRoutes;
    this.options.config.server = {
      ...this.serverConfig,
      apiKeyRoutes: nextRoutes,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
  }

  private async setProviderModelFilter(body: ProviderModelFilterRequest): Promise<void> {
    if (!this.options.configPath) {
      throw new Error('cannot persist provider model filter because server was started without configPath');
    }

    const providerId = body.providerId?.trim();
    if (!providerId || !this.options.config.providers[providerId]) {
      throw new Error('providerId must be an existing provider');
    }

    const currentFilters = { ...(this.serverConfig.modelProviderFilters ?? {}) };
    const nextFilters = body.only === true
      ? Object.fromEntries(Object.keys(this.options.config.providers).map((id) => [
        id,
        {
          ...currentFilters[id],
          enabled: id === providerId,
        },
      ]))
      : currentFilters;

    nextFilters[providerId] = {
      ...nextFilters[providerId],
      enabled: body.enabled ?? nextFilters[providerId]?.enabled ?? true,
      freeOnly: body.freeOnly ?? nextFilters[providerId]?.freeOnly ?? false,
    };

    this.serverConfig.modelProviderFilters = nextFilters;
    this.options.config.server = {
      ...this.serverConfig,
      modelProviderFilters: nextFilters,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
  }

  private async addUpstreamApiKeyProvider(body: UpstreamApiKeyRequest): Promise<Record<string, unknown>> {
    if (!this.options.configPath) {
      throw new Error('cannot persist upstream API key because server was started without configPath');
    }

    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      throw new Error('apiKey is required');
    }

    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const providerId = resolveProviderId(this.options.config, body.providerId, body.displayName, baseUrl);
    const displayName = body.displayName?.trim() || `API Key: ${new URL(baseUrl).host}`;
    const providerConfig: BrainProviderConfig = {
      ...this.options.config.providers[providerId],
      type: 'openai-api-key',
      displayName,
      baseUrl,
      apiKey,
      localOnly: false,
      disabled: false,
    };

    this.options.config.providers = {
      ...this.options.config.providers,
      [providerId]: providerConfig,
    };

    const model = body.model?.trim();
    if (model) {
      this.options.config.models = addUnique(this.options.config.models ?? [], model);
    }

    registerConfiguredProvider(this.options.registry, providerId, providerConfig);
    await atomicWriteJson(this.options.configPath, this.options.config);

    let selectedDefaultModel: string | undefined;
    let warning: string | undefined;
    if (body.makeDefault === true) {
      try {
        const defaultModel = model ?? (await this.options.registry.get(providerId).listModels?.())?.[0]?.id;
        if (defaultModel) {
          await this.setDefaultModel(defaultModel);
          selectedDefaultModel = defaultModel;
        }
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      providerId,
      selectedDefaultModel,
      warning,
    };
  }

  private async setDefaultModel(model?: string): Promise<void> {
    if (!model) {
      throw new Error('model is required');
    }
    const availableModels = await this.availableModelDescriptors();
    const selectedModel = availableModels.find((candidate) => candidate.id === model);
    if (!selectedModel) {
      throw new Error(`unsupported model: ${model}`);
    }
    if (!this.options.configPath) {
      throw new Error('cannot persist selected model because server was started without configPath');
    }

    const providerId = selectedModel.providerId
      ?? this.options.config.routing?.chat?.providerId
      ?? this.options.config.defaultProvider;

    this.options.config.defaultModel = model;
    this.options.config.routing = {
      ...this.options.config.routing,
      chat: {
        ...this.options.config.routing?.chat,
        providerId,
        model,
      },
      fast: {
        ...this.options.config.routing?.fast,
        providerId,
        model,
      },
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
  }

  private applyLocalApiKeyRoute(request: BrainProductRequest, localApiKey: string): BrainProductRequest {
    const route = this.serverConfig.apiKeyRoutes?.[localApiKey];
    if (!route) {
      return request;
    }

    return {
      ...request,
      providerId: route.providerId,
      model: route.model,
      metadata: {
        ...request.metadata,
        localBrainKeyModelRoute: true,
      },
    };
  }

  private filterModelsForLocalApiKey(models: BrainModelDescriptor[], localApiKey: string): BrainModelDescriptor[] {
    const route = this.serverConfig.apiKeyRoutes?.[localApiKey];
    if (!route) {
      return models;
    }

    const selected = models.find((model) => model.id === route.model);
    return selected
      ? [selected]
      : [{
        id: route.model,
        providerId: route.providerId,
        displayName: route.model,
      }];
  }

  private async availableModelDescriptors(freeOnly = false): Promise<BrainModelDescriptor[]> {
    const models = new Map<string, BrainModelDescriptor>();
    const addModel = (model: BrainModelDescriptor): void => {
      const current = models.get(model.id);
      models.set(model.id, {
        ...current,
        ...model,
        providerId: model.providerId ?? current?.providerId,
        displayName: model.displayName ?? current?.displayName ?? model.id,
        free: model.free ?? current?.free,
      });
    };

    for (const model of this.options.config.models ?? []) {
      addModel({
        id: model,
        providerId: this.options.config.defaultProvider,
        displayName: model,
      });
    }
    if (this.options.config.defaultModel) {
      addModel({
        id: this.options.config.defaultModel,
        providerId: this.options.config.defaultProvider,
        displayName: this.options.config.defaultModel,
      });
    }
    for (const route of Object.values(this.options.config.routing ?? {})) {
      if (route?.model) {
        addModel({
          id: route.model,
          providerId: route.providerId ?? this.options.config.defaultProvider,
          displayName: route.model,
        });
      }
    }
    for (const provider of this.options.registry.list()) {
      if (!provider.listModels) {
        continue;
      }
      try {
        for (const model of await provider.listModels()) {
          addModel(model);
        }
      } catch {
        // Dynamic model discovery should not make the local gateway unavailable.
      }
    }
    return [...models.values()]
      .filter((model) => this.isModelAllowedByProviderFilter(model))
      .filter((model) => !freeOnly || model.free === true)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async constrainToAllowedModels(request: BrainProductRequest): Promise<BrainProductRequest> {
    const models = await this.availableModelDescriptors();
    if (models.length === 0) {
      throw new Error('no models are allowed by the current provider filters');
    }

    const requestedModel = request.model;
    const requestedProviderId = request.providerId;
    const requestedAllowed = requestedModel
      ? models.find((model) => model.id === requestedModel && (!requestedProviderId || model.providerId === requestedProviderId))
      : undefined;
    if (requestedAllowed) {
      return request;
    }

    const fallback = models[0];
    return {
      ...request,
      providerId: fallback.providerId,
      model: fallback.id,
      metadata: {
        ...request.metadata,
        localBrainProviderFilterForcedModel: true,
      },
    };
  }

  private isModelAllowedByProviderFilter(model: BrainModelDescriptor): boolean {
    const providerId = model.providerId ?? this.options.config.defaultProvider;
    const filter = this.serverConfig.modelProviderFilters?.[providerId];
    if (filter?.enabled === false) {
      return false;
    }
    if (filter?.freeOnly === true && model.free !== true) {
      return false;
    }
    return true;
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
    apiKeyRoutes: config?.apiKeyRoutes ?? {},
    modelProviderFilters: config?.modelProviderFilters ?? {},
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

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https');
  }
  return raw;
}

function resolveProviderId(config: BrainConfig, requestedId: string | undefined, displayName: string | undefined, baseUrl: string): string {
  if (requestedId?.trim()) {
    return normalizeProviderId(requestedId);
  }

  const base = normalizeProviderId(displayName || new URL(baseUrl).host || 'api-key-provider');
  let candidate = base;
  let index = 2;
  while (config.providers[candidate]) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function normalizeProviderId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new Error('providerId must contain letters or numbers');
  }
  return normalized;
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

async function fetchOpenAICompatibleModelIds(baseUrl: string | undefined, apiKey: string | undefined): Promise<string[]> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const token = apiKey?.trim();
  if (!token) {
    throw new Error('apiKey is required');
  }

  const response = await fetch(`${normalizedBaseUrl}/models`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`upstream model discovery failed: ${response.status} ${text}`);
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort((left, right) => left.localeCompare(right));
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
    code, input, select { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    input, select { width: 100%; min-width: 0; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
    button { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; background: transparent; color: var(--text); cursor: pointer; white-space: nowrap; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; }
    button.secondary { border-color: var(--accent-2); color: var(--accent-2); }
    button.danger { border-color: var(--danger); color: var(--danger); }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .key { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .key-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; gap: 10px; }
    .key-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center; }
    .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--line); border-radius: 6px; padding: 10px; color: var(--muted); }
    .meta { display: grid; gap: 8px; color: var(--muted); font-size: 14px; }
    .notice { color: var(--muted); font-size: 13px; }
    .stack { display: grid; gap: 10px; }
    .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .check { display: inline-flex; gap: 8px; align-items: center; color: var(--muted); font-size: 14px; }
    .check input { width: auto; }
    .pill { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 12px; color: var(--muted); }
    .model-line { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .model-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-meta { margin-top: 3px; color: var(--muted); font-size: 12px; }
    .source-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    @media (max-width: 760px) {
      header { display: block; }
      .status { margin-top: 16px; }
      .grid, .split { grid-template-columns: 1fr; }
      .row, .key, .key-actions { grid-template-columns: 1fr; flex-wrap: wrap; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>LocalBrain</h1>
        <p data-i18n="subtitle">Local OpenAI-compatible brain gateway</p>
      </div>
      <div class="status"><span class="dot"></span><span id="status">Loading</span></div>
    </header>
    <div class="grid">
      <section>
        <h2 data-i18n="connection">Connection</h2>
        <label class="notice">OPENAI_BASE_URL</label>
        <div class="row">
          <input id="baseUrl" readonly>
          <button data-copy="baseUrl" data-i18n="copy">Copy</button>
        </div>
        <label class="notice" data-i18n="defaultModel">Default model</label>
        <div class="row">
          <input id="model" readonly>
          <button data-copy="model" data-i18n="copy">Copy</button>
        </div>
      </section>
      <section>
        <h2 data-i18n="service">Service</h2>
        <div class="meta">
          <div><span data-i18n="configFile">Config file</span>: <span id="configPath"></span></div>
          <div><span data-i18n="auditLog">Audit log</span>: <span id="auditLogPath"></span></div>
          <div><span data-i18n="provider">Provider</span>: <span id="providers"></span></div>
          <div><span data-i18n="language">Language</span>: <button id="toggleLanguage" data-i18n="toggleLanguage">中文</button></div>
        </div>
      </section>
      <section class="wide">
        <h2 data-i18n="localApiKeys">Local API Keys</h2>
        <ul id="keys"></ul>
        <div class="row">
          <button class="primary" id="newKey" data-i18n="newKey">Generate New Key</button>
          <button class="danger" id="replaceKey" data-i18n="replaceKey">Replace With New Key</button>
          <button class="secondary" id="toggleKeys" data-i18n="showHide">Show/Hide</button>
        </div>
        <p class="notice" data-i18n="localKeysNotice">These are local proxy keys, not Codex or OpenAI tokens. They are only used to access LocalBrain on 127.0.0.1.</p>
      </section>
      <section class="wide">
        <h2 data-i18n="upstreamApiKeys">Upstream API Keys</h2>
        <div class="stack">
          <div class="split">
            <input id="upstreamName" data-i18n-placeholder="providerName" placeholder="Provider name">
            <input id="upstreamBaseUrl" placeholder="https://api.openai.com/v1">
          </div>
          <div class="split">
            <input id="upstreamKey" type="password" data-i18n-placeholder="apiKey" placeholder="API key">
            <button id="fetchUpstreamModels" data-i18n="fetchModels">Fetch Models</button>
          </div>
          <select id="upstreamModel"></select>
          <label class="check"><input id="makeDefault" type="checkbox"><span data-i18n="useAsDefault">Use as default when model is available</span></label>
          <div class="row">
            <button class="primary" id="addUpstreamKey" data-i18n="addApiKeyProvider">Add API Key Provider</button>
          </div>
          <ul id="upstreamProviders"></ul>
        </div>
        <p class="notice" data-i18n="upstreamNotice">Stored upstream keys stay in the local config file. Clients still use the LocalBrain base URL and local proxy key.</p>
      </section>
      <section class="wide">
        <h2 data-i18n="modelSources">Model Sources</h2>
        <ul id="modelSources"></ul>
        <p class="notice" data-i18n="modelSourcesNotice">Disable a source to keep LocalBrain from listing or using its models. Free-only keeps only models marked as free for that source.</p>
      </section>
      <section class="wide">
        <h2 data-i18n="models">Models</h2>
        <label class="check"><input id="freeOnly" type="checkbox"><span data-i18n="onlyFreeModels">Only show free models</span></label>
        <ul id="models"></ul>
      </section>
    </div>
  </main>
  <script>
    let visible = false;
    let state = null;
    let onlyFree = localStorage.getItem('localbrain.onlyFreeModels') === 'true';
    let language = localStorage.getItem('localbrain.consoleLanguage') || ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    const $ = (id) => document.getElementById(id);
    const copy = {
      en: {
        subtitle: 'Local OpenAI-compatible brain gateway',
        connection: 'Connection',
        copy: 'Copy',
        defaultModel: 'Default model',
        service: 'Service',
        configFile: 'Config file',
        auditLog: 'Audit log',
        provider: 'Provider',
        language: 'Language',
        toggleLanguage: '中文',
        localApiKeys: 'Local API Keys',
        newKey: 'Generate New Key',
        replaceKey: 'Replace With New Key',
        showHide: 'Show/Hide',
        localKeysNotice: 'These are local proxy keys, not Codex or OpenAI tokens. They are only used to access LocalBrain on 127.0.0.1.',
        upstreamApiKeys: 'Upstream API Keys',
        providerName: 'Provider name',
        apiKey: 'API key',
        fetchModels: 'Fetch Models',
        selectFetchedModel: 'Fetch models, then choose one (optional)',
        useAsDefault: 'Use as default when model is available',
        addApiKeyProvider: 'Add API Key Provider',
        upstreamNotice: 'Stored upstream keys stay in the local config file. Clients still use the LocalBrain base URL and local proxy key.',
        modelSources: 'Model Sources',
        modelSourcesNotice: 'Disable a source to keep LocalBrain from listing or using its models. Free-only keeps only models marked as free for that source.',
        models: 'Models',
        onlyFreeModels: 'Only show free models',
        running: 'Running',
        unavailable: 'Unavailable',
        notProvided: 'not provided',
        disabled: 'disabled',
        defaultRouting: 'Default routing',
        assignedModel: 'Assigned model',
        assign: 'Assign',
        clear: 'Clear',
        noUpstreamProviders: 'No upstream API key providers yet.',
        storedKey: 'stored key',
        envKey: 'env key',
        noModels: 'No models match the current filter.',
        free: 'free',
        paidUnknown: 'paid/unknown',
        noSources: 'No model sources are registered.',
        enabled: 'Enabled',
        freeOnly: 'Free only',
        useOnlyFree: 'Use only free',
        modelFetchFailed: 'Failed to fetch upstream models',
        updateKeyFailed: 'Failed to update key model',
        updateSourceFailed: 'Failed to update model source',
        addUpstreamFailed: 'Failed to add upstream key'
      },
      zh: {
        subtitle: '本地 OpenAI-compatible 大脑网关',
        connection: '连接',
        copy: '复制',
        defaultModel: '默认模型',
        service: '服务',
        configFile: '配置文件',
        auditLog: '审计日志',
        provider: 'Provider',
        language: '语言',
        toggleLanguage: 'English',
        localApiKeys: '本地 API Key',
        newKey: '生成新 Key',
        replaceKey: '替换为新 Key',
        showHide: '显示/隐藏',
        localKeysNotice: '这些是 LocalBrain 本地代理 Key，不是 Codex 或 OpenAI token，只用于访问 127.0.0.1 上的 LocalBrain。',
        upstreamApiKeys: '上游 API Key',
        providerName: 'Provider 名称',
        apiKey: 'API Key',
        fetchModels: '拉取模型',
        selectFetchedModel: '先拉取模型，再选择一个（可选）',
        useAsDefault: '模型可用时设为默认',
        addApiKeyProvider: '添加 API Key Provider',
        upstreamNotice: '上游 Key 会保存在本地配置文件中；产品端仍然使用 LocalBrain 的 Base URL 和本地代理 Key。',
        modelSources: '模型来源',
        modelSourcesNotice: '关闭某个来源后，LocalBrain 不会列出或使用它的模型。Free only 只保留该来源中标记为免费的模型。',
        models: '模型',
        onlyFreeModels: '只显示免费模型',
        running: '运行中',
        unavailable: '不可用',
        notProvided: '未提供',
        disabled: '已禁用',
        defaultRouting: '默认路由',
        assignedModel: '指定模型',
        assign: '指定',
        clear: '清除',
        noUpstreamProviders: '还没有上游 API Key provider。',
        storedKey: '已存储 Key',
        envKey: '环境变量 Key',
        noModels: '没有符合当前过滤条件的模型。',
        free: '免费',
        paidUnknown: '付费/未知',
        noSources: '没有注册模型来源。',
        enabled: '启用',
        freeOnly: '只用免费',
        useOnlyFree: '只用免费',
        modelFetchFailed: '拉取上游模型失败',
        updateKeyFailed: '更新 Key 模型失败',
        updateSourceFailed: '更新模型来源失败',
        addUpstreamFailed: '添加上游 Key 失败'
      }
    };
    const t = (key) => copy[language]?.[key] || copy.en[key] || key;
    function applyLanguage() {
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
      resetUpstreamModelSelect();
    }
    function resetUpstreamModelSelect() {
      const select = $('upstreamModel');
      if (!select || select.options.length > 1) return;
      select.innerHTML = '<option value="">' + t('selectFetchedModel') + '</option>';
    }
    async function refresh() {
      const res = await fetch('/brain/local-state');
      state = await res.json();
      $('status').textContent = state.ok ? t('running') : t('unavailable');
      $('baseUrl').value = state.openAIBaseUrl || '';
      $('model').value = state.defaultModel || '';
      $('configPath').textContent = state.configPath || t('notProvided');
      $('auditLogPath').textContent = state.auditLogPath || t('disabled');
      $('providers').textContent = (state.providers || []).map((p) => p.id).join(', ');
      $('freeOnly').checked = onlyFree;
      applyLanguage();
      renderKeys();
      renderUpstreamProviders();
      renderModelSources();
      renderModels();
    }
    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function mask(key) {
      if (!key || key.length < 18) return '••••••';
      return key.slice(0, 14) + '••••••' + key.slice(-6);
    }
    function renderKeys() {
      const keys = state?.apiKeys || [];
      const details = state?.apiKeyDetails || keys.map((key) => ({ key, route: null }));
      const models = state?.availableModelDetails || [];
      const options = (selected) => '<option value="">' + t('defaultRouting') + '</option>' + models.map((model) => {
        const value = escapeHtml(model.id);
        const label = escapeHtml((model.displayName || model.id) + (model.providerId ? ' · ' + model.providerId : '') + (model.free === true ? ' · ' + t('free') : ''));
        return '<option value="' + value + '"' + (model.id === selected ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
      $('keys').innerHTML = details.map((detail, index) => {
        const key = detail.key;
        const route = detail.route || {};
        const assigned = route.model ? escapeHtml(route.model + (route.providerId ? ' · ' + route.providerId : '')) : t('defaultRouting');
        return '<li class="key-card"><div class="mono">' + (visible ? escapeHtml(key) : mask(key)) + '</div>' +
          '<div class="model-meta">' + t('assignedModel') + ': ' + assigned + '</div>' +
          '<div class="key-actions"><select data-key-model="' + index + '">' + options(route.model) + '</select>' +
          '<button data-key-save="' + index + '">' + t('assign') + '</button><button data-key-clear="' + index + '">' + t('clear') + '</button><button data-key="' + index + '">' + t('copy') + '</button></div></li>';
      }).join('');
      document.querySelectorAll('[data-key]').forEach((button) => {
        button.addEventListener('click', () => navigator.clipboard.writeText(keys[Number(button.dataset.key)]));
      });
      document.querySelectorAll('[data-key-save]').forEach((button) => {
        button.addEventListener('click', () => {
          const index = Number(button.dataset.keySave);
          const select = document.querySelector('[data-key-model="' + index + '"]');
          setKeyModel(keys[index], select.value, false).catch((error) => alert(error.message));
        });
      });
      document.querySelectorAll('[data-key-clear]').forEach((button) => {
        button.addEventListener('click', () => setKeyModel(keys[Number(button.dataset.keyClear)], '', true).catch((error) => alert(error.message)));
      });
    }
    function renderUpstreamProviders() {
      const providers = state?.upstreamProviders || [];
      if (providers.length === 0) {
        $('upstreamProviders').innerHTML = '<li class="notice">' + t('noUpstreamProviders') + '</li>';
        return;
      }
      $('upstreamProviders').innerHTML = providers.map((provider) => (
        '<li class="model-line"><div><div class="model-title">' + escapeHtml(provider.displayName || provider.id) + '</div>' +
        '<div class="model-meta">' + escapeHtml(provider.id) + ' · ' + escapeHtml(provider.baseUrl) + '</div></div>' +
        '<span class="pill">' + (provider.hasStoredApiKey ? t('storedKey') : escapeHtml(provider.apiKeyEnv || t('envKey'))) + '</span></li>'
      )).join('');
    }
    function renderModels() {
      const models = (state?.availableModelDetails || []).filter((model) => !onlyFree || model.free === true);
      if (models.length === 0) {
        $('models').innerHTML = '<li class="notice">' + t('noModels') + '</li>';
        return;
      }
      $('models').innerHTML = models.map((model) => (
        '<li class="model-line"><div><div class="model-title">' + escapeHtml(model.displayName || model.id) + '</div>' +
        '<div class="model-meta">' + escapeHtml(model.id) + (model.providerId ? ' · ' + escapeHtml(model.providerId) : '') + '</div></div>' +
        '<span class="pill">' + (model.free === true ? t('free') : t('paidUnknown')) + '</span></li>'
      )).join('');
    }
    function renderModelSources() {
      const providers = state?.providers || [];
      const filters = state?.modelProviderFilters || {};
      if (providers.length === 0) {
        $('modelSources').innerHTML = '<li class="notice">' + t('noSources') + '</li>';
        return;
      }
      $('modelSources').innerHTML = providers.map((provider, index) => {
        const filter = filters[provider.id] || {};
        const enabled = filter.enabled !== false;
        const freeOnly = filter.freeOnly === true;
        return '<li class="model-line"><div><div class="model-title">' + escapeHtml(provider.displayName || provider.id) + '</div>' +
          '<div class="model-meta">' + escapeHtml(provider.id) + ' · ' + escapeHtml(provider.kind) + '</div></div>' +
          '<div class="source-actions">' +
          '<label class="check"><input type="checkbox" data-source-enabled="' + index + '"' + (enabled ? ' checked' : '') + '>' + t('enabled') + '</label>' +
          '<label class="check"><input type="checkbox" data-source-free="' + index + '"' + (freeOnly ? ' checked' : '') + '>' + t('freeOnly') + '</label>' +
          '<button data-source-only-free="' + index + '">' + t('useOnlyFree') + '</button>' +
          '</div></li>';
      }).join('');
      document.querySelectorAll('[data-source-enabled]').forEach((input) => {
        input.addEventListener('change', () => {
          const provider = providers[Number(input.dataset.sourceEnabled)];
          const filter = filters[provider.id] || {};
          setProviderFilter(provider.id, input.checked, filter.freeOnly === true, false).catch((error) => alert(error.message));
        });
      });
      document.querySelectorAll('[data-source-free]').forEach((input) => {
        input.addEventListener('change', () => {
          const provider = providers[Number(input.dataset.sourceFree)];
          const filter = filters[provider.id] || {};
          setProviderFilter(provider.id, filter.enabled !== false, input.checked, false).catch((error) => alert(error.message));
        });
      });
      document.querySelectorAll('[data-source-only-free]').forEach((button) => {
        button.addEventListener('click', () => {
          const provider = providers[Number(button.dataset.sourceOnlyFree)];
          setProviderFilter(provider.id, true, true, true).catch((error) => alert(error.message));
        });
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
    async function addUpstreamKey() {
      const payload = {
        displayName: $('upstreamName').value,
        baseUrl: $('upstreamBaseUrl').value,
        apiKey: $('upstreamKey').value,
        model: $('upstreamModel').value,
        makeDefault: $('makeDefault').checked
      };
      const res = await fetch('/brain/admin/upstream-api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t('addUpstreamFailed'));
      state = body.state;
      $('upstreamKey').value = '';
      resetUpstreamModelSelect();
      renderUpstreamProviders();
      renderModelSources();
      renderModels();
    }
    async function fetchUpstreamModels() {
      const res = await fetch('/brain/admin/upstream-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: $('upstreamBaseUrl').value,
          apiKey: $('upstreamKey').value
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t('modelFetchFailed'));
      $('upstreamModel').innerHTML = '<option value="">' + t('selectFetchedModel') + '</option>' + (body.models || []).map((model) => (
        '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>'
      )).join('');
    }
    async function setProviderFilter(providerId, enabled, freeOnly, only) {
      const res = await fetch('/brain/admin/provider-model-filter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId, enabled, freeOnly, only })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t('updateSourceFailed'));
      state = body.state;
      renderKeys();
      renderModelSources();
      renderModels();
    }
    async function setKeyModel(apiKey, model, clear) {
      const res = await fetch('/brain/admin/key-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, model, clear })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t('updateKeyFailed'));
      state = body.state;
      renderKeys();
    }
    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', () => navigator.clipboard.writeText($(button.dataset.copy).value));
    });
    $('newKey').addEventListener('click', () => createKey(false));
    $('replaceKey').addEventListener('click', () => createKey(true));
    $('toggleKeys').addEventListener('click', () => { visible = !visible; renderKeys(); });
    $('addUpstreamKey').addEventListener('click', () => addUpstreamKey().catch((error) => alert(error.message)));
    $('fetchUpstreamModels').addEventListener('click', () => fetchUpstreamModels().catch((error) => alert(error.message)));
    $('toggleLanguage').addEventListener('click', () => {
      language = language === 'zh' ? 'en' : 'zh';
      localStorage.setItem('localbrain.consoleLanguage', language);
      applyLanguage();
      if (state) {
        renderKeys();
        renderUpstreamProviders();
        renderModelSources();
        renderModels();
      }
    });
    $('freeOnly').addEventListener('change', () => {
      onlyFree = $('freeOnly').checked;
      localStorage.setItem('localbrain.onlyFreeModels', String(onlyFree));
      renderModels();
    });
    applyLanguage();
    refresh().catch((error) => {
      $('status').textContent = 'Error';
      console.error(error);
    });
  </script>
</body>
</html>`;
}
