import { randomUUID } from 'node:crypto';

import { BrainContextBuilder } from './context-builder.ts';
import { BrainModelRouter } from './model-router.ts';
import { assertPolicyAllowed, evaluateProviderPolicy, evaluateRequestPolicy, filterToolsByPolicy } from './policy.ts';
import { BrainProviderRegistry } from './provider-registry.ts';
import { normalizeProviderResponse } from './provider-response.ts';
import { BrainToolBridge } from './tool-bridge.ts';
import type {
  BrainConfig,
  BrainProductRequest,
  BrainProductResponse,
  BrainSessionState,
} from './types.ts';

export class BrainRuntime {
  private readonly config: BrainConfig;
  private readonly providers: BrainProviderRegistry;
  private readonly router: BrainModelRouter;
  private readonly contextBuilder = new BrainContextBuilder();
  private readonly toolBridge: BrainToolBridge;

  constructor(
    config: BrainConfig,
    providers: BrainProviderRegistry,
  ) {
    this.config = config;
    this.providers = providers;
    this.router = new BrainModelRouter(config);
    this.toolBridge = new BrainToolBridge(config.tools?.maxToolCalls ?? 4);
  }

  async run(request: BrainProductRequest): Promise<BrainProductResponse> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const taskKind = request.taskKind ?? 'chat';
    const route = this.router.route(taskKind, {
      providerId: request.providerId,
      model: request.model,
    });
    const provider = this.providers.get(route.providerId);
    const requestPolicy = evaluateRequestPolicy(this.config, request);
    const providerPolicy = evaluateProviderPolicy(this.config, provider);
    const filteredTools = filterToolsByPolicy(this.config, request.tools ?? []);
    const policyDecisions = [
      ...requestPolicy,
      ...providerPolicy,
      ...filteredTools.decisions,
    ];

    assertPolicyAllowed(policyDecisions);

    const messages = this.contextBuilder.build(request);
    const rawProviderResponse = await provider.generate({
      taskKind,
      model: route.model,
      messages,
      tools: filteredTools.tools,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      metadata: request.metadata,
    });
    const providerResponse = normalizeProviderResponse(rawProviderResponse, provider.id, route.model);

    const toolResults = await this.toolBridge.executeToolCalls(providerResponse.toolCalls, filteredTools.tools, {
      runId,
      sessionId: request.session?.sessionId,
      taskKind,
    });

    const session = this.buildNextSession(request, providerResponse.message);
    const finishedAt = new Date().toISOString();

    return {
      runId,
      providerId: providerResponse.providerId,
      model: providerResponse.model,
      message: providerResponse.message,
      toolResults,
      session,
      finishReason: providerResponse.finishReason,
      usage: providerResponse.usage,
      audit: {
        startedAt,
        finishedAt,
        taskKind,
        providerId: providerResponse.providerId,
        model: providerResponse.model,
        policyDecisions,
        toolCalls: providerResponse.toolCalls,
        toolResults,
        notes: [
          `provider=${provider.describe().displayName}`,
          `messages=${messages.length}`,
        ],
      },
    };
  }

  private buildNextSession(
    request: BrainProductRequest,
    assistantMessage: BrainProductResponse['message'],
  ): BrainSessionState {
    if (this.config.memory?.mode === 'none') {
      return {
        sessionId: request.session?.sessionId ?? randomUUID(),
        messages: [],
        metadata: request.session?.metadata,
      };
    }

    const maxSessionMessages = this.config.memory?.maxSessionMessages ?? 20;
    const priorMessages = request.session?.messages ?? [];
    const nextMessages = [
      ...priorMessages,
      {
        role: 'user' as const,
        content: request.input,
        metadata: request.metadata,
      },
      assistantMessage,
    ].slice(-maxSessionMessages);

    return {
      sessionId: request.session?.sessionId ?? randomUUID(),
      messages: nextMessages,
      summary: request.session?.summary,
      metadata: request.session?.metadata,
    };
  }
}
