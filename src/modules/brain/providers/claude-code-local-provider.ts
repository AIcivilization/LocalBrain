import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
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
import { fetchViaHttpProxy, proxyEnvironmentIfAvailable, resolveForcedProxyUrl } from './proxy.ts';

const execFileAsync = promisify(execFile);

// Anthropic exposes the live model catalog here; Claude Code has no `models`
// subcommand, so we read it directly with the CLI's OAuth token.
const CLAUDE_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models';
// Family aliases the CLI resolves to the latest model (e.g. `opus` -> newest
// Opus). Used when live discovery is unavailable (logged out / offline) so the
// gateway keeps working. Kept minimal and long-lived on purpose.
const CLAUDE_FALLBACK_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
// Preferred display order for discovered families; unknown families sort after.
const CLAUDE_FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable'];

export interface ClaudeCodeLocalProviderOptions {
  id: string;
  cliPath?: string;
  displayName?: string;
  workDir?: string;
  timeoutMs?: number;
  modelCacheTtlMs?: number;
  settingSources?: string;
  proxyUrl?: string;
  forceProxy?: boolean;
  experimental?: boolean;
}

interface ClaudeCodeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  session_id?: string;
  error?: string;
}

export class ClaudeCodeLocalProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'claude-code-local' as const;
  private readonly configuredCliPath?: string;
  private readonly displayName: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly modelCacheTtlMs: number;
  private readonly settingSources?: string;
  private readonly proxyUrl?: string;
  private readonly forceProxy: boolean;
  private readonly experimental: boolean;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: ClaudeCodeLocalProviderOptions) {
    this.id = options.id;
    this.configuredCliPath = options.cliPath;
    this.displayName = options.displayName ?? 'Claude Code Local Provider';
    this.workDir = options.workDir ?? path.join(os.homedir(), 'Library', 'Application Support', 'LocalBrain', 'claude-code-workdir');
    this.timeoutMs = options.timeoutMs ?? 900_000;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? 60_000;
    this.settingSources = options.settingSources;
    this.proxyUrl = options.proxyUrl;
    this.forceProxy = options.forceProxy ?? true;
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

    // Prefer the live catalog so new model families appear automatically and
    // upgrades never require a code change. Fall back to stable family aliases
    // when the user is logged out or the request fails, so listing never throws
    // and the gateway stays usable.
    let models: BrainModelDescriptor[] | undefined;
    try {
      models = await this.discoverModels();
    } catch (error) {
      // Being signed out is the normal, quiet path. Anything else (e.g. the API
      // rejecting the token) is worth surfacing so the live path can be fixed
      // instead of silently degrading to the fallback forever.
      if (!(error instanceof SignedOutError)) {
        console.warn(`[${this.id}] live model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      models = undefined;
    }
    if (!models || models.length === 0) {
      models = CLAUDE_FALLBACK_FAMILIES.map((family) => this.familyDescriptor(family));
    }

    this.modelCache = {
      expiresAt: now + this.modelCacheTtlMs,
      models,
    };
    return models;
  }

  private familyDescriptor(family: string): BrainModelDescriptor {
    return {
      id: `claude-code/${family}`,
      providerId: this.id,
      displayName: `Claude Code ${capitalize(family)}`,
    };
  }

  private async discoverModels(): Promise<BrainModelDescriptor[]> {
    const token = await readClaudeOAuthToken();
    if (!token || !token.accessToken) {
      throw new SignedOutError('Claude Code is not signed in (no OAuth token found)');
    }
    if (token.expiresAt && token.expiresAt <= Date.now()) {
      throw new SignedOutError('Claude Code OAuth token has expired');
    }

    const catalog = await this.fetchModelCatalog(token.accessToken);
    const families: string[] = [];
    const seen = new Set<string>();
    for (const entry of catalog) {
      const family = claudeModelFamily(entry.id);
      if (!family || seen.has(family)) {
        continue;
      }
      seen.add(family);
      families.push(family);
    }
    return sortClaudeFamilies(families).map((family) => this.familyDescriptor(family));
  }

  private async fetchModelCatalog(accessToken: string): Promise<Array<{ id: string }>> {
    const init = {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      timeoutMs: 15_000,
    };
    const url = `${CLAUDE_MODELS_ENDPOINT}?limit=1000`;
    const proxyUrl = this.forceProxy ? resolveForcedProxyUrl(this.proxyUrl) : undefined;
    const response = proxyUrl
      ? await fetchViaHttpProxy(url, init, proxyUrl)
      : await fetchDirect(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude models request failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? [])
      .filter((entry): entry is { id: string } => typeof entry.id === 'string');
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    await mkdir(this.workDir, { recursive: true });
    const prompt = toClaudePrompt(request.messages);
    const cliModel = toClaudeCliModel(request.model);
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      cliModel,
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
      '--no-session-persistence',
      '--no-chrome',
      '--disable-slash-commands',
    ];
    if (this.settingSources) {
      args.push('--setting-sources', this.settingSources);
    }

    const cliPath = await resolveClaudeCodeCliPath(this.configuredCliPath);
    const { stdout, stderr } = await runClaudeCode(cliPath, args, prompt, {
      cwd: this.workDir,
      timeout: this.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...(this.forceProxy ? proxyEnvironmentIfAvailable(process.env, this.proxyUrl) : process.env),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? '1',
      },
    });

    const payload = parseClaudeCodeJson(stdout);
    if (payload.is_error === true || payload.subtype === 'error') {
      throw new Error(`Claude Code failed: ${payload.error ?? payload.result ?? stderr.trim() ?? 'unknown error'}`);
    }

    const content = payload.result ?? stdout.trim();
    return {
      providerId: this.id,
      model: request.model,
      message: {
        role: 'assistant',
        content,
      },
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
        outputTokens: content.length,
      },
      raw: {
        type: payload.type,
        subtype: payload.subtype,
        durationMs: payload.duration_ms,
        durationApiMs: payload.duration_api_ms,
        numTurns: payload.num_turns,
        totalCostUsd: payload.total_cost_usd,
        sessionId: payload.session_id,
      },
    };
  }

}

async function resolveClaudeCodeCliPath(configuredCliPath?: string): Promise<string> {
  const managedPaths = await discoverManagedClaudeCodeCliPaths();
  if (configuredCliPath) {
    if (isClaudeManagedVersionPath(configuredCliPath)) {
      const latestManaged = managedPaths[0];
      if (latestManaged) {
        return latestManaged;
      }
    }
    if (await isExecutable(configuredCliPath)) {
      return configuredCliPath;
    }
  }

  for (const candidate of [
    ...managedPaths,
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude',
  ]) {
    if (candidate === 'claude' || await isExecutable(candidate)) {
      return candidate;
    }
  }
  return 'claude';
}

async function discoverManagedClaudeCodeCliPaths(): Promise<string[]> {
  const root = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => !entry.startsWith('.'))
    .map((entry) => ({
      version: entry,
      cliPath: path.join(root, entry, 'claude.app', 'Contents', 'MacOS', 'claude'),
    }))
    .sort((left, right) => compareVersionLike(right.version, left.version));

  const executablePaths: string[] = [];
  for (const candidate of candidates) {
    if (await isExecutable(candidate.cliPath)) {
      executablePaths.push(candidate.cliPath);
    }
  }
  return executablePaths;
}

function isClaudeManagedVersionPath(value: string): boolean {
  return value.includes('/Library/Application Support/Claude/claude-code/')
    && value.endsWith('/claude.app/Contents/MacOS/claude');
}

async function isExecutable(value: string): Promise<boolean> {
  try {
    await access(value, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compareVersionLike(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return left.localeCompare(right);
}

function runClaudeCode(
  cliPath: string,
  args: string[],
  stdin: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Claude Code timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxBuffer) {
        child.kill('SIGTERM');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maxBuffer) {
        child.kill('SIGTERM');
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      reject(new Error(`Claude Code exited with ${signal ?? code}: ${err || out}`));
    });
    child.stdin.end(stdin);
  });
}

function toClaudeCliModel(model: string): string {
  if (model === 'claude-code/opus') {
    return 'opus';
  }
  if (model === 'claude-code/sonnet') {
    return 'sonnet';
  }
  if (model.startsWith('claude-code/')) {
    return model.slice('claude-code/'.length);
  }
  return model;
}

function toClaudePrompt(messages: BrainMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      lines.push(`System:\n${message.content}`);
      continue;
    }
    if (message.role === 'assistant') {
      lines.push(`Assistant:\n${message.content}`);
      continue;
    }
    if (message.role === 'tool') {
      lines.push(`Tool result${message.name ? ` (${message.name})` : ''}:\n${message.content}`);
      continue;
    }
    lines.push(`User:\n${message.content}`);
  }
  return lines.join('\n\n');
}

function parseClaudeCodeJson(stdout: string): ClaudeCodeJsonResult {
  try {
    return JSON.parse(stdout) as ClaudeCodeJsonResult;
  } catch {
    return {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: stdout.trim(),
    };
  }
}

// Signals the expected "no usable login" case so callers can stay quiet about
// it while still logging genuine discovery failures.
class SignedOutError extends Error {}

interface ClaudeOAuthToken {
  accessToken: string;
  expiresAt?: number;
}

// Reads the Claude Code subscription OAuth token. Newer installs keep it in the
// macOS Keychain under the `Claude Code-credentials` service; some setups use a
// `~/.claude/.credentials.json` file. Both hold `{ claudeAiOauth: {...} }`.
async function readClaudeOAuthToken(): Promise<ClaudeOAuthToken | undefined> {
  const fileToken = await readOAuthTokenFromFile();
  if (fileToken) {
    return fileToken;
  }
  if (process.platform === 'darwin') {
    return readOAuthTokenFromKeychain();
  }
  return undefined;
}

async function readOAuthTokenFromFile(): Promise<ClaudeOAuthToken | undefined> {
  try {
    const text = await readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return parseOAuthCredentials(text);
  } catch {
    return undefined;
  }
}

async function readOAuthTokenFromKeychain(): Promise<ClaudeOAuthToken | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    return parseOAuthCredentials(stdout);
  } catch {
    return undefined;
  }
}

function parseOAuthCredentials(text: string): ClaudeOAuthToken | undefined {
  try {
    const json = JSON.parse(text.trim()) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = json.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
      return undefined;
    }
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    };
  } catch {
    return undefined;
  }
}

// Extracts the model family (`claude-opus-4-8` -> `opus`) so upgrades within a
// family collapse onto a single always-latest alias. Rejects purely-numeric
// segments so legacy `claude-3-5-sonnet-*` ids don't produce a bogus `3` alias.
function claudeModelFamily(id: string): string | undefined {
  const family = /^claude-([a-z0-9]+)-/.exec(id)?.[1];
  if (!family || /^[0-9]+$/.test(family)) {
    return undefined;
  }
  return family;
}

function sortClaudeFamilies(families: string[]): string[] {
  const rank = (family: string): number => {
    const index = CLAUDE_FAMILY_ORDER.indexOf(family);
    return index === -1 ? CLAUDE_FAMILY_ORDER.length : index;
  };
  return [...families].sort((left, right) => {
    const delta = rank(left) - rank(right);
    return delta !== 0 ? delta : left.localeCompare(right);
  });
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

async function fetchDirect(
  url: string,
  init: { method?: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      json: () => response.json(),
    };
  } finally {
    clearTimeout(timer);
  }
}
