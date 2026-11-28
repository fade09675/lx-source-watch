import { readFile } from 'node:fs/promises';
import { SnapshotSchema, type CnPlatformTarget } from '@lx/shared';
import type { CnRow, CnProgressEvent } from '../cn.js';
import { loadScript } from '../script.js';
import type { ResolvedSource } from '../registry.js';
import type { ProxyConfig } from '../net/http.js';
import { probeSource } from '../probe/source.js';
import type { UrlRecord } from '../probe/platform.js';
import { errorMessage, mapLimit } from '../util.js';
import { log } from '../logger.js';

export interface PlatformProbeOptions {
  statusPath: string;
  targets: CnPlatformTarget[];
  proxy?: ProxyConfig;
  proxyLabel: string;
  concurrency?: number;
  timeoutMs?: number;
  allowPrivate?: boolean;
  onProgress?: (event: CnProgressEvent) => void | Promise<void>;
}

export interface PlatformProbeResult {
  rows: CnRow[];
  urls: UrlRecord[];
}

function resolveSource(source: {
  id: string;
  title: string;
  url: string;
  mirror?: string;
  homepage?: string;
  category?: string;
  endpoints: { url: string; role: 'primary' | 'candidate' }[];
}): ResolvedSource {
  return {
    id: source.id,
    title: source.title,
    storage: 'remote',
    url: source.url,
    resolvedUrl: source.url,
    resolvedMirror: source.mirror,
    endpoints: source.endpoints,
    homepage: source.homepage,
    category: source.category ?? '在线',
    enabled: true,
    trusted: true,
    mirrors: [],
  } as ResolvedSource;
}

/**
 * 国内平台补测：只重跑海外失败/未测的平台。
 * 脚本与脚本内的网络请求都走当前国内代理，返回可交给 stage 2 的 URL。
 */
export async function probeCnPlatforms(opts: PlatformProbeOptions): Promise<PlatformProbeResult> {
  const snapshot = SnapshotSchema.parse(JSON.parse(await readFile(opts.statusPath, 'utf8')));
  const rows: CnRow[] = [];
  const urls: UrlRecord[] = [];
  const targets = opts.targets.filter((target) => target.platforms.length > 0);
  await opts.onProgress?.({
    stage: 'loading',
    done: 0,
    total: targets.length,
    unit: '平台源',
    message: `准备国内平台补测 ${targets.length} 个源`,
  });

  let completed = 0;
  await mapLimit(targets, Math.max(1, opts.concurrency ?? 1), async (target) => {
    const source = snapshot.sources.find((item) => item.id === target.sourceId);
    if (!source?.url) {
      for (const platform of target.platforms) {
        rows.push({
          sourceId: target.sourceId,
          platform,
          url: '',
          proxy: opts.proxyLabel,
          ok: false,
          status: 0,
          ttfbMs: 0,
          totalMs: 0,
          bytes: 0,
          error: '源不存在或缺少脚本地址',
        });
      }
      return;
    }

    try {
      const script = await loadScript(resolveSource(source), {
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
      });
      const outcome = await probeSource(resolveSource(source), script, {
        mode: 'default',
        requestTimeoutMs: 30_000,
        platformTimeoutMs: opts.timeoutMs ?? 20_000,
        streamTimeoutMs: opts.timeoutMs ?? 15_000,
        initTimeoutMs: 12_000,
        scriptTimeoutMs: 15_000,
        platformConcurrency: 2,
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
        onlyPlatforms: target.platforms,
      });
      const platformByKey = new Map(outcome.result.platforms.map((platform) => [platform.key, platform]));
      const urlByKey = new Map(outcome.urls.map((url) => [url.platform, url]));
      for (const key of target.platforms) {
        const platform = platformByKey.get(key);
        const url = urlByKey.get(key);
        rows.push({
          sourceId: target.sourceId,
          platform: key,
          quality: url?.quality,
          url: url?.url ?? '',
          proxy: opts.proxyLabel,
          ok: platform?.ok ?? false,
          status: 0,
          ttfbMs: 0,
          totalMs: platform?.totalMs ?? 0,
          bytes: 0,
          error: platform?.ok ? undefined : (platform?.error ?? '平台未返回结果').slice(0, 300),
        });
        if (url?.url) urls.push(url);
      }
      log.info(
        `国内平台补测 ${target.sourceId}：${outcome.result.stats.ok}/${outcome.result.stats.tested} 通过`,
      );
    } catch (error) {
      const message = errorMessage(error).slice(0, 300);
      for (const platform of target.platforms) {
        rows.push({
          sourceId: target.sourceId,
          platform,
          url: '',
          proxy: opts.proxyLabel,
          ok: false,
          status: 0,
          ttfbMs: 0,
          totalMs: 0,
          bytes: 0,
          error: message,
        });
      }
      log.warn(`国内平台补测 ${target.sourceId} 失败：${message}`);
    } finally {
      completed += 1;
      await opts.onProgress?.({
        stage: 'sources',
        done: completed,
        total: targets.length,
        unit: '平台源',
        message: `国内平台补测 ${completed}/${targets.length} 个源`,
      });
    }
  });

  return { rows, urls };
}
