import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrainServer, createBrainRuntimeFromConfig, loadBrainConfigFile, validateBrainConfig } from '../modules/brain/index.ts';
import type { BrainConfig } from '../modules/brain/index.ts';

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, '../..');
  const configPath = process.argv[2] ?? path.join(projectRoot, 'logs', 'brain.codex.local.config.json');
  const sourcePath = process.argv[3] ?? path.join(projectRoot, 'docs', 'brain.codex-chatgpt.config.example.json');

  await ensureLocalConfig(configPath, sourcePath);

  const config = await loadBrainConfigFile(configPath);
  const validation = validateBrainConfig(config);
  if (!validation.ok) {
    throw new Error(`brain config validation failed: ${validation.errors.join('; ')}`);
  }

  const { runtime, registry } = createBrainRuntimeFromConfig(config);
  const server = new BrainServer({ config, configPath, runtime, registry });
  await server.listen();

  console.log('');
  console.log('LocalBrain is running');
  console.log(`Console:        ${server.url()}/`);
  console.log(`OPENAI_BASE_URL ${server.url()}/v1`);
  console.log(`Config:         ${configPath}`);
  console.log(`Providers:      ${registry.list().map((provider) => provider.id).join(', ')}`);
  console.log('');

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

async function ensureLocalConfig(configPath: string, sourcePath: string): Promise<void> {
  try {
    await access(configPath);
    await mergeConfigDefaults(configPath, sourcePath);
    await removeDeepSeekWebConfig(configPath);
    await normalizePortableProviderConfig(configPath);
    return;
  } catch {
    // Create the config below.
  }

  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as BrainConfig;
  const localKey = `brain-local-${randomBytes(24).toString('base64url')}`;
  const localConfig: BrainConfig = {
    ...source,
    server: {
      host: source.server?.host ?? '127.0.0.1',
      port: source.server?.port ?? 8787,
      requireAuth: true,
      apiKeys: [localKey],
      publicBaseUrl: source.server?.publicBaseUrl ?? 'http://127.0.0.1:8787',
      auditLogPath: source.server?.auditLogPath ?? 'logs/brain-server-audit.jsonl',
    },
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(localConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await removeDeepSeekWebConfig(configPath);
  await normalizePortableProviderConfig(configPath);

  console.log('Created LocalBrain config');
  console.log(`Config:         ${configPath}`);
  console.log(`OPENAI_API_KEY  ${localKey}`);
}

async function mergeConfigDefaults(configPath: string, sourcePath: string): Promise<void> {
  const current = JSON.parse(await readFile(configPath, 'utf8')) as BrainConfig;
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as BrainConfig;
  let changed = false;

  const providers = { ...current.providers };
  for (const [providerId, providerConfig] of Object.entries(source.providers)) {
    if (!providers[providerId]) {
      providers[providerId] = providerConfig;
      changed = true;
      continue;
    }

    const currentOptions = providers[providerId].options ?? {};
    const sourceOptions = providerConfig.options ?? {};
    const nextOptions = { ...currentOptions };
    let providerChanged = false;
    for (const [key, value] of Object.entries(sourceOptions)) {
      if (!(key in nextOptions)) {
        nextOptions[key] = value;
        providerChanged = true;
      }
    }
    if (providerChanged) {
      providers[providerId] = {
        ...providers[providerId],
        options: nextOptions,
      };
      changed = true;
    }
  }

  const nextModels = new Set(current.models ?? []);
  for (const model of source.models ?? []) {
    if (!nextModels.has(model)) {
      nextModels.add(model);
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  const nextConfig: BrainConfig = {
    ...current,
    providers,
    models: [...nextModels],
  };
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function normalizePortableProviderConfig(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as BrainConfig;
  let changed = false;

  for (const providerConfig of Object.values(config.providers ?? {})) {
    const options = providerConfig.options ?? {};
    if (providerConfig.type === 'claude-code-local') {
      const cliPath = typeof options.cliPath === 'string' ? options.cliPath : '';
      if (isClaudeManagedVersionPath(cliPath)) {
        delete options.cliPath;
        providerConfig.options = options;
        changed = true;
      }
      continue;
    }

    if (providerConfig.type === 'codex-chatgpt-local') {
      if (isUserHomePath(options.authPath, '.codex/auth.json')) {
        delete options.authPath;
        providerConfig.options = options;
        changed = true;
      }
      if (isKnownCodexCliPath(options.cliPath)) {
        delete options.cliPath;
        providerConfig.options = options;
        changed = true;
      }
      continue;
    }

    if (providerConfig.type === 'opencode-local') {
      if (isUserHomePath(options.cliPath, '.opencode/bin/opencode')) {
        delete options.cliPath;
        providerConfig.options = options;
        changed = true;
      }
      continue;
    }

    if (providerConfig.type === 'antigravity-local') {
      if (isUserHomePath(options.stateDbPath, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb')) {
        delete options.stateDbPath;
        providerConfig.options = options;
        changed = true;
      }
      if (isOldLocalBrainProjectPath(options.imageOutputDir) || isOldLocalBrainFileUri(options.workspaceUri)) {
        delete options.imageOutputDir;
        delete options.workspaceUri;
        providerConfig.options = options;
        changed = true;
      }
    }
  }

  if (changed) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function isClaudeManagedVersionPath(value: string): boolean {
  return value.includes('/Library/Application Support/Claude/claude-code/')
    && value.endsWith('/claude.app/Contents/MacOS/claude');
}

function isUserHomePath(value: unknown, suffix: string): boolean {
  return typeof value === 'string'
    && /^\/Users\/[^/]+\//.test(value)
    && value.endsWith(`/${suffix}`);
}

function isOldLocalBrainProjectPath(value: unknown): boolean {
  return typeof value === 'string' && /^\/Users\/[^/]+\/LocalBrain\//.test(value);
}

function isOldLocalBrainFileUri(value: unknown): boolean {
  return typeof value === 'string' && /^file:\/\/\/Users\/[^/]+\/LocalBrain/.test(value);
}

function isKnownCodexCliPath(value: unknown): boolean {
  return typeof value === 'string'
    && (
      value === '/opt/homebrew/bin/codex'
      || value === '/usr/local/bin/codex'
      || isUserHomePath(value, '.local/bin/codex')
      || isUserHomePath(value, '.npm-global/bin/codex')
    );
}

async function removeDeepSeekWebConfig(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as BrainConfig;
  let changed = false;

  for (const [providerId, providerConfig] of Object.entries(config.providers ?? {})) {
    if (providerId === 'deepseek-web-local' || providerConfig.type === 'deepseek-web-local') {
      delete config.providers[providerId];
      changed = true;
    }
  }

  const models = (config.models ?? []).filter((model) => !model.startsWith('deepseek-web/'));
  if (models.length !== (config.models ?? []).length) {
    config.models = models;
    changed = true;
  }

  if (config.defaultModel?.startsWith('deepseek-web/')) {
    config.defaultProvider = Object.keys(config.providers)[0] ?? 'mock-local';
    config.defaultModel = config.models?.[0] ?? '';
    changed = true;
  }

  for (const [taskKind, route] of Object.entries(config.routing ?? {})) {
    if (route?.providerId === 'deepseek-web-local' || route?.model?.startsWith('deepseek-web/')) {
      delete config.routing?.[taskKind as keyof typeof config.routing];
      changed = true;
    }
  }

  if (config.server?.modelProviderFilters?.['deepseek-web-local']) {
    delete config.server.modelProviderFilters['deepseek-web-local'];
    changed = true;
  }

  for (const [apiKey, route] of Object.entries(config.server?.apiKeyRoutes ?? {})) {
    if (route?.providerId === 'deepseek-web-local' || route?.model?.startsWith('deepseek-web/')) {
      delete config.server?.apiKeyRoutes?.[apiKey];
      changed = true;
    }
  }

  if (changed) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

main().catch((error: unknown) => {
  console.error('brain start failed');
  console.error(error);
  process.exitCode = 1;
});
