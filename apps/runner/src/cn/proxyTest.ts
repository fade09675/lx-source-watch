import type { ProxyTestReport, ProxyTestRow } from '@lx/shared';
import { log } from '../logger.js';
import { errorMessage, nowIso } from '../util.js';
import type { ChainHop } from './mihomo.js';
import {
  fetchRunnerProxies,
  isUdpOnly,
  reportProxyCheck,
  testRunnerProxy,
  type ProxyCheck,
  type RunnerProxy,
} from './proxyPool.js';

/**
 * 内核节点的跳板候选：已测活的普通 http/socks5，延迟最低的优先。
 * 与 IPTV 一致：每个跳板单独试一次，不串联；最后一个候选是直连。
 */
export function selectHops(proxies: RunnerProxy[], maxHops = 5): ChainHop[] {
  const limit = Math.max(1, Math.min(5, maxHops));
  return proxies
    .filter(
      (proxy) =>
        !proxy.kernelOnly &&
        !isUdpOnly(proxy) &&
        (proxy.protocol === 'http' || proxy.protocol === 'socks5') &&
        Boolean(proxy.lastOkAt),
    )
    .sort((a, b) => (a.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.lastLatencyMs ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit)
    .map((proxy) => ({
      protocol: proxy.protocol === 'socks5' ? ('socks5' as const) : ('http' as const),
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    }));
}

/**
 * 单条回传结果。error 在单节点回写里保留完整内核日志，
 * 但汇总报告有 300 字符上限，这里必须截断，否则整份报告被 400 拒绝。
 */
export function toProxyTestRow(proxy: RunnerProxy, check: ProxyCheck): ProxyTestRow {
  return {
    id: proxy.id,
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    subscriptionId: proxy.subscriptionId ?? null,
    kernelOnly: proxy.kernelOnly,
    ok: check.ok,
    latencyMs: check.latencyMs,
    country: check.country,
    asn: check.asn,
    error: check.error?.slice(0, 300),
    testedAt: nowIso(),
  };
}

export interface ProxyTestOptions {
  endpoint: string;
  token: string;
  /** 由任务派发时传入：测完回写任务与占位运行。 */
  taskId?: string;
  runId?: string;
  /** 只测这一个节点。 */
  proxyId?: string;
  /** 只测这个订阅下的节点。 */
  subscriptionId?: string;
  /** 默认 5，与 cn 补测一致，最高 10。 */
  concurrency?: number;
  /** 内核节点最多试几个跳板，默认 5。 */
  maxHops?: number;
  allowPrivate?: boolean;
  /** 只测前 N 个，便于本地调试。 */
  limit?: number;
}

export interface ProxyTestSummary {
  total: number;
  ok: number;
  kernelOk: number;
  skippedUdp: number;
  durationMs: number;
}

function apiBase(endpoint: string): string {
  return endpoint.replace(/\/api\/ingest\/?$/, '').replace(/\/+$/, '');
}

/** 把测活结果回写 Worker，让任务和占位运行真正结束，而不是等看门狗。 */
async function reportProxyTestResult(
  options: ProxyTestOptions,
  report: ProxyTestReport,
): Promise<void> {
  const url = `${apiBase(options.endpoint)}/api/runner/proxy-test-result`;
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        log.info('测活结果已回写');
        return;
      }
      lastError = `HTTP ${response.status}：${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`测活结果回写失败：${lastError}`);
}

/** 逐个测活所有启用节点，结果通过 runner 接口写回成功/失败次数与出口信息。 */
export async function runProxyTest(options: ProxyTestOptions): Promise<ProxyTestSummary> {
  const startedMs = Date.now();
  const proxies = await fetchRunnerProxies(options.endpoint, options.token, {
    allowPrivate: options.allowPrivate,
  });
  const scoped = proxies.filter(
    (proxy) =>
      (!options.proxyId || proxy.id === options.proxyId) &&
      (!options.subscriptionId || proxy.subscriptionId === options.subscriptionId),
  );
  const udp = scoped.filter(isUdpOnly);
  let testable = scoped.filter((proxy) => !isUdpOnly(proxy));
  if (options.limit && options.limit > 0) testable = testable.slice(0, options.limit);
  if (!testable.length) {
    throw new Error(
      udp.length
        ? `该范围只有 UDP 节点（hy2/tuic，${udp.length} 个），当前环境不可测`
        : '没有可测活的代理（需启用）',
    );
  }

  const concurrency = Math.max(1, Math.min(10, options.concurrency ?? 5));
  const hops = selectHops(proxies, options.maxHops ?? 5);
  const total = testable.length;
  let done = 0;
  let ok = 0;
  let kernelOk = 0;
  const queue = [...testable];
  const rows: ProxyTestRow[] = [];

  log.step(`开始代理测活：${total} 个，并发 ${concurrency}，跳板 ${hops.length} 个`);

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    for (;;) {
      const proxy = queue.shift();
      if (!proxy) return;
      let check;
      try {
        check = await testRunnerProxy(proxy, {
          allowPrivate: options.allowPrivate,
          hops,
          maxHops: options.maxHops ?? 5,
        });
      } catch (error) {
        check = {
          ok: false,
          latencyMs: 0,
          egressIp: '',
          country: '',
          asn: '',
          error: errorMessage(error).slice(0, 300),
        };
      }
      if (check.ok) {
        ok += 1;
        if (proxy.kernelOnly) kernelOk += 1;
      }
      await reportProxyCheck(options.endpoint, options.token, proxy.id, check, options.allowPrivate);
      rows.push(toProxyTestRow(proxy, check));
      done += 1;
      const label = proxy.name || proxy.id;
      if (check.ok) {
        log.info(`[${done}/${total}] ${label} 可用 · ${check.latencyMs}ms · ${check.country || '-'} ${check.asn || ''}`);
      } else {
        log.warn(`[${done}/${total}] ${label} 不可用：${check.error ?? ''}`);
      }
    }
  });
  await Promise.all(workers);

  const summary: ProxyTestSummary = {
    total,
    ok,
    kernelOk,
    skippedUdp: udp.length,
    durationMs: Date.now() - startedMs,
  };

  if (options.taskId && options.runId) {
    await reportProxyTestResult(options, {
      runId: options.runId,
      taskId: options.taskId,
      ...summary,
      results: rows,
    });
  }

  return summary;
}
