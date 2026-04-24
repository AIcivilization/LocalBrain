import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBrainRuntimeFromConfig, loadBrainConfigFile, validateBrainConfig } from '../modules/brain/index.ts';

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, '../..');
  const configPath = process.argv[2] ?? path.join(projectRoot, 'docs', 'brain.config.example.json');
  const config = await loadBrainConfigFile(configPath);
  const validation = validateBrainConfig(config);

  let registeredProviders: string[] = [];
  if (validation.ok) {
    const { registry } = createBrainRuntimeFromConfig(config);
    registeredProviders = registry.list().map((provider) => provider.id);
  }

  console.log(JSON.stringify({
    ok: validation.ok,
    configPath,
    errors: validation.errors,
    warnings: validation.warnings,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    registeredProviders,
    routes: Object.keys(config.routing ?? {}),
  }, null, 2));

  if (!validation.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('brain config check failed');
  console.error(error);
  process.exitCode = 1;
});
