import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrainConfig } from '../modules/brain/index.ts';

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, '../..');
  const outputPath = process.argv[2] ?? path.join(projectRoot, 'logs', 'brain.local.config.json');
  const sourcePath = process.argv[3] ?? path.join(projectRoot, 'docs', 'brain.config.example.json');
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

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(localConfig, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  console.log(JSON.stringify({
    ok: true,
    sourcePath,
    configPath: outputPath,
    openAIBaseUrl: `${localConfig.server?.publicBaseUrl ?? 'http://127.0.0.1:8787'}/v1`,
    openAIAPIKey: localKey,
    startCommand: `npm run brain-server -- ${outputPath}`,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error('brain local init failed');
  console.error(error);
  process.exitCode = 1;
});
