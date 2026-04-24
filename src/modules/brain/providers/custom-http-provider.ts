import type {
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';
import { normalizeProviderResponse } from '../provider-response.ts';

export interface CustomHttpBrainProviderOptions {
  id: string;
  endpoint: string;
  displayName?: string;
  apiKeyEnv?: string;
  localOnly?: boolean;
  experimental?: boolean;
}

export class CustomHttpBrainProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'custom-http' as const;
  private readonly endpoint: string;
  private readonly displayName: string;
  private readonly apiKeyEnv?: string;
  private readonly localOnly: boolean;
  private readonly experimental: boolean;

  constructor(options: CustomHttpBrainProviderOptions) {
    this.id = options.id;
    this.endpoint = options.endpoint;
    this.displayName = options.displayName ?? 'Custom HTTP Brain Provider';
    this.apiKeyEnv = options.apiKeyEnv;
    this.localOnly = options.localOnly ?? (
      this.endpoint.startsWith('http://127.0.0.1') || this.endpoint.startsWith('http://localhost')
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
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.apiKeyEnv) {
      const apiKey = process.env[this.apiKeyEnv];
      if (!apiKey) {
        throw new Error(`missing API key env for custom HTTP brain provider: ${this.apiKeyEnv}`);
      }
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`custom HTTP brain provider failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as BrainProviderResponse;
    return normalizeProviderResponse(payload, this.id, request.model);
  }
}
