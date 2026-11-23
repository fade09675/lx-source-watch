import { cnVerify, type CnFile } from '../cn.js';
import { log } from '../logger.js';
import { errorMessage } from '../util.js';
import {
  activateProxy,
  fetchRunnerProxies,
  isUdpOnly,
  reportProxyCheck,
  testRunnerProxy,
  type RunnerProxy,
} from './proxyPool.js';
import { selectHops } from './proxyTest.js';

export interface CnRunOptions {
  urlsPath: string;
  outPath: string;
  /** Worker 的 ingest 地址，用来推导 /api/runner/proxies。 */
  endpoint: string;
  token: string;
  preferredId?: string;
  maxProxies?: number;
  concurrency?: number;
  timeoutMs?: number;
  limit?: number;
  platform?: string;
  allowPrivate?: boolean;
}

/** 普通代理优先（快），内核节点最后（要启动进程）；指定节点置顶。 */
function rankProxies(proxies: RunnerProxy[], preferredId?: string): RunnerProxy[] {
  return [...proxies].sort((a, b) => {
    if (preferredId) {
      if (a.id === preferredId) return -1;
      if (b.id === preferredId) return 1;
    }
    const rank = (proxy: RunnerProxy) => (proxy.kernelOnly ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.lastOkAt ?? '').localeCompare(a.lastOkAt ?? '');
  });
}

/**
 * 从 Worker 代理池依次挑可用节点（普通优先、内核兜底），
 * 通过它补测已解析的播放 URL。只测 URL，不执行音源脚本。
 * 一个节点测活/启动/补测失败，写回失败后自动换下一个，最多试 maxProxies 个。
 */
export async function cnRun(opts: CnRunOptions): Promise<CnFile> {
  const proxies = await fetchRunnerProxies(opts.endpoint, opts.token, { allowPrivate: opts.allowPrivate });
  if (!proxies.length) {
    throw new Error('代理池为空：请先在管理页导入并启用至少一个代理');
  }
  const usable = proxies.filter((proxy) => !isUdpOnly(proxy));
  const udpCount = proxies.length - usable.length;
  log.step(
    `代理池 ${proxies.length} 个（普通 ${proxies.filter((p) => !p.kernelOnly).length}，内核 ${proxies.filter((p) => p.kernelOnly).length}${udpCount ? `，跳过 UDP ${udpCount}` : ''}）`,
  );
  if (!usable.length) throw new Error('代理池里只有 UDP 节点（hy2/tuic），当前环境不可测');

  const maxProxies = Math.max(1, opts.maxProxies ?? 8);
  const candidates = rankProxies(usable, opts.preferredId).slice(0, maxProxies);
  const hops = selectHops(proxies, 5);
  let lastError = '';

  for (const proxy of candidates) {
    const label = proxy.name || proxy.id;
    const check = await testRunnerProxy(proxy, {
      allowPrivate: opts.allowPrivate,
      hops,
      maxHops: 5,
    });
    if (!check.ok) {
      lastError = check.error ?? '测活失败';
      await reportProxyCheck(
        opts.endpoint,
        opts.token,
        proxy.id,
        { ...check, ok: false, error: lastError.slice(0, 300) },
        opts.allowPrivate,
      ).catch(() => undefined);
      log.warn(`节点不可用，换下一个：${label}（${lastError}）`);
      continue;
    }

    let active;
    try {
      active = await activateProxy(proxy);
    } catch (error) {
      lastError = errorMessage(error);
      await reportProxyCheck(
        opts.endpoint,
        opts.token,
        proxy.id,
        { ok: false, latencyMs: check.latencyMs, egressIp: check.egressIp, error: lastError.slice(0, 300) },
        opts.allowPrivate,
      ).catch(() => undefined);
      log.warn(`节点启动失败，换下一个：${label}（${lastError}）`);
      continue;
    }

    try {
      const file = await cnVerify({
        urlsPath: opts.urlsPath,
        outPath: opts.outPath,
        proxy: active.client,
        proxyLabel: active.label,
        concurrency: opts.concurrency ?? 5,
        timeoutMs: opts.timeoutMs ?? 15_000,
        limit: opts.limit,
        platform: opts.platform,
      });
      await reportProxyCheck(
        opts.endpoint,
        opts.token,
        proxy.id,
        {
          ok: true,
          latencyMs: check.latencyMs,
          egressIp: check.egressIp,
          country: check.country,
          asn: check.asn,
        },
        opts.allowPrivate,
      ).catch(() => undefined);
      return file;
    } catch (error) {
      lastError = errorMessage(error);
      await reportProxyCheck(
        opts.endpoint,
        opts.token,
        proxy.id,
        {
          ok: false,
          latencyMs: check.latencyMs,
          egressIp: check.egressIp,
          error: lastError.slice(0, 300),
        },
        opts.allowPrivate,
      ).catch(() => undefined);
      log.warn(`补测失败，换下一个：${label}（${lastError}）`);
    } finally {
      await active.stop();
    }
  }

  throw new Error(`所有候选代理都失败${lastError ? `：${lastError}` : ''}（最多尝试 ${maxProxies} 个）`);
}
