export type BrainRole = 'system' | 'user' | 'assistant' | 'tool';

export type BrainTaskKind =
  | 'chat'
  | 'code'
  | 'structured-output'
  | 'tool-use'
  | 'fast'
  | 'vision'
  | 'image';

export type BrainProviderKind =
  | 'mock'
  | 'openai-api-key'
  | 'vercel-ai-sdk'
  | 'custom-http'
  | 'opencode-local'
  | 'codex-chatgpt-local'
  | 'chatgpt-subscription-experimental';

export type BrainFinishReason = 'stop' | 'length' | 'tool-calls' | 'error';

export interface BrainMessage {
  role: BrainRole;
  content: string;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface BrainToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BrainToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface BrainUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface BrainProviderRequest {
  taskKind: BrainTaskKind;
  model: string;
  messages: BrainMessage[];
  tools: BrainToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface BrainProviderResponse {
  providerId: string;
  model: string;
  message: BrainMessage;
  toolCalls: BrainToolCall[];
  finishReason: BrainFinishReason;
  usage?: BrainUsage;
  raw?: unknown;
}

export interface BrainProvider {
  id: string;
  kind: BrainProviderKind;
  describe(): BrainProviderDescriptor;
  generate(request: BrainProviderRequest): Promise<BrainProviderResponse>;
  listModels?(): Promise<BrainModelDescriptor[]>;
}

export interface BrainProviderDescriptor {
  id: string;
  kind: BrainProviderKind;
  displayName: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
  localOnly: boolean;
  experimental: boolean;
}

export interface BrainModelDescriptor {
  id: string;
  providerId?: string;
  displayName?: string;
  free?: boolean;
}

export interface BrainToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: BrainToolExecutor;
}

export type BrainToolExecutor = (
  args: Record<string, unknown>,
  context: BrainToolExecutionContext,
) => Promise<BrainToolResult>;

export interface BrainToolExecutionContext {
  runId: string;
  sessionId?: string;
  taskKind: BrainTaskKind;
  signal?: AbortSignal;
}

export interface BrainSessionState {
  sessionId: string;
  messages: BrainMessage[];
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface BrainProductRequest {
  input: string;
  taskKind?: BrainTaskKind;
  session?: BrainSessionState;
  systemPrompt?: string;
  appContext?: BrainAppContext;
  tools?: BrainToolDefinition[];
  model?: string;
  providerId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface BrainAppContext {
  productName: string;
  surface: string;
  userId?: string;
  locale?: string;
  state?: Record<string, unknown>;
  constraints?: string[];
}

export interface BrainProductResponse {
  runId: string;
  providerId: string;
  model: string;
  message: BrainMessage;
  toolResults: BrainToolResult[];
  session: BrainSessionState;
  finishReason: BrainFinishReason;
  usage?: BrainUsage;
  audit: BrainRunAudit;
}

export interface BrainRunAudit {
  startedAt: string;
  finishedAt: string;
  taskKind: BrainTaskKind;
  providerId: string;
  model: string;
  policyDecisions: BrainPolicyDecision[];
  toolCalls: BrainToolCall[];
  toolResults: BrainToolResult[];
  notes: string[];
}

export interface BrainConfig {
  defaultProvider: string;
  defaultModel: string;
  models?: string[];
  providers: Record<string, BrainProviderConfig>;
  server?: BrainServerConfig;
  routing?: Partial<Record<BrainTaskKind, BrainRouteConfig>>;
  tools?: BrainToolPolicyConfig;
  memory?: BrainMemoryConfig;
  policy?: BrainPolicyConfig;
}

export interface BrainServerConfig {
  host: string;
  port: number;
  apiKeys: string[];
  apiKeyRoutes?: Record<string, {
    providerId?: string;
    model: string;
  }>;
  modelProviderFilters?: Record<string, {
    enabled?: boolean;
    freeOnly?: boolean;
  }>;
  requireAuth: boolean;
  publicBaseUrl?: string;
  auditLogPath?: string;
}

export interface BrainRouteConfig {
  providerId?: string;
  model: string;
}

export interface BrainProviderConfig {
  type: BrainProviderKind;
  displayName?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  localOnly?: boolean;
  experimental?: boolean;
  disabled?: boolean;
  options?: Record<string, unknown>;
}

export interface BrainToolPolicyConfig {
  enabled: boolean;
  allowlist?: string[];
  denylist?: string[];
  maxToolCalls?: number;
}

export interface BrainMemoryConfig {
  mode: 'none' | 'session' | 'external';
  maxSessionMessages?: number;
}

export interface BrainPolicyConfig {
  allowNetworkModelCalls: boolean;
  allowExperimentalSubscriptionLogin: boolean;
  allowProductStateInPrompt: boolean;
  requireToolAllowlist: boolean;
}

export interface BrainPolicyDecision {
  allowed: boolean;
  code: string;
  reason: string;
}

export interface BrainConfigValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
