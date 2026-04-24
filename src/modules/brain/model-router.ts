import type { BrainConfig, BrainRouteConfig, BrainTaskKind } from './types.ts';

export interface BrainRoute {
  providerId: string;
  model: string;
}

export class BrainModelRouter {
  private readonly config: BrainConfig;

  constructor(config: BrainConfig) {
    this.config = config;
  }

  route(taskKind: BrainTaskKind, overrides?: Partial<BrainRouteConfig>): BrainRoute {
    const configured = this.config.routing?.[taskKind];
    const model = overrides?.model ?? configured?.model ?? this.config.defaultModel;
    const providerId = overrides?.providerId
      ?? this.providerForModel(model)
      ?? configured?.providerId
      ?? this.config.defaultProvider;
    return { providerId, model };
  }

  private providerForModel(model: string): string | undefined {
    if (!model.startsWith('opencode/')) {
      return undefined;
    }

    return Object.entries(this.config.providers)
      .find(([_providerId, provider]) => provider.type === 'opencode-local' && provider.disabled !== true)?.[0];
  }
}
