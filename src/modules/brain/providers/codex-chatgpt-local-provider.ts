import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  BrainMessage,
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';

const execFileAsync = promisify(execFile);

interface CodexAuthJson {
  auth_mode?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface JwtClaims {
  aud?: string | string[];
  exp?: number;
  iat?: number;
  azp?: string;
  account_id?: string;
  chatgpt_account_id?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface CodexModelCatalog {
  models?: CodexCatalogModel[];
}

interface CodexCatalogModel {
  slug?: string;
  display_name?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
}

export interface CodexChatGptLocalProviderOptions {
  id: string;
  authPath?: string;
  endpoint?: string;
  cliPath?: string;
  clientId?: string;
  displayName?: string;
  refreshSkewSeconds?: number;
  userAgent?: string;
  modelCacheTtlMs?: number;
}

const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

export class CodexChatGptLocalProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'codex-chatgpt-local' as const;
  private readonly authPath: string;
  private readonly endpoint: string;
  private readonly cliPath: string;
  private readonly clientId: string;
  private readonly displayName: string;
  private readonly refreshSkewSeconds: number;
  private readonly userAgent: string;
  private readonly modelCacheTtlMs: number;
  private refreshInFlight?: Promise<CodexAuthJson>;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: CodexChatGptLocalProviderOptions) {
    this.id = options.id;
    this.authPath = options.authPath ?? path.join(os.homedir(), '.codex', 'auth.json');
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.cliPath = options.cliPath ?? 'codex';
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.displayName = options.displayName ?? 'Codex ChatGPT Local Provider';
    this.refreshSkewSeconds = options.refreshSkewSeconds ?? 300;
    this.userAgent = options.userAgent ?? 'brain-local-codex-provider/0.1';
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? 60_000;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      supportsStreaming: false,
      supportsTools: false,
      localOnly: false,
      experimental: true,
    };
  }

  async listModels(): Promise<BrainModelDescriptor[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    const { stdout } = await execFileAsync(this.cliPath, ['debug', 'models'], {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const catalog = JSON.parse(stdout) as CodexModelCatalog;
    const models = (catalog.models ?? [])
      .filter((model) => typeof model.slug === 'string' && model.slug.length > 0)
      .filter((model) => model.visibility !== 'hide')
      .sort((left, right) => (left.priority ?? 999) - (right.priority ?? 999))
      .map((model) => ({
        id: model.slug as string,
        providerId: this.id,
        displayName: model.display_name ?? model.slug,
      }));

    this.modelCache = {
      expiresAt: now + this.modelCacheTtlMs,
      models,
    };
    return models;
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    const auth = await this.loadFreshAuth();
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id ?? extractAccountId(accessToken);
    if (!accessToken) {
      throw new Error(`Codex auth at ${this.authPath} does not contain an access token`);
    }
    if (!accountId) {
      throw new Error(`Codex auth at ${this.authPath} does not contain a ChatGPT account id`);
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'openai-beta': 'responses=experimental',
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/',
        originator: 'codex_cli_rs',
        version: '0.124.0',
        session_id: randomUUID(),
        'user-agent': this.userAgent,
      },
      body: JSON.stringify(toCodexResponsesPayload(request)),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Codex ChatGPT backend failed: ${response.status} ${preview(text)}`);
    }

    const text = await response.text();
    const output = collectOutputTextFromSse(text);

    return {
      providerId: this.id,
      model: request.model,
      message: {
        role: 'assistant',
        content: output,
      },
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
        outputTokens: output.length,
      },
    };
  }

  private async loadFreshAuth(): Promise<CodexAuthJson> {
    const auth = await this.readAuth();
    const accessToken = auth.tokens?.access_token;
    const refreshToken = auth.tokens?.refresh_token;
    if (!accessToken || !refreshToken) {
      return auth;
    }

    const exp = decodeJwt(accessToken)?.exp;
    const now = Math.floor(Date.now() / 1000);
    if (exp && exp - now > this.refreshSkewSeconds) {
      return auth;
    }

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshAuth(auth).finally(() => {
        this.refreshInFlight = undefined;
      });
    }

    return this.refreshInFlight;
  }

  private async readAuth(): Promise<CodexAuthJson> {
    const text = await readFile(this.authPath, 'utf8');
    const auth = JSON.parse(text) as CodexAuthJson;
    if (auth.auth_mode !== 'chatgpt') {
      throw new Error(`Codex auth mode is ${auth.auth_mode ?? 'unknown'}, expected chatgpt`);
    }
    return auth;
  }

  private async refreshAuth(auth: CodexAuthJson): Promise<CodexAuthJson> {
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken) {
      throw new Error('Codex auth has no refresh token');
    }

    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Codex token refresh failed: ${response.status} ${preview(text)}`);
    }

    const payload = await response.json() as RefreshResponse;
    if (!payload.access_token || !payload.refresh_token) {
      throw new Error('Codex token refresh response did not include access_token and refresh_token');
    }

    const nextAuth: CodexAuthJson = {
      ...auth,
      tokens: {
        id_token: payload.id_token ?? auth.tokens?.id_token,
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        account_id: auth.tokens?.account_id ?? extractAccountId(payload.access_token),
      },
      last_refresh: new Date().toISOString(),
    };

    await atomicWriteJson(this.authPath, nextAuth);
    return nextAuth;
  }
}

function toCodexResponsesPayload(request: BrainProviderRequest): Record<string, unknown> {
  const instructions = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n') || 'You are a helpful assistant.';
  const inputMessages = request.messages
    .filter((message) => message.role !== 'system')
    .map(toResponseInputMessage);

  return {
    model: request.model,
    instructions,
    input: inputMessages.length > 0 ? inputMessages : [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '',
          },
        ],
      },
    ],
    store: false,
    stream: true,
    text: {
      verbosity: 'medium',
    },
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
}

function toResponseInputMessage(message: BrainMessage): Record<string, unknown> {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const type = role === 'assistant' ? 'output_text' : 'input_text';
  return {
    role,
    content: [
      {
        type,
        text: message.content,
      },
    ],
  };
}

function collectOutputTextFromSse(sse: string): string {
  const lines = sse.split(/\r?\n/);
  let eventName = '';
  let output = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }

    if (!line.startsWith('data:')) {
      continue;
    }

    const dataText = line.slice('data:'.length).trim();
    if (!dataText || dataText === '[DONE]') {
      continue;
    }

    try {
      const data = JSON.parse(dataText) as Record<string, unknown>;
      if (eventName === 'response.output_text.delta' && typeof data.delta === 'string') {
        output += data.delta;
      } else if (!output && eventName === 'response.completed') {
        output = extractTextFromCompletedResponse(data) || output;
      }
    } catch {
      // Ignore malformed SSE data chunks; the HTTP status already succeeded.
    }
  }

  return output;
}

function extractTextFromCompletedResponse(data: Record<string, unknown>): string {
  const response = data.response;
  if (!response || typeof response !== 'object' || !('output' in response) || !Array.isArray(response.output)) {
    return '';
  }

  const parts: string[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== 'object' || !('content' in item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('');
}

function decodeJwt(token?: string): JwtClaims | undefined {
  if (!token) {
    return undefined;
  }
  const part = token.split('.')[1];
  if (!part) {
    return undefined;
  }

  try {
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as JwtClaims;
  } catch {
    return undefined;
  }
}

function extractAccountId(token?: string): string | undefined {
  const claims = decodeJwt(token);
  return claims?.['https://api.openai.com/auth']?.chatgpt_account_id
    ?? claims?.chatgpt_account_id
    ?? claims?.account_id;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, filePath);
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 500);
}
