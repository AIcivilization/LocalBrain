import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { Socket } from 'node:net';
import tls from 'node:tls';

export interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export function resolveForcedProxyUrl(configuredProxyUrl?: string): string | undefined {
  const configured = normalizeProxyUrl(configuredProxyUrl);
  if (configured) {
    return configured;
  }

  for (const key of ['LOCALBRAIN_PROXY_URL', 'BRAIN_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = normalizeProxyUrl(process.env[key]);
    if (value) {
      return value;
    }
  }

  return macOSSystemProxyUrl() ?? commonLocalProxyUrl();
}

// Routes a child process through the proxy when one can be found, and leaves it
// on the direct path when none can. Refusing to run without a proxy bought
// nothing: on a machine whose connectivity comes from a TUN-mode client there is
// no proxy endpoint to discover, yet direct calls work, so the strict form only
// broke providers that would otherwise have succeeded.
export function proxyEnvironmentIfAvailable(
  baseEnv: NodeJS.ProcessEnv,
  configuredProxyUrl?: string,
): NodeJS.ProcessEnv {
  const proxyUrl = resolveForcedProxyUrl(configuredProxyUrl);
  return proxyUrl ? proxyEnvironment(baseEnv, proxyUrl) : baseEnv;
}

export function proxyEnvironment(baseEnv: NodeJS.ProcessEnv, proxyUrl: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: mergeNoProxy(baseEnv.NO_PROXY ?? baseEnv.no_proxy),
    no_proxy: mergeNoProxy(baseEnv.NO_PROXY ?? baseEnv.no_proxy),
  };
}

export async function fetchViaHttpProxy(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    timeoutMs?: number;
  },
  proxyUrl: string,
): Promise<ProxyFetchResponse> {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== 'http:') {
    throw new Error(`HTTP proxy is required for ${target.hostname}; unsupported proxy protocol: ${proxy.protocol}`);
  }
  if (target.protocol !== 'https:') {
    throw new Error(`HTTPS target is required for proxied provider call: ${url}`);
  }

  const body = typeof init.body === 'string'
    ? Buffer.from(init.body)
    : init.body
      ? Buffer.from(init.body.toString())
      : Buffer.alloc(0);
  const headers = normalizeHeaders(init.headers ?? {});
  if (body.length > 0 && !hasHeader(headers, 'content-length')) {
    headers['Content-Length'] = String(body.length);
  }
  if (!hasHeader(headers, 'host')) {
    headers.Host = target.host;
  }
  headers.Connection = 'close';

  const socket = await connectProxyTunnel(proxy, target, init.timeoutMs ?? 120_000);
  const secureSocket = tls.connect({
    socket,
    servername: target.hostname,
  });

  return await new Promise<ProxyFetchResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      secureSocket.destroy();
      finish(() => reject(new Error(`proxied request timed out after ${init.timeoutMs ?? 120_000}ms`)));
    }, init.timeoutMs ?? 120_000);
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    secureSocket.once('secureConnect', () => {
      const path = `${target.pathname || '/'}${target.search}`;
      const requestHead = [
        `${init.method ?? 'GET'} ${path} HTTP/1.1`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
      ].join('\r\n');
      secureSocket.write(requestHead);
      if (body.length > 0) {
        secureSocket.write(body);
      }
    });
    secureSocket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    secureSocket.once('error', (error) => finish(() => reject(error)));
    secureSocket.once('end', () => {
      finish(() => {
        try {
          resolve(parseHttpResponse(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    });
    secureSocket.once('close', () => {
      if (!settled) {
        finish(() => {
          try {
            resolve(parseHttpResponse(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      }
    });
  });
}

function normalizeProxyUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function macOSSystemProxyUrl(): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  try {
    const output = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 256 * 1024,
    });
    const httpsEnabled = output.match(/HTTPSEnable\s*:\s*1/) !== null;
    const httpsHost = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const httpsPort = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (httpsEnabled && httpsHost && httpsPort) {
      return `http://${httpsHost}:${httpsPort}`;
    }
    const httpEnabled = output.match(/HTTPEnable\s*:\s*1/) !== null;
    const httpHost = output.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const httpPort = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
    if (httpEnabled && httpHost && httpPort) {
      return `http://${httpHost}:${httpPort}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function commonLocalProxyUrl(): string | undefined {
  for (const port of [1082, 7890, 7897, 1087, 1080, 8080, 6152, 6153]) {
    if (isPortOpen('127.0.0.1', port)) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return undefined;
}

function isPortOpen(host: string, port: number): boolean {
  try {
    execFileSync('nc', ['-z', host, String(port)], {
      timeout: 500,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function mergeNoProxy(existing?: string): string {
  const values = new Set((existing ?? '').split(',').map((item) => item.trim()).filter(Boolean));
  for (const value of ['127.0.0.1', 'localhost', '::1']) {
    values.add(value);
  }
  return [...values].join(',');
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = value;
  }
  return normalized;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function proxyAuthHeader(proxy: URL): Record<string, string> {
  if (!proxy.username) {
    return {};
  }
  const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
  return {
    'Proxy-Authorization': `Basic ${auth}`,
  };
}

function connectProxyTunnel(proxy: URL, target: URL, timeoutMs: number): Promise<Socket> {
  const targetPort = target.port || '443';
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...proxyAuthHeader(proxy),
      },
      timeout: timeoutMs,
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${response.statusCode} ${response.statusMessage ?? ''}`.trim()));
        return;
      }
      resolve(socket);
    });
    request.once('timeout', () => {
      request.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`));
    });
    request.once('error', reject);
    request.end();
  });
}

function parseHttpResponse(buffer: Buffer): ProxyFetchResponse {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator < 0) {
    throw new Error('proxied response did not contain HTTP headers');
  }
  const head = buffer.subarray(0, separator).toString('utf8');
  const body = buffer.subarray(separator + 4);
  const lines = head.split(/\r?\n/);
  const statusMatch = lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
  if (!statusMatch) {
    throw new Error('proxied response had an invalid HTTP status line');
  }
  const status = Number(statusMatch[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) {
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
  }
  const bodyText = decodeResponseBody(body, headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusMatch[2] ?? '',
    headers,
    async text() {
      return bodyText;
    },
    async json() {
      return JSON.parse(bodyText) as unknown;
    },
  };
}

function decodeResponseBody(body: Buffer, headers: Record<string, string>): string {
  if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    return decodeChunkedBody(body).toString('utf8');
  }
  return body.toString('utf8');
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) {
      break;
    }
    const sizeText = body.subarray(offset, lineEnd).toString('ascii').split(';')[0];
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      break;
    }
    offset = lineEnd + 2;
    if (size === 0) {
      break;
    }
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}
