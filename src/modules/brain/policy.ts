import type {
  BrainConfig,
  BrainPolicyConfig,
  BrainPolicyDecision,
  BrainProvider,
  BrainProductRequest,
  BrainToolDefinition,
} from './types.ts';

const DEFAULT_POLICY: BrainPolicyConfig = {
  allowNetworkModelCalls: false,
  allowExperimentalSubscriptionLogin: false,
  allowProductStateInPrompt: true,
  requireToolAllowlist: false,
};

export function resolveBrainPolicy(config: BrainConfig): BrainPolicyConfig {
  return {
    ...DEFAULT_POLICY,
    ...config.policy,
  };
}

export function evaluateProviderPolicy(
  config: BrainConfig,
  provider: BrainProvider,
): BrainPolicyDecision[] {
  const policy = resolveBrainPolicy(config);
  const descriptor = provider.describe();
  const decisions: BrainPolicyDecision[] = [];

  if (!policy.allowNetworkModelCalls && !descriptor.localOnly) {
    decisions.push({
      allowed: false,
      code: 'network-model-calls-disabled',
      reason: `provider ${provider.id} is not local-only and network model calls are disabled`,
    });
  }

  if (descriptor.kind === 'chatgpt-subscription-experimental' && !policy.allowExperimentalSubscriptionLogin) {
    decisions.push({
      allowed: false,
      code: 'experimental-subscription-login-disabled',
      reason: 'ChatGPT subscription login adapters are disabled for this brain configuration',
    });
  }

  if (decisions.length === 0) {
    decisions.push({
      allowed: true,
      code: 'provider-policy-allowed',
      reason: `provider ${provider.id} is allowed`,
    });
  }

  return decisions;
}

export function evaluateRequestPolicy(
  config: BrainConfig,
  request: BrainProductRequest,
): BrainPolicyDecision[] {
  const policy = resolveBrainPolicy(config);
  const decisions: BrainPolicyDecision[] = [];

  if (!request.input.trim()) {
    decisions.push({
      allowed: false,
      code: 'empty-input',
      reason: 'request.input must not be empty',
    });
  }

  if (!policy.allowProductStateInPrompt && request.appContext?.state) {
    decisions.push({
      allowed: false,
      code: 'product-state-in-prompt-disabled',
      reason: 'appContext.state was supplied but product state injection is disabled',
    });
  }

  if (decisions.length === 0) {
    decisions.push({
      allowed: true,
      code: 'request-policy-allowed',
      reason: 'request is allowed',
    });
  }

  return decisions;
}

export function filterToolsByPolicy(
  config: BrainConfig,
  tools: BrainToolDefinition[],
): { tools: BrainToolDefinition[]; decisions: BrainPolicyDecision[] } {
  const toolPolicy = config.tools ?? { enabled: false };

  if (!toolPolicy.enabled) {
    return {
      tools: [],
      decisions: [
        {
          allowed: true,
          code: 'tools-disabled',
          reason: 'tool use is disabled for this brain configuration',
        },
      ],
    };
  }

  const allowlist = new Set(toolPolicy.allowlist ?? []);
  const denylist = new Set(toolPolicy.denylist ?? []);
  const requireAllowlist = config.policy?.requireToolAllowlist ?? false;
  const allowedTools: BrainToolDefinition[] = [];
  const decisions: BrainPolicyDecision[] = [];

  for (const tool of tools) {
    if (denylist.has(tool.name)) {
      decisions.push({
        allowed: false,
        code: 'tool-denied',
        reason: `tool ${tool.name} is denied`,
      });
      continue;
    }

    if ((requireAllowlist || allowlist.size > 0) && !allowlist.has(tool.name)) {
      decisions.push({
        allowed: false,
        code: 'tool-not-allowlisted',
        reason: `tool ${tool.name} is not allowlisted`,
      });
      continue;
    }

    allowedTools.push(tool);
  }

  decisions.push({
    allowed: true,
    code: 'tool-policy-applied',
    reason: `${allowedTools.length} tool(s) allowed`,
  });

  return { tools: allowedTools, decisions };
}

export function assertPolicyAllowed(decisions: BrainPolicyDecision[]): void {
  const blockers = decisions.filter((decision) => !decision.allowed);
  if (blockers.length === 0) {
    return;
  }

  const message = blockers.map((blocker) => `${blocker.code}: ${blocker.reason}`).join('; ');
  throw new Error(`brain policy blocked request: ${message}`);
}
