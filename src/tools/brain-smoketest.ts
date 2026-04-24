import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBrainRuntimeFromConfig, loadBrainConfigFile, validateBrainConfig } from '../modules/brain/index.ts';
import type { BrainToolDefinition } from '../modules/brain/index.ts';

const echoTool: BrainToolDefinition = {
  name: 'echo',
  description: 'Returns the received input for smoke testing.',
  async execute(args, context) {
    return {
      callId: 'echo-result',
      name: 'echo',
      ok: true,
      content: JSON.stringify({
        args,
        runId: context.runId,
        taskKind: context.taskKind,
      }),
    };
  },
};

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, '../..');
  const configPath = path.join(projectRoot, 'docs', 'brain.config.example.json');
  const config = await loadBrainConfigFile(configPath);
  const validation = validateBrainConfig(config);
  if (!validation.ok) {
    throw new Error(`brain config validation failed: ${validation.errors.join('; ')}`);
  }

  const { runtime: brain, registry } = createBrainRuntimeFromConfig(config);
  const response = await brain.run({
    input: '请用大脑模块响应，并 use-tool:echo',
    taskKind: 'tool-use',
    systemPrompt: 'You are a local smoke test brain.',
    appContext: {
      productName: 'SubtleBalanceCore',
      surface: 'brain-smoketest',
      locale: 'zh-CN',
      constraints: ['local-only', 'no-network'],
      state: {
        mode: 'test',
      },
    },
    tools: [echoTool],
  });

  console.log(JSON.stringify({
    ok: true,
    providerId: response.providerId,
    model: response.model,
    finishReason: response.finishReason,
    message: response.message.content,
    toolResults: response.toolResults,
    sessionMessageCount: response.session.messages.length,
    policyCodes: response.audit.policyDecisions.map((decision) => decision.code),
    registeredProviders: registry.list().map((provider) => provider.id),
    configWarnings: validation.warnings,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error('brain smoketest failed');
  console.error(error);
  process.exitCode = 1;
});
