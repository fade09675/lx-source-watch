import httpMod from 'node:http';
import type { Agent as HttpAgent } from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { TimeoutError } from '../util.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface ProxyConfig {
  url: string;
  /** 仅 host:port，用于日志与快照，绝不包含账号密码。 */
  label: string;
}

export function parseProxy(raw: string | undefined): ProxyConfig | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    if (!/^(https?|socks[45]?):$/.test(u.protocol)) return undefined;
    const port = u.port || (u.protocol.startsWith('socks') ? '1080' : u.protocol === 'https:' ? '443' : '80');
    return { url: u.toString(), label: `${u.hostname}:${port}` };
  } catch {
    return undefined;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  proxy?: ProxyConfig;
  /** 测试/本地开发允许访问 localhost。 */
  allowPrivate?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  /** 最后一个 hop 从发起到收到响应头的耗时。 */
  firstByteMs: number;
  totalMs: number;
  url: string;
  truncated: boolean;
  redirects: number;
}

const directHttp = new httpMod.Agent({ keepAlive: true, maxSockets: 24 });
const directHttps = new https.Agent({ keepAlive: true, maxSockets: 24 });
const proxyAgents = new Map<string, { http: HttpAgent; https: HttpAgent }>();

function agentsFor(proxy: ProxyConfig): { http: HttpAgent; https: HttpAgent } {
  const cached = proxyAgents.get(proxy.url);
  if (cached) return cached;
  let agents: { http: HttpAgent; https: HttpAgent };
  if (/^socks/i.test(proxy.url)) {
    const a = new SocksProxyAgent(proxy.url) as unknown as HttpAgent;
    agents = { http: a, https: a };
  } else {
    agents = {
      http: new HttpProxyAgent(proxy.url) as unknown as HttpAgent,
      https: new HttpsProxyAgent(proxy.url) as unknown as HttpAgent,
    };
  }
  proxyAgents.set(proxy.url, agents);
  return agents;
}

const checkedHosts = new Map<string, number>();
const HOST_CHECK_TTL = 5 * 60_000;

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    const [a, b] = [p[0] ?? 0, p[1] ?? 0];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
  return false;
}

const PRIVATE_HOST = 'EPRIVATEHOST';

async function assertPublicUrl(raw: string): Promise<void> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error(`不允许的协议：${u.protocol}`), { code: PRIVATE_HOST });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw Object.assign(new Error(`不允许访问内网地址：${host}`), { code: PRIVATE_HOST });
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw Object.assign(new Error(`不允许访问内网地址：${host}`), { code: PRIVATE_HOST });
    return;
  }
  const last = checkedHosts.get(host);
  if (last && Date.now() - last < HOST_CHECK_TTL) return;
  const addrs = await lookup(host, { all: true, verbatim: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw Object.assign(new Error(`域名解析到内网地址：${host} → ${a.address}`), { code: PRIVATE_HOST });
    }
  }
  checkedHosts.set(host, Date.now());
}

function normalizeHeaders(input: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function maybeDecompress(body: Buffer, encoding: string | undefined): Buffer {
  if (!body.length || !encoding) return body;
  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(body);
    if (encoding.includes('deflate')) return zlib.inflateSync(body);
    if (encoding.includes('br')) return zlib.brotliDecompressSync(body);
  } catch {
    // 已经解码过或数据不完整时保持原样。
  }
  return body;
}

interface HopResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  firstByteMs: number;
  truncated: boolean;
}

function requestOnce(rawUrl: string, opts: RequestOptions): Promise<HopResult> {
  const u = new URL(rawUrl);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : httpMod;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers = { ...(opts.headers ?? {}) };
  if (!hasHeader(headers, 'user-agent')) headers['user-agent'] = USER_AGENT;
  if (!hasHeader(headers, 'accept')) headers['accept'] = '*/*';
  if (!hasHeader(headers, 'accept-encoding')) headers['accept-encoding'] = 'identity';

  let agent: HttpAgent | undefined;
  if (opts.proxy) {
    const agents = agentsFor(opts.proxy);
    agent = isHttps ? agents.https : agents.http;
  } else {
    agent = isHttps ? directHttps : directHttp;
  }

  return new Promise<HopResult>((resolve, reject) => {
    const started = performance.now();
    let settled = false;
    let truncated = false;
    let firstByteMs = 0;
    const chunks: Buffer[] = [];
    let size = 0;
    let response: import('node:http').IncomingMessage | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = lib.request(
      u,
      { method, headers, agent, timeout: timeoutMs },
      (res) => {
        response = res;
        firstByteMs = performance.now() - started;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBytes) {
            truncated = true;
            res.destroy();
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? '',
                headers: normalizeHeaders(res.headers),
                body: Buffer.concat(chunks).subarray(0, maxBytes),
                firstByteMs,
                truncated,
              }),
            );
          }
        });
        const done = (): void => {
          const raw = Buffer.concat(chunks);
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: normalizeHeaders(res.headers),
              body: maybeDecompress(raw, res.headers['content-encoding']),
              firstByteMs,
              truncated,
            }),
          );
        };
        res.on('end', done);
        res.on('error', (e) => {
          if (truncated) return;
          finish(() => reject(e));
        });
        res.on('close', () => {
          if (truncated) return;
          if (!res.complete) {
            finish(() => reject(Object.assign(new Error('连接提前关闭'), { code: 'ECONNRESET' })));
          }
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new TimeoutError(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);

    req.on('error', (e) => {
      if (truncated) return;
      finish(() => reject(e));
    });

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' }));
      } else {
        opts.signal.addEventListener(
          'abort',
          () => req.destroy(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' })),
          { once: true },
        );
      }
    }

    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export async function httpRequest(rawUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const started = performance.now();
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = rawUrl;
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body;
  let redirects = 0;

  for (;;) {
    if (!opts.proxy && !opts.allowPrivate) {
      await assertPublicUrl(current);
    }
    const hop = await requestOnce(current, { ...opts, method, body });
    const location = hop.headers.location;
    if (hop.status >= 300 && hop.status < 400 && location && redirects < maxRedirects) {
      redirects++;
      current = new URL(location, current).href;
      if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return {
      ...hop,
      url: current,
      redirects,
      totalMs: performance.now() - started,
    };
  }
}

/** 给沙箱脚本用的简化 fetch。 */
export async function simpleFetch(
  input: string | URL,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
  proxy?: ProxyConfig,
): Promise<Response> {
  const res = await httpRequest(String(input), {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    proxy,
    timeoutMs: 30_000,
  });
  const bodyInit = res.status === 204 || res.status === 304 ? null : res.body;
  const arrayBuffer =
    bodyInit === null
      ? null
      : (bodyInit.buffer.slice(
          bodyInit.byteOffset,
          bodyInit.byteOffset + bodyInit.byteLength,
        ) as ArrayBuffer);
  return new Response(arrayBuffer, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
