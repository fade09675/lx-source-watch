import { log } from '../logger.js';
import { httpRequest, parseProxy, type ProxyConfig } from '../net/http.js';
import { errorMessage } from '../util.js';
import { startKernel, type KernelHandle } from './mihomo.js';

export interface RunnerProxy {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  config?: string;
  kernelOnly: boolean;
  engine?: string;
  lastOkAt?: string | null;
}

export interface ProxyCheck {
  ok: boolean;
  latencyMs: number;
  egressIp: string;
  error?: string;
}

export interface ActiveProxy {
  client: ProxyConfig;
  kernelOnly: boolean;
  label: string;
  stop: () => Promise<void>;
}

interface ItemsResponse {
  items?: RunnerProxy[];
}

function apiBase(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest\/?$/, '');
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function proxyUrl(proxy: RunnerProxy): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  const scheme = proxy.protocol === 'https' ? 'http' : proxy.protocol === 'socks5h' ? 'socks5' : proxy.protocol;
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

/** 从 Worker 拉取启用的代理池（Bearer RUNNER_TOKEN）。 */
export async function fetchRunnerProxies(
  endpoint: string,
  token: string,
  options: { allowPrivate?: boolean } = {},
): Promise<RunnerProxy[]> {
  const base = apiBase(endpoint);
  const res = await httpRequest(`${base}/api/runner/proxies`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
    allowPrivate: options.allowPrivate,
  });
  if (res.status !== 200) throw new Error(`拉取代理池失败：HTTP ${res.status} ${res.body.toString('utf8').slice(0, 200)}`);
  const data = JSON.parse(res.body.toString('utf8')) as ItemsResponse;
  return (data.items ?? []).filter((proxy) => proxy.host && proxy.port > 0);
}

export async function reportProxyCheck(
  endpoint: string,
  token: string,
  id: string,
  check: ProxyCheck,
  allowPrivate = false,
): Promise<void> {
  try {
    const base = apiBase(endpoint);
    await httpRequest(`${base}/api/runner/proxies/${encodeURIComponent(id)}/check`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(check),
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      allowPrivate,
    });
  } catch (e) {
    log.warn(`回写代理测活失败（忽略）：${errorMessage(e)}`);
  }
}

function parseEgress(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const value = data.ip ?? data.query ?? data.address;
    if (typeof value === 'string') return value.slice(0, 80);
  } catch {
    // 不是 JSON。
  }
  const match = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return match?.[0] ?? '';
}

const TEST_URLS = ['https://ipinfo.io/json', 'https://myip.ipip.net'];

async function probeThrough(client: ProxyConfig, allowPrivate = false): Promise<ProxyCheck> {
  let lastError = '';
  for (const url of TEST_URLS) {
    const started = Date.now();
    try {
      const res = await httpRequest(url, {
        headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'lx-source-watch-proxy/1.0' },
        timeoutMs: 8_000,
        maxBytes: 64 * 1024,
        maxRedirects: 2,
        proxy: client,
        allowPrivate,
      });
      const latencyMs = Math.max(1, Date.now() - started);
      if (res.status >= 200 && res.status < 400) {
        const text = res.body.toString('utf8');
        return { ok: true, latencyMs, egressIp: parseEgress(text) };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = errorMessage(e).slice(0, 200);
    }
  }
  return { ok: false, latencyMs: 0, egressIp: '', error: lastError || '不可用' };
}

export async function testRunnerProxy(proxy: RunnerProxy, allowPrivate = false): Promise<ProxyCheck> {
  if (!proxy.kernelOnly) {
    const client = parseProxy(proxyUrl(proxy));
    if (!client) return { ok: false, latencyMs: 0, egressIp: '', error: '代理地址不合法' };
    return probeThrough(client, allowPrivate);
  }
  let handle: KernelHandle | null = null;
  try {
    handle = await startKernel({ id: proxy.id, name: proxy.name, protocol: proxy.protocol, config: proxy.config });
    const client = parseProxy(`socks5://127.0.0.1:${handle.port}`);
    if (!client) throw new Error('本地端口不合法');
    return await probeThrough(client, allowPrivate);
  } catch (e) {
    return { ok: false, latencyMs: 0, egressIp: '', error: errorMessage(e).slice(0, 300) };
  } finally {
    if (handle) await handle.stop();
  }
}

/** 启动选中节点：普通代理直接用，内核节点启动 mihomo 并返回本地 SOCKS。 */
export async function activateProxy(proxy: RunnerProxy): Promise<ActiveProxy> {
  const kernelOnly = proxy.kernelOnly;
  if (!kernelOnly) {
    const client = parseProxy(proxyUrl(proxy));
    if (!client) throw new Error('代理地址不合法');
    return { client, kernelOnly: false, label: proxy.name || proxy.id, stop: async () => undefined };
  }
  if (!proxy.config?.trim()) throw new Error('内核节点缺少配置');
  const handle = await startKernel({ id: proxy.id, name: proxy.name, protocol: proxy.protocol, config: proxy.config });
  const client = parseProxy(`socks5://127.0.0.1:${handle.port}`);
  if (!client) throw new Error('本地端口不合法');
  return { client, kernelOnly: true, label: `${proxy.name || proxy.id}（内核）`, stop: () => handle.stop() };
}

/**
 * 选一个可用节点：普通代理优先（快），内核节点最后（要启动进程）。
 * 最多预检 maxProxies 个，避免一个坏节点拖住整轮。
 */
export async function pickRunnerProxy(
  proxies: RunnerProxy[],
  options: { preferredId?: string; maxProxies?: number; allowPrivate?: boolean } = {},
): Promise<{ proxy: RunnerProxy; check: ProxyCheck } | null> {
  const rank = (proxy: RunnerProxy) => (proxy.kernelOnly ? 1 : 0);
  const sorted = [...proxies].sort((a, b) => {
    if (options.preferredId) {
      if (a.id === options.preferredId) return -1;
      if (b.id === options.preferredId) return 1;
    }
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.lastOkAt ?? '').localeCompare(a.lastOkAt ?? '');
  });
  const candidates = sorted.slice(0, Math.max(1, options.maxProxies ?? 8));
  for (const proxy of candidates) {
    log.step(`预检代理：${proxy.name || proxy.id}（${proxy.protocol}${proxy.kernelOnly ? '，内核' : ''}）`);
    const check = await testRunnerProxy(proxy, options.allowPrivate);
    if (check.ok) {
      log.success(`代理可用：${proxy.name || proxy.id}，出口 ${check.egressIp || '未知'}，${check.latencyMs}ms`);
      return { proxy, check };
    }
    log.warn(`代理不可用：${proxy.name || proxy.id}：${check.error ?? ''}`);
  }
  return null;
}
