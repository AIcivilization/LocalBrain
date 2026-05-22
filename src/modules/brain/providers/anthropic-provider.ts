import type {
  BrainMessage,
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicBrainProviderOptions {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  displayName?: string;
  localOnly?: boolean;
  experimental?: boolean;
  anthropicVersion?: string;
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicModelsResponse {
  data?: Array<{
    id?: string;
    display_name?: string;
    type?: string;
  }>;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AnthropicBrainProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'anthropic-api-key' as const;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyEnv?: string;
  private readonly displayName: string;
  private readonly localOnly: boolean;
  private readonly experimental: boolean;
  private readonly anthropicVersion: string;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: AnthropicBrainProviderOptions) {
    this.id = options.id;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.apiKeyEnv = options.apiKeyEnv;
    this.displayName = options.displayName ?? 'Claude / Anthropic';
    this.localOnly = options.localOnly ?? false;
    this.experimental = options.experimental ?? false;
    this.anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      supportsStreaming: false,
      supportsTools: false,
      localOnly: this.localOnly,
      experimental: this.experimental,
    };
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    const apiKey = this.resolveApiKey();
    const converted = convertMessages(request.messages);

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': this.anthropicVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: Math.max(1, request.maxOutputTokens ?? 4096),
        temperature: request.temperature,
        system: converted.system || undefined,
        messages: converted.messages,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude provider ${this.id} failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as AnthropicMessageResponse;
    const content = (payload.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');

    const inputTokens = payload.usage?.input_tokens;
    const outputTokens = payload.usage?.output_tokens;
    return {
      providerId: this.id,
      model: payload.model ?? request.model,
      message: {
        role: 'assistant',
        content,
      },
      toolCalls: [],
      finishReason: payload.stop_reason === 'max_tokens' ? 'length' : 'stop',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: typeof inputTokens === 'number' && typeof outputTokens === 'number'
          ? inputTokens + outputTokens
          : undefined,
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
        'x-api-key': apiKey,
        'anthropic-version': this.anthropicVersion,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude provider ${this.id} model discovery failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as AnthropicModelsResponse;
    const models = (payload.data ?? [])
      .map((model) => ({
        id: model.id,
        displayName: model.display_name ?? model.id,
      }))
      .filter((model): model is { id: string; displayName: string } => (
        typeof model.id === 'string' && model.id.length > 0
      ))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((model) => ({
        id: model.id,
        providerId: this.id,
        displayName: model.displayName,
        free: false,
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
      throw new Error(`missing API key for Claude provider ${this.id}: ${source}`);
    }
    return apiKey;
  }
}

function convertMessages(messages: BrainMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const converted: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }

    if (message.role === 'assistant') {
      converted.push({
        role: 'assistant',
        content: message.content || ' ',
      });
      continue;
    }

    if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: `Tool result${message.name ? ` (${message.name})` : ''}: ${message.content}`,
      });
      continue;
    }

    converted.push({
      role: 'user',
      content: message.content || ' ',
    });
  }

  return {
    system: system.join('\n\n'),
    messages: converted.length > 0 ? converted : [{ role: 'user', content: ' ' }],
  };
}
