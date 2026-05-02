import type {
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
  BrainToolCall,
} from '../types.ts';

export interface OpenAICompatibleBrainProviderOptions {
  id: string;
  kind?: 'openai-api-key' | 'vercel-ai-sdk';
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  displayName?: string;
  localOnly?: boolean;
  experimental?: boolean;
}

interface OpenAICompatibleResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIModelsResponse {
  data?: Array<{
    id?: string;
    object?: string;
    owned_by?: string;
  }>;
}

export class OpenAICompatibleBrainProvider implements BrainProvider {
  readonly id: string;
  readonly kind: 'openai-api-key' | 'vercel-ai-sdk';
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyEnv?: string;
  private readonly displayName: string;
  private readonly localOnly: boolean;
  private readonly experimental: boolean;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: OpenAICompatibleBrainProviderOptions) {
    this.id = options.id;
    this.kind = options.kind ?? 'openai-api-key';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.apiKeyEnv = options.apiKeyEnv;
    this.displayName = options.displayName ?? 'OpenAI-Compatible Brain Provider';
    this.localOnly = options.localOnly ?? (
      this.baseUrl.startsWith('http://127.0.0.1') || this.baseUrl.startsWith('http://localhost')
    );
    this.experimental = options.experimental ?? false;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      supportsStreaming: false,
      supportsTools: true,
      localOnly: this.localOnly,
      experimental: this.experimental,
    };
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    const apiKey = this.resolveApiKey();

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
          name: message.name,
        })),
        temperature: request.temperature,
        max_completion_tokens: request.maxOutputTokens,
        tools: request.tools.length > 0 ? request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? {
              type: 'object',
              properties: {},
            },
          },
        })) : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI-compatible provider ${this.id} failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as OpenAICompatibleResponse;
    const choice = payload.choices?.[0];
    const message = choice?.message;
    const toolCalls = parseToolCalls(message?.tool_calls ?? []);
    const content = message?.content ?? '';

    return {
      providerId: this.id,
      model: payload.model ?? request.model,
      message: {
        role: 'assistant',
        content,
      },
      toolCalls,
      finishReason: choice?.finish_reason === 'length'
        ? 'length'
        : toolCalls.length > 0
          ? 'tool-calls'
          : 'stop',
      usage: {
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens,
      },
      raw: payload,
    };
  }

  async listModels(): Promise<BrainModelDescriptor[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    const apiKey = this.resolveApiKey();

    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI-compatible provider ${this.id} model discovery failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as OpenAIModelsResponse;
    const models = (payload.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({
        id,
        providerId: this.id,
        displayName: id,
      }));

    this.modelCache = {
      expiresAt: now + 60_000,
      models,
    };
    return models;
  }

  private resolveApiKey(): string {
    const apiKey = this.apiKey ?? (this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined);
    if (!apiKey) {
      const source = this.apiKeyEnv ? `env ${this.apiKeyEnv}` : 'stored provider apiKey';
      throw new Error(`missing API key for OpenAI-compatible provider ${this.id}: ${source}`);
    }
    return apiKey;
  }
}

function parseToolCalls(toolCalls: NonNullable<OpenAICompatibleResponse['choices']>[number]['message']['tool_calls']): BrainToolCall[] {
  return toolCalls.map((toolCall, index) => {
    const argsText = toolCall.function?.arguments ?? '{}';
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {
        raw: argsText,
      };
    }

    return {
      id: toolCall.id ?? `tool-call-${index}`,
      name: toolCall.function?.name ?? 'unknown',
      arguments: args,
    };
  });
}
