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

main().catch((error: unknown) => {
  console.error('brain start failed');
  console.error(error);
  process.exitCode = 1;
});
