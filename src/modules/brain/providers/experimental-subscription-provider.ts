import type {
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';

export class ExperimentalSubscriptionBrainProvider implements BrainProvider {
  readonly kind = 'chatgpt-subscription-experimental' as const;
  readonly id: string;

  constructor(id = 'chatgpt-subscription-local-experimental') {
    this.id = id;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: 'ChatGPT Subscription Local Experimental Adapter',
      supportsStreaming: false,
      supportsTools: false,
      localOnly: false,
      experimental: true,
    };
  }

  async generate(_request: BrainProviderRequest): Promise<BrainProviderResponse> {
    throw new Error(
      'experimental subscription provider is an adapter boundary only; wire a local test implementation outside product code',
    );
  }
}
