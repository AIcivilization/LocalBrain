import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

interface LocalApiKeyDeleteRequest {
  apiKey?: string;
}

interface LocalApiKeyLabelRequest {
  apiKey?: string;
  label?: string;
}

interface ProviderModelFilterRequest {
  providerId?: string;
  enabled?: boolean;
  freeOnly?: boolean;
  only?: boolean;
}

interface BrainHealthTestRequest {
  apiKey?: string;
  model?: string;
  input?: string;
  all?: boolean;
}

interface BrainModelSpeedTestRequest {
  apiKey?: string;
  input?: string;
  freeOnly?: boolean;
  models?: string[];
}

interface AutoHealthRequest {
  enabled?: boolean;
  intervalMs?: number;
}

interface BrainHealthMetric {
  timestamp: string;
  apiKeyFingerprint: string;
  providerId?: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  errorCode?: string;
  errorMessage?: string;
}

interface BrainModelMetric {
  timestamp: string;
  apiKeyFingerprint: string;
  providerId?: string;
  model: string;
  modelName?: string;
  ok: boolean;
  durationMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  errorCode?: string;
  errorMessage?: string;
}

interface BrainRequestLogEntry {
  timestamp: string;
  apiKeyFingerprint: string;
  apiKeyLabel?: string;
  path: string;
  providerId?: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface OpenAIImageGenerationRequest {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
  user?: string;
  metadata?: Record<string, unknown>;
}

export class BrainServer {
  private readonly options: BrainServerOptions;
  private readonly serverConfig: BrainServerConfig;
  private readonly healthMetrics: BrainHealthMetric[] = [];
  private readonly modelMetrics: BrainModelMetric[] = [];
  private readonly requestLogs: BrainRequestLogEntry[] = [];
  private readonly metricsLogPath?: string;
  private readonly requestLogPath?: string;
  private autoHealthTimer?: ReturnType<typeof setInterval>;
  private server?: Server;

  constructor(options: BrainServerOptions) {
    this.options = options;
    this.serverConfig = normalizeServerConfig(options.config.server);
    this.metricsLogPath = resolveMetricsLogPath(options.configPath, this.serverConfig.auditLogPath);
    this.requestLogPath = resolveRequestLogPath(options.configPath, this.serverConfig.auditLogPath);
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
    await this.loadPersistedMetrics();
    this.configureAutoHealthTimer();
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    if (this.autoHealthTimer) {
      clearInterval(this.autoHealthTimer);
      this.autoHealthTimer = undefined;
    }
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

    if (method === 'POST' && path === '/brain/admin/delete-key') {
      const body = await this.readJson<LocalApiKeyDeleteRequest>(request);
      await this.deleteLocalApiKey(body);
      this.writeJson(response, 200, {
        ok: true,
        state: await this.localState(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/key-label') {
      const body = await this.readJson<LocalApiKeyLabelRequest>(request);
      await this.setLocalApiKeyLabel(body);
      this.writeJson(response, 200, {
        ok: true,
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

    if (method === 'GET' && path === '/brain/admin/health') {
      this.writeJson(response, 200, {
        ok: true,
        health: await this.keyHealthSnapshot(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/health/test') {
      const body = await this.readJson<BrainHealthTestRequest>(request);
      const result = await this.runHealthTest(body);
      this.writeJson(response, 200, {
        ok: true,
        ...result,
        health: await this.keyHealthSnapshot(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/model-speed-test') {
      const body = await this.readJson<BrainModelSpeedTestRequest>(request);
      const result = await this.runModelSpeedTest(body);
      this.writeJson(response, 200, {
        ok: true,
        ...result,
        modelSpeed: this.modelSpeedSnapshot(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'GET' && path === '/brain/admin/request-log') {
      this.writeJson(response, 200, {
        ok: true,
        logs: this.requestLogs.slice(-100).reverse(),
      });
      await this.audit(method, path, 200, startedAt);
      return;
    }

    if (method === 'POST' && path === '/brain/admin/auto-health') {
      const body = await this.readJson<AutoHealthRequest>(request);
      await this.setAutoHealth(body);
      this.writeJson(response, 200, {
        ok: true,
        state: await this.localState(),
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
      try {
        const result = await this.options.runtime.run(await this.constrainToAllowedModels(this.applyLocalApiKeyRoute(body, localApiKey)));
        await this.recordRequestLogFromResult(localApiKey, path, startedAt, true, result.providerId, result.model, result.usage);
        this.writeJson(response, 200, result);
        await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      } catch (error) {
        await this.recordRequestLogError(localApiKey, path, startedAt, error, body.providerId, body.model);
        throw error;
      }
      return;
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      const body = await this.readJson<Record<string, unknown>>(request);
      const brainRequest = openAIChatToBrainRequest(body);
      try {
        const result = await this.options.runtime.run(await this.constrainToAllowedModels(this.applyLocalApiKeyRoute(brainRequest, localApiKey)));
        await this.recordRequestLogFromResult(localApiKey, path, startedAt, true, result.providerId, result.model, result.usage);
        if (body.stream === true) {
          this.writeSse(response, brainToOpenAIChatStreamChunks(result));
          await this.audit(method, path, 200, startedAt, result.providerId, result.model);
          return;
        }
        this.writeJson(response, 200, brainToOpenAIChatCompletion(result));
        await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      } catch (error) {
        await this.recordRequestLogError(localApiKey, path, startedAt, error, brainRequest.providerId, brainRequest.model);
        throw error;
      }
      return;
    }

    if (method === 'POST' && path === '/v1/images/generations') {
      const body = await this.readJson<OpenAIImageGenerationRequest>(request);
      try {
        const result = await this.generateImage(body, localApiKey);
        const brain = result.brain as { providerId?: string; model?: string } | undefined;
        await this.recordRequestLogFromResult(localApiKey, path, startedAt, true, brain?.providerId, brain?.model);
        this.writeJson(response, 200, result);
        await this.audit(method, path, 200, startedAt, brain?.providerId, brain?.model);
      } catch (error) {
        await this.recordRequestLogError(localApiKey, path, startedAt, error, undefined, body.model);
        throw error;
      }
      return;
    }

    if (method === 'POST' && path === '/v1/responses') {
      const body = await this.readJson<Record<string, unknown>>(request);
      const brainRequest = openAIResponsesToBrainRequest(body);
      try {
        const result = await this.options.runtime.run(await this.constrainToAllowedModels(this.applyLocalApiKeyRoute(brainRequest, localApiKey)));
        await this.recordRequestLogFromResult(localApiKey, path, startedAt, true, result.providerId, result.model, result.usage);
        this.writeJson(response, 200, brainToOpenAIResponse(result));
        await this.audit(method, path, 200, startedAt, result.providerId, result.model);
      } catch (error) {
        await this.recordRequestLogError(localApiKey, path, startedAt, error, brainRequest.providerId, brainRequest.model);
        throw error;
      }
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

  private async keyHealthSnapshot(): Promise<Array<Record<string, unknown>>> {
    const now = Date.now();
    return this.serverConfig.apiKeys.map((apiKey) => {
      const fingerprint = fingerprintApiKey(apiKey);
      const route = this.serverConfig.apiKeyRoutes?.[apiKey];
      const records = this.healthMetrics.filter((metric) => metric.apiKeyFingerprint === fingerprint);
      const latest = records[records.length - 1];
      const recent = records.filter((metric) => now - Date.parse(metric.timestamp) <= 60 * 60 * 1000);
      const recentWindow = recent.length > 0 ? recent : records.slice(-20);
      const successes = recentWindow.filter((metric) => metric.ok);
      const recentOneMinute = records.filter((metric) => now - Date.parse(metric.timestamp) <= 60 * 1000);
      const recentErrors = recentWindow.filter((metric) => !metric.ok);
      return {
        apiKey,
        apiKeyFingerprint: fingerprint,
        route,
        status: latest ? (latest.ok ? 'ok' : 'error') : 'unknown',
        lastTestAt: latest?.timestamp,
        providerId: latest?.providerId ?? route?.providerId,
        model: latest?.model ?? route?.model ?? this.options.config.defaultModel,
        durationMs: latest?.durationMs,
        firstTokenMs: latest?.durationMs,
        outputTokens: latest?.outputTokens,
        tokensPerSecond: latest?.tokensPerSecond,
        successRate: recentWindow.length > 0 ? successes.length / recentWindow.length : undefined,
        recentCount: recentWindow.length,
        recentPerMinute: recentOneMinute.length,
        recentErrors: recentErrors.length,
        errorCode: latest?.errorCode,
        errorMessage: latest?.errorMessage,
      };
    });
  }

  private async runHealthTest(body: BrainHealthTestRequest): Promise<Record<string, unknown>> {
    const requestedKey = body.apiKey?.trim();
    const keys = body.all === true
      ? this.serverConfig.apiKeys
      : requestedKey
        ? [requestedKey]
        : this.serverConfig.apiKeys.slice(0, 1);
    if (keys.length === 0) {
      throw new Error('no local API keys are configured');
    }
    for (const apiKey of keys) {
      if (!this.serverConfig.apiKeys.includes(apiKey)) {
        throw new Error('apiKey must be an existing local API key');
      }
    }

    const results = await Promise.all(keys.map((apiKey) => this.runSingleHealthTest(apiKey, body)));
    return {
      results,
    };
  }

  private async runSingleHealthTest(apiKey: string, body: BrainHealthTestRequest): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const input = body.input?.trim() || '请只回复 OK';
    let providerId: string | undefined;
    let model: string | undefined;
    try {
      const baseRequest: BrainProductRequest = {
        input,
        taskKind: 'chat',
        session: {
          sessionId: `health-${fingerprintApiKey(apiKey)}`,
          messages: [],
        },
        appContext: {
          productName: 'LocalBrain',
          surface: 'health-test',
        },
        metadata: {
          localBrainHealthTest: true,
          localBrainTestTimeoutMs: 45_000,
        },
      };
      let routed = this.applyLocalApiKeyRoute(baseRequest, apiKey);
      const selectedModel = body.model?.trim();
      if (selectedModel) {
        const descriptor = (await this.availableModelDescriptors()).find((candidate) => candidate.id === selectedModel);
        routed = {
          ...routed,
          model: selectedModel,
          providerId: descriptor?.providerId ?? routed.providerId,
        };
      }
      const constrained = await this.constrainToAllowedModels(routed);
      const result = await this.options.runtime.run(constrained);
      providerId = result.providerId;
      model = result.model;
      const durationMs = Date.now() - startedAt;
      const outputTokens = result.usage?.outputTokens ?? result.message.content.length;
      const metric = await this.recordHealthMetric({
        timestamp: new Date().toISOString(),
        apiKeyFingerprint: fingerprintApiKey(apiKey),
        providerId,
        model,
        ok: true,
        durationMs,
        outputTokens,
        tokensPerSecond: tokensPerSecond(outputTokens, durationMs),
      });
      return {
        ...metric,
        apiKey,
        reply: result.message.content,
        finishReason: result.finishReason,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const metric = await this.recordHealthMetric({
        timestamp: new Date().toISOString(),
        apiKeyFingerprint: fingerprintApiKey(apiKey),
        providerId,
        model: model ?? body.model?.trim() ?? this.serverConfig.apiKeyRoutes?.[apiKey]?.model,
        ok: false,
        durationMs,
        outputTokens: 0,
        tokensPerSecond: 0,
        errorCode: errorToCode(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return {
        ...metric,
        apiKey,
      };
    }
  }

  private async recordHealthMetric(metric: BrainHealthMetric): Promise<BrainHealthMetric> {
    this.healthMetrics.push(metric);
    if (this.healthMetrics.length > 500) {
      this.healthMetrics.splice(0, this.healthMetrics.length - 500);
    }
    if (this.metricsLogPath) {
      await mkdir(path.dirname(this.metricsLogPath), { recursive: true });
      await appendFile(this.metricsLogPath, `${JSON.stringify(metric)}\n`, 'utf8').catch(() => undefined);
    }
    return metric;
  }

  private modelSpeedSnapshot(): BrainModelMetric[] {
    const latestByModel = new Map<string, BrainModelMetric>();
    for (const metric of this.modelMetrics) {
      latestByModel.set(metric.model, metric);
    }
    return [...latestByModel.values()]
      .sort((left, right) => {
        if (left.ok !== right.ok) {
          return left.ok ? -1 : 1;
        }
        return left.durationMs - right.durationMs;
      });
  }

  private async runModelSpeedTest(body: BrainModelSpeedTestRequest): Promise<Record<string, unknown>> {
    const apiKey = body.apiKey?.trim() || this.serverConfig.apiKeys[0];
    if (!apiKey || !this.serverConfig.apiKeys.includes(apiKey)) {
      throw new Error('apiKey must be an existing local API key');
    }

    const visibleModels = await this.availableModelDescriptors(body.freeOnly === true);
    const requested = new Set((body.models ?? []).map((model) => model.trim()).filter(Boolean));
    const models = requested.size > 0
      ? visibleModels.filter((model) => requested.has(model.id))
      : visibleModels;
    if (models.length === 0) {
      throw new Error('no visible models to test');
    }

    const results: BrainModelMetric[] = [];
    for (const model of models) {
      results.push(await this.runSingleModelSpeedTest(apiKey, model, body.input));
    }

    return {
      results: results.sort((left, right) => {
        if (left.ok !== right.ok) {
          return left.ok ? -1 : 1;
        }
        return left.durationMs - right.durationMs;
      }),
    };
  }

  private async runSingleModelSpeedTest(
    apiKey: string,
    model: BrainModelDescriptor,
    input?: string,
  ): Promise<BrainModelMetric> {
    const startedAt = Date.now();
    try {
      const result = await this.options.runtime.run(await this.constrainToAllowedModels({
        input: input?.trim() || '请只回复 OK',
        taskKind: 'chat',
        model: model.id,
        providerId: model.providerId,
        session: {
          sessionId: `model-speed-${fingerprintApiKey(apiKey)}-${model.id}`,
          messages: [],
        },
        appContext: {
          productName: 'LocalBrain',
          surface: 'model-speed-test',
        },
        metadata: {
          localBrainModelSpeedTest: true,
          localBrainTestTimeoutMs: 45_000,
        },
      }));
      const durationMs = Date.now() - startedAt;
      const outputTokens = result.usage?.outputTokens ?? result.message.content.length;
      return await this.recordModelMetric({
        timestamp: new Date().toISOString(),
        apiKeyFingerprint: fingerprintApiKey(apiKey),
        providerId: result.providerId,
        model: result.model,
        modelName: model.displayName ?? result.model,
        ok: true,
        durationMs,
        outputTokens,
        tokensPerSecond: tokensPerSecond(outputTokens, durationMs),
      });
    } catch (error) {
      return await this.recordModelMetric({
        timestamp: new Date().toISOString(),
        apiKeyFingerprint: fingerprintApiKey(apiKey),
        providerId: model.providerId,
        model: model.id,
        modelName: model.displayName ?? model.id,
        ok: false,
        durationMs: Date.now() - startedAt,
        outputTokens: 0,
        tokensPerSecond: 0,
        errorCode: errorToCode(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordModelMetric(metric: BrainModelMetric): Promise<BrainModelMetric> {
    this.modelMetrics.push(metric);
    if (this.modelMetrics.length > 500) {
      this.modelMetrics.splice(0, this.modelMetrics.length - 500);
    }
    if (this.metricsLogPath) {
      await mkdir(path.dirname(this.metricsLogPath), { recursive: true });
      await appendFile(this.metricsLogPath, `${JSON.stringify({ type: 'model-speed', ...metric })}\n`, 'utf8').catch(() => undefined);
    }
    return metric;
  }

  private async recordRequestLogFromResult(
    apiKey: string,
    routePath: string,
    startedAt: number,
    ok: boolean,
    providerId?: string,
    model?: string,
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
  ): Promise<void> {
    await this.recordRequestLog({
      timestamp: new Date().toISOString(),
      apiKeyFingerprint: fingerprintApiKey(apiKey),
      apiKeyLabel: this.serverConfig.apiKeyLabels?.[apiKey],
      path: routePath,
      providerId,
      model,
      ok,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      tokensPerSecond: tokensPerSecond(usage?.outputTokens ?? 0, Date.now() - startedAt),
    });
  }

  private async recordRequestLogError(
    apiKey: string,
    routePath: string,
    startedAt: number,
    error: unknown,
    providerId?: string,
    model?: string,
  ): Promise<void> {
    await this.recordRequestLog({
      timestamp: new Date().toISOString(),
      apiKeyFingerprint: fingerprintApiKey(apiKey),
      apiKeyLabel: this.serverConfig.apiKeyLabels?.[apiKey],
      path: routePath,
      providerId,
      model,
      ok: false,
      durationMs: Date.now() - startedAt,
      errorCode: errorToCode(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  private async recordRequestLog(entry: BrainRequestLogEntry): Promise<void> {
    this.requestLogs.push(entry);
    if (this.requestLogs.length > 300) {
      this.requestLogs.splice(0, this.requestLogs.length - 300);
    }
    if (this.requestLogPath) {
      await mkdir(path.dirname(this.requestLogPath), { recursive: true });
      await appendFile(this.requestLogPath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => undefined);
    }
  }

  private async loadPersistedMetrics(): Promise<void> {
    this.healthMetrics.splice(0);
    this.modelMetrics.splice(0);
    this.requestLogs.splice(0);

    if (this.metricsLogPath) {
      const text = await readFile(this.metricsLogPath, 'utf8').catch(() => '');
      for (const line of text.split('\n').filter(Boolean).slice(-1000)) {
        const parsed = safeJsonParse<Record<string, unknown>>(line);
        if (!parsed) continue;
        if (parsed.type === 'model-speed') {
          this.modelMetrics.push(parsed as unknown as BrainModelMetric);
        } else if (typeof parsed.apiKeyFingerprint === 'string' && typeof parsed.ok === 'boolean') {
          this.healthMetrics.push(parsed as unknown as BrainHealthMetric);
        }
      }
      if (this.healthMetrics.length > 500) {
        this.healthMetrics.splice(0, this.healthMetrics.length - 500);
      }
      if (this.modelMetrics.length > 500) {
        this.modelMetrics.splice(0, this.modelMetrics.length - 500);
      }
    }

    if (this.requestLogPath) {
      const text = await readFile(this.requestLogPath, 'utf8').catch(() => '');
      for (const line of text.split('\n').filter(Boolean).slice(-300)) {
        const parsed = safeJsonParse<BrainRequestLogEntry>(line);
        if (parsed) {
          this.requestLogs.push(parsed);
        }
      }
    }
  }

  private configureAutoHealthTimer(): void {
    if (this.autoHealthTimer) {
      clearInterval(this.autoHealthTimer);
      this.autoHealthTimer = undefined;
    }
    if (this.serverConfig.autoHealthCheck?.enabled !== true) {
      return;
    }
    const intervalMs = Math.max(60_000, this.serverConfig.autoHealthCheck.intervalMs ?? 5 * 60_000);
    this.autoHealthTimer = setInterval(() => {
      this.runHealthTest({ all: true }).catch(() => undefined);
    }, intervalMs);
    this.autoHealthTimer.unref?.();
  }

  private async localState(): Promise<Record<string, unknown>> {
    const models = await this.availableModelDescriptors();
    const apiKeyRoutes = this.serverConfig.apiKeyRoutes ?? {};
    const modelProviderFilters = this.serverConfig.modelProviderFilters ?? {};
    const apiKeyDetails = this.serverConfig.apiKeys.map((key) => ({
      key,
      label: this.serverConfig.apiKeyLabels?.[key],
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
      apiKeyLabels: this.serverConfig.apiKeyLabels ?? {},
      keyHealth: await this.keyHealthSnapshot(),
      modelSpeed: this.modelSpeedSnapshot(),
      requestLogs: this.requestLogs.slice(-100).reverse(),
      autoHealthCheck: this.serverConfig.autoHealthCheck ?? { enabled: false, intervalMs: 5 * 60_000 },
      metricsLogPath: this.metricsLogPath,
      requestLogPath: this.requestLogPath,
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
    const nextApiKeyLabels = replace ? {} : { ...this.serverConfig.apiKeyLabels };
    const modelProviderFilters = { ...this.serverConfig.modelProviderFilters };
    this.serverConfig.apiKeys = nextKeys;
    this.serverConfig.apiKeyRoutes = nextApiKeyRoutes;
    this.serverConfig.apiKeyLabels = nextApiKeyLabels;
    this.options.config.server = {
      ...this.serverConfig,
      apiKeys: nextKeys,
      apiKeyRoutes: nextApiKeyRoutes,
      apiKeyLabels: nextApiKeyLabels,
      modelProviderFilters,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
    return key;
  }

  private async deleteLocalApiKey(body: LocalApiKeyDeleteRequest): Promise<void> {
    if (!this.options.configPath) {
      throw new Error('cannot persist deleted key because server was started without configPath');
    }

    const apiKey = body.apiKey?.trim();
    if (!apiKey || !this.serverConfig.apiKeys.includes(apiKey)) {
      throw new Error('apiKey must be an existing local API key');
    }

    const nextKeys = this.serverConfig.apiKeys.filter((key) => key !== apiKey);
    if (this.serverConfig.requireAuth && nextKeys.length === 0 && !process.env.BRAIN_API_KEY) {
      throw new Error('cannot delete the last local API key while auth is required');
    }

    const nextRoutes = { ...(this.serverConfig.apiKeyRoutes ?? {}) };
    delete nextRoutes[apiKey];
    const nextLabels = { ...(this.serverConfig.apiKeyLabels ?? {}) };
    delete nextLabels[apiKey];
    this.serverConfig.apiKeys = nextKeys;
    this.serverConfig.apiKeyRoutes = nextRoutes;
    this.serverConfig.apiKeyLabels = nextLabels;
    this.options.config.server = {
      ...this.serverConfig,
      apiKeys: nextKeys,
      apiKeyRoutes: nextRoutes,
      apiKeyLabels: nextLabels,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
  }

  private async setLocalApiKeyLabel(body: LocalApiKeyLabelRequest): Promise<void> {
    if (!this.options.configPath) {
      throw new Error('cannot persist key label because server was started without configPath');
    }

    const apiKey = body.apiKey?.trim();
    if (!apiKey || !this.serverConfig.apiKeys.includes(apiKey)) {
      throw new Error('apiKey must be an existing local API key');
    }

    const label = body.label?.trim();
    const nextLabels = { ...(this.serverConfig.apiKeyLabels ?? {}) };
    if (label) {
      nextLabels[apiKey] = label.slice(0, 80);
    } else {
      delete nextLabels[apiKey];
    }
    this.serverConfig.apiKeyLabels = nextLabels;
    this.options.config.server = {
      ...this.serverConfig,
      apiKeyLabels: nextLabels,
    };

    await atomicWriteJson(this.options.configPath, this.options.config);
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

  private async setAutoHealth(body: AutoHealthRequest): Promise<void> {
    if (!this.options.configPath) {
      throw new Error('cannot persist auto health setting because server was started without configPath');
    }
    const intervalMs = Math.max(60_000, body.intervalMs ?? this.serverConfig.autoHealthCheck?.intervalMs ?? 5 * 60_000);
    this.serverConfig.autoHealthCheck = {
      enabled: body.enabled === true,
      intervalMs,
    };
    this.options.config.server = {
      ...this.serverConfig,
      autoHealthCheck: this.serverConfig.autoHealthCheck,
    };
    await atomicWriteJson(this.options.configPath, this.options.config);
    this.configureAutoHealthTimer();
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

  private async generateImage(body: OpenAIImageGenerationRequest, localApiKey: string): Promise<Record<string, unknown>> {
    const prompt = body.prompt?.trim();
    if (!prompt) {
      throw new Error('prompt is required');
    }

    const routed = this.applyLocalApiKeyRoute({
      input: prompt,
      taskKind: 'image',
      model: body.model,
      metadata: body.metadata,
    }, localApiKey);
    const constrained = await this.constrainToAllowedModels(routed);
    const providerId = constrained.providerId ?? this.options.config.defaultProvider;
    const model = constrained.model ?? this.options.config.defaultModel;
    const provider = this.options.registry.get(providerId);
    if (!provider.generateImage) {
      throw new Error(`provider ${providerId} does not support image generation`);
    }

    const imageResult = await provider.generateImage({
      model,
      prompt,
      n: body.n,
      size: body.size,
      metadata: body.metadata,
    });

    return {
      created: Math.floor(Date.now() / 1000),
      data: await Promise.all(imageResult.images.map(async (image) => {
        if (body.response_format === 'url') {
          return {
            url: image.url,
            local_path: image.path,
            revised_prompt: image.revisedPrompt ?? prompt,
          };
        }
        return {
          b64_json: image.b64Json ?? (image.path ? (await readFile(image.path)).toString('base64') : undefined),
          url: image.url,
          local_path: image.path,
          revised_prompt: image.revisedPrompt ?? prompt,
        };
      })),
      brain: {
        providerId: imageResult.providerId,
        model: imageResult.model,
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
    apiKeyLabels: config?.apiKeyLabels ?? {},
    apiKeyRoutes: config?.apiKeyRoutes ?? {},
    modelProviderFilters: config?.modelProviderFilters ?? {},
    requireAuth: config?.requireAuth ?? true,
    publicBaseUrl: config?.publicBaseUrl,
    auditLogPath: config?.auditLogPath,
    autoHealthCheck: config?.autoHealthCheck ?? { enabled: false, intervalMs: 5 * 60_000 },
  };
}

function resolveMetricsLogPath(configPath: string | undefined, auditLogPath: string | undefined): string | undefined {
  if (configPath) {
    return path.join(path.dirname(configPath), 'brain.metrics.jsonl');
  }
  if (auditLogPath) {
    return path.join(path.dirname(auditLogPath), 'brain.metrics.jsonl');
  }
  return undefined;
}

function resolveRequestLogPath(configPath: string | undefined, auditLogPath: string | undefined): string | undefined {
  if (configPath) {
    return path.join(path.dirname(configPath), 'brain.requests.jsonl');
  }
  if (auditLogPath) {
    return path.join(path.dirname(auditLogPath), 'brain.requests.jsonl');
  }
  return undefined;
}

function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function tokensPerSecond(tokens: number, durationMs: number): number {
  if (tokens <= 0 || durationMs <= 0) {
    return 0;
  }
  return Math.round((tokens / (durationMs / 1000)) * 10) / 10;
}

function errorToCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized|invalid token|missing token|401/i.test(message)) {
    return 'auth_error';
  }
  if (/429|rate limit|too many/i.test(message)) {
    return 'rate_limited';
  }
  if (/timeout|aborted/i.test(message)) {
    return 'timeout';
  }
  if (/unsupported model|model .* not found|does not support/i.test(message)) {
    return 'model_error';
  }
  return 'error';
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

function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
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

interface DeepSeekWebTokenCandidate {
  token: string;
  source: string;
  sourceMtimeMs: number;
}

async function discoverDeepSeekWebUserTokens(): Promise<DeepSeekWebTokenCandidate[]> {
  const homes = browserLocalStorageRoots();
  const candidates: DeepSeekWebTokenCandidate[] = [];
  for (const root of homes) {
    const files = await listLevelDbFiles(root).catch(() => []);
    for (const file of files) {
      const tokens = await extractDeepSeekTokensFromFile(file.path).catch(() => []);
      candidates.push(...tokens.map((token) => ({
        token,
        source: file.path,
        sourceMtimeMs: file.mtimeMs,
      })));
    }
  }
  for (const file of await listSafariLocalStorageFiles().catch(() => [])) {
    const tokens = await extractDeepSeekTokensFromFile(file.path).catch(() => []);
    candidates.push(...tokens.map((token) => ({
      token,
      source: file.path,
      sourceMtimeMs: file.mtimeMs,
    })));
  }
  return uniqueTokenCandidates(candidates)
    .sort((left, right) => {
      const scoreDiff = scoreDiscoveredToken(right.token) - scoreDiscoveredToken(left.token);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return right.sourceMtimeMs - left.sourceMtimeMs;
    });
}

function browserLocalStorageRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Google/Chrome Canary'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
    path.join(home, 'Library/Application Support/Chromium'),
    path.join(home, 'Library/Application Support/Arc/User Data'),
    path.join(home, 'Library/Application Support/Vivaldi'),
    path.join(home, 'Library/Application Support/Opera Software/Opera Stable'),
  ];
}

async function listSafariLocalStorageFiles(): Promise<Array<{ path: string; mtimeMs: number }>> {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Library/Safari/LocalStorage'),
    path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'),
  ];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    await collectSafariLocalStorageFiles(root, files, 0).catch(() => undefined);
  }
  return files;
}

async function collectSafariLocalStorageFiles(
  dir: string,
  files: Array<{ path: string; mtimeMs: number }>,
  depth: number,
): Promise<void> {
  if (depth > 5) {
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSafariLocalStorageFiles(filePath, files, depth + 1).catch(() => undefined);
      continue;
    }
    if (!entry.isFile() || !/^localstorage\.sqlite3(?:-wal)?$/i.test(entry.name)) {
      continue;
    }
    const info = await stat(filePath).catch(() => undefined);
    if (info && info.size > 0 && info.size <= 64 * 1024 * 1024) {
      files.push({
        path: filePath,
        mtimeMs: info.mtimeMs,
      });
    }
  }
}

async function listLevelDbFiles(root: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const profileDirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => entry.name === 'Default' || entry.name.startsWith('Profile ') || entry.name === 'Guest Profile')
    .flatMap((entry) => {
      const profile = path.join(root, entry.name);
      return [
        path.join(profile, 'Local Storage', 'leveldb'),
        path.join(profile, 'IndexedDB', 'https_chat.deepseek.com_0.indexeddb.leveldb'),
        path.join(profile, 'IndexedDB', 'https_platform.deepseek.com_0.indexeddb.leveldb'),
      ];
    });

  const operaStorage = path.join(root, 'Local Storage', 'leveldb');
  profileDirs.push(operaStorage);

  for (const dir of profileDirs) {
    const levelEntries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of levelEntries) {
      if (!entry.isFile() || !/\.(ldb|log)$/i.test(entry.name)) {
        continue;
      }
      const file = path.join(dir, entry.name);
      const info = await stat(file).catch(() => undefined);
      if (info && info.size > 0 && info.size <= 64 * 1024 * 1024) {
        files.push({
          path: file,
          mtimeMs: info.mtimeMs,
        });
      }
    }
  }

  return files;
}

async function extractDeepSeekTokensFromFile(file: string): Promise<string[]> {
  const buffer = await readFile(file);
  const texts = [
    buffer.toString('utf8'),
    buffer.toString('utf16le'),
    buffer.toString('latin1'),
  ];
  const tokens = new Set<string>();

  for (const text of texts) {
    if (!text.includes('deepseek') && !text.includes('userToken')) {
      continue;
    }
    for (const token of extractDeepSeekTokensFromText(text)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function extractDeepSeekTokensFromText(text: string): string[] {
  const candidates = new Set<string>();
  const addMatches = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      const candidate = sanitizeDiscoveredToken(match[1]);
      if (candidate) {
        candidates.add(candidate);
      }
    }
  };

  addMatches(/userToken[\s\S]{0,2048}?(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g);
  addMatches(/userToken[\s\S]{0,1024}?"value"\s*:\s*"([^"]{32,4096})"/g);
  addMatches(/"userToken"\s*:\s*"([^"]{32,4096})"/g);
  addMatches(/userToken[\s\S]{0,512}?["']([A-Za-z0-9._+/=-]{48,4096})["']/g);
  addMatches(/userToken[\s\S]{0,512}?([A-Za-z0-9._+/=-]{48,4096})/g);

  return [...candidates]
    .filter((candidate) => !candidate.includes('deepseek.com'))
    .filter((candidate) => !candidate.includes('Local Storage'))
    .sort((left, right) => scoreDiscoveredToken(right) - scoreDiscoveredToken(left));
}

function uniqueTokenCandidates(candidates: DeepSeekWebTokenCandidate[]): DeepSeekWebTokenCandidate[] {
  const byToken = new Map<string, DeepSeekWebTokenCandidate>();
  for (const candidate of candidates) {
    const current = byToken.get(candidate.token);
    if (!current || candidate.sourceMtimeMs > current.sourceMtimeMs) {
      byToken.set(candidate.token, candidate);
    }
  }
  return [...byToken.values()];
}

function sanitizeDiscoveredToken(value: string | undefined): string | undefined {
  const cleaned = normalizeDeepSeekStorageToken(value)
    ?.replace(/\u0000/g, '')
    .trim()
    .replace(/^Bearer\s+/i, '');
  if (!cleaned || cleaned.length < 32 || cleaned.length > 4096) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._+/=-]+$/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function normalizeDeepSeekStorageToken(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\u0000/g, '').trim();
  if (!cleaned) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(cleaned) as { value?: unknown };
    if (typeof parsed.value === 'string' && parsed.value.trim()) {
      return parsed.value.trim();
    }
  } catch {
    // DeepSeek has used both raw localStorage tokens and JSON-wrapped values.
  }
  return cleaned;
}

function scoreDiscoveredToken(value: string): number {
  let score = value.length;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    score += 10_000;
  }
  return score;
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
      --warning: #9a6a00;
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
        --warning: #e8bd61;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 20px 16px 42px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
    h1 { margin: 0; font-size: 24px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    p { color: var(--muted); margin: 8px 0 0; line-height: 1.5; }
    .status { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--muted); background: var(--panel); white-space: nowrap; }
    .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    section { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 12px; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .toolbar { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    .channel-head { align-items: center; overflow-x: auto; padding-bottom: 2px; }
    .channel-toolbar { flex-wrap: nowrap; justify-content: flex-end; min-width: max-content; }
    .channel-toolbar select { width: auto; min-width: 92px; }
    .connection-strip { display: grid; grid-template-columns: minmax(130px, 0.5fr) minmax(180px, 0.7fr) minmax(220px, 1fr) minmax(260px, 1.1fr) minmax(220px, 0.8fr); gap: 10px; }
    .info-cell { min-width: 0; }
    .info-cell label { display: block; margin-bottom: 4px; }
    .copy-line { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; min-width: 0; }
    code, input, select { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    input, select { width: 100%; min-width: 0; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 7px 8px; }
    button { border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; background: transparent; color: var(--text); cursor: pointer; white-space: nowrap; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; }
    button.secondary { border-color: var(--accent-2); color: var(--accent-2); }
    button.danger { border-color: var(--danger); color: var(--danger); }
    button:disabled { cursor: wait; opacity: 0.6; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .channel-list { display: grid; gap: 8px; }
    .channel-card { border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; overflow-y: hidden; background: color-mix(in srgb, var(--panel) 92%, var(--bg)); }
    .channel-card summary { list-style: none; cursor: pointer; }
    .channel-card summary::-webkit-details-marker { display: none; }
    .channel-summary { display: grid; grid-template-columns: 145px 92px 240px 82px 76px 82px 92px auto; gap: 8px; align-items: center; padding: 8px; min-height: 44px; min-width: 960px; }
    .channel-name, .channel-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .channel-model-select { height: 34px; }
    .channel-edit { border-top: 1px solid var(--line); padding: 10px; display: grid; grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr); gap: 10px; }
    .channel-edit-wide { grid-column: 1 / -1; }
    .channel-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--line); border-radius: 6px; padding: 7px 8px; color: var(--muted); }
    .meta { display: grid; gap: 8px; color: var(--muted); font-size: 14px; }
    .notice { color: var(--muted); font-size: 13px; }
    .stack { display: grid; gap: 10px; }
    .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .check { display: inline-flex; gap: 8px; align-items: center; color: var(--muted); font-size: 14px; white-space: nowrap; }
    .check input { width: auto; }
    .pill { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 12px; color: var(--muted); }
    .pill.ok { color: var(--accent); border-color: var(--accent); }
    .pill.unstable { color: var(--warning); border-color: var(--warning); }
    .pill.error { color: var(--danger); border-color: var(--danger); }
    .model-line { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .model-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-meta { margin-top: 3px; color: var(--muted); font-size: 12px; }
    .source-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    details.advanced { grid-column: 1 / -1; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 0; min-width: 0; }
    details.advanced > summary { cursor: pointer; padding: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; list-style: none; }
    details.advanced > summary::-webkit-details-marker { display: none; }
    .advanced-body { border-top: 1px solid var(--line); padding: 12px; display: grid; gap: 12px; }
    .table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .table th, .table td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
    .table th { color: var(--muted); font-weight: 600; }
    .chat-box { border: 1px solid var(--line); border-radius: 8px; min-height: 180px; max-height: 360px; overflow: auto; padding: 10px; display: grid; gap: 8px; align-content: start; }
    .message { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; line-height: 1.45; }
    .message.user { border-color: var(--accent-2); }
    .message.assistant { border-color: var(--accent); }
    textarea { width: 100%; min-height: 60px; resize: vertical; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 9px; font: 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (max-width: 760px) {
      header { display: block; }
      .status { margin-top: 16px; }
      .grid, .split, .connection-strip, .channel-edit { grid-template-columns: 1fr; }
      .row, .channel-actions, .toolbar { flex-wrap: wrap; }
      .channel-toolbar { flex-wrap: nowrap; }
    }
    @media (max-width: 520px) {
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
      <section class="wide">
        <div class="section-head">
          <h2 data-i18n="accessInfo">Access</h2>
          <div class="toolbar">
            <span class="pill"><span data-i18n="activeChannels">Active channels</span>: <span id="activeChannels">0</span></span>
            <button id="toggleLanguage" data-i18n="toggleLanguage">中文</button>
          </div>
        </div>
        <div class="connection-strip">
          <div class="info-cell">
            <label class="notice" data-i18n="service">Service</label>
            <div class="mono" id="serviceSummary"></div>
          </div>
          <div class="info-cell">
            <label class="notice" data-i18n="channelStatus">Channel status</label>
            <div class="mono" id="channelSummary"></div>
          </div>
          <div class="info-cell">
            <label class="notice" data-i18n="recommendedChannel">Recommended channel</label>
            <div class="mono" id="recommendedChannel"></div>
          </div>
          <div class="info-cell">
            <label class="notice">OPENAI_BASE_URL</label>
            <div class="copy-line">
              <input id="baseUrl" readonly>
              <button data-copy="baseUrl" data-i18n="copy">Copy</button>
            </div>
          </div>
          <div class="info-cell">
            <label class="notice" data-i18n="defaultRouteFallback">Default route fallback</label>
            <div class="copy-line">
              <input id="model" readonly>
              <button data-copy="model" data-i18n="copy">Copy</button>
            </div>
          </div>
        </div>
      </section>
      <section class="wide">
        <div class="section-head channel-head">
          <h2 data-i18n="channelManagement">Channel Management</h2>
          <div class="toolbar channel-toolbar">
            <button class="primary" id="testAllKeys" data-i18n="testAllKeys">Test All Channels (calls models)</button>
            <button id="refreshHealth" data-i18n="refreshHealth">Refresh Health</button>
            <select id="autoHealthInterval">
              <option value="300000">5 min</option>
              <option value="600000">10 min</option>
              <option value="1800000">30 min</option>
            </select>
            <label class="check"><input id="autoHealthEnabled" type="checkbox"><span data-i18n="autoHealth">Auto health</span></label>
          </div>
        </div>
        <ul id="channels" class="channel-list"></ul>
        <div class="row">
          <button class="primary" id="newKey" data-i18n="newKey">Generate New Key</button>
          <button class="secondary" id="toggleKeys" data-i18n="showHide">Show/Hide</button>
          <button class="secondary" id="exportKeys" data-i18n="exportKeys">Export Keys</button>
        </div>
        <p class="notice" data-i18n="channelsNotice">Each local key is a channel. Give it a name, assign a model, then use status, speed, and success rate to choose the right channel.</p>
      </section>
      <section class="wide">
        <div class="section-head">
          <h2 data-i18n="chatAndSpeed">Chat & Speed</h2>
        </div>
        <div class="split">
          <div class="stack">
            <div class="split">
              <select id="chatKey"></select>
              <select id="chatModel"></select>
            </div>
            <div id="chatMessages" class="chat-box"></div>
            <textarea id="chatInput" data-i18n-placeholder="chatPlaceholder" placeholder="Type a test message"></textarea>
            <div class="row">
              <button class="primary" id="sendChatTest" data-i18n="send">Send</button>
              <button id="clearChatTest" data-i18n="clearChat">Clear</button>
            </div>
            <div id="chatMetrics" class="model-meta"></div>
          </div>
          <div class="stack">
            <div class="row">
              <select id="speedKey"></select>
              <label class="check"><input id="speedFreeOnly" type="checkbox"><span data-i18n="onlyVisibleFree">Use current free filter</span></label>
              <button class="primary" id="testVisibleModels" data-i18n="testVisibleModels">Test Visible Models</button>
              <button id="exportModelSpeed" data-i18n="exportModelSpeed">Export Results</button>
            </div>
            <div style="overflow:auto;">
              <table class="table">
                <thead><tr><th data-i18n="modelColumn">Model</th><th data-i18n="statusColumn">Status</th><th data-i18n="latencyColumn">Latency</th><th data-i18n="speedColumn">Speed</th></tr></thead>
                <tbody id="modelSpeedRows"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      <details class="advanced">
        <summary><h2 data-i18n="providerSources">Provider Sources</h2><span class="pill" data-i18n="advancedCollapsed">Advanced</span></summary>
        <div class="advanced-body">
          <ul id="modelSources"></ul>
          <p class="notice" data-i18n="modelSourcesNotice">Disable a source to keep LocalBrain from listing or using its models. Free-only keeps only models marked as free for that source.</p>
        </div>
      </details>
      <details class="advanced">
        <summary><h2 data-i18n="upstreamApiKeys">Upstream API Keys</h2><span class="pill" data-i18n="advancedCollapsed">Advanced</span></summary>
        <div class="advanced-body">
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
        </div>
      </details>
      <details class="advanced">
        <summary><h2 data-i18n="advancedSettings">Advanced Settings</h2><span class="pill" data-i18n="advancedCollapsed">Advanced</span></summary>
        <div class="advanced-body">
          <div class="meta">
            <div><span data-i18n="configFile">Config file</span>: <span id="configPath"></span></div>
            <div><span data-i18n="auditLog">Audit log</span>: <span id="auditLogPath"></span></div>
          </div>
          <div>
            <div class="section-head">
              <h2 data-i18n="models">Models</h2>
              <label class="check"><input id="freeOnly" type="checkbox"><span data-i18n="onlyFreeModels">Only show free models</span></label>
            </div>
            <ul id="models"></ul>
          </div>
          <div class="row">
            <button class="danger" id="resetAllKeys" data-i18n="resetAllKeys">Reset All Channel Keys...</button>
          </div>
        </div>
      </details>
    </div>
  </main>
  <script>
    let visible = false;
    let state = null;
    let onlyFree = localStorage.getItem('localbrain.onlyFreeModels') === 'true';
    let language = localStorage.getItem('localbrain.consoleLanguage') || ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    let chatMessages = [];
    const $ = (id) => document.getElementById(id);
    const copy = {
      en: {
        subtitle: 'Local OpenAI-compatible brain gateway',
        connection: 'Connection',
        accessInfo: 'Access',
        activeChannels: 'Active channels',
        channelStatus: 'Channel status',
        recommendedChannel: 'Recommended channel',
        copy: 'Copy',
        defaultModel: 'Default model',
        defaultRouteFallback: 'Default fallback',
        service: 'Service',
        configFile: 'Config file',
        auditLog: 'Audit log',
        provider: 'Source',
        language: 'Language',
        toggleLanguage: '中文',
        localApiKeys: 'Local API Keys',
        channelManagement: 'Channel Management',
        channelsNotice: 'Each local key is a channel. Name it, assign a model, then choose by status, speed, and success rate.',
        newKey: 'Generate New Key',
        resetAllKeys: 'Reset All Channel Keys...',
        showHide: 'Show/Hide',
        exportKeys: 'Export Keys',
        exportCopied: 'Key/model export copied to clipboard.',
        keyName: 'Key name',
        saveName: 'Save name',
        localKeysNotice: 'These are local proxy keys, not Codex or OpenAI tokens. They are only used to access LocalBrain on 127.0.0.1.',
        upstreamApiKeys: 'Upstream Keys',
        providerSources: 'Model Sources',
        advancedSettings: 'Advanced Settings',
        advancedCollapsed: 'Advanced',
        providerName: 'Source name',
        apiKey: 'API key',
        fetchModels: 'Fetch Models',
        selectFetchedModel: 'Fetch models, then choose one (optional)',
        useAsDefault: 'Use as default when model is available',
        addApiKeyProvider: 'Add Upstream Key',
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
        deleteKey: 'Delete Key',
        noUpstreamProviders: 'No upstream API key providers yet.',
        storedKey: 'stored key',
        envKey: 'env key',
        noModels: 'No models match the current filter.',
        free: 'free',
        paidUnknown: 'paid/unknown',
        noSources: 'No model sources are registered.',
        noChannels: 'No local channels yet.',
        keyHealth: 'Key Status',
        testAllKeys: 'Test All Channels (calls models)',
        refreshHealth: 'Refresh Health',
        keyColumn: 'Key',
        modelColumn: 'Model',
        statusColumn: 'Status',
        latencyColumn: 'Latency',
        speedColumn: 'Speed',
        rateColumn: 'Rate',
        actionsColumn: 'Actions',
        keyHealthNotice: 'Health checks send a tiny prompt through the selected local key and record latency, speed, success rate, and common errors.',
        testKey: 'Test',
        modelSpeed: 'Model Speed',
        testVisibleModels: 'Test Visible Models',
        exportModelSpeed: 'Export Results',
        modelSpeedCopied: 'Model speed results copied to clipboard.',
        onlyVisibleFree: 'Use current free filter',
        errorColumn: 'Error',
        timeColumn: 'Time',
        autoHealth: 'Auto health',
        unknown: 'unknown',
        ok: 'ok',
        unstable: 'unstable',
        error: 'error',
        never: 'never',
        chatTester: 'Chat Tester',
        chatAndSpeed: 'Chat & Speed',
        chatPlaceholder: 'Type a test message',
        send: 'Send',
        clearChat: 'Clear',
        selectKey: 'Select key',
        useAssignedModel: 'Use key assigned model',
        chatTestFailed: 'Chat test failed',
        enabled: 'Enabled',
        freeOnly: 'Free models only',
        useOnlyFree: 'Use only this free source',
        testAllConfirm: 'This will call every configured channel once and may consume paid credits or membership quota. Continue?',
        modelSpeedConfirm: 'This will call multiple visible models and may consume paid credits or membership quota. Continue?',
        deleteKeyConfirm: 'Delete this local channel? Products using this key will stop working until they switch to another LocalBrain key.',
        resetAllKeysConfirm: 'Reset all LocalBrain channel keys? Existing products using current keys will stop working until they are updated.',
        modelFetchFailed: 'Failed to fetch upstream models',
        updateKeyFailed: 'Failed to update key model',
        updateSourceFailed: 'Failed to update model source',
        addUpstreamFailed: 'Failed to add upstream key',
        deleteKeyFailed: 'Failed to delete local key',
      },
      zh: {
        subtitle: '本地 OpenAI-compatible 大脑网关',
        connection: '连接',
        accessInfo: '接入信息',
        activeChannels: '最近活跃通道',
        channelStatus: '通道状态',
        recommendedChannel: '推荐通道',
        copy: '复制',
        defaultModel: '默认模型',
        defaultRouteFallback: '默认备用路由',
        service: '服务',
        configFile: '配置文件',
        auditLog: '审计日志',
        provider: '来源',
        language: '语言',
        toggleLanguage: 'English',
        localApiKeys: '本地 API Key',
        channelManagement: '通道管理',
        channelsNotice: '每个本地 Key 就是一条通道。命名、指定模型后，用状态、速度、成功率来决定使用哪条。',
        newKey: '生成新 Key',
        resetAllKeys: '重置全部通道 Key...',
        showHide: '显示/隐藏',
        exportKeys: '导出全部 Key',
        exportCopied: 'Key 与模型对应关系已复制到剪贴板。',
        keyName: 'Key 名称',
        saveName: '保存名称',
        localKeysNotice: '这些是 LocalBrain 本地代理 Key，不是 Codex 或 OpenAI token，只用于访问 127.0.0.1 上的 LocalBrain。',
        upstreamApiKeys: '上游 Key',
        providerSources: '模型来源',
        advancedSettings: '高级设置',
        advancedCollapsed: '高级',
        providerName: '来源名称',
        apiKey: 'API Key',
        fetchModels: '拉取模型',
        selectFetchedModel: '先拉取模型，再选择一个（可选）',
        useAsDefault: '模型可用时设为默认',
        addApiKeyProvider: '添加上游 Key',
        upstreamNotice: '上游 Key 会保存在本地配置文件中；产品端仍然使用 LocalBrain 的 Base URL 和本地代理 Key。',
        modelSources: '模型来源',
        modelSourcesNotice: '关闭某个来源后，LocalBrain 不会列出或使用它的模型。只用免费模型会只保留该来源中标记为免费的模型。',
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
        deleteKey: '删除 Key',
        noUpstreamProviders: '还没有上游 Key。',
        storedKey: '已存储 Key',
        envKey: '环境变量 Key',
        noModels: '没有符合当前过滤条件的模型。',
        free: '免费',
        paidUnknown: '付费/未知',
        noSources: '没有注册模型来源。',
        noChannels: '还没有本地通道。',
        keyHealth: 'Key 状态',
        testAllKeys: '测试全部通道（会调用模型）',
        refreshHealth: '刷新状态',
        keyColumn: 'Key',
        modelColumn: '模型',
        statusColumn: '状态',
        latencyColumn: '耗时',
        speedColumn: '速度',
        rateColumn: '成功率/频率',
        actionsColumn: '操作',
        keyHealthNotice: '体检会通过选中的本地 Key 发送一个很小的提示词，并记录耗时、速度、成功率和常见错误。',
        testKey: '测试',
        modelSpeed: '模型测速',
        testVisibleModels: '测试当前可见模型',
        exportModelSpeed: '导出结果',
        modelSpeedCopied: '模型测速结果已复制到剪贴板。',
        onlyVisibleFree: '跟随免费筛选',
        errorColumn: '错误',
        timeColumn: '时间',
        autoHealth: '自动体检',
        unknown: '未知',
        ok: '可用',
        unstable: '不稳定',
        error: '异常',
        never: '从未',
        chatTester: '试聊窗口',
        chatAndSpeed: '试聊与测速',
        chatPlaceholder: '输入一条测试消息',
        send: '发送',
        clearChat: '清空',
        selectKey: '选择 Key',
        useAssignedModel: '使用 Key 指定模型',
        chatTestFailed: '试聊失败',
        enabled: '启用',
        freeOnly: '只用免费模型',
        useOnlyFree: '只用此来源免费模型',
        testAllConfirm: '这会把每个已配置通道都调用一次，可能消耗付费额度或会员额度。继续吗？',
        modelSpeedConfirm: '这会调用多个当前可见模型，可能消耗付费额度或会员额度。继续吗？',
        deleteKeyConfirm: '删除这条本地通道？正在使用这个 Key 的产品需要切换到其他 LocalBrain Key，否则会停止工作。',
        resetAllKeysConfirm: '重置全部 LocalBrain 通道 Key？所有正在使用当前 Key 的产品都会失效，需要更新到新 Key 后才能继续使用。',
        modelFetchFailed: '拉取上游模型失败',
        updateKeyFailed: '更新 Key 模型失败',
        updateSourceFailed: '更新模型来源失败',
        addUpstreamFailed: '添加上游 Key 失败',
        deleteKeyFailed: '删除本地 Key 失败'
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
      $('serviceSummary').textContent = state.ok ? t('running') : t('unavailable');
      $('channelSummary').textContent = channelSummaryText();
      $('recommendedChannel').textContent = recommendedChannelText();
      $('baseUrl').value = state.openAIBaseUrl || '';
      $('model').value = state.defaultModel || '';
      $('configPath').textContent = state.configPath || t('notProvided');
      $('auditLogPath').textContent = state.auditLogPath || t('disabled');
      $('activeChannels').textContent = activeChannelText();
      $('freeOnly').checked = onlyFree;
      applyLanguage();
      renderChannels();
      renderUpstreamProviders();
      renderModelSources();
      renderModelSpeed();
      renderHealthControls();
      renderChatTester();
      renderModels();
    }
    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function mask(key) {
      if (!key || key.length < 18) return '••••••';
      return key.slice(0, 14) + '••••••' + key.slice(-6);
    }
    function activeChannelText() {
      const now = Date.now();
      const labelsByFingerprint = new Map((state?.keyHealth || []).map((item) => [
        item.apiKeyFingerprint,
        state?.apiKeyLabels?.[item.apiKey] || mask(item.apiKey)
      ]));
      const active = [];
      const seen = new Set();
      for (const log of state?.requestLogs || []) {
        const timestamp = Date.parse(log.timestamp || '');
        if (!Number.isFinite(timestamp) || now - timestamp > 10 * 60 * 1000 || !log.apiKeyFingerprint || seen.has(log.apiKeyFingerprint)) {
          continue;
        }
        seen.add(log.apiKeyFingerprint);
        active.push(log.apiKeyLabel || labelsByFingerprint.get(log.apiKeyFingerprint) || log.apiKeyFingerprint);
      }
      return active.length > 0 ? active.slice(0, 4).join(', ') : '0';
    }
    function normalizedSuccessRate(value) {
      if (typeof value !== 'number') return undefined;
      return value > 1 ? value / 100 : value;
    }
    function channelHealthLevel(health = {}) {
      if (health.status === 'error') return 'error';
      if (health.status === 'ok') {
        const rate = normalizedSuccessRate(health.successRate);
        if (typeof rate === 'number' && rate < 0.8) return 'unstable';
        if (typeof health.durationMs === 'number' && health.durationMs >= 15000) return 'unstable';
        return 'ok';
      }
      return 'unknown';
    }
    function channelHealthRank(level) {
      return { error: 0, unstable: 1, unknown: 2, ok: 3 }[level] ?? 2;
    }
    function providerShortName(providerId, modelId) {
      if (providerId === 'codex-chatgpt-local') return 'Codex';
      if (providerId === 'opencode-local') return 'OpenCode';
      if (providerId === 'antigravity-local') return 'Antigravity';
      if (providerId) return t('upstreamApiKeys');
      if (String(modelId || '').startsWith('opencode/')) return 'OpenCode';
      if (String(modelId || '').startsWith('antigravity/')) return 'Antigravity';
      if (String(modelId || '').startsWith('gpt-')) return 'Codex';
      return t('modelColumn');
    }
    function channelRows() {
      const keys = state?.apiKeys || [];
      const details = state?.apiKeyDetails || keys.map((key) => ({ key, route: null }));
      const healthByKey = new Map((state?.keyHealth || []).map((item) => [item.apiKey, item]));
      return details.map((detail) => {
        const route = detail.route || {};
        const health = healthByKey.get(detail.key) || {};
        const modelId = route.model || health.model || state?.defaultModel || '';
        const providerId = route.providerId || health.providerId || modelById(modelId)?.providerId || '';
        const level = channelHealthLevel(health);
        return { detail, key: detail.key, route, health, modelId, providerId, level };
      }).sort((left, right) => {
        const rank = channelHealthRank(left.level) - channelHealthRank(right.level);
        if (rank !== 0) return rank;
        const duration = (right.health.durationMs ?? -1) - (left.health.durationMs ?? -1);
        if (duration !== 0) return duration;
        return String(left.detail.label || left.key).localeCompare(String(right.detail.label || right.key), language === 'zh' ? 'zh-CN' : 'en');
      });
    }
    function channelSummaryText() {
      const rows = channelRows();
      const counts = rows.reduce((acc, row) => {
        acc[row.level] = (acc[row.level] || 0) + 1;
        return acc;
      }, {});
      return [
        (counts.ok || 0) + ' ' + t('ok'),
        (counts.unstable || 0) + ' ' + t('unstable'),
        (counts.error || 0) + ' ' + t('error'),
        (counts.unknown || 0) + ' ' + t('unknown')
      ].join(' · ');
    }
    function recommendedChannelText() {
      const rows = channelRows();
      const preferred = rows.find((row) => row.level === 'ok') || rows.find((row) => row.level === 'unstable') || rows[0];
      if (!preferred) return t('unknown');
      const label = preferred.detail.label || mask(preferred.key);
      return label + ' · ' + providerShortName(preferred.providerId, preferred.modelId) + ' · ' + formatMs(preferred.health.durationMs);
    }
    function modelById(modelId) {
      return (state?.availableModelDetails || []).find((model) => model.id === modelId);
    }
    function modelLabel(modelId, providerId, includeProvider = false) {
      if (!modelId) return t('defaultRouting');
      const model = modelById(modelId);
      const label = model?.displayName || shortModelName(modelId);
      const provider = providerId || model?.providerId;
      return includeProvider && provider ? label + ' · ' + provider : label;
    }
    function shortModelName(modelId) {
      const names = {
      };
      const value = names[modelId] || modelId;
      const raw = String(value || '');
      if (raw.startsWith('opencode/')) return raw.slice('opencode/'.length);
      if (raw.startsWith('antigravity/')) return raw.slice('antigravity/'.length);
      return raw;
    }
    function modelOptions(selected) {
      const models = state?.availableModelDetails || [];
      const groups = new Map();
      for (const model of models) {
        const group = providerShortName(model.providerId, model.id);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(model);
      }
      const defaultOption = '<option value="">' + t('defaultRouting') + '</option>';
      const grouped = Array.from(groups.entries()).map(([group, items]) => {
        const options = items.map((model) => {
          const value = escapeHtml(model.id);
          const label = escapeHtml((model.displayName || shortModelName(model.id)) + (model.free === true ? ' · ' + t('free') : ''));
          return '<option value="' + value + '"' + (model.id === selected ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
        return '<optgroup label="' + escapeHtml(group) + '">' + options + '</optgroup>';
      }).join('');
      return defaultOption + grouped;
    }
    function exportKeyModelText() {
      const details = state?.apiKeyDetails || [];
      const rows = details.map((detail) => {
        const route = detail.route || {};
        const modelId = route.model || state?.defaultModel || '';
        const model = modelById(modelId);
        return {
          key: detail.key,
          baseUrl: state?.openAIBaseUrl || '',
          providerId: route.providerId || model?.providerId || '',
          model: modelId,
          modelName: model?.displayName || shortModelName(modelId),
          free: model?.free === true,
          status: (state?.keyHealth || []).find((item) => item.apiKey === detail.key)?.status || 'unknown'
        };
      });
      const csv = ['key,base_url,provider_id,model,model_name,free,status']
        .concat(rows.map((row) => [row.key, row.baseUrl, row.providerId, row.model, row.modelName, row.free, row.status]
          .map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(',')))
        .join('\\n');
      return JSON.stringify({ exportedAt: new Date().toISOString(), keys: rows }, null, 2) + '\\n\\nCSV\\n' + csv;
    }
    function exportModelSpeedText() {
      const rows = state?.modelSpeed || [];
      const csv = ['model,model_name,provider_id,ok,duration_ms,tokens_per_second,error']
        .concat(rows.map((row) => [row.model, row.modelName || modelLabel(row.model, row.providerId), row.providerId || '', row.ok, row.durationMs ?? '', row.tokensPerSecond ?? '', row.errorMessage || '']
          .map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(',')))
        .join('\\n');
      return JSON.stringify({ exportedAt: new Date().toISOString(), models: rows }, null, 2) + '\\n\\nCSV\\n' + csv;
    }
    function renderChannels() {
      const rows = channelRows();
      $('channelSummary').textContent = channelSummaryText();
      $('recommendedChannel').textContent = recommendedChannelText();
      if (rows.length === 0) {
        $('channels').innerHTML = '<li class="notice">' + t('noChannels') + '</li>';
        return;
      }
      $('channels').innerHTML = rows.map((row, index) => {
        const { detail, key, route, health, modelId, providerId, level } = row;
        const label = detail.label || mask(key);
        const assigned = route.model ? modelLabel(route.model, route.providerId, false) : t('defaultRouting');
        const error = health.errorMessage ? '<div class="model-meta">' + escapeHtml(health.errorMessage) + '</div>' : '';
        const rate = formatPercent(health.successRate) + '<div class="model-meta">' + escapeHtml(String(health.recentPerMinute || 0)) + '/min · ' + escapeHtml(String(health.recentCount || 0)) + '</div>';
        return '<li><details class="channel-card"><summary><div class="channel-summary">' +
          '<div class="channel-name"><strong>' + escapeHtml(label) + '</strong><div class="model-meta">' + (visible ? escapeHtml(key) : mask(key)) + '</div></div>' +
          '<div><span class="pill">' + escapeHtml(providerShortName(providerId, modelId)) + '</span></div>' +
          '<div class="channel-model"><select class="channel-model-select" data-channel-model="' + index + '">' + modelOptions(route.model) + '</select><div class="model-meta">' + escapeHtml(modelId || '') + '</div></div>' +
          '<div><span class="pill ' + level + '">' + t(level) + '</span>' + error + '</div>' +
          '<div>' + escapeHtml(formatMs(health.durationMs)) + '<div class="model-meta">TTFT≈' + escapeHtml(formatMs(health.firstTokenMs)) + '</div></div>' +
          '<div>' + escapeHtml(formatTps(health.tokensPerSecond)) + '<div class="model-meta">' + escapeHtml(String(health.outputTokens ?? '-')) + ' tokens</div></div>' +
          '<div>' + rate + '</div>' +
          '<div class="channel-actions"><button data-channel-test="' + index + '">' + t('testKey') + '</button><button data-channel-copy="' + index + '">' + t('copy') + '</button></div>' +
          '</div></summary><div class="channel-edit">' +
          '<input data-key-label="' + index + '" placeholder="' + t('keyName') + '" value="' + escapeHtml(detail.label || '') + '">' +
          '<div class="mono">' + (visible ? escapeHtml(key) : mask(key)) + '</div>' +
          '<div class="channel-edit-wide model-meta">' + t('assignedModel') + ': ' + escapeHtml(assigned) + ' · ' + escapeHtml(modelId || '') + (providerId ? ' · ' + escapeHtml(providerId) : '') + ' · ' + t('timeColumn') + ': ' + escapeHtml(formatTime(health.lastTestAt)) + '</div>' +
          '<div class="channel-actions channel-edit-wide">' +
          '<button data-key-label-save="' + index + '">' + t('saveName') + '</button>' +
          '<button data-key-clear="' + index + '">' + t('clear') + '</button>' +
          '<button class="danger" data-key-delete="' + index + '">' + t('deleteKey') + '</button>' +
          '</div></div></details></li>';
      }).join('');
      const renderedKeys = rows.map((row) => row.key);
      document.querySelectorAll('[data-channel-model]').forEach((select) => {
        select.addEventListener('click', (event) => {
          event.stopPropagation();
        });
        select.addEventListener('change', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const index = Number(select.dataset.channelModel);
          setKeyModel(renderedKeys[index], select.value, select.value === '').catch((error) => alert(error.message));
        });
      });
      document.querySelectorAll('[data-channel-copy]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          navigator.clipboard.writeText(renderedKeys[Number(button.dataset.channelCopy)]);
        });
      });
      document.querySelectorAll('[data-channel-test]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const key = renderedKeys[Number(button.dataset.channelTest)];
          if (!key) return;
          button.disabled = true;
          testKeyHealth(key).catch((error) => alert(error.message)).finally(() => { button.disabled = false; });
        });
      });
      document.querySelectorAll('[data-key-label-save]').forEach((button) => {
        button.addEventListener('click', () => {
          const index = Number(button.dataset.keyLabelSave);
          const input = document.querySelector('[data-key-label="' + index + '"]');
          setKeyLabel(renderedKeys[index], input.value).catch((error) => alert(error.message));
        });
      });
      document.querySelectorAll('[data-key-clear]').forEach((button) => {
        button.addEventListener('click', () => setKeyModel(renderedKeys[Number(button.dataset.keyClear)], '', true).catch((error) => alert(error.message)));
      });
      document.querySelectorAll('[data-key-delete]').forEach((button) => {
        button.addEventListener('click', () => {
          if (!confirm(t('deleteKeyConfirm'))) return;
          deleteLocalKey(renderedKeys[Number(button.dataset.keyDelete)]).catch((error) => alert(error.message));
        });
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
        return '<li class="model-line"><div><div class="model-title">' + escapeHtml(providerShortName(provider.id, '')) + '</div>' +
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
    function renderModelSpeed() {
      const rowsForKeys = channelRows();
      const selectedKey = $('speedKey').value;
      $('speedKey').innerHTML = rowsForKeys.map((row) => (
        '<option value="' + escapeHtml(row.key) + '"' + (row.key === selectedKey ? ' selected' : '') + '>' + escapeHtml((row.detail.label || mask(row.key))) + '</option>'
      )).join('');
      $('speedFreeOnly').checked = onlyFree;
      const rows = state?.modelSpeed || [];
      if (rows.length === 0) {
        $('modelSpeedRows').innerHTML = '<tr><td colspan="4" class="notice">' + t('unknown') + '</td></tr>';
        return;
      }
      $('modelSpeedRows').innerHTML = rows.map((row) => {
        const statusClass = row.ok ? 'ok' : 'error';
        return '<tr><td>' + escapeHtml(row.modelName || modelLabel(row.model, row.providerId, false)) + '<div class="model-meta">' + escapeHtml(row.model || '') + '</div></td>' +
          '<td><span class="pill ' + statusClass + '">' + (row.ok ? t('ok') : t('error')) + '</span><div class="model-meta">' + escapeHtml(row.providerId || '') + '</div></td>' +
          '<td>' + escapeHtml(formatMs(row.durationMs)) + '</td>' +
          '<td>' + escapeHtml(formatTps(row.tokensPerSecond)) + '<div class="model-meta">' + escapeHtml(row.errorMessage || String(row.outputTokens ?? 0) + ' tokens') + '</div></td></tr>';
      }).join('');
    }
    function formatMs(value) {
      if (typeof value !== 'number') return '-';
      return value >= 1000 ? (value / 1000).toFixed(1) + 's' : value + 'ms';
    }
    function formatTps(value) {
      return typeof value === 'number' ? value.toFixed(1) + ' t/s' : '-';
    }
    function formatPercent(value) {
      const rate = normalizedSuccessRate(value);
      return typeof rate === 'number' ? Math.round(rate * 100) + '%' : '-';
    }
    function formatTime(value) {
      if (!value) return t('never');
      try { return new Date(value).toLocaleTimeString(); } catch { return value; }
    }
    function renderHealthControls() {
      const auto = state?.autoHealthCheck || {};
      $('autoHealthEnabled').checked = auto.enabled === true;
      $('autoHealthInterval').value = String(auto.intervalMs || 300000);
    }
    function renderChatTester() {
      const rowsForKeys = channelRows();
      const selectedKey = $('chatKey').value;
      const selectedModel = $('chatModel').value;
      $('chatKey').innerHTML = '<option value="">' + t('selectKey') + '</option>' + rowsForKeys.map((row) => (
        '<option value="' + escapeHtml(row.key) + '"' + (row.key === selectedKey ? ' selected' : '') + '>' + escapeHtml(row.detail.label || mask(row.key)) + '</option>'
      )).join('');
      $('chatModel').innerHTML = '<option value="">' + t('useAssignedModel') + '</option>' + modelOptions(selectedModel).replace('<option value="">' + t('defaultRouting') + '</option>', '');
      renderChatMessages();
    }
    function renderChatMessages() {
      $('chatMessages').innerHTML = chatMessages.map((message) => (
        '<div class="message ' + escapeHtml(message.role) + '"><strong>' + escapeHtml(message.role) + '</strong>\\n' + escapeHtml(message.content) + '</div>'
      )).join('');
      $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    }
    async function createKey(replace) {
      const res = await fetch('/brain/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replace })
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error?.message || t('updateKeyFailed'));
      state = payload.state;
      visible = true;
      renderChannels();
      renderChatTester();
      renderModelSpeed();
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
      renderChannels();
      renderUpstreamProviders();
      renderModelSources();
      renderModels();
      renderChatTester();
      renderModelSpeed();
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
      renderChannels();
      renderModelSources();
      renderModels();
      renderChatTester();
      renderModelSpeed();
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
      renderChannels();
      renderChatTester();
      renderModelSpeed();
    }
    async function setKeyLabel(apiKey, label) {
      const res = await fetch('/brain/admin/key-label', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, label })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t('updateKeyFailed'));
      state = body.state;
      renderChannels();
      renderModelSpeed();
      renderChatTester();
    }
    async function refreshHealth() {
      const res = await fetch('/brain/admin/health');
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || 'health failed');
      state = { ...state, keyHealth: body.health };
      renderChannels();
      renderHealthControls();
    }
    async function testKeyHealth(apiKey, all = false, input, model) {
      const res = await fetch('/brain/admin/health/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, all, input, model })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || 'health test failed');
      state = { ...state, keyHealth: body.health };
      renderChannels();
      renderHealthControls();
      return body.results || [];
    }
    async function testVisibleModels() {
      const res = await fetch('/brain/admin/model-speed-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: $('speedKey').value || (state?.apiKeys || [])[0],
          freeOnly: $('speedFreeOnly').checked,
          input: '请只回复 OK'
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || 'model speed test failed');
      state = { ...state, modelSpeed: body.modelSpeed };
      renderModelSpeed();
      return body.results || [];
    }
    async function saveAutoHealth() {
      const res = await fetch('/brain/admin/auto-health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: $('autoHealthEnabled').checked,
          intervalMs: Number($('autoHealthInterval').value)
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || 'auto health failed');
      state = body.state;
      renderChannels();
      renderHealthControls();
    }
    async function sendChatTest() {
      const apiKey = $('chatKey').value || (state?.apiKeys || [])[0];
      const input = $('chatInput').value.trim();
      const model = $('chatModel').value;
      if (!apiKey || !input) return;
      chatMessages.push({ role: 'user', content: input });
      $('chatInput').value = '';
      $('chatMetrics').textContent = '';
      renderChatMessages();
      const results = await testKeyHealth(apiKey, false, input, model);
      const result = results[0];
      if (result?.ok) {
        chatMessages.push({ role: 'assistant', content: result.reply || '' });
        $('chatMetrics').textContent = [
          modelLabel(result.model, result.providerId, false),
          result.providerId,
          formatMs(result.durationMs),
          formatTps(result.tokensPerSecond),
          String(result.outputTokens || 0) + ' tokens'
        ].filter(Boolean).join(' · ');
      } else {
        const message = result?.errorMessage || t('chatTestFailed');
        chatMessages.push({ role: 'assistant', content: message });
        $('chatMetrics').textContent = result?.errorCode || 'error';
      }
      renderChatMessages();
    }
    async function deleteLocalKey(apiKey) {
      const res = await fetch('/brain/admin/delete-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t('deleteKeyFailed'));
      state = body.state;
      renderChannels();
      renderChatTester();
      renderModelSpeed();
    }
    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', () => navigator.clipboard.writeText($(button.dataset.copy).value));
    });
    function runFromButton(button, task) {
      button.disabled = true;
      return Promise.resolve()
        .then(task)
        .catch((error) => alert(error.message))
        .finally(() => { button.disabled = false; });
    }
    $('newKey').addEventListener('click', (event) => runFromButton(event.currentTarget, () => createKey(false)));
    $('resetAllKeys').addEventListener('click', (event) => {
      if (!confirm(t('resetAllKeysConfirm'))) return;
      runFromButton(event.currentTarget, () => createKey(true));
    });
    $('toggleKeys').addEventListener('click', () => { visible = !visible; renderChannels(); });
    $('exportKeys').addEventListener('click', () => navigator.clipboard.writeText(exportKeyModelText()).then(() => alert(t('exportCopied'))));
    $('testVisibleModels').addEventListener('click', (event) => {
      if (!confirm(t('modelSpeedConfirm'))) return;
      runFromButton(event.currentTarget, () => testVisibleModels());
    });
    $('exportModelSpeed').addEventListener('click', () => navigator.clipboard.writeText(exportModelSpeedText()).then(() => alert(t('modelSpeedCopied'))));
    $('addUpstreamKey').addEventListener('click', () => addUpstreamKey().catch((error) => alert(error.message)));
    $('fetchUpstreamModels').addEventListener('click', () => fetchUpstreamModels().catch((error) => alert(error.message)));
    $('testAllKeys').addEventListener('click', (event) => {
      if (!confirm(t('testAllConfirm'))) return;
      runFromButton(event.currentTarget, () => testKeyHealth(undefined, true));
    });
    $('refreshHealth').addEventListener('click', (event) => runFromButton(event.currentTarget, () => refreshHealth()));
    $('autoHealthEnabled').addEventListener('change', () => saveAutoHealth().catch((error) => alert(error.message)));
    $('autoHealthInterval').addEventListener('change', () => saveAutoHealth().catch((error) => alert(error.message)));
    $('sendChatTest').addEventListener('click', () => sendChatTest().catch((error) => alert(error.message)));
    $('clearChatTest').addEventListener('click', () => { chatMessages = []; $('chatMetrics').textContent = ''; renderChatMessages(); });
    $('chatInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        sendChatTest().catch((error) => alert(error.message));
      }
    });
    $('toggleLanguage').addEventListener('click', () => {
      language = language === 'zh' ? 'en' : 'zh';
      localStorage.setItem('localbrain.consoleLanguage', language);
      applyLanguage();
      if (state) {
        renderChannels();
        renderUpstreamProviders();
        renderModelSources();
        renderModelSpeed();
        renderHealthControls();
        renderChatTester();
        renderModels();
      }
    });
    $('freeOnly').addEventListener('change', () => {
      onlyFree = $('freeOnly').checked;
      localStorage.setItem('localbrain.onlyFreeModels', String(onlyFree));
      renderModelSpeed();
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
