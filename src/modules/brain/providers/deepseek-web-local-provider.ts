import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BrainMessage,
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';

export interface DeepSeekWebLocalProviderOptions {
  id: string;
  displayName?: string;
  baseUrl?: string;
  userToken?: string;
  userTokenEnv?: string;
  userTokenPath?: string;
  wasmPath?: string;
  modelCacheTtlMs?: number;
  experimental?: boolean;
}

interface DeepSeekApiEnvelope<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

interface DeepSeekCurrentUserData {
  token?: string;
}

interface DeepSeekSessionData {
  biz_data?: {
    id?: string;
  };
}

interface DeepSeekChallengeData {
  biz_data?: {
    challenge?: DeepSeekChallenge;
  };
}

interface DeepSeekChallenge {
  algorithm?: string;
  challenge?: string;
  salt?: string;
  difficulty?: number;
  expire_at?: number;
  signature?: string;
}

interface DeepSeekStreamEvent {
  message_id?: number | string;
  choices?: Array<{
    delta?: {
      type?: string;
      content?: string;
      search_results?: Array<{
        title?: string;
        url?: string;
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_MODEL_CACHE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;
const COMPLETION_TIMEOUT_MS = 180_000;
const DEFAULT_WASM_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'deepseek_sha3_wasm_bg.7b9ca65ddd.wasm',
);

const FAKE_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  origin: DEFAULT_BASE_URL,
  referer: `${DEFAULT_BASE_URL}/`,
  pragma: 'no-cache',
  priority: 'u=1, i',
  'sec-ch-ua': '"Chromium";v="133", "Google Chrome";v="133", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'x-app-version': '20241129.1',
  'x-client-locale': 'zh-CN',
  'x-client-platform': 'web',
  'x-client-version': '1.0.0-always',
};

export class DeepSeekWebLocalProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'deepseek-web-local' as const;
  private readonly displayName: string;
  private readonly baseUrl: string;
  private readonly userToken?: string;
  private readonly userTokenEnv?: string;
  private readonly userTokenPath?: string;
  private readonly wasmPath: string;
  private readonly modelCacheTtlMs: number;
  private readonly experimental: boolean;
  private accessToken?: CachedAccessToken;
  private accessTokenInFlight?: Promise<string>;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: DeepSeekWebLocalProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName ?? 'DeepSeek Web Experimental Provider';
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userToken = options.userToken;
    this.userTokenEnv = options.userTokenEnv;
    this.userTokenPath = options.userTokenPath;
    this.wasmPath = options.wasmPath ?? DEFAULT_WASM_PATH;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
    this.experimental = options.experimental ?? true;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      supportsStreaming: false,
      supportsTools: false,
      localOnly: true,
      experimental: this.experimental,
    };
  }

  async listModels(): Promise<BrainModelDescriptor[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    const models = [
      {
        id: 'deepseek-web/default',
        providerId: this.id,
        displayName: 'DeepSeek 即时',
        free: true,
      },
      {
        id: 'deepseek-web/expert',
        providerId: this.id,
        displayName: 'DeepSeek 专家',
        free: true,
      },
      {
        id: 'deepseek-web/default-search',
        providerId: this.id,
        displayName: 'DeepSeek 即时+搜索',
        free: true,
      },
      {
        id: 'deepseek-web/expert-search',
        providerId: this.id,
        displayName: 'DeepSeek 专家+搜索',
        free: true,
      },
    ];

    this.modelCache = {
      expiresAt: now + this.modelCacheTtlMs,
      models,
    };
    return models;
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    const prompt = messagesToDeepSeekPrompt(request.messages);
    const modelMode = modelToMode(request.model);
    const sessionId = await this.createSession();
    const powResponse = await this.createPowResponse('/api/v0/chat/completion');
    const token = await this.resolveAccessToken();

    const response = await fetchWithTimeout(`${this.baseUrl}/api/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...this.headers(token),
        'content-type': 'application/json',
        cookie: generateCookie(),
        'x-ds-pow-response': powResponse,
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt,
        ref_file_ids: [],
        search_enabled: modelMode.searchEnabled,
        thinking_enabled: modelMode.thinkingEnabled,
        model_type: modelMode.modelType,
      }),
      timeoutMs: COMPLETION_TIMEOUT_MS,
    });

    if (!response.ok) {
      throw new Error(`DeepSeek Web completion failed: ${response.status} ${preview(await response.text())}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new Error(`DeepSeek Web completion returned ${contentType || 'unknown content type'}: ${preview(await response.text())}`);
    }

    const output = await collectDeepSeekSse(response);

    return {
      providerId: this.id,
      model: request.model,
      message: {
        role: 'assistant',
        content: output.content,
      },
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        inputTokens: prompt.length,
        outputTokens: output.content.length,
        totalTokens: prompt.length + output.content.length,
      },
      raw: {
        sessionId,
        messageId: output.messageId,
        reasoningContent: output.reasoningContent,
      },
    };
  }

  private async createSession(): Promise<string> {
    const token = await this.resolveAccessToken();
    const response = await fetchWithTimeout(`${this.baseUrl}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: {
        ...this.headers(token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        character_id: null,
      }),
      timeoutMs: 15_000,
    });
    const data = await readDeepSeekJson<DeepSeekSessionData>(response, 'create session');
    const sessionId = data.biz_data?.id;
    if (!sessionId) {
      throw new Error('DeepSeek Web did not return a chat session id');
    }
    return sessionId;
  }

  private async createPowResponse(targetPath: string): Promise<string> {
    const token = await this.resolveAccessToken();
    const response = await fetchWithTimeout(`${this.baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: {
        ...this.headers(token),
        'content-type': 'application/json',
        cookie: generateCookie(),
      },
      body: JSON.stringify({
        target_path: targetPath,
      }),
      timeoutMs: 15_000,
    });
    const data = await readDeepSeekJson<DeepSeekChallengeData>(response, 'create PoW challenge');
    const challenge = data.biz_data?.challenge;
    if (!challenge) {
      throw new Error('DeepSeek Web did not return a PoW challenge');
    }

    const answer = await solveChallengeWithWasm(challenge, this.wasmPath);
    if (answer === undefined) {
      throw new Error('DeepSeek Web PoW solver did not find an answer');
    }
    return Buffer.from(JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    })).toString('base64');
  }

  private async resolveAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now) {
      return this.accessToken.token;
    }

    if (!this.accessTokenInFlight) {
      this.accessTokenInFlight = this.refreshAccessToken().finally(() => {
        this.accessTokenInFlight = undefined;
      });
    }
    return this.accessTokenInFlight;
  }

  private async refreshAccessToken(): Promise<string> {
    const refreshToken = await this.resolveUserToken();
    const response = await fetchWithTimeout(`${this.baseUrl}/api/v0/users/current`, {
      method: 'GET',
      headers: {
        ...this.headers(refreshToken),
        cookie: generateCookie(),
      },
      timeoutMs: 15_000,
    });
    const data = await readDeepSeekJson<DeepSeekCurrentUserData>(response, 'refresh user token');
    if (!data.token) {
      throw new Error('DeepSeek Web token refresh did not return an access token');
    }
    this.accessToken = {
      token: data.token,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
    return data.token;
  }

  private async resolveUserToken(): Promise<string> {
    const token = this.userToken
      ?? (this.userTokenEnv ? process.env[this.userTokenEnv] : undefined)
      ?? (this.userTokenPath ? (await readFile(expandHome(this.userTokenPath), 'utf8')).trim() : undefined);
    if (!token) {
      throw new Error('DeepSeek Web provider requires a local userToken. Copy userToken from chat.deepseek.com LocalStorage into LocalBrain first.');
    }
    return token;
  }

  private headers(token: string): Record<string, string> {
    return {
      ...FAKE_HEADERS,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      authorization: `Bearer ${token}`,
    };
  }
}

function messagesToDeepSeekPrompt(messages: BrainMessage[]): string {
  const processed = messages.map((message) => ({
    role: message.role,
    text: message.content,
  }));
  if (processed.length === 0) {
    return '';
  }

  const merged: Array<{ role: string; text: string }> = [];
  let current = { ...processed[0] };
  for (const message of processed.slice(1)) {
    if (message.role === current.role) {
      current.text += `\n\n${message.text}`;
      continue;
    }
    merged.push(current);
    current = { ...message };
  }
  merged.push(current);

  return merged
    .map((block, index) => {
      if (block.role === 'assistant') {
        return `<｜Assistant｜>${block.text}<｜end▁of▁sentence｜>`;
      }
      if (block.role === 'user' || block.role === 'system') {
        return index > 0 ? `<｜User｜>${block.text}` : block.text;
      }
      return block.text;
    })
    .join('')
    .replace(/\!\[.+\]\(.+\)/g, '');
}

function modelToMode(model: string): {
  modelType: 'default' | 'expert';
  searchEnabled: boolean;
  thinkingEnabled: boolean;
} {
  const normalized = model.toLowerCase();
  return {
    modelType: normalized.includes('expert') ? 'expert' : 'default',
    searchEnabled: normalized.includes('search'),
    thinkingEnabled: normalized.includes('think') || normalized.includes('r1'),
  };
}

async function collectDeepSeekSse(response: Response): Promise<{
  content: string;
  reasoningContent: string;
  messageId?: string | number;
}> {
  if (!response.body) {
    throw new Error('DeepSeek Web returned an empty stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let messageId: string | number | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const eventText of events) {
      const data = parseSseData(eventText);
      if (!data || data === '[DONE]') {
        continue;
      }
      const event = JSON.parse(data) as DeepSeekStreamEvent;
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (!delta) {
        continue;
      }
      messageId = event.message_id ?? messageId;
      const text = delta.content?.replace(/\[citation:\d+\]/g, '') ?? '';
      if (delta.type === 'thinking') {
        reasoningContent += text;
      } else {
        content += text;
      }
    }
  }

  return {
    content: content.trimStart(),
    reasoningContent,
    messageId,
  };
}

function parseSseData(eventText: string): string | undefined {
  return eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim();
}

async function readDeepSeekJson<T>(response: Response, action: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek Web ${action} failed: ${response.status} ${preview(text)}`);
  }
  const envelope = JSON.parse(text) as DeepSeekApiEnvelope<T>;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new Error(`DeepSeek Web ${action} failed: ${envelope.msg ?? `code ${envelope.code}`}`);
  }
  return (envelope.data ?? envelope) as T;
}

async function solveChallengeWithWasm(challenge: DeepSeekChallenge, wasmPath: string): Promise<number | undefined> {
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`unsupported DeepSeek Web PoW algorithm: ${challenge.algorithm ?? 'unknown'}`);
  }
  if (
    typeof challenge.challenge !== 'string'
    || typeof challenge.salt !== 'string'
    || typeof challenge.difficulty !== 'number'
    || typeof challenge.expire_at !== 'number'
  ) {
    throw new Error('DeepSeek Web PoW challenge is incomplete');
  }

  const wasmBuffer = await readFile(wasmPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DeepSeek Web PoW wasm is missing at ${wasmPath}: ${message}`);
  });
  const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
  const wasm = instance.exports as Record<string, WebAssembly.ExportValue>;
  const memory = wasm.memory as WebAssembly.Memory | undefined;
  const stackPointer = wasm.__wbindgen_add_to_stack_pointer as ((value: number) => number) | undefined;
  const allocate = wasm.__wbindgen_export_0 as ((size: number, align: number) => number) | undefined;
  const reallocate = wasm.__wbindgen_export_1 as ((ptr: number, oldSize: number, newSize: number, align: number) => number) | undefined;
  const wasmSolve = wasm.wasm_solve as ((retptr: number, ptr0: number, len0: number, ptr1: number, len1: number, difficulty: number) => void) | undefined;
  if (!memory || !stackPointer || !allocate || !reallocate || !wasmSolve) {
    throw new Error('DeepSeek Web PoW wasm exports are incompatible');
  }

  let cachedMemory = new Uint8Array(memory.buffer);
  const encoder = new TextEncoder();
  const encodeString = (value: string): { ptr: number; len: number } => {
    let ptr = allocate(value.length, 1) >>> 0;
    let offset = 0;
    cachedMemory = cachedMemory.byteLength === 0 ? new Uint8Array(memory.buffer) : cachedMemory;
    for (; offset < value.length; offset += 1) {
      const code = value.charCodeAt(offset);
      if (code > 127) {
        break;
      }
      cachedMemory[ptr + offset] = code;
    }

    if (offset !== value.length) {
      if (offset > 0) {
        value = value.slice(offset);
      }
      ptr = reallocate(ptr, value.length, offset + value.length * 3, 1) >>> 0;
      cachedMemory = new Uint8Array(memory.buffer);
      const result = encoder.encodeInto(value, cachedMemory.subarray(ptr + offset, ptr + offset + value.length * 3));
      offset += result.written;
      ptr = reallocate(ptr, offset + value.length * 3, offset, 1) >>> 0;
    }

    return { ptr, len: offset };
  };

  const retptr = stackPointer(-16);
  try {
    const challengeArg = encodeString(challenge.challenge);
    const prefixArg = encodeString(`${challenge.salt}_${challenge.expire_at}_`);
    wasmSolve(retptr, challengeArg.ptr, challengeArg.len, prefixArg.ptr, prefixArg.len, challenge.difficulty);
    const view = new DataView(memory.buffer);
    const status = view.getInt32(retptr, true);
    return status === 0 ? undefined : view.getFloat64(retptr + 8, true);
  } finally {
    stackPointer(16);
  }
}

async function fetchWithTimeout(url: string, options: RequestInit & { timeoutMs: number }): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function generateCookie(): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    `intercom-HWWAFSESTIME=${Date.now()}`,
    `HWWAFSESID=${randomBytes(9).toString('hex')}`,
    `Hm_lvt_${randomBytes(16).toString('hex')}=${now},${now},${now}`,
    `Hm_lpvt_${randomBytes(16).toString('hex')}=${now}`,
    `_frid=${randomUUID().replace(/-/g, '')}`,
    `_fr_ssid=${randomUUID().replace(/-/g, '')}`,
    `_fr_pvid=${randomUUID().replace(/-/g, '')}`,
  ].join('; ');
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function preview(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}
