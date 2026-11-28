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
  type RunnerProxy,
} from './proxyPool.js';
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

  const config = await fetchRunnerConfig(opts.endpoint, opts.token);
  const maxProxies = Math.max(1, opts.maxProxies ?? 8);
  const candidates = rankProxies(usable, opts.preferredId).slice(0, maxProxies);
  const maxHops = Math.max(
    1,
    Math.min(5, opts.maxHops && opts.maxHops > 0 ? opts.maxHops : config.cnMaxHops),
  );
  const autoSwitch = opts.autoSwitch ?? config.cnAutoSwitch;
  const hops = selectHops(proxies, maxHops);
  log.info(`补测运行参数：跳板 ${hops.length} 个，失败${autoSwitch ? '自动换节点' : '不换节点'}`);
  let lastError = '';

  for (const proxy of candidates) {
    const label = proxy.name || proxy.id;
    const check = await testRunnerProxy(proxy, {
      allowPrivate: opts.allowPrivate,
      hops,
      maxHops,
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
      if (!autoSwitch) throw new Error(`节点不可用且已关闭自动换节点：${label}（${lastError}）`);
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
