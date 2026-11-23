import { log } from '../logger.js';
import { httpRequest, parseProxy, type ProxyConfig } from '../net/http.js';
import { errorMessage } from '../util.js';
import { startKernel, type ChainHop, type KernelHandle } from './mihomo.js';

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
  subscriptionId?: string | null;
  lastOkAt?: string | null;
  lastLatencyMs?: number | null;
  successCount?: number;
  failCount?: number;
  country?: string;
  asn?: string;
}

/** UDP 协议（hysteria/tuic）在 Actions 里基本不可用，测活和国内补测都跳过。 */
export function isUdpOnly(proxy: Pick<RunnerProxy, 'protocol'>): boolean {
  const protocol = proxy.protocol.toLowerCase();
  return protocol === 'hysteria' || protocol === 'hysteria2' || protocol === 'tuic';
}

export interface ProxyCheck {
  ok: boolean;
  latencyMs: number;
  egressIp: string;
  country?: string;
  asn?: string;
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

interface Target {
  url: string;
  json: boolean;
}

/** 与 IPTV 相同的四个目标：一个失败不判死，逐个回退。 */
const TEST_TARGETS: Target[] = [
  { url: 'https://ipinfo.io/json', json: true },
  { url: 'https://myip.ipip.net', json: false },
  { url: 'https://www.baidu.com/', json: false },
  { url: 'https://api.ip.sb/geoip', json: true },
];

const TARGET_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;

export function parseEgress(json: boolean, body: string): { egressIp: string; country: string; asn: string } {
  if (json) {
    try {
      const data = JSON.parse(body) as { ip?: string; country?: string; org?: string; asn?: number; isp?: string };
      const org = data.org ?? data.isp ?? '';
      const asn = typeof data.asn === 'number' ? `AS${data.asn}` : (org.match(/AS\d+/)?.[0] ?? '');
      return { egressIp: String(data.ip ?? ''), country: String(data.country ?? ''), asn };
    } catch {
      // 不是 JSON，走文本匹配。
    }
  }
  const ip = body.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ?? '';
  const asn = body.match(/AS\d+/)?.[0] ?? '';
  return { egressIp: ip, country: '', asn };
}

function fail(error: string, latencyMs = 0): ProxyCheck {
  return { ok: false, latencyMs, egressIp: '', country: '', asn: '', error };
}

async function probeThrough(client: ProxyConfig, allowPrivate: boolean, deadline: number): Promise<ProxyCheck> {
  let lastError = '';
  for (const target of TEST_TARGETS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const started = Date.now();
    try {
      const res = await httpRequest(target.url, {
        headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'lx-source-watch-proxy/1.0' },
        timeoutMs: Math.min(TARGET_TIMEOUT_MS, remaining),
        maxBytes: 64 * 1024,
        maxRedirects: 2,
        proxy: client,
        allowPrivate,
      });
      const latencyMs = Math.max(1, Date.now() - started);
      if (res.status >= 200 && res.status < 400) {
        const parsed = parseEgress(target.json, res.body.toString('utf8'));
        return { ok: true, latencyMs, ...parsed };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = errorMessage(e).slice(0, 200);
    }
  }
  return fail(lastError || '不可用');
}

export interface TestProxyOptions {
  allowPrivate?: boolean;
  /** 内核节点的中转跳板候选，按顺序尝试，最后再直连。 */
  hops?: ChainHop[];
  maxHops?: number;
}

export async function testRunnerProxy(proxy: RunnerProxy, options: TestProxyOptions = {}): Promise<ProxyCheck> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  if (!proxy.kernelOnly) {
    const client = parseProxy(proxyUrl(proxy));
    if (!client) return fail('代理地址不合法');
    return probeThrough(client, options.allowPrivate ?? false, deadline);
  }
  const hops = (options.hops ?? []).filter((hop) => hop.host && hop.port).slice(0, Math.max(1, options.maxHops ?? 5));
  const attempts: Array<ChainHop | null> = [...hops, null];
  let last: ProxyCheck = fail('内核节点缺少配置');
  for (const hop of attempts) {
    let handle: KernelHandle | null = null;
    try {
      handle = await startKernel(
        { id: proxy.id, name: proxy.name, protocol: proxy.protocol, config: proxy.config ?? '' },
        { hop: hop ?? undefined },
      );
      const client = parseProxy(`socks5://127.0.0.1:${handle.port}`);
      if (!client) throw new Error('本地端口不合法');
      const result = await probeThrough(client, options.allowPrivate ?? false, deadline);
      if (result.ok) return result;
      last = result;
    } catch (e) {
      last = fail(errorMessage(e).slice(0, 300));
    } finally {
      if (handle) await handle.stop();
    }
  }
  return last;
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
    const check = await testRunnerProxy(proxy, { allowPrivate: options.allowPrivate });
    if (check.ok) {
      log.success(`代理可用：${proxy.name || proxy.id}，出口 ${check.egressIp || '未知'}，${check.latencyMs}ms`);
      return { proxy, check };
    }
    log.warn(`代理不可用：${proxy.name || proxy.id}：${check.error ?? ''}`);
  }
  return null;
}
