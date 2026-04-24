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
    const providerId = overrides?.providerId ?? configured?.providerId ?? this.config.defaultProvider;
    const model = overrides?.model ?? configured?.model ?? this.config.defaultModel;
    return { providerId, model };
  }
}
