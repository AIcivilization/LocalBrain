import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
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

export interface OpenCodeLocalBrainProviderOptions {
  id: string;
  displayName?: string;
  baseUrl?: string;
  cliPath?: string;
  modelProvider?: string;
  passwordEnv?: string;
  experimental?: boolean;
}

interface OpenCodeSession {
  id?: string;
}

interface OpenCodeMessageResponse {
  content?: string;
  message?: {
    content?: string;
  };
  output?: string;
  text?: string;
}

export class OpenCodeLocalBrainProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'opencode-local' as const;
  private readonly displayName: string;
  private readonly baseUrl: string;
  private readonly cliPath: string;
  private readonly modelProvider: string;
  private readonly passwordEnv?: string;
  private readonly experimental: boolean;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: OpenCodeLocalBrainProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName ?? 'OpenCode Local Provider';
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:4096').replace(/\/+$/, '');
    this.cliPath = options.cliPath ?? '/Users/wf/.opencode/bin/opencode';
    this.modelProvider = options.modelProvider ?? 'opencode';
    this.passwordEnv = options.passwordEnv;
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

    const { stdout } = await execFileAsync(this.cliPath, ['models', this.modelProvider], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith(`${this.modelProvider}/`))
      .map((id) => ({
        id,
        providerId: this.id,
        displayName: id,
        free: id.endsWith('-free') || id === `${this.modelProvider}/gpt-5-nano`,
      }));

    this.modelCache = {
      expiresAt: now + 60_000,
      models,
    };
    return models;
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    let response: { content: string; raw: unknown };
    try {
      response = await this.generateWithCli(request);
    } catch (cliError) {
      try {
        response = await this.generateWithLocalServer(request);
      } catch (serverError) {
        throw new Error(`OpenCode CLI failed: ${formatError(cliError)}; OpenCode local server failed: ${formatError(serverError)}`);
      }
    }

    return {
      providerId: this.id,
      model: request.model,
      message: {
        role: 'assistant',
        content: response.content,
      },
      toolCalls: [],
      finishReason: 'stop',
      raw: response.raw,
    };
  }

  private async generateWithCli(request: BrainProviderRequest): Promise<{ content: string; raw: unknown }> {
    const timeout = requestTimeoutMs(request, 180_000);
    const stdout = await spawnOpenCodeCli(this.cliPath, [
      'run',
      '--model',
      request.model,
      '--format',
      'json',
      buildPrompt(request.messages),
    ], timeout, {
      cwd: opencodeWorkingDirectory(),
      env: opencodeEnvironment(this.cliPath),
    });

    const content = extractCliContent(stdout);
    if (!content) {
      throw new Error('OpenCode CLI returned no assistant content');
    }

    return {
      content,
      raw: stdout,
    };
  }

  private async generateWithLocalServer(request: BrainProviderRequest): Promise<{ content: string; raw: unknown }> {
    const session = await this.requestOpenCode<OpenCodeSession>('/session', 'POST', {
      title: 'LocalBrain Session',
    });
    if (!session.id) {
      throw new Error('OpenCode local provider failed to create a session');
    }

    const response = await this.requestOpenCode<OpenCodeMessageResponse>(`/session/${session.id}/message`, 'POST', {
      content: buildPrompt(request.messages),
      model: request.model,
    });

    return {
      content: extractContent(response),
      raw: response,
    };
  }

  private async requestOpenCode<T>(path: string, method: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const password = this.passwordEnv ? process.env[this.passwordEnv] : undefined;
    if (password) {
      headers.authorization = `Bearer ${password}`;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenCode local provider failed: ${response.status} ${text}`);
    }
    return await response.json() as T;
  }
}

interface SpawnOpenCodeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function spawnOpenCodeCli(
  cliPath: string,
  args: string[],
  timeoutMs: number,
  options: SpawnOpenCodeOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBuffer = 16 * 1024 * 1024;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('OpenCode CLI stdout exceeded max buffer')));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('OpenCode CLI stderr exceeded max buffer')));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (timedOut) {
          reject(new Error(`OpenCode CLI timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`OpenCode CLI exited with code ${code ?? 'null'} signal ${signal ?? 'null'}${stderr ? `: ${stderr}` : ''}`));
          return;
        }
        resolve(stdout);
      });
    });
  });
}

function requestTimeoutMs(request: BrainProviderRequest, fallback: number): number {
  const value = request.metadata?.localBrainTestTimeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), 5_000), fallback);
}

function opencodeWorkingDirectory(): string {
  return process.env.HOME || os.homedir();
}

function opencodeEnvironment(cliPath: string): NodeJS.ProcessEnv {
  const home = process.env.HOME || os.homedir();
  const cliDir = cliPath.includes('/') ? cliPath.slice(0, cliPath.lastIndexOf('/')) : undefined;
  const pathValue = [
    cliDir,
    process.env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean).join(':');
  return {
    HOME: home,
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || process.env.USER || os.userInfo().username,
    SHELL: process.env.SHELL || '/bin/zsh',
    PATH: pathValue,
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: process.env.TERM || 'dumb',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    PWD: home,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error ? ` ${(error as { code?: unknown }).code}` : '';
    const signal = 'signal' in error ? ` ${(error as { signal?: unknown }).signal}` : '';
    return `${error.message}${code}${signal}`.trim();
  }
  return String(error);
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

function buildPrompt(messages: BrainMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === 'system') {
        return `System:\n${message.content}`;
      }
      if (message.role === 'assistant') {
        return `Assistant:\n${message.content}`;
      }
      return message.content;
    })
    .join('\n\n');
}

function extractContent(response: OpenCodeMessageResponse): string {
  return response.content
    ?? response.message?.content
    ?? response.output
    ?? response.text
    ?? JSON.stringify(response);
}

function extractCliContent(stdout: string): string {
  const fullText = stdout.trim();
  if (fullText) {
    try {
      const chunks: string[] = [];
      collectText(JSON.parse(fullText), chunks);
      const content = chunks.join('').trim();
      if (content) {
        return content;
      }
    } catch {
      // Fall through to line-by-line JSON event parsing.
    }
  }

  const chunks: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      collectText(JSON.parse(trimmed), chunks);
    } catch {
      chunks.push(stripAnsi(trimmed));
    }
  }
  return chunks.join('').trim();
}

function collectText(value: unknown, chunks: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, chunks);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'delta']) {
    if (typeof record[key] === 'string') {
      chunks.push(record[key]);
    }
  }

  if (record.message && typeof record.message === 'object') {
    collectText(record.message, chunks);
  }
  if (record.part && typeof record.part === 'object') {
    collectText(record.part, chunks);
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
