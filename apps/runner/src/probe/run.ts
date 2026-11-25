import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  INTERVAL_HOURS,
  SCHEMA_VERSION,
  SnapshotSchema,
  nextCheckAt,
  summarizeSources,
  type EndpointResult,
  type Snapshot,
  type SourceResult,
  type Summary,
} from '@lx/shared';
import { parseScriptMeta } from '../lx/meta.js';
import { log } from '../logger.js';
import type { ProxyConfig } from '../net/http.js';
import { fetchRegistry, loadRegistry, type ResolvedSource } from '../registry.js';
import { loadMirrorTemplates } from '../mirrors.js';
import type { LoadedScript } from '../script.js';
import { errorMessage, mapLimit, nowIso, randomId } from '../util.js';
import { checkEndpoints, chooseEndpoint, describeEndpointFailure, toEndpointResults } from './endpoints.js';
import { failedSourceResult, probeSource } from './source.js';
import type { ProbeMode, UrlRecord } from './platform.js';

export interface ProbeOptions {
  registryPath: string;
  /** 从 Worker 公开接口读取音源清单；失败回退 registryPath。 */
  registryUrl?: string;
  outPath: string;
  urlsPath: string;
  mergeFrom?: string;
  only?: string[];
  limit?: number;
  sourceConcurrency?: number;
  platformConcurrency?: number;
  mode: ProbeMode;
  quality?: '128k' | '320k' | '192k' | 'flac' | 'flac24bit' | 'hires' | 'atmos' | 'master' | 'auto';
  requestTimeoutMs?: number;
  platformTimeoutMs?: number;
  streamTimeoutMs?: number;
  initTimeoutMs?: number;
  scriptTimeoutMs?: number;
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
  preferMirror?: boolean;
  /** 公开的镜像模板接口；缺省时 Actions 走 dash.dpdns.org。 */
  configUrl?: string;
  mirrorTimeoutMs?: number;
  repoRoot?: string;
  rawBase?: string;
  repoVars?: { version?: string; author?: string; description?: string; expire?: string };
  /** 由任务系统预分配的运行 id；本地直接跑时自动生成。 */
  runId?: string;
}

export interface ProbeOutput {
  snapshot: Snapshot;
  urls: UrlRecord[];
}

export function summarize(sources: SourceResult[]): Summary {
  return summarizeSources(sources);
}

async function readSnapshot(path: string): Promise<Snapshot | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = SnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 探测主流程：加载清单 → 并发（按源）加载脚本、初始化、逐平台测试 → 合并旧结果 → 写出快照。
 * 任何单个来源失败都不会中断整轮。
 */
export async function runProbe(opts: ProbeOptions): Promise<ProbeOutput> {
  const started = Date.now();
  const mirrorTemplates = await loadMirrorTemplates({ configUrl: opts.configUrl });
  const registryOpts = {
    only: opts.only,
    limit: opts.limit,
    repoRoot: opts.repoRoot,
    rawBase: opts.rawBase,
    mirrorTemplates,
  };
  let sources: ResolvedSource[];
  if (opts.registryUrl) {
    try {
      sources = await fetchRegistry(opts.registryUrl, registryOpts);
      log.info(`来源清单：从接口读取 ${sources.length} 个（${opts.registryUrl}）`);
    } catch (e) {
      log.warn(`${errorMessage(e)}，回退本地清单 ${opts.registryPath}`);
      sources = await loadRegistry(opts.registryPath, registryOpts);
    }
  } else {
    sources = await loadRegistry(opts.registryPath, registryOpts);
  }
  const partial = Boolean(opts.only?.length || opts.limit);
  log.step(
    `来源 ${sources.length} 个 · 模式 ${opts.mode} · 音质 ${opts.quality ?? '128k'} · 源并发 ${opts.sourceConcurrency ?? 2}`,
  );

  const sourceConcurrency = Math.max(1, opts.sourceConcurrency ?? 2);
  const platformConcurrency = Math.max(1, opts.platformConcurrency ?? 4);
  let index = 0;

  const results = await mapLimit(sources, sourceConcurrency, async (src) => {
    const seq = ++index;
    const t0 = Date.now();
    let script: LoadedScript | undefined;
    let endpoints: EndpointResult[] = [];
    let chosenInfo: { via: 'primary' | 'mirror'; url: string } | undefined;
    try {
      const checks = await checkEndpoints(src, {
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
        timeoutMs: opts.requestTimeoutMs ?? 30_000,
        mirrorTimeoutMs: opts.mirrorTimeoutMs ?? 8_000,
      });
      endpoints = toEndpointResults(checks);
      const chosen = chooseEndpoint(checks);
      if (!chosen?.check.code) throw new Error(describeEndpointFailure(checks));
      if (chosen.warning) log.warn(`[${seq}/${sources.length}] ${src.id}：${chosen.warning}`);
      chosenInfo = {
        via: chosen.check.role === 'primary' ? 'primary' : 'mirror',
        url: chosen.check.url,
      };

      script = {
        code: chosen.check.code,
        bytes: chosen.check.bytes ?? Buffer.byteLength(chosen.check.code),
        sha: chosen.check.sha ?? '',
        sha256: chosen.check.sha256 ?? '',
        fromMirror: chosen.check.role === 'candidate',
        url: chosen.check.url,
      };
      const meta = parseScriptMeta(script.code, `${src.id}.js`);
      const outcome = await probeSource(src, script, {
        mode: opts.mode,
        quality: opts.quality,
        requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
        platformTimeoutMs: opts.platformTimeoutMs ?? 20_000,
        streamTimeoutMs: opts.streamTimeoutMs ?? 12_000,
        initTimeoutMs: opts.initTimeoutMs ?? 12_000,
        scriptTimeoutMs: opts.scriptTimeoutMs ?? 15_000,
        platformConcurrency,
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
        onPlatform: (key, outcome) => {
          if (!outcome.result.ok) {
            log.debug(`  [${seq}/${sources.length}] ${src.id} ${key}: ${outcome.result.error ?? '失败'}`);
          }
        },
      });
      outcome.result.endpoints = endpoints;
      if (src.origin) outcome.result.origin = src.origin.slice(0, 300);
      if (chosenInfo) {
        outcome.result.via = chosenInfo.via;
        outcome.result.chosenUrl = chosenInfo.url;
      }
      outcome.result.version = meta.version?.slice(0, 40);
      outcome.result.author = meta.author?.slice(0, 80);
      outcome.result.description = meta.description?.slice(0, 500);
      const r = outcome.result;
      log.info(
        `${r.initOk ? '✓' : '×'} [${seq}/${sources.length}] ${src.id} ${r.stats.ok}/${r.stats.tested} (${Date.now() - t0}ms)${r.initError ? ` init: ${r.initError}` : ''} · 接入点 ${endpoints.filter((e) => e.ok).length}/${endpoints.length}`,
      );
      return outcome;
    } catch (e) {
      const meta = script ? parseScriptMeta(script.code, `${src.id}.js`) : undefined;
      const message = errorMessage(e);
      log.warn(`× [${seq}/${sources.length}] ${src.id} 失败：${message}`);
      const failed = failedSourceResult(src, script, message, t0, meta);
      failed.endpoints = endpoints;
      if (src.origin) failed.origin = src.origin.slice(0, 300);
      if (chosenInfo) {
        failed.via = chosenInfo.via;
        failed.chosenUrl = chosenInfo.url;
      }
      failed.version = meta?.version?.slice(0, 40);
      failed.author = meta?.author?.slice(0, 80);
      failed.description = meta?.description?.slice(0, 500);
      return {
        result: failed,
        urls: [] as UrlRecord[],
      };
    }
  });

  let finalResults = results.map((r) => r.result);
  if (opts.mergeFrom) {
    const prev = await readSnapshot(opts.mergeFrom);
    if (prev) {
      const present = new Set(finalResults.map((s) => s.id));
      const carried = prev.sources.filter((s) => !present.has(s.id));
      if (carried.length) {
        finalResults = [...finalResults, ...carried];
        log.info(`合并上一轮未测来源 ${carried.length} 个`);
      }
    } else {
      log.warn(`未能读取上一轮快照，跳过合并：${opts.mergeFrom}`);
    }
  }

  finalResults.sort((a, b) => a.id.localeCompare(b.id));
  const generatedAt = nowIso();
  const snapshot: Snapshot = {
    schemaVersion: SCHEMA_VERSION,
    runId: opts.runId ?? randomId(6),
    generatedAt,
    nextCheckAt: nextCheckAt(generatedAt, INTERVAL_HOURS),
    intervalHours: INTERVAL_HOURS,
    runner: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    checkScope: partial ? 'partial' : 'all',
    durationMs: Date.now() - started,
    summary: summarize(finalResults),
    sources: finalResults,
  };

  const validated = SnapshotSchema.safeParse(snapshot);
  if (!validated.success) {
    throw new Error(
      `快照校验失败：${validated.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('；')}`,
    );
  }

  const urls = results.flatMap((r) => r.urls);
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, `${JSON.stringify(validated.data, null, 2)}\n`, 'utf8');
  await writeFile(
    opts.urlsPath,
    `${JSON.stringify({ version: 1, generatedAt, urls }, null, 2)}\n`,
    'utf8',
  );

  const s = validated.data.summary;
  log.success(
    `完成：${s.total} 源（可用 ${s.available} / 部分 ${s.partial} / 失效 ${s.unavailable} / 未测 ${s.untested}），平台 ${s.platformsOk}/${s.platformsTested}，耗时 ${(validated.data.durationMs / 1000).toFixed(1)}s`,
  );
  log.info(`快照：${opts.outPath}`);
  log.info(`URL 清单：${opts.urlsPath}（${urls.length} 条）`);
  return { snapshot: validated.data, urls };
}

export type { ResolvedSource };
