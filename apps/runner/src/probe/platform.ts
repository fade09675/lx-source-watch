import {
  platformMeta,
  testCasesFor,
  truncate,
  type PlatformResult,
  type Quality,
} from '@lx/shared';
import type { LoadedSource, LxSourceDeclaration } from '../lx/sandbox.js';
import { log } from '../logger.js';
import type { ProxyConfig } from '../net/http.js';
import { ProbeError, classifyResolveError } from './errors.js';
import { qualityChain } from './quality.js';
import { RETRY_DELAY_MS, RetryBudget, isTransientError, sleep } from './retry.js';
import { verifyAudioUrl } from './stream.js';

export interface UrlRecord {
  sourceId: string;
  platform: string;
  quality: Quality;
  url: string;
  resolveMs: number;
  /** 默认模式下拉流是否成功；skip-verify 时为 null。 */
  ok: boolean | null;
}

export type ProbeMode = 'default' | 'deep' | 'skip-verify';

export interface TestPlatformOptions {
  sourceId: string;
  mode: ProbeMode;
  quality?: Quality | 'auto';
  requestTimeoutMs: number;
  streamTimeoutMs: number;
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
}

export interface PlatformOutcome {
  result: PlatformResult;
  urls: UrlRecord[];
}

/**
 * 取链瞬时失败时重试一次；脚本接口抖动、TLS 复位等常见于首次请求。
 * 每次平台检测共享一个 RetryBudget，避免取链和拉流各重试导致耗时翻倍。
 */
async function resolveWithRetry(
  source: LoadedSource,
  payload: Parameters<LoadedSource['call']>[0],
  timeoutMs: number,
  budget: RetryBudget,
  label: string,
): Promise<string> {
  try {
    return await source.call(payload, timeoutMs);
  } catch (e) {
    const first = classifyResolveError(e);
    if (!isTransientError(first) || !budget.take()) throw first;
    log.warn(`${label} 取链瞬时失败，${RETRY_DELAY_MS}ms 后重试一次：${first.message}`);
    await sleep(RETRY_DELAY_MS);
    return source.call(payload, timeoutMs);
  }
}

/**
 * 单平台检测：测试曲 → 取链 → Range 拉流校验。
 * 一个测试曲失败会换下一首；128k 失败可按配置降级/升级音质。
 */
export async function testPlatform(
  key: string,
  decl: LxSourceDeclaration | undefined,
  source: LoadedSource,
  opts: TestPlatformOptions,
): Promise<PlatformOutcome> {
  const meta = platformMeta(key);
  const name = decl?.name?.trim() || meta.name;
  const started = Date.now();
  const urls: UrlRecord[] = [];
  const retryBudget = new RetryBudget();

  const cases = testCasesFor(key);
  if (cases.length === 0) {
    return {
      result: {
        key,
        name,
        declared: true,
        tested: false,
        ok: false,
        errorKind: 'untested',
        error: '暂无该平台的测试曲，未做拉流校验',
      },
      urls,
    };
  }

  const chain = qualityChain(decl?.qualitys ?? ['128k'], opts.quality, opts.mode === 'deep');
  let lastError: ProbeError | undefined;
  let lastUrlHost: string | undefined;
  let lastStatus: number | undefined;
  let lastContentType: string | undefined;
  let lastQuality: Quality | undefined;
  let firstResolveMs: number | undefined;

  for (const testCase of cases) {
    for (const quality of chain) {
      const t0 = Date.now();
      let url: string;
      try {
        url = await resolveWithRetry(
          source,
          {
            source: key,
            action: 'musicUrl',
            info: { type: quality, musicInfo: testCase.musicInfo },
          },
          opts.requestTimeoutMs,
          retryBudget,
          `${name} ${quality}`,
        );
      } catch (e) {
        lastError = classifyResolveError(e);
        lastQuality = quality;
        // 超时/网络错误换音质大概率也没用，直接换下一首测试曲；
        // 其余错误（音质不支持、接口参数错误）继续尝试下一档音质。
        if (lastError.kind === 'resolve_timeout' || lastError.kind === 'resolve_network') break;
        continue;
      }

      const resolveMs = Date.now() - t0;
      if (firstResolveMs === undefined) firstResolveMs = resolveMs;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        lastError = new ProbeError('resolve_empty', '脚本返回的播放地址不是合法 URL');
        lastQuality = quality;
        break;
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        lastError = new ProbeError('resolve_empty', `不支持的协议：${parsed.protocol}`);
        lastQuality = quality;
        break;
      }

      const record: UrlRecord = { sourceId: opts.sourceId, platform: key, quality, url, resolveMs, ok: null };
      urls.push(record);
      lastQuality = quality;

      if (opts.mode === 'skip-verify') {
        record.ok = true;
        return {
          result: {
            key,
            name,
            declared: true,
            tested: true,
            ok: true,
            quality,
            resolveMs,
            totalMs: Date.now() - started,
          },
          urls,
        };
      }

      let verified = await verifyAudioUrl(url, {
        timeoutMs: opts.streamTimeoutMs,
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
      });
      if (!verified.ok && isTransientError(verified.error) && retryBudget.take()) {
        log.warn(
          `${name} ${quality} 拉流瞬时失败，${RETRY_DELAY_MS}ms 后重试一次：${verified.error?.message ?? '未知错误'}`,
        );
        await sleep(RETRY_DELAY_MS);
        verified = await verifyAudioUrl(url, {
          timeoutMs: opts.streamTimeoutMs,
          proxy: opts.proxy,
          allowPrivate: opts.allowPrivate,
        });
      }
      if (verified.ok) {
        record.ok = true;
        return {
          result: {
            key,
            name,
            declared: true,
            tested: true,
            ok: true,
            quality,
            resolveMs,
            ttfbMs: verified.ttfbMs,
            totalMs: Date.now() - started,
            urlHost: verified.urlHost,
            httpStatus: verified.status,
            contentType: verified.contentType,
          },
          urls,
        };
      }

      record.ok = false;
      lastError = verified.error;
      lastUrlHost = verified.urlHost;
      lastStatus = verified.status || undefined;
      lastContentType = verified.contentType;
    }
  }

  return {
    result: {
      key,
      name,
      declared: true,
      tested: true,
      ok: false,
      quality: lastQuality,
      resolveMs: firstResolveMs,
      totalMs: Date.now() - started,
      errorKind: lastError?.kind ?? 'script',
      error: truncate(lastError?.message ?? '未知错误', 400),
      urlHost: lastUrlHost,
      httpStatus: lastStatus,
      contentType: lastContentType,
    },
    urls,
  };
}
