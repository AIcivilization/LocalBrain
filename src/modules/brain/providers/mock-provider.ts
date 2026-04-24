import type {
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
  BrainToolCall,
} from '../types.ts';

export class MockBrainProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'mock' as const;

  constructor(id = 'mock-local') {
    this.id = id;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: 'Mock Local Brain Provider',
      supportsStreaming: false,
      supportsTools: true,
      localOnly: true,
      experimental: false,
    };
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    const latestUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const toolCalls = this.extractToolCalls(latestUser?.content ?? '', request.tools.map((tool) => tool.name));
    const content = [
      `mock:${request.taskKind}`,
      `model:${request.model}`,
      `input:${latestUser?.content ?? ''}`,
      toolCalls.length > 0 ? `toolCalls:${toolCalls.map((call) => call.name).join(',')}` : 'toolCalls:none',
    ].join('\n');

    return {
      providerId: this.id,
      model: request.model,
      message: {
        role: 'assistant',
        content,
      },
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
      usage: {
        inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
        outputTokens: content.length,
      },
    };
  }

  private extractToolCalls(input: string, toolNames: string[]): BrainToolCall[] {
    const calls: BrainToolCall[] = [];
    const match = input.match(/use-tool:([a-zA-Z0-9_-]+)/);
    if (!match) {
      return calls;
    }

    const name = match[1];
    if (!toolNames.includes(name)) {
      return calls;
    }

    calls.push({
      id: `mock-tool-${Date.now()}`,
      name,
      arguments: {
        input,
      },
    });

    return calls;
  }
}
