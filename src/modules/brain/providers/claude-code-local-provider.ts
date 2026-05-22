import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  BrainMessage,
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';

export interface ClaudeCodeLocalProviderOptions {
  id: string;
  cliPath?: string;
  displayName?: string;
  workDir?: string;
  timeoutMs?: number;
  modelCacheTtlMs?: number;
  settingSources?: string;
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

    const models: BrainModelDescriptor[] = [
      {
        id: 'claude-code/sonnet',
        providerId: this.id,
        displayName: 'Claude Code Sonnet',
      },
      {
        id: 'claude-code/opus',
        providerId: this.id,
        displayName: 'Claude Code Opus',
      },
    ];

    this.modelCache = {
      expiresAt: now + this.modelCacheTtlMs,
      models,
    };
    return models;
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
        ...process.env,
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
