import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  BrainMessage,
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
  BrainProviderStatus,
} from '../types.ts';
import { proxyEnvironmentIfAvailable } from './proxy.ts';

// Several locally installed AI IDEs ship an agent CLI that copies the Claude
// Code headless contract: `-p` for a single turn, `--output-format json`, a
// `--model` flag, and a permission mode that never prompts. They differ only in
// flag spelling and in how the model catalog is discovered, so one provider with
// a per-vendor profile covers all of them and adding the next IDE is one entry.
export type AgentCliVendor = 'grok' | 'qoder' | 'workbuddy' | 'workbuddy-ai';

export const AGENT_CLI_VENDORS: AgentCliVendor[] = ['grok', 'qoder', 'workbuddy', 'workbuddy-ai'];

// One refresh round trip is not always enough in practice, and the second 401
// still clears on the next attempt. Two retries covers it without making a
// genuinely signed-out CLI slow to report.
const MAX_STALE_AUTH_RETRIES = 2;

// Model discovery sits in front of ordinary requests, so it must not inherit the
// generation timeout: a wedged CLI would otherwise hold up a chat request for
// the full 15 minutes. Generous enough for a cold CLI plus its auth retries.
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 45_000;

// A CLI that is signed out stays signed out until the user acts, and each probe
// costs seconds, so failures are remembered far longer than successes. A fresh
// login shows up within this window, or immediately after a restart.
const FAILED_DISCOVERY_CACHE_MS = 5 * 60_000;

// A model the vendor cannot possibly own. WorkBuddy answers an unknown model by
// printing the catalog its account is entitled to, which is the only listing it
// offers and is more accurate than any hard-coded table. The prompt has to be
// non-empty or the CLI returns early without ever validating the model, but it
// still costs nothing because the request dies before reaching a model.
const WORKBUDDY_MODEL_PROBE = 'localbrain-model-probe';
const WORKBUDDY_MODEL_PROBE_PROMPT = 'hi';

interface AgentCliModelDiscovery {
  args: string[];
  stdin?: string;
  // Receives stdout and stderr joined, because these CLIs are inconsistent about
  // which stream carries the catalog.
  parse(text: string): string[];
}

interface AgentCliProfile {
  displayName: string;
  // Vendor name for model labels, kept here so one table holds everything that
  // varies per vendor.
  shortName: string;
  modelPrefix: string;
  cliPaths: string[];
  // Looked up on PATH when no absolute candidate exists. Omitted when the
  // command name cannot identify the vendor on its own.
  bareCommand?: string;
  // Directory of `<name>-<version>` CLI copies, newest wins.
  versionedCliRoot?: string;
  promptDelivery: 'stdin' | 'prompt-file';
  generateArgs(cliModel: string, promptFile?: string): string[];
  modelDiscovery: AgentCliModelDiscovery;
  forceProxyByDefault: boolean;
}

const PROFILES: Record<AgentCliVendor, AgentCliProfile> = {
  grok: {
    displayName: 'Grok Bot Local Provider',
    shortName: 'Grok',
    modelPrefix: 'grok/',
    cliPaths: [
      path.join(os.homedir(), '.grok', 'bin', 'grok'),
      path.join(os.homedir(), '.local', 'bin', 'grok'),
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
    ],
    bareCommand: 'grok',
    // `-p` takes the prompt as its value, so a long context would hit the argv
    // limit; the CLI's own prompt file avoids that.
    promptDelivery: 'prompt-file',
    generateArgs: (cliModel, promptFile) => [
      '--prompt-file',
      promptFile ?? '',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
      '--no-subagents',
      '--disable-web-search',
      '--verbatim',
      ...(cliModel ? ['-m', cliModel] : []),
      '--tools',
      '',
    ],
    modelDiscovery: {
      args: ['models'],
      parse: (text) => parseListedModels(text, /available models:/i),
    },
    forceProxyByDefault: true,
  },
  qoder: {
    displayName: 'Qoder Local Provider',
    shortName: 'Qoder',
    modelPrefix: 'qoder/',
    cliPaths: [
      path.join(os.homedir(), '.local', 'bin', 'qodercli'),
      path.join(os.homedir(), '.qodersec', 'bin', 'qodercli'),
      '/opt/homebrew/bin/qodercli',
      '/usr/local/bin/qodercli',
    ],
    bareCommand: 'qodercli',
    versionedCliRoot: path.join(os.homedir(), '.qoder', 'bin', 'qodercli'),
    promptDelivery: 'stdin',
    generateArgs: (cliModel) => [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dont_ask',
      '--no-session-persistence',
      ...(cliModel ? ['-m', cliModel] : []),
      // `--tools` is variadic here, so it has to stay last or it swallows the
      // flags that follow it.
      '--tools',
      '',
    ],
    modelDiscovery: {
      args: ['--list-models'],
      parse: (text) => parseListedModels(text),
    },
    forceProxyByDefault: false,
  },
  workbuddy: {
    displayName: 'WorkBuddy Local Provider',
    shortName: 'WorkBuddy',
    modelPrefix: 'workbuddy/',
    cliPaths: [
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
      path.join(os.homedir(), 'Applications', 'WorkBuddy.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
      path.join(os.homedir(), '.local', 'bin', 'codebuddy'),
      '/opt/homebrew/bin/codebuddy',
      '/usr/local/bin/codebuddy',
    ],
    // No PATH fallback on purpose: both WorkBuddy products ship an identical
    // `codebuddy` command, so resolving by name could silently drive the other
    // product's account and endpoint.
    promptDelivery: 'stdin',
    generateArgs: workBuddyGenerateArgs,
    modelDiscovery: {
      args: workBuddyGenerateArgs(WORKBUDDY_MODEL_PROBE),
      stdin: WORKBUDDY_MODEL_PROBE_PROMPT,
      parse: (text) => parseListedModels(text, /supported models/i),
    },
    forceProxyByDefault: false,
  },
  'workbuddy-ai': {
    displayName: 'WorkBuddy AI Local Provider',
    shortName: 'WorkBuddy AI',
    modelPrefix: 'workbuddy-ai/',
    cliPaths: [
      '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
      path.join(os.homedir(), 'Applications', 'WorkBuddy AI.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    ],
    // See the WorkBuddy profile: the shared command name makes a PATH fallback
    // unsafe here too.
    promptDelivery: 'stdin',
    generateArgs: workBuddyGenerateArgs,
    modelDiscovery: {
      args: workBuddyGenerateArgs(WORKBUDDY_MODEL_PROBE),
      stdin: WORKBUDDY_MODEL_PROBE_PROMPT,
      parse: (text) => parseListedModels(text, /supported models/i),
    },
    // Overseas endpoint, but it answers directly, and forcing a proxy would make
    // the provider unusable on machines that have none.
    forceProxyByDefault: false,
  },
};

function workBuddyGenerateArgs(cliModel: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    ...(cliModel ? ['--model', cliModel] : []),
    '--tools',
    '',
  ];
}

export interface AgentCliLocalProviderOptions {
  id: string;
  vendor: AgentCliVendor;
  displayName?: string;
  cliPath?: string;
  workDir?: string;
  timeoutMs?: number;
  modelCacheTtlMs?: number;
  modelDiscoveryTimeoutMs?: number;
  proxyUrl?: string;
  forceProxy?: boolean;
  experimental?: boolean;
}

// The model namespace a vendor's models are published under, so routing can send
// `workbuddy/glm-5.3` to the WorkBuddy provider without an explicit providerId.
export function agentCliModelPrefix(vendor: AgentCliVendor): string {
  return PROFILES[vendor].modelPrefix;
}

export function isAgentCliVendor(value: unknown): value is AgentCliVendor {
  return typeof value === 'string' && (AGENT_CLI_VENDORS as string[]).includes(value);
}

export class AgentCliLocalProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'agent-cli-local' as const;
  readonly vendor: AgentCliVendor;
  private readonly profile: AgentCliProfile;
  private readonly displayName: string;
  private readonly configuredCliPath?: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly modelCacheTtlMs: number;
  private readonly modelDiscoveryTimeoutMs: number;
  private readonly proxyUrl?: string;
  private readonly forceProxy: boolean;
  private readonly experimental: boolean;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };
  private modelDiscoveryInFlight?: Promise<BrainModelDescriptor[]>;
  // What the last discovery learned, kept so status costs nothing to report.
  private lastDiscovery?: {
    at: string;
    modelCount: number;
    cliPath?: string;
    error?: string;
  };
  private lastDiscoveryOutput?: string;

  constructor(options: AgentCliLocalProviderOptions) {
    if (!isAgentCliVendor(options.vendor)) {
      throw new Error(`unsupported agent CLI vendor: ${String(options.vendor)}`);
    }
    this.id = options.id;
    this.vendor = options.vendor;
    this.profile = PROFILES[options.vendor];
    this.displayName = options.displayName ?? this.profile.displayName;
    this.configuredCliPath = options.cliPath;
    this.workDir = options.workDir
      ?? path.join(os.homedir(), 'Library', 'Application Support', 'LocalBrain', `${options.vendor}-workdir`);
    this.timeoutMs = options.timeoutMs ?? 900_000;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? 60_000;
    this.modelDiscoveryTimeoutMs = options.modelDiscoveryTimeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
    this.proxyUrl = options.proxyUrl;
    this.forceProxy = options.forceProxy ?? this.profile.forceProxyByDefault;
    this.experimental = options.experimental ?? true;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      supportsStreaming: false,
      supportsTools: false,
      // The CLI runs locally but reaches the vendor's cloud with its own login.
      localOnly: false,
      experimental: this.experimental,
    };
  }

  async listModels(): Promise<BrainModelDescriptor[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return this.modelCache.models;
    }

    // Discovery spawns a CLI process and can take seconds, while the gateway
    // asks for the catalog on nearly every request. Concurrent callers share one
    // run instead of each starting their own.
    this.modelDiscoveryInFlight ??= this.refreshModels().finally(() => {
      this.modelDiscoveryInFlight = undefined;
    });
    return this.modelDiscoveryInFlight;
  }

  private async refreshModels(): Promise<BrainModelDescriptor[]> {
    let models: BrainModelDescriptor[] = [];
    let ok = false;
    let failure: string | undefined;
    let cliPath: string | undefined;
    try {
      cliPath = await this.resolveCliPath();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (!failure) {
      try {
        models = (await this.discoverModels()).map((id) => ({
          id: `${this.profile.modelPrefix}${id}`,
          providerId: this.id,
          displayName: `${this.profile.shortName} ${id}`,
        }));
        ok = true;
      } catch (error) {
        // A signed-out CLI is the common case and must not break `/v1/models`
        // for every other provider, so discovery degrades to an empty catalog.
        failure = error instanceof Error ? error.message : String(error);
      }
    }

    if (failure) {
      console.warn(`[${this.id}] model discovery failed: ${failure}`);
    }
    this.lastDiscovery = {
      at: new Date().toISOString(),
      modelCount: models.length,
      cliPath,
      error: failure ?? (models.length === 0 ? this.lastDiscoveryHint() : undefined),
    };

    // An empty catalog from a CLI that answered is still a failure to report
    // anything, and re-probing it every minute is what makes a signed-out
    // provider expensive.
    const ttl = ok && models.length > 0 ? this.modelCacheTtlMs : FAILED_DISCOVERY_CACHE_MS;
    this.modelCache = {
      expiresAt: Date.now() + ttl,
      models,
    };
    return models;
  }

  // Derived entirely from the last discovery, so the menu can ask on every
  // refresh without spawning anything.
  checkStatus(): BrainProviderStatus {
    const discovery = this.lastDiscovery;
    const dependency = {
      kind: 'cli' as const,
      name: this.profile.bareCommand ?? this.profile.cliPaths[0].split('/').pop() ?? 'CLI',
      path: discovery?.cliPath,
      found: discovery?.cliPath !== undefined,
    };

    if (!discovery) {
      return { providerId: this.id, state: 'unknown', dependency };
    }
    const base = {
      providerId: this.id,
      dependency,
      modelCount: discovery.modelCount,
      checkedAt: discovery.at,
      error: discovery.error,
    };
    if (discovery.modelCount > 0) {
      return { ...base, state: 'ready' };
    }
    if (!discovery.cliPath) {
      return { ...base, state: 'missing-dependency' };
    }
    return { ...base, state: looksSignedOut(discovery.error) ? 'signed-out' : 'error' };
  }

  // Discovery can succeed as a process and still report nothing, which for these
  // CLIs means the catalog was refused rather than empty. The CLI's own prose
  // says which, so prefer it over a generic line.
  private lastDiscoveryHint(): string {
    return this.lastDiscoveryOutput || `${this.displayName} returned no models`;
  }

  private async discoverModels(): Promise<string[]> {
    const discovery = this.profile.modelDiscovery;
    const { stdout, stderr } = await this.runCli(discovery.args, discovery.stdin ?? '', this.modelDiscoveryTimeoutMs);
    const output = `${stdout}\n${stderr}`;
    const models = discovery.parse(output);
    // A CLI that lists nothing usually said why in prose the parser drops
    // ("Not logged in. Run `qodercli login`"). Keep it so status can tell a
    // signed-out CLI apart from one that genuinely has no models.
    this.lastDiscoveryOutput = models.length === 0 ? output.trim().slice(0, 400) : undefined;
    return models;
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    await mkdir(this.workDir, { recursive: true });
    const prompt = toAgentPrompt(request.messages);
    const cliModel = this.toCliModel(request.model);

    let promptFile: string | undefined;
    if (this.profile.promptDelivery === 'prompt-file') {
      promptFile = path.join(this.workDir, `prompt-${randomUUID()}.txt`);
      await writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
    }

    try {
      const args = this.profile.generateArgs(cliModel, promptFile);
      const run = await this.runCli(args, promptFile ? '' : prompt, this.timeoutMs);
      const content = extractAgentCliResult(run, this.displayName);

      return {
        providerId: this.id,
        model: request.model,
        message: {
          role: 'assistant',
          content: content.text,
        },
        toolCalls: [],
        finishReason: 'stop',
        usage: content.usage ?? {
          inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
          outputTokens: content.text.length,
        },
        raw: content.raw,
      };
    } finally {
      if (promptFile) {
        await rm(promptFile, { force: true });
      }
    }
  }

  private toCliModel(model: string): string {
    const stripped = model.startsWith(this.profile.modelPrefix)
      ? model.slice(this.profile.modelPrefix.length)
      : model;
    // `default` is LocalBrain's way of saying "whatever the CLI picks", which is
    // what omitting the flag does.
    return stripped === 'default' ? '' : stripped;
  }

  // These CLIs refresh their access token lazily: calls made after an idle period
  // fail with 401 until a refresh lands, then succeed with the token those
  // failures produced. Retrying turns that into a non-event; a CLI that is
  // genuinely signed out just fails every attempt and reports its own message.
  private async runCli(args: string[], stdin: string, timeoutMs: number): Promise<AgentCliRun> {
    const deadline = Date.now() + timeoutMs;
    let run = await this.runCliOnce(args, stdin, timeoutMs);
    for (let attempt = 0; attempt < MAX_STALE_AUTH_RETRIES; attempt += 1) {
      const remaining = deadline - Date.now();
      // Retries share the caller's budget rather than multiplying it, so a
      // signed-out CLI cannot stall a request for three full timeouts.
      if (!looksLikeStaleAuth(run) || remaining <= 0) {
        return run;
      }
      run = await this.runCliOnce(args, stdin, remaining);
    }
    return run;
  }

  private async runCliOnce(args: string[], stdin: string, timeoutMs: number): Promise<AgentCliRun> {
    await mkdir(this.workDir, { recursive: true });
    const cliPath = await this.resolveCliPath();
    return runAgentCli(cliPath, args, stdin, {
      cwd: this.workDir,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      label: this.displayName,
      env: this.forceProxy
        ? proxyEnvironmentIfAvailable(process.env, this.proxyUrl)
        : process.env,
    });
  }

  private async resolveCliPath(): Promise<string> {
    if (this.configuredCliPath && await isExecutable(this.configuredCliPath)) {
      return this.configuredCliPath;
    }

    for (const candidate of [
      ...await discoverVersionedCliPaths(this.profile.versionedCliRoot),
      ...this.profile.cliPaths,
    ]) {
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
    if (this.profile.bareCommand) {
      // Let PATH resolve it, so a fresh install works without config.
      return this.profile.bareCommand;
    }
    throw new Error(
      `${this.displayName}: CLI not found. Looked in ${this.profile.cliPaths.join(', ')}. `
      + 'Install the app, or set options.cliPath to the CLI you want this provider to drive.',
    );
  }
}

// Newest `<name>-<version>` copy first, mirroring how these CLIs self-update
// into a versioned directory and repoint their launcher symlink.
async function discoverVersionedCliPaths(root?: string): Promise<string[]> {
  if (!root) {
    return [];
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.startsWith('.'))
    .sort((left, right) => compareVersionLike(right, left))
    .map((entry) => path.join(root, entry));
}

function compareVersionLike(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/).filter(Boolean).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[^0-9]+/).filter(Boolean).map((part) => Number.parseInt(part, 10));
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

// Only a failed run can be a stale-auth failure. Scanning successful output too
// would re-run the whole generation whenever an answer happens to mention 401.
// A stale-auth failure shows up either as a non-zero exit or, as WorkBuddy does
// it, as an empty stdout with the 401 on stderr.
// These CLIs all say it differently ("Not logged in", "Not signed in",
// "Authentication required", a bare 401), so match the shapes rather than one
// vendor's wording.
function looksSignedOut(text?: string): boolean {
  if (!text) {
    return false;
  }
  return /not (logged|signed) in/i.test(text)
    || /authentication required/i.test(text)
    || /\b401\b/.test(text)
    || /please run .{0,20}login/i.test(text);
}

function looksLikeStaleAuth(run: AgentCliRun): boolean {
  if (run.exitCode === 0 && run.stdout.trim().length > 0) {
    return false;
  }
  const text = `${run.stdout}\n${run.stderr}`;
  return /\b401\b/.test(text) || /authentication required/i.test(text);
}

async function isExecutable(value: string): Promise<boolean> {
  try {
    await access(value, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Catalog listings all look like `  - model-id` or `  * model-id (default)`,
// optionally after a header line. Anything that is not a bullet is prose.
export function parseListedModels(text: string, header?: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const start = header
    ? lines.findIndex((line) => header.test(line))
    : -1;
  if (header && start === -1) {
    return [];
  }

  const models: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*[-*•]\s+([A-Za-z0-9][A-Za-z0-9._:@\/-]*)/.exec(line);
    if (!match) {
      continue;
    }
    const id = match[1];
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(id);
  }
  return models;
}

interface AgentCliRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface AgentCliResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}

// These CLIs disagree on the JSON envelope: Qoder prints one result object,
// WorkBuddy prints the whole message array, Grok prints an error object, and any
// of them may fall back to plain text. Read them all rather than guessing.
export function extractAgentCliResult(run: AgentCliRun, label: string): AgentCliResult {
  const { stderr, exitCode } = run;
  const trimmed = run.stdout.trim();
  if (!trimmed) {
    throw new Error(`${label} failed: ${stderr.trim() || `exited with ${exitCode ?? 'no status'}`}`);
  }

  const payload = parseAgentCliPayload(trimmed);
  if (!payload) {
    if (exitCode !== 0) {
      throw new Error(`${label} failed: ${trimmed || stderr.trim()}`);
    }
    return { text: trimmed };
  }

  const record = payload as Record<string, unknown>;
  const message = stringField(record, 'message');
  const result = stringField(record, 'result');
  // A failed run says so in the envelope, in the exit code, or in both; the
  // CLI's own wording ("Not logged in - run /login") is what the caller needs.
  if (record.type === 'error' || record.is_error === true || record.subtype === 'error' || exitCode !== 0) {
    const reason = message ?? result ?? stringField(record, 'error') ?? stderr.trim();
    throw new Error(`${label} failed: ${reason || 'unknown error'}`);
  }

  const text = result ?? message ?? contentBlocksToText(record.content) ?? trimmed;
  return {
    text,
    usage: toUsage(record.usage),
    raw: {
      type: record.type,
      subtype: record.subtype,
      durationMs: numberField(record, 'duration_ms'),
      numTurns: numberField(record, 'num_turns'),
      sessionId: stringField(record, 'session_id'),
    },
  };
}

// Returns the object that carries the final answer, whichever envelope was used:
// a bare object, the last `result` entry of an array, or the last JSON line of
// an NDJSON stream. `undefined` means the output was not JSON at all.
function parseAgentCliPayload(text: string): unknown {
  const direct = tryParseJson(text);
  if (direct !== undefined) {
    return pickResultEntry(direct);
  }

  const entries: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = tryParseJson(line.trim());
    if (parsed !== undefined) {
      entries.push(parsed);
    }
  }
  return entries.length > 0 ? pickResultEntry(entries) : undefined;
}

function pickResultEntry(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index] as Record<string, unknown> | null;
    if (entry && typeof entry === 'object' && (entry.type === 'result' || entry.type === 'error')) {
      return entry;
    }
  }
  return value[value.length - 1];
}

function tryParseJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function contentBlocksToText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      const record = block as Record<string, unknown> | null;
      return record && typeof record.text === 'string' ? record.text : '';
    })
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('') : undefined;
}

// Undefined rather than a hollow object when the CLI reported no numbers, so the
// caller's character-count estimate still applies.
function toUsage(value: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = numberField(record, 'input_tokens');
  const outputTokens = numberField(record, 'output_tokens');
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function toAgentPrompt(messages: BrainMessage[]): string {
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

function runAgentCli(
  cliPath: string,
  args: string[],
  stdin: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    label: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
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
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${options.label} timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxBuffer) {
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maxBuffer) {
        truncated = true;
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
      if (truncated) {
        // The captured output is a fragment; parsing it would hand the caller a
        // chopped payload dressed up as an answer.
        reject(new Error(`${options.label} exceeded ${options.maxBuffer} bytes of output and was stopped`));
        return;
      }
      // A non-zero exit is how these CLIs report "not signed in" and similar,
      // and their own message reads better than an exit code, so the caller
      // classifies the run instead of this helper.
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? (signal ? -1 : null),
      });
    });
    child.stdin.end(stdin);
  });
}
