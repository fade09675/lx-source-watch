import { cnVerify, type CnFile, type CnProgressEvent, type CnRow, type CnScope } from '../cn.js';
import { log } from '../logger.js';
import { errorMessage } from '../util.js';
import type { CnPlatformTarget } from '@lx/shared';
import { probeCnPlatforms } from './platformProbe.js';
import { readFile, writeFile } from 'node:fs/promises';
import {
  activateProxy,
  fetchRunnerProxies,
  isUdpOnly,
  reportProxyCheck,
  testRunnerProxy,
  type ProxyCheck,
  type RunnerProxy,
} from './proxyPool.js';
import type { ChainHop } from './mihomo.js';
import { selectHops } from './proxyTest.js';
import { fetchRunnerConfig } from './runnerConfig.js';

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
  /** 内核节点最多试几个跳板；未指定时用 Worker 设置。 */
  maxHops?: number;
  /** 失败后是否自动换下一个代理；未指定时用 Worker 设置。 */
  autoSwitch?: boolean;
  limit?: number;
  platform?: string;
  scope?: CnScope;
  statusPath?: string;
  skipEndpoints?: boolean;
  allowPrivate?: boolean;
  /** 海外失败/未测平台，先在国内重跑取链。 */
  platformTargets?: CnPlatformTarget[];
  onProgress?: (event: CnProgressEvent) => void | Promise<void>;
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

interface PreflightedProxy {
  proxy: RunnerProxy;
  check: ProxyCheck;
}

async function preflightProxies(
  proxies: RunnerProxy[],
  options: { allowPrivate?: boolean; hops: ChainHop[]; maxHops: number; concurrency: number; preferredId?: string },
): Promise<PreflightedProxy[]> {
  const results: PreflightedProxy[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, proxies.length) }, async () => {
    while (true) {
      const index = cursor++;
      const proxy = proxies[index];
      if (!proxy) return;
      try {
        const check = await testRunnerProxy(proxy, {
          allowPrivate: options.allowPrivate,
          hops: options.hops,
          maxHops: options.maxHops,
        });
        if (check.ok) results.push({ proxy, check });
      } catch {
        // A broken kernel process should not abort the whole preflight.
      }
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.check.latencyMs - b.check.latencyMs);
  if (options.preferredId) {
    const index = results.findIndex((item) => item.proxy.id === options.preferredId);
    if (index > 0) {
      const [preferred] = results.splice(index, 1);
      if (preferred) results.unshift(preferred);
    }
  }
  return results;
}

export function cnPlatformStageQuality(rows: CnRow[]): { usable: boolean; reason: string } {
  const ok = rows.filter((row) => row.ok).length;
  if (rows.length >= 10 && ok / rows.length < 0.1) {
    return { usable: false, reason: `平台可达 ${ok}/${rows.length}，低于 10%` };
  }
  return { usable: true, reason: '' };
}

export function cnResultQuality(
  file: CnFile,
  platformRows: CnRow[],
): { usable: boolean; reason: string; score: number } {
  const urlRate = file.summary.tested ? file.summary.ok / file.summary.tested : 0;
  const platformOk = platformRows.filter((row) => row.ok).length;
  const platformRate = platformRows.length ? platformOk / platformRows.length : 0;
  if (file.summary.tested >= 10 && urlRate < 0.05) {
    return {
      usable: false,
      reason: `地址可达 ${file.summary.ok}/${file.summary.tested}，低于 5%`,
      score: urlRate,
    };
  }
  if (platformRows.length >= 20 && platformRate < 0.03) {
    return {
      usable: false,
      reason: `平台可达 ${platformOk}/${platformRows.length}，低于 3%`,
      score: platformRate,
    };
  }
  return { usable: true, reason: '', score: Math.max(urlRate, platformRate) };
}

/**
 * 从 Worker 代理池预检全部节点，按延迟从低到高依次补测；
 * 预检或补测质量不达标就换下一个，最多试 maxProxies 个。
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

  const config = await fetchRunnerConfig(opts.endpoint, opts.token);
  // 60 分钟 workflow 内完成：先预检一小批候选，再最多跑 3 个节点。
  const maxProxies = Math.max(1, opts.maxProxies ?? 3);
  const preflightLimit = Math.max(maxProxies, 12);
  const startedAt = Date.now();
  const budgetMs = 45 * 60 * 1000;
  const maxHops = Math.max(
    1,
    Math.min(5, opts.maxHops && opts.maxHops > 0 ? opts.maxHops : config.cnMaxHops),
  );
  const autoSwitch = opts.autoSwitch ?? config.cnAutoSwitch;
  const hops = selectHops(proxies, maxHops);
  log.info(`补测运行参数：跳板 ${hops.length} 个，失败${autoSwitch ? '自动换节点' : '不换节点'}`);
  const preflightPool = rankProxies(usable, opts.preferredId).slice(0, preflightLimit);
  const tested = await preflightProxies(preflightPool, {
    allowPrivate: opts.allowPrivate,
    hops,
    maxHops,
    concurrency: 6,
    preferredId: opts.preferredId,
  });
  log.info(
    `预检 ${preflightPool.length}/${usable.length} 个节点，${tested.length} 个可用，按延迟排序`,
  );
  const candidates = tested.slice(0, maxProxies);
  let lastError = '';

  for (const candidate of candidates) {
    if (Date.now() - startedAt > budgetMs) {
      lastError = '补测时间预算用尽（45 分钟），停止继续换节点';
      log.warn(lastError);
      break;
    }
    const { proxy, check } = candidate;
    const label = proxy.name || proxy.id;

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
      if (!autoSwitch) throw new Error(`节点启动失败且已关闭自动换节点：${label}（${lastError}）`);
      continue;
    }

    try {
      // 阶段 1：国内重跑海外失败/未测平台的取链。
      // 只有拿到地址后，阶段 2 才会对这些地址做国内拉流校验。
      let platformRows: CnRow[] = [];
      const targets = opts.platformTargets ?? [];
      if (targets.length) {
        try {
          const probe = await probeCnPlatforms({
            statusPath: opts.statusPath ?? 'out/status.json',
            targets,
            proxy: active.client,
            proxyLabel: active.label,
            concurrency: 1,
            timeoutMs: opts.timeoutMs ?? 20_000,
            allowPrivate: opts.allowPrivate,
            onProgress: opts.onProgress,
          });
          platformRows = probe.rows;
          const stageQuality = cnPlatformStageQuality(platformRows);
          if (!stageQuality.usable) {
            lastError = stageQuality.reason;
            await reportProxyCheck(
              opts.endpoint,
              opts.token,
              proxy.id,
              { ...check, ok: false, error: stageQuality.reason.slice(0, 300) },
              opts.allowPrivate,
            ).catch(() => undefined);
            log.warn(`平台补测质量不达标，跳过地址补测并换节点：${label}（${stageQuality.reason}）`);
            if (!autoSwitch) {
              throw new Error(`平台补测质量不达标且已关闭自动换节点：${label}（${stageQuality.reason}）`);
            }
            continue;
          }
          if (probe.urls.length) {
            const raw = JSON.parse(await readFile(opts.urlsPath, 'utf8')) as {
              version: 1;
              generatedAt: string;
              urls: unknown[];
            };
            const seen = new Set(
              raw.urls.map((item) => (item as { url?: string }).url).filter((url): url is string => Boolean(url)),
            );
            for (const url of probe.urls) {
              if (seen.has(url.url)) continue;
              seen.add(url.url);
              raw.urls.push(url);
            }
            await writeFile(opts.urlsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
            log.info(`国内平台补测新增 ${probe.urls.length} 个地址，进入地址补测`);
          }
        } catch (error) {
          // 平台阶段失败不应阻断已有的 URL 补测。
          log.warn(`国内平台补测失败，继续地址补测：${errorMessage(error)}`);
        }
      }

      const file = await cnVerify({
        urlsPath: opts.urlsPath,
        outPath: opts.outPath,
        proxy: active.client,
        proxyLabel: active.label,
        concurrency: opts.concurrency ?? 5,
        timeoutMs: opts.timeoutMs ?? 15_000,
        limit: opts.limit,
        platform: opts.platform,
        scope: opts.scope ?? 'failed',
        statusPath: opts.statusPath,
        skipEndpoints: opts.skipEndpoints,
        onProgress: opts.onProgress,
      });
      if (platformRows.length) {
        // 平台阶段的结果优先；URL 阶段补上其余平台的记录。
        const merged = new Map<string, CnRow>();
        for (const row of platformRows) merged.set(`${row.sourceId}\u0000${row.platform}`, row);
        for (const row of file.rows) {
          const key = `${row.sourceId}\u0000${row.platform}`;
          if (!merged.has(key)) merged.set(key, row);
        }
        file.rows = [...merged.values()];
        file.mode = 'execute';
        await writeFile(opts.outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      }
      const quality = cnResultQuality(file, platformRows);
      if (!quality.usable) {
        lastError = quality.reason;
        await reportProxyCheck(
          opts.endpoint,
          opts.token,
          proxy.id,
          { ...check, ok: false, error: quality.reason.slice(0, 300) },
          opts.allowPrivate,
        ).catch(() => undefined);
        log.warn(`节点补测质量不达标，换下一个：${label}（${quality.reason}）`);
        if (!autoSwitch) throw new Error(`补测质量不达标且已关闭自动换节点：${label}（${quality.reason}）`);
        continue;
      }

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
      if (!autoSwitch) throw new Error(`补测失败且已关闭自动换节点：${label}（${lastError}）`);
    } finally {
      await active.stop();
    }
  }

  throw new Error(`所有候选代理都失败${lastError ? `：${lastError}` : ''}（最多尝试 ${maxProxies} 个）`);
}
