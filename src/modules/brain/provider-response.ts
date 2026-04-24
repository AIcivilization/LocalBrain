import type { BrainProviderResponse } from './types.ts';

const FINISH_REASONS = new Set(['stop', 'length', 'tool-calls', 'error']);
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

export function normalizeProviderResponse(
  response: BrainProviderResponse,
  fallbackProviderId: string,
  fallbackModel: string,
): BrainProviderResponse {
  const providerId = response.providerId || fallbackProviderId;
  const model = response.model || fallbackModel;
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  const finishReason = FINISH_REASONS.has(response.finishReason) ? response.finishReason : 'stop';

  if (!response.message || typeof response.message.content !== 'string') {
    throw new Error('provider response must include message.content');
  }

  if (!MESSAGE_ROLES.has(response.message.role)) {
    throw new Error(`provider response message has unsupported role: ${response.message.role}`);
  }

  for (const call of toolCalls) {
    if (!call.id || !call.name || typeof call.arguments !== 'object' || call.arguments === null) {
      throw new Error('provider response contains an invalid tool call');
    }
  }

  return {
    ...response,
    providerId,
    model,
    toolCalls,
    finishReason,
  };
}
