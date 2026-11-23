import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SourceResult } from '@lx/shared';
import { log } from './logger.js';
import { httpRequest, type ProxyConfig } from './net/http.js';
import { loadRegistry } from './registry.js';
import { loadScript } from './script.js';
import { errorMessage, mapLimit, nowIso } from './util.js';
import type { UrlRecord } from './probe/platform.js';
import { probeSource } from './probe/source.js';

export interface CnRow {
  sourceId: string;
  platform: string;
  quality?: string;
  url: string;
  proxy: string;
  ok: boolean;
  status: number;
  contentType?: string;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  speedKbps?: number;
  error?: string;
}

export interface CnFile {
  version: 1;
  generatedAt: string;
  mode: 'verify' | 'execute';
  proxy: string;
  summary: { tested: number; ok: number };
  rows: CnRow[];
}

export interface CnVerifyOptions {
  urlsPath: string;
  outPath: string;
  proxy: ProxyConfig;
  concurrency?: number;
  timeoutMs?: number;
  limit?: number;
  platform?: string;
}

const CN_MAX_BYTES = 262_144;

interface UrlsFile {
  version: 1;
  generatedAt: string;
  urls: UrlRecord[];
}

async function probeUrl(record: UrlRecord, proxy: ProxyConfig, timeoutMs: number): Promise<CnRow> {
  const started = Date.now();
  const base: CnRow = {
    sourceId: record.sourceId,
    platform: record.platform,
    quality: record.quality,
    url: record.url,
    proxy: proxy.label,
    ok: false,
    status: 0,
    ttfbMs: 0,
    totalMs: 0,
    bytes: 0,
  };
  let res;
  try {
    res = await httpRequest(record.url, {
      headers: { range: `bytes=0-${CN_MAX_BYTES - 1}`, accept: '*/*' },
      timeoutMs,
      maxBytes: CN_MAX_BYTES,
      proxy,
      maxRedirects: 5,
    });
    if ([400, 405, 416, 501].includes(res.status)) {
      res = await httpRequest(record.url, {
        headers: { accept: '*/*' },
        timeoutMs,
        maxBytes: CN_MAX_BYTES,
        proxy,
        maxRedirects: 5,
      });
    }
  } catch (e) {
    return {
      ...base,
      totalMs: Date.now() - started,
      error: errorMessage(e).slice(0, 300),
    };
  }

  const elapsed = Math.max(1, Date.now() - started);
  const contentType = res.headers['content-type'];
  const reachable = (res.status === 200 || res.status === 206) && res.body.length > 0;
  return {
    ...base,
    ok: reachable,
    status: res.status,
    contentType,
    ttfbMs: Math.round(res.firstByteMs),
    totalMs: elapsed,
    bytes: res.body.length,
    speedKbps: reachable ? Math.round((res.body.length * 8) / elapsed) : undefined,
    error: reachable ? undefined : `HTTP ${res.status}`,
  };
}

/** 国内补测（只测已解析 URL，不执行脚本，避免代理凭据暴露给第三方脚本）。 */
export async function cnVerify(opts: CnVerifyOptions): Promise<CnFile> {
  const raw = JSON.parse(await readFile(opts.urlsPath, 'utf8')) as UrlsFile;
  let urls = raw.urls ?? [];
  if (opts.platform) urls = urls.filter((u) => u.platform === opts.platform);
  if (opts.limit) urls = urls.slice(0, opts.limit);

  // 同一 URL 只测一次，但保留 sourceId/platform 归属。
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  log.step(`国内补测：${unique.length} 条 URL，代理 ${opts.proxy.label}，并发 ${opts.concurrency ?? 5}`);
  const rows = await mapLimit(unique, Math.max(1, opts.concurrency ?? 5), (u) =>
    probeUrl(u, opts.proxy as ProxyConfig, opts.timeoutMs ?? 15_000),
  );
  const ok = rows.filter((r) => r.ok).length;
  const file: CnFile = {
    version: 1,
    generatedAt: nowIso(),
    mode: 'verify',
    proxy: opts.proxy.label,
    summary: { tested: rows.length, ok },
    rows,
  };
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  log.success(`国内补测完成：${ok}/${rows.length} 可达（${opts.proxy.label}）`);
  return file;
}

export interface CnExecuteOptions extends Omit<CnVerifyOptions, 'urlsPath'> {
  registryPath: string;
  only?: string[];
  limit?: number;
}

/**
 * 走代理重新执行脚本（高风险模式）。
 * 会执行第三方 JS，并让脚本看到代理凭据，因此只应对 trusted 来源开启。
 */
export async function cnExecute(opts: CnExecuteOptions): Promise<{ sources: SourceResult[]; outPath: string }> {
  const sources = await loadRegistry(opts.registryPath, { only: opts.only, limit: opts.limit ?? 5 });
  log.step(`国内执行模式：${sources.length} 个来源，代理 ${opts.proxy.label}`);
  const results = await mapLimit(sources, 1, async (src) => {
    try {
      const script = await loadScript(src, { proxy: opts.proxy });
      const outcome = await probeSource(src, script, {
        mode: 'default',
        requestTimeoutMs: 30_000,
        platformTimeoutMs: 20_000,
        streamTimeoutMs: opts.timeoutMs ?? 15_000,
        initTimeoutMs: 12_000,
        scriptTimeoutMs: 15_000,
        platformConcurrency: 3,
        proxy: opts.proxy,
      });
      log.info(`✓ ${src.id} ${outcome.result.stats.ok}/${outcome.result.stats.tested}`);
      return outcome.result;
    } catch (e) {
      log.warn(`× ${src.id}: ${errorMessage(e)}`);
      return undefined;
    }
  });
  const kept = results.filter((r): r is SourceResult => Boolean(r));
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(
    opts.outPath,
    `${JSON.stringify({ version: 1, generatedAt: nowIso(), proxy: opts.proxy.label, sources: kept }, null, 2)}\n`,
    'utf8',
  );
  return { sources: kept, outPath: opts.outPath };
}
