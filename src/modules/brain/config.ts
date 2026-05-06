import { readFile } from 'node:fs/promises';

import { BrainRuntime } from './brain-runtime.ts';
import { BrainProviderRegistry } from './provider-registry.ts';
import { AntigravityLocalBrainProvider } from './providers/antigravity-local-provider.ts';
import { CodexChatGptLocalProvider } from './providers/codex-chatgpt-local-provider.ts';
import { CustomHttpBrainProvider } from './providers/custom-http-provider.ts';
import { ExperimentalSubscriptionBrainProvider } from './providers/experimental-subscription-provider.ts';
import { MockBrainProvider } from './providers/mock-provider.ts';
import { OpenAICompatibleBrainProvider } from './providers/openai-compatible-provider.ts';
import { OpenCodeLocalBrainProvider } from './providers/opencode-local-provider.ts';
import type {
  BrainConfig,
  BrainConfigValidationResult,
  BrainProviderConfig,
  BrainProviderKind,
} from './types.ts';

const PROVIDER_KINDS: BrainProviderKind[] = [
  'mock',
  'openai-api-key',
  'vercel-ai-sdk',
  'custom-http',
  'opencode-local',
  'antigravity-local',
  'deepseek-web-local',
  'codex-chatgpt-local',
  'chatgpt-subscription-experimental',
];

export async function loadBrainConfigFile(filePath: string): Promise<BrainConfig> {
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text) as BrainConfig;
}

export function validateBrainConfig(config: BrainConfig): BrainConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.defaultProvider) {
    errors.push('defaultProvider is required');
  }

  if (!config.defaultModel) {
    errors.push('defaultModel is required');
  }

  if (!config.providers || Object.keys(config.providers).length === 0) {
    errors.push('providers must contain at least one provider');
  }

  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    if (!PROVIDER_KINDS.includes(providerConfig.type)) {
      errors.push(`provider ${providerId} has unsupported type: ${providerConfig.type}`);
    }

    if (providerConfig.type === 'custom-http' && !providerConfig.baseUrl) {
      errors.push(`custom-http provider ${providerId} requires baseUrl`);
    }

    if (providerConfig.type === 'codex-chatgpt-local' && providerConfig.localOnly === true) {
      warnings.push(`provider ${providerId} reads local Codex auth but calls chatgpt.com; localOnly should usually be false`);
    }

    if (providerConfig.type === 'openai-api-key' || providerConfig.type === 'vercel-ai-sdk') {
      if (!providerConfig.apiKeyEnv && !providerConfig.apiKey) {
        errors.push(`provider ${providerId} requires apiKeyEnv or apiKey`);
      }
      if (providerConfig.type === 'vercel-ai-sdk') {
        warnings.push(`provider ${providerId} is treated as OpenAI-compatible; set baseUrl to an AI Gateway / compatible endpoint`);
      }
    }
  }

  if (config.defaultProvider && config.providers?.[config.defaultProvider]?.disabled) {
    errors.push(`defaultProvider ${config.defaultProvider} is disabled`);
  }

  if (config.defaultProvider && !config.providers?.[config.defaultProvider]) {
    errors.push(`defaultProvider ${config.defaultProvider} is not declared in providers`);
  }

  for (const [taskKind, route] of Object.entries(config.routing ?? {})) {
    if (route.providerId && !config.providers?.[route.providerId]) {
      errors.push(`routing.${taskKind}.providerId ${route.providerId} is not declared in providers`);
    }
    if (route.providerId && config.providers?.[route.providerId]?.disabled) {
      errors.push(`routing.${taskKind}.providerId ${route.providerId} is disabled`);
    }
    if (!route.model) {
      errors.push(`routing.${taskKind}.model is required`);
    }
  }

  if (config.policy?.requireToolAllowlist && config.tools?.enabled && !config.tools.allowlist?.length) {
    warnings.push('requireToolAllowlist is true but tools.allowlist is empty');
  }

  if (config.server) {
    if (!config.server.host) {
      errors.push('server.host is required when server is configured');
    }
    if (!Number.isInteger(config.server.port) || config.server.port <= 0 || config.server.port > 65535) {
      errors.push('server.port must be an integer between 1 and 65535');
    }
    if (config.server.requireAuth && config.server.apiKeys.length === 0 && !process.env.BRAIN_API_KEY) {
      errors.push('server.apiKeys must contain at least one key when server.requireAuth=true');
    }
    for (const [apiKey, route] of Object.entries(config.server.apiKeyRoutes ?? {})) {
      if (!config.server.apiKeys.includes(apiKey) && process.env.BRAIN_API_KEY !== apiKey) {
        warnings.push('server.apiKeyRoutes contains an assignment for a key not listed in server.apiKeys');
      }
      if (!route.model) {
        errors.push('server.apiKeyRoutes entries must include model');
      }
      if (route.providerId && !config.providers?.[route.providerId]) {
        errors.push(`server.apiKeyRoutes providerId ${route.providerId} is not declared in providers`);
      }
      if (route.providerId && config.providers?.[route.providerId]?.disabled) {
        errors.push(`server.apiKeyRoutes providerId ${route.providerId} is disabled`);
      }
    }
    for (const providerId of Object.keys(config.server.modelProviderFilters ?? {})) {
      if (!config.providers?.[providerId]) {
        errors.push(`server.modelProviderFilters providerId ${providerId} is not declared in providers`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function createBrainRuntimeFromConfig(config: BrainConfig): {
  runtime: BrainRuntime;
  registry: BrainProviderRegistry;
  config: BrainConfig;
} {
  const validation = validateBrainConfig(config);
  if (!validation.ok) {
    throw new Error(`invalid brain config: ${validation.errors.join('; ')}`);
  }

  const registry = new BrainProviderRegistry();

  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.disabled) {
      continue;
    }
    registerConfiguredProvider(registry, providerId, providerConfig);
  }

  return {
    runtime: new BrainRuntime(config, registry),
    registry,
    config,
  };
}

export function registerConfiguredProvider(
  registry: BrainProviderRegistry,
  providerId: string,
  providerConfig: BrainProviderConfig,
): void {
  if (providerConfig.type === 'mock') {
    registry.register(new MockBrainProvider(providerId));
    return;
  }

  if (providerConfig.type === 'custom-http') {
    registry.register(new CustomHttpBrainProvider({
      id: providerId,
      endpoint: providerConfig.baseUrl ?? '',
      displayName: providerConfig.displayName,
      apiKeyEnv: providerConfig.apiKeyEnv,
      localOnly: providerConfig.localOnly,
      experimental: providerConfig.experimental,
    }));
    return;
  }

  if (providerConfig.type === 'chatgpt-subscription-experimental') {
    registry.register(new ExperimentalSubscriptionBrainProvider(providerId));
    return;
  }

  if (providerConfig.type === 'codex-chatgpt-local') {
    registry.register(new CodexChatGptLocalProvider({
      id: providerId,
      displayName: providerConfig.displayName,
      authPath: typeof providerConfig.options?.authPath === 'string' ? providerConfig.options.authPath : undefined,
      endpoint: providerConfig.baseUrl,
      cliPath: typeof providerConfig.options?.cliPath === 'string' ? providerConfig.options.cliPath : undefined,
      clientId: typeof providerConfig.options?.clientId === 'string' ? providerConfig.options.clientId : undefined,
      userAgent: typeof providerConfig.options?.userAgent === 'string' ? providerConfig.options.userAgent : undefined,
      modelCacheTtlMs: typeof providerConfig.options?.modelCacheTtlMs === 'number' ? providerConfig.options.modelCacheTtlMs : undefined,
    }));
    return;
  }

  if (providerConfig.type === 'opencode-local') {
    registry.register(new OpenCodeLocalBrainProvider({
      id: providerId,
      displayName: providerConfig.displayName,
      baseUrl: providerConfig.baseUrl,
      cliPath: typeof providerConfig.options?.cliPath === 'string' ? providerConfig.options.cliPath : undefined,
      modelProvider: typeof providerConfig.options?.modelProvider === 'string' ? providerConfig.options.modelProvider : undefined,
      passwordEnv: typeof providerConfig.options?.passwordEnv === 'string' ? providerConfig.options.passwordEnv : undefined,
      experimental: providerConfig.experimental,
    }));
    return;
  }

  if (providerConfig.type === 'antigravity-local') {
    registry.register(new AntigravityLocalBrainProvider({
      id: providerId,
      displayName: providerConfig.displayName,
      stateDbPath: typeof providerConfig.options?.stateDbPath === 'string' ? providerConfig.options.stateDbPath : undefined,
      sqlitePath: typeof providerConfig.options?.sqlitePath === 'string' ? providerConfig.options.sqlitePath : undefined,
      httpsServerPort: typeof providerConfig.options?.httpsServerPort === 'number' ? providerConfig.options.httpsServerPort : undefined,
      csrfToken: typeof providerConfig.options?.csrfToken === 'string' ? providerConfig.options.csrfToken : undefined,
      imageOutputDir: typeof providerConfig.options?.imageOutputDir === 'string' ? providerConfig.options.imageOutputDir : undefined,
      workspaceUri: typeof providerConfig.options?.workspaceUri === 'string' ? providerConfig.options.workspaceUri : undefined,
      modelCacheTtlMs: typeof providerConfig.options?.modelCacheTtlMs === 'number' ? providerConfig.options.modelCacheTtlMs : undefined,
      experimental: providerConfig.experimental,
    }));
    return;
  }

  if (providerConfig.type === 'deepseek-web-local') {
    return;
  }

  if (providerConfig.type === 'openai-api-key' || providerConfig.type === 'vercel-ai-sdk') {
    registry.register(new OpenAICompatibleBrainProvider({
      id: providerId,
      kind: providerConfig.type,
      baseUrl: providerConfig.baseUrl ?? 'https://api.openai.com/v1',
      displayName: providerConfig.displayName,
      apiKey: providerConfig.apiKey,
      apiKeyEnv: providerConfig.apiKeyEnv ?? 'OPENAI_API_KEY',
      localOnly: providerConfig.localOnly,
      experimental: providerConfig.experimental,
    }));
    return;
  }

  throw new Error(`provider ${providerId} of type ${providerConfig.type} is not supported`);
}
