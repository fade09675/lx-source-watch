import { cnVerify, type CnFile } from '../cn.js';
import { log } from '../logger.js';
import { errorMessage } from '../util.js';
import { activateProxy, fetchRunnerProxies, pickRunnerProxy, reportProxyCheck } from './proxyPool.js';

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

/**
 * 从 Worker 代理池挑选一个可用节点（普通优先、内核兜底），
 * 通过它补测已解析的播放 URL。只测 URL，不执行音源脚本。
 */
export async function cnRun(opts: CnRunOptions): Promise<CnFile> {
  const proxies = await fetchRunnerProxies(opts.endpoint, opts.token, { allowPrivate: opts.allowPrivate });
  if (!proxies.length) {
    throw new Error('代理池为空：请先在管理页导入并启用至少一个代理');
  }
  log.step(`代理池 ${proxies.length} 个（普通 ${proxies.filter((p) => !p.kernelOnly).length}，内核 ${proxies.filter((p) => p.kernelOnly).length}）`);

  const picked = await pickRunnerProxy(proxies, {
    preferredId: opts.preferredId,
    maxProxies: opts.maxProxies ?? 8,
    allowPrivate: opts.allowPrivate,
  });
  if (!picked) throw new Error('代理池里没有可用节点');

  let active;
  try {
    active = await activateProxy(picked.proxy);
  } catch (e) {
    await reportProxyCheck(opts.endpoint, opts.token, picked.proxy.id, {
      ok: false,
      latencyMs: 0,
      egressIp: '',
      error: errorMessage(e),
    }, opts.allowPrivate);
    throw e;
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
    await reportProxyCheck(opts.endpoint, opts.token, picked.proxy.id, {
      ok: true,
      latencyMs: picked.check.latencyMs,
      egressIp: picked.check.egressIp,
    }, opts.allowPrivate);
    return file;
  } finally {
    await active.stop();
  }
}
