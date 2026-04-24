import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrainServer, createBrainRuntimeFromConfig, loadBrainConfigFile, validateBrainConfig } from '../modules/brain/index.ts';

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, '../..');
  const configPath = process.argv[2] ?? path.join(projectRoot, 'docs', 'brain.config.example.json');
  const config = await loadBrainConfigFile(configPath);
  const validation = validateBrainConfig(config);

  if (!validation.ok) {
    throw new Error(`brain config validation failed: ${validation.errors.join('; ')}`);
  }

  const { runtime, registry } = createBrainRuntimeFromConfig(config);
  const server = new BrainServer({ config, configPath, runtime, registry });
  await server.listen();

  console.log(JSON.stringify({
    ok: true,
    service: 'brain-server',
    url: server.url(),
    openAIBaseUrl: `${server.url()}/v1`,
    defaultModel: config.defaultModel,
    providers: registry.list().map((provider) => provider.id),
    warnings: validation.warnings,
  }, null, 2));

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

main().catch((error: unknown) => {
  console.error('brain server failed');
  console.error(error);
  process.exitCode = 1;
});
