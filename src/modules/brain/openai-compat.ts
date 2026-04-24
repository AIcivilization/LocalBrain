import type {
  BrainMessage,
  BrainProductRequest,
  BrainProductResponse,
  BrainTaskKind,
} from './types.ts';
import type { BrainProviderRegistry } from './provider-registry.ts';

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages?: Array<{
    role: string;
    content?: unknown;
    name?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  user?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenAIResponsesRequest {
  model?: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  metadata?: Record<string, unknown>;
}

export function openAIChatToBrainRequest(body: OpenAIChatCompletionRequest): BrainProductRequest {
  const messages = body.messages ?? [];
  const normalized = messages.map((message) => ({
    role: normalizeMessageRole(message.role),
    content: normalizeContent(message.content),
    name: message.name,
  }));
  const systemPrompt = normalized
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n') || undefined;
  const nonSystem = normalized.filter((message) => message.role !== 'system');
  const latestUserIndex = findLatestUserIndex(nonSystem);
  const latestUser = latestUserIndex >= 0 ? nonSystem[latestUserIndex] : nonSystem[nonSystem.length - 1];
  const priorMessages = latestUserIndex >= 0
    ? nonSystem.filter((_message, index) => index !== latestUserIndex)
    : nonSystem.slice(0, -1);

  return {
    input: latestUser?.content ?? '',
    taskKind: 'chat',
    model: body.model,
    temperature: body.temperature,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    systemPrompt,
    session: {
      sessionId: body.user ?? 'openai-compatible-session',
      messages: priorMessages,
    },
    appContext: {
      productName: 'openai-compatible-client',
      surface: 'v1/chat/completions',
      userId: body.user,
      state: body.metadata,
    },
    metadata: {
      ...body.metadata,
      openaiCompat: true,
    },
  };
}

export function openAIResponsesToBrainRequest(body: OpenAIResponsesRequest): BrainProductRequest {
  return {
    input: normalizeContent(body.input),
    taskKind: 'chat',
    model: body.model,
    temperature: body.temperature,
    maxOutputTokens: body.max_output_tokens,
    systemPrompt: body.instructions,
    appContext: {
      productName: 'openai-compatible-client',
      surface: 'v1/responses',
      state: body.metadata,
    },
    metadata: {
      ...body.metadata,
      openaiCompat: true,
      responsesApi: true,
    },
  };
}

export function brainToOpenAIChatCompletion(response: BrainProductResponse): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${response.runId}`,
    object: 'chat.completion',
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: response.message.content,
        },
        finish_reason: toOpenAIFinishReason(response.finishReason),
      },
    ],
    usage: {
      prompt_tokens: response.usage?.inputTokens ?? 0,
      completion_tokens: response.usage?.outputTokens ?? 0,
      total_tokens: response.usage?.totalTokens ?? (
        (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0)
      ),
    },
    brain: {
      runId: response.runId,
      providerId: response.providerId,
      toolResults: response.toolResults,
    },
  };
}

export function brainToOpenAIChatStreamChunks(response: BrainProductResponse): string[] {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${response.runId}`;
  const first = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
        },
        finish_reason: null,
      },
    ],
  };
  const content = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {
          content: response.message.content,
        },
        finish_reason: null,
      },
    ],
  };
  const last = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: toOpenAIFinishReason(response.finishReason),
      },
    ],
  };

  return [first, content, last].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).concat('data: [DONE]\n\n');
}

export function brainToOpenAIResponse(response: BrainProductResponse): Record<string, unknown> {
  return {
    id: `resp-${response.runId}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: response.model,
    output: [
      {
        id: `msg-${response.runId}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: response.message.content,
          },
        ],
      },
    ],
    output_text: response.message.content,
    usage: {
      input_tokens: response.usage?.inputTokens ?? 0,
      output_tokens: response.usage?.outputTokens ?? 0,
      total_tokens: response.usage?.totalTokens ?? (
        (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0)
      ),
    },
    brain: {
      runId: response.runId,
      providerId: response.providerId,
      toolResults: response.toolResults,
    },
  };
}

export function modelsResponse(
  registry: BrainProviderRegistry,
  defaultModel: string,
  availableModels: string[] = [defaultModel],
): Record<string, unknown> {
  const providerModels = registry.list().flatMap((provider) => availableModels.map((model) => ({
    id: `${provider.id}/${model}`,
    object: 'model',
    created: 0,
    owned_by: provider.id,
  })));

  return {
    object: 'list',
    data: [
      ...availableModels.map((model) => ({
        id: model,
        object: 'model',
        created: 0,
        owned_by: model === defaultModel ? 'brain-default' : 'brain',
      })),
      ...providerModels,
    ],
  };
}

function findLatestUserIndex(messages: BrainMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return index;
    }
  }
  return -1;
}

function normalizeMessageRole(role: string): BrainMessage['role'] {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role;
  }
  return 'user';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return JSON.stringify(part);
    }).join('\n');
  }

  if (content === undefined || content === null) {
    return '';
  }

  return JSON.stringify(content);
}

function toOpenAIFinishReason(reason: string): string {
  if (reason === 'length') {
    return 'length';
  }
  if (reason === 'tool-calls') {
    return 'tool_calls';
  }
  if (reason === 'error') {
    return 'stop';
  }
  return 'stop';
}
