import {
  computeSourceStatus,
  platformMeta,
  sortPlatformKeys,
  type PlatformResult,
  type SourceResult,
} from '@lx/shared';
import { loadLxSource, type LoadedSource } from '../lx/sandbox.js';
import type { ProxyConfig } from '../net/http.js';
import type { ResolvedSource } from '../registry.js';
import type { LoadedScript } from '../script.js';
import { mapLimit, nowIso } from '../util.js';
import { testPlatform, type PlatformOutcome, type ProbeMode, type UrlRecord } from './platform.js';

export interface SourceProbeOptions {
  mode: ProbeMode;
  quality?: '128k' | '320k' | '192k' | 'flac' | 'flac24bit' | 'hires' | 'atmos' | 'master' | 'auto';
  requestTimeoutMs: number;
  platformTimeoutMs: number;
  streamTimeoutMs: number;
  initTimeoutMs: number;
  scriptTimeoutMs: number;
  platformConcurrency: number;
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
  onPlatform?: (key: string, outcome: PlatformOutcome) => void;
}

export interface SourceOutcome {
  result: SourceResult;
  urls: UrlRecord[];
}

const KEY_RE = /^[a-z0-9_-]{2,16}$/i;

function baseResult(src: ResolvedSource, script: LoadedScript, started: number): SourceResult {
  return {
    id: src.id,
    title: src.title,
    url: src.resolvedUrl,
    mirror: src.resolvedMirror,
    homepage: src.homepage,
    category: src.category,
    storage: src.storage,
    scriptSha: script.sha,
    endpoints: [],
    status: 'untested',
    initOk: false,
    stats: { ok: 0, tested: 0, total: 0 },
    platforms: [],
    checkedAt: nowIso(),
    durationMs: Date.now() - started,
  };
}

/** 初始化失败时仍然把元数据里声明的平台列出来，前端可以显示“未测”。 */
export function failedSourceResult(
  src: ResolvedSource,
  script: LoadedScript | undefined,
  error: string,
  started: number,
  meta?: { support?: string[]; version?: string; author?: string; description?: string },
): SourceResult {
  const base = script
    ? baseResult(src, script, started)
    : {
        id: src.id,
        title: src.title,
        url: src.resolvedUrl,
        mirror: src.resolvedMirror,
        homepage: src.homepage,
        category: src.category,
        storage: src.storage,
        endpoints: [],
        status: 'untested' as const,
        initOk: false,
        stats: { ok: 0, tested: 0, total: 0 },
        platforms: [],
        checkedAt: nowIso(),
        durationMs: Date.now() - started,
      };
  const keys = (meta?.support ?? []).filter((k) => KEY_RE.test(k));
  const platforms: PlatformResult[] = keys.map((key) => ({
    key,
    name: platformMeta(key).name,
    declared: true,
    tested: false,
    ok: false,
    errorKind: 'init',
    error: '音源初始化失败，平台未测',
  }));
  return {
    ...base,
    status: 'untested',
    initOk: false,
    initError: error.slice(0, 600),
    stats: { ok: 0, tested: 0, total: platforms.length },
    platforms,
    checkedAt: nowIso(),
    durationMs: Date.now() - started,
  };
}

/**
 * 在沙箱里初始化脚本并逐平台检测。
 * 所有平台共享一个脚本实例（与 LX 运行时一致），销毁时统一清理定时器。
 */
export async function probeSource(
  src: ResolvedSource,
  script: LoadedScript,
  opts: SourceProbeOptions,
): Promise<SourceOutcome> {
  const started = Date.now();
  let loaded: LoadedSource | undefined;

  try {
    loaded = await loadLxSource({
      code: script.code,
      filename: `${src.id}.js`,
      initTimeoutMs: opts.initTimeoutMs,
      scriptTimeoutMs: opts.scriptTimeoutMs,
      proxy: opts.proxy,
      allowPrivate: opts.allowPrivate,
    });

    const declared = Object.keys(loaded.sources).filter((k) => KEY_RE.test(k));
    const support = loaded.meta.support.filter((k) => KEY_RE.test(k) && !declared.includes(k));
    const keys = sortPlatformKeys([...declared, ...support]);

    const outcomes = await mapLimit(keys, opts.platformConcurrency, async (key) => {
      const outcome = await testPlatform(key, loaded?.sources[key], loaded as LoadedSource, {
        sourceId: src.id,
        mode: opts.mode,
        quality: opts.quality,
        requestTimeoutMs: opts.platformTimeoutMs,
        streamTimeoutMs: opts.streamTimeoutMs,
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
      });
      opts.onPlatform?.(key, outcome);
      return outcome;
    });

    const platforms = outcomes.map((o) => o.result);
    const urls = outcomes.flatMap((o) => o.urls);
    const tested = platforms.filter((p) => p.tested).length;
    const ok = platforms.filter((p) => p.ok).length;

    return {
      result: {
        ...baseResult(src, script, started),
        initOk: true,
        status: computeSourceStatus({ tested, ok }),
        stats: { ok, tested, total: platforms.length },
        platforms,
        checkedAt: nowIso(),
        durationMs: Date.now() - started,
      },
      urls,
    };
  } finally {
    loaded?.dispose();
  }
}
