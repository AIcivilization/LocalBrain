import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  BrainImageGenerationRequest,
  BrainImageGenerationResponse,
  BrainMessage,
  BrainModelDescriptor,
  BrainProvider,
  BrainProviderDescriptor,
  BrainProviderRequest,
  BrainProviderResponse,
} from '../types.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_STATE_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Antigravity',
  'User',
  'globalStorage',
  'state.vscdb',
);

const KNOWN_ANTIGRAVITY_MODELS: Array<{ displayName: string; id: string; enumNumber: number; free?: boolean }> = [
  {
    displayName: 'Gemini 3.1 Pro (High)',
    id: 'antigravity/gemini-3.1-pro-high',
    enumNumber: 1037,
  },
  {
    displayName: 'Gemini 3.1 Pro (Low)',
    id: 'antigravity/gemini-3.1-pro-low',
    enumNumber: 1036,
  },
  {
    displayName: 'Gemini 3 Flash',
    id: 'antigravity/gemini-3-flash',
    enumNumber: 1047,
  },
  {
    displayName: 'Claude Sonnet 4.6 (Thinking)',
    id: 'antigravity/claude-sonnet-4.6-thinking',
    enumNumber: 1035,
  },
  {
    displayName: 'Claude Opus 4.6 (Thinking)',
    id: 'antigravity/claude-opus-4.6-thinking',
    enumNumber: 1026,
  },
  {
    displayName: 'GPT-OSS 120B (Medium)',
    id: 'antigravity/gpt-oss-120b-medium',
    enumNumber: 342,
  },
];

export interface AntigravityLocalProviderOptions {
  id: string;
  displayName?: string;
  stateDbPath?: string;
  sqlitePath?: string;
  httpsServerPort?: number;
  csrfToken?: string;
  imageOutputDir?: string;
  workspaceUri?: string;
  modelCacheTtlMs?: number;
  experimental?: boolean;
}

interface AntigravityAuthStatus {
  userStatusProtoBinaryBase64?: string;
}

export class AntigravityLocalBrainProvider implements BrainProvider {
  readonly id: string;
  readonly kind = 'antigravity-local' as const;
  private readonly displayName: string;
  private readonly stateDbPath: string;
  private readonly sqlitePath: string;
  private readonly httpsServerPort?: number;
  private readonly csrfToken?: string;
  private readonly imageOutputDir: string;
  private readonly workspaceUri?: string;
  private readonly modelCacheTtlMs: number;
  private readonly experimental: boolean;
  private modelCache?: {
    expiresAt: number;
    models: BrainModelDescriptor[];
  };

  constructor(options: AntigravityLocalProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName ?? 'Antigravity Local Provider';
    this.stateDbPath = options.stateDbPath ?? DEFAULT_STATE_DB_PATH;
    this.sqlitePath = options.sqlitePath ?? 'sqlite3';
    this.httpsServerPort = options.httpsServerPort;
    this.csrfToken = options.csrfToken;
    this.imageOutputDir = options.imageOutputDir ?? path.join(process.cwd(), 'logs', 'antigravity-images');
    this.workspaceUri = options.workspaceUri;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? 60_000;
    this.experimental = options.experimental ?? true;
  }

  describe(): BrainProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      supportsStreaming: false,
      supportsTools: false,
      localOnly: false,
      experimental: this.experimental,
    };
  }

  async generateImage(request: BrainImageGenerationRequest): Promise<BrainImageGenerationResponse> {
    const model = await this.resolveModel(request.model);
    const endpoint = await this.resolveGrpcEndpoint();
    const imagePaths = await requestAntigravityImageGeneration({
      endpoint,
      prompt: request.prompt,
      modelEnum: model.enumNumber,
      outputDir: this.imageOutputDir,
      workspaceUri: this.workspaceUri ?? pathToFileUri(process.cwd()),
    });

    return {
      providerId: this.id,
      model: request.model,
      images: await Promise.all(imagePaths.slice(0, request.n ?? 1).map(async (imagePath) => ({
        path: imagePath,
        url: pathToFileUri(imagePath),
        b64Json: (await readFile(imagePath)).toString('base64'),
        mimeType: mimeTypeForPath(imagePath),
        revisedPrompt: request.prompt,
      }))),
      raw: {
        imagePaths,
      },
    };
  }

  async listModels(): Promise<BrainModelDescriptor[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    const userStatus = await this.readUserStatusProto();
    const discovered = discoverAntigravityModels(userStatus);
    const models = discovered.map((model) => ({
      id: model.id,
      providerId: this.id,
      displayName: model.displayName,
      free: model.free,
    }));

    this.modelCache = {
      expiresAt: now + this.modelCacheTtlMs,
      models,
    };
    return models;
  }

  async generate(request: BrainProviderRequest): Promise<BrainProviderResponse> {
    const model = await this.resolveModel(request.model);
    const endpoint = await this.resolveGrpcEndpoint();
    const content = await requestAntigravityModelResponse({
      endpoint,
      prompt: buildAntigravityPrompt(request.messages),
      modelEnum: model.enumNumber,
    });

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
    };
  }

  private async resolveModel(modelId: string): Promise<{ displayName: string; enumNumber: number }> {
    const userStatus = await this.readUserStatusProto();
    const model = discoverAntigravityModels(userStatus).find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`unsupported Antigravity model: ${modelId}`);
    }
    return model;
  }

  private async readUserStatusProto(): Promise<Buffer> {
    const authStatus = await this.readJsonValue<AntigravityAuthStatus>('antigravityAuthStatus');
    const encoded = authStatus.userStatusProtoBinaryBase64;
    if (!encoded) {
      throw new Error(`Antigravity state at ${this.stateDbPath} does not contain userStatusProtoBinaryBase64`);
    }
    return Buffer.from(encoded, 'base64');
  }

  private async readJsonValue<T>(key: string): Promise<T> {
    const { stdout } = await execFileAsync(this.sqlitePath, [
      this.stateDbPath,
      `select value from ItemTable where key = '${key.replaceAll("'", "''")}';`,
    ], {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text) {
      throw new Error(`Antigravity state key not found: ${key}`);
    }
    return JSON.parse(text) as T;
  }

  private async resolveGrpcEndpoint(): Promise<{ port: number; csrfToken: string }> {
    if (this.httpsServerPort && this.csrfToken) {
      return {
        port: this.httpsServerPort,
        csrfToken: this.csrfToken,
      };
    }

    const { stdout } = await execFileAsync('ps', ['aux'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('language_server_macos_arm') || !line.includes('--https_server_port')) {
        continue;
      }
      const port = Number(matchProcessArg(line, '--https_server_port'));
      const csrfToken = matchProcessArg(line, '--csrf_token');
      if (Number.isInteger(port) && port > 0 && csrfToken) {
        return {
          port,
          csrfToken,
        };
      }
    }

    throw new Error('Antigravity local language server is not running. Open Antigravity, then retry.');
  }
}

interface AntigravityGrpcEndpoint {
  port: number;
  csrfToken: string;
}

async function requestAntigravityModelResponse(options: {
  endpoint: AntigravityGrpcEndpoint;
  prompt: string;
  modelEnum: number;
}): Promise<string> {
  const message = Buffer.concat([
    encodeStringField(1, options.prompt),
    encodeVarintField(2, options.modelEnum),
  ]);
  const responseMessages = await requestAntigravityUnary({
    endpoint: options.endpoint,
    path: '/exa.language_server_pb.LanguageServerService/GetModelResponse',
    message,
    timeoutMs: 180_000,
  });

  const output = responseMessages
    .map((responseMessage) => decodeStringField(responseMessage, 1))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('');
  if (!output) {
    throw new Error('Antigravity local gRPC returned no assistant content');
  }
  return output;
}

async function requestAntigravityImageGeneration(options: {
  endpoint: AntigravityGrpcEndpoint;
  prompt: string;
  modelEnum: number;
  outputDir: string;
  workspaceUri: string;
}): Promise<string[]> {
  await mkdir(options.outputDir, { recursive: true });

  const cascadeId = randomUUID();
  const plannerConfig = Buffer.concat([
    encodeVarintField(1, options.modelEnum),
    encodeMessageField(15, encodeVarintField(1, options.modelEnum)),
    encodeMessageField(13, encodeMessageField(40, encodeStringField(2, options.outputDir))),
  ]);
  const cascadeConfig = encodeMessageField(1, plannerConfig);
  const customAgentSpec = encodeMessageField(11, cascadeConfig);

  await requestAntigravityUnary({
    endpoint: options.endpoint,
    path: '/exa.language_server_pb.LanguageServerService/StartCascade',
    message: Buffer.concat([
      encodeVarintField(4, 1),
      encodeVarintField(5, 4),
      encodeStringField(7, cascadeId),
      encodeStringField(8, options.workspaceUri),
      encodeMessageField(11, customAgentSpec),
    ]),
    timeoutMs: 30_000,
  });

  const imagePrompt = [
    'Use the generate_image tool to create the requested image.',
    'Save the image to the configured output directory and return the generated file path.',
    options.prompt,
  ].join('\n\n');

  await requestAntigravityUnary({
    endpoint: options.endpoint,
    path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
    message: Buffer.concat([
      encodeStringField(1, cascadeId),
      encodeMessageField(2, encodeStringField(1, imagePrompt)),
      encodeMessageField(5, cascadeConfig),
      encodeBooleanField(8, true),
      encodeVarintField(11, 1),
    ]),
    timeoutMs: 300_000,
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const messages = await requestAntigravityUnary({
      endpoint: options.endpoint,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      message: Buffer.concat([
        encodeStringField(1, cascadeId),
        encodeVarintField(4, 3),
      ]),
      timeoutMs: 30_000,
    });
    const imagePaths = extractImagePaths(Buffer.concat(messages), options.outputDir);
    if (imagePaths.length > 0) {
      return imagePaths;
    }
    await sleep(2_000);
  }

  throw new Error('Antigravity image generation finished without a discoverable image path');
}

async function requestAntigravityUnary(options: {
  endpoint: AntigravityGrpcEndpoint;
  path: string;
  message: Buffer;
  timeoutMs: number;
}): Promise<Buffer[]> {
  const body = encodeGrpcFrame(options.message);
  const client = http2.connect(`https://127.0.0.1:${options.endpoint.port}`, {
    rejectUnauthorized: false,
  });

  try {
    return await new Promise<Buffer[]>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let grpcStatus = 'unknown';
      let grpcMessage = '';
      const request = client.request({
        ':method': 'POST',
        ':path': options.path,
        'content-type': 'application/grpc',
        te: 'trailers',
        'x-codeium-csrf-token': options.endpoint.csrfToken,
      });

      const timeout = setTimeout(() => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('Antigravity local gRPC request timed out'));
      }, options.timeoutMs);

      request.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on('trailers', (trailers) => {
        if (typeof trailers['grpc-status'] === 'string') {
          grpcStatus = trailers['grpc-status'];
        }
        if (typeof trailers['grpc-message'] === 'string') {
          grpcMessage = decodeURIComponent(trailers['grpc-message']);
        }
      });
      request.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      request.on('end', () => {
        clearTimeout(timeout);
        if (grpcStatus !== '0' && grpcStatus !== 'unknown') {
          reject(new Error(`Antigravity local gRPC failed: ${grpcStatus} ${grpcMessage}`.trim()));
          return;
        }
        resolve(decodeGrpcFrames(Buffer.concat(chunks)));
      });

      request.end(body);
    });
  } finally {
    client.close();
  }
}

function discoverAntigravityModels(userStatus: Buffer): Array<{ displayName: string; id: string; enumNumber: number; free?: boolean }> {
  const discovered = new Map<string, { displayName: string; id: string; enumNumber: number; free?: boolean }>();

  for (const known of KNOWN_ANTIGRAVITY_MODELS) {
    if (!bufferIncludesUtf8(userStatus, known.displayName)) {
      continue;
    }
    discovered.set(known.id, known);
  }

  for (const candidate of scanModelEntries(userStatus)) {
    const known = KNOWN_ANTIGRAVITY_MODELS.find((model) => model.displayName === candidate.displayName);
    const id = known?.id ?? `antigravity/${slugifyModelName(candidate.displayName)}`;
    discovered.set(id, {
      displayName: candidate.displayName,
      id,
      enumNumber: candidate.enumNumber ?? known?.enumNumber ?? 0,
      free: known?.free,
    });
  }

  return [...discovered.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function scanModelEntries(userStatus: Buffer): Array<{ displayName: string; enumNumber?: number }> {
  const entries: Array<{ displayName: string; enumNumber?: number }> = [];
  const strings = extractAsciiStrings(userStatus);
  for (const item of strings) {
    if (!looksLikeModelDisplayName(item.value)) {
      continue;
    }
    entries.push({
      displayName: item.value,
      enumNumber: findNearbyModelEnum(userStatus, item.end),
    });
  }
  return entries;
}

function extractAsciiStrings(buffer: Buffer): Array<{ value: string; start: number; end: number }> {
  const strings: Array<{ value: string; start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable && start === -1) {
      start = index;
    }
    if ((!printable || index === buffer.length - 1) && start !== -1) {
      const end = printable && index === buffer.length - 1 ? index + 1 : index;
      if (end - start >= 3) {
        strings.push({
          value: buffer.subarray(start, end).toString('utf8'),
          start,
          end,
        });
      }
      start = -1;
    }
  }
  return strings;
}

function findNearbyModelEnum(buffer: Buffer, offset: number): number | undefined {
  const end = Math.min(buffer.length, offset + 80);
  for (let index = offset; index < end - 2; index += 1) {
    if (buffer[index] !== 0x12) {
      continue;
    }
    const length = buffer[index + 1];
    const messageStart = index + 2;
    const messageEnd = Math.min(buffer.length, messageStart + length);
    if (length <= 0 || messageEnd > end + 40) {
      continue;
    }
    for (let inner = messageStart; inner < messageEnd - 1; inner += 1) {
      if (buffer[inner] === 0x08) {
        return readVarint(buffer, inner + 1)?.value;
      }
    }
  }
  return undefined;
}

function encodeGrpcFrame(message: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function decodeGrpcFrames(buffer: Buffer): Buffer[] {
  const messages: Buffer[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const compressed = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (compressed !== 0) {
      throw new Error('Antigravity local gRPC returned compressed content');
    }
    if (end > buffer.length) {
      throw new Error('Antigravity local gRPC returned a truncated frame');
    }
    messages.push(buffer.subarray(start, end));
    offset = end;
  }
  return messages;
}

function encodeStringField(field: number, value: string): Buffer {
  const content = Buffer.from(value, 'utf8');
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(content.length),
    content,
  ]);
}

function encodeMessageField(field: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(value.length),
    value,
  ]);
}

function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([
    encodeVarint((field << 3) | 0),
    encodeVarint(value),
  ]);
}

function encodeBooleanField(field: number, value: boolean): Buffer {
  return encodeVarintField(field, value ? 1 : 0);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function readVarint(buffer: Buffer, offset: number): { value: number; nextOffset: number } | undefined {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < buffer.length && index < offset + 10; index += 1) {
    const byte = buffer[index];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return {
        value,
        nextOffset: index + 1,
      };
    }
    shift += 7;
  }
  return undefined;
}

function decodeStringField(buffer: Buffer, field: number): string | undefined {
  const tag = (field << 3) | 2;
  let index = 0;
  while (index < buffer.length) {
    const fieldInfo = readVarint(buffer, index);
    if (!fieldInfo) {
      return undefined;
    }
    const wireType = fieldInfo.value & 0x07;
    const fieldNumber = fieldInfo.value >> 3;
    index = fieldInfo.nextOffset;
    if (wireType === 2) {
      const lengthInfo = readVarint(buffer, index);
      if (!lengthInfo) {
        return undefined;
      }
      const start = lengthInfo.nextOffset;
      const end = start + lengthInfo.value;
      if (end > buffer.length) {
        return undefined;
      }
      if (fieldNumber === field || fieldInfo.value === tag) {
        return buffer.subarray(start, end).toString('utf8');
      }
      index = end;
      continue;
    }
    if (wireType === 0) {
      const valueInfo = readVarint(buffer, index);
      if (!valueInfo) {
        return undefined;
      }
      index = valueInfo.nextOffset;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function matchProcessArg(line: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line.match(new RegExp(`${escaped}\\s+([^\\s]+)`))?.[1];
}

function extractImagePaths(buffer: Buffer, outputDir: string): string[] {
  const text = buffer.toString('latin1');
  const values = new Set<string>();
  for (const match of text.matchAll(/file:\/\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp)/gi)) {
    values.add(fileUriToPath(match[0]));
  }
  const escapedOutputDir = outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of text.matchAll(new RegExp(`${escapedOutputDir}[^\\s"'<>]+?\\.(?:png|jpe?g|webp)`, 'gi'))) {
    values.add(match[0]);
  }
  return [...values];
}

function pathToFileUri(filePath: string): string {
  return `file://${path.resolve(filePath).split(path.sep).map(encodeURIComponent).join('/')}`;
}

function fileUriToPath(uri: string): string {
  return decodeURIComponent(new URL(uri).pathname);
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  return 'image/png';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeModelDisplayName(value: string): boolean {
  return /^(Gemini|Claude|GPT|OpenAI|Anthropic)\b/i.test(value)
    && value.length <= 80
    && !value.includes(';');
}

function bufferIncludesUtf8(buffer: Buffer, value: string): boolean {
  return buffer.indexOf(Buffer.from(value, 'utf8')) >= 0;
}

function slugifyModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\(([^)]+)\)/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildAntigravityPrompt(messages: BrainMessage[]): string {
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
