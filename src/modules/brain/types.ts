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
  | 'anthropic-api-key'
  | 'claude-code-local'
  | 'vercel-ai-sdk'
  | 'custom-http'
  | 'opencode-local'
  | 'antigravity-local'
  | 'deepseek-web-local'
  | 'codex-chatgpt-local'
  | 'agent-cli-local'
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

export interface BrainImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  metadata?: Record<string, unknown>;
}

export interface BrainImageGenerationResponse {
  providerId: string;
  model: string;
  images: BrainGeneratedImage[];
  raw?: unknown;
}

export interface BrainGeneratedImage {
  path?: string;
  url?: string;
  b64Json?: string;
  mimeType?: string;
  revisedPrompt?: string;
}

export interface BrainProvider {
  id: string;
  kind: BrainProviderKind;
  describe(): BrainProviderDescriptor;
  generate(request: BrainProviderRequest): Promise<BrainProviderResponse>;
  generateImage?(request: BrainImageGenerationRequest): Promise<BrainImageGenerationResponse>;
  listModels?(): Promise<BrainModelDescriptor[]>;
  // Reports why the provider is or is not usable. Must be cheap: it reads what
  // the last discovery already learned rather than probing again, so the UI can
  // ask for it on every refresh.
  checkStatus?(): BrainProviderStatus;
}

// What a provider needs present on this machine before it can answer. The shape
// of that dependency is what makes each provider fail differently, so naming it
// lets one piece of UI explain all of them.
export type BrainProviderDependencyKind =
  | 'none'
  | 'cli'
  | 'local-service'
  | 'credential-file'
  | 'api-key';

export interface BrainProviderDependency {
  kind: BrainProviderDependencyKind;
  // What to look for, e.g. `codebuddy` or `Antigravity language server`.
  name: string;
  path?: string;
  found: boolean;
}

// A state rather than a sentence: the menu bar renders in two languages, so the
// wording belongs to the UI and only the classification travels.
export type BrainProviderState =
  | 'ready'
  | 'signed-out'
  | 'missing-dependency'
  | 'error'
  | 'unknown';

export interface BrainProviderStatus {
  providerId: string;
  state: BrainProviderState;
  dependency?: BrainProviderDependency;
  modelCount?: number;
  checkedAt?: string;
  // The vendor CLI's own words. Untranslatable, and worth showing verbatim
  // because it usually names the exact command that fixes the problem.
  error?: string;
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
  apiKeyLabels?: Record<string, string>;
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
  autoHealthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
  };
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
