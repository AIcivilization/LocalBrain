import type { BrainProvider } from './types.ts';

export class BrainProviderRegistry {
  private readonly providers = new Map<string, BrainProvider>();

  register(provider: BrainProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`brain provider already registered: ${provider.id}`);
    }

    this.providers.set(provider.id, provider);
  }

  get(providerId: string): BrainProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`brain provider not registered: ${providerId}`);
    }

    return provider;
  }

  list(): BrainProvider[] {
    return [...this.providers.values()];
  }
}
