import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SnapshotSchema, type SourceResult } from '@lx/shared';
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

export interface CnEndpointRow {
  sourceId: string;
  url: string;
  role: 'primary' | 'candidate';
  ok: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  error?: string;
}

export interface CnFile {
  version: 1;
  generatedAt: string;
  mode: 'verify' | 'execute';
  proxy: string;
  summary: { tested: number; ok: number };
  rows: CnRow[];
  /** 接入点（主地址/镜像）的国内连通性；4B 起写入。 */
  endpoints?: CnEndpointRow[];
}

export interface CnProgressEvent {
  stage: 'loading' | 'sources' | 'endpoints' | 'reporting';
  done: number;
  total: number;
  unit?: string;
  message?: string;
}

export interface CnVerifyOptions {
  urlsPath: string;
  outPath: string;
  proxy: ProxyConfig;
  /** 展示用代理名；缺省用 proxy.label。 */
  proxyLabel?: string;
  concurrency?: number;
  timeoutMs?: number;
  limit?: number;
  platform?: string;
  /** failed=只补测海外未通过的地址（默认）；all=全部重测。 */
  scope?: CnScope;
  /** 探测产物 status.json，用来补测每个接入点；缺省 out/status.json。 */
  statusPath?: string;
  /** 跳过接入点补测（只测平台播放地址）。 */
  skipEndpoints?: boolean;
  /** 任务进度回调；没有任务系统时为空。 */
  onProgress?: (event: CnProgressEvent) => void | Promise<void>;
}

export type CnScope = 'failed' | 'all';

/**
 * 国内补测只挑“海外没跑通”的地址，避免每轮重复测可用链接。
 * 与 IPTV 的 cn-probe 选择口径一致；all 仅用于手动排查。
 */
export function selectCnUrls(urls: UrlRecord[], scope: CnScope): UrlRecord[] {
  if (scope === 'all') return urls;
  return urls.filter((url) => url.ok !== true);
}

const CN_MAX_BYTES = 262_144;
const CN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface UrlsFile {
  version: 1;
  generatedAt: string;
  urls: UrlRecord[];
}

async function probeUrl(record: UrlRecord, proxy: ProxyConfig, timeoutMs: number, proxyLabel: string): Promise<CnRow> {
  const started = Date.now();
  const base: CnRow = {
    sourceId: record.sourceId,
    platform: record.platform,
    quality: record.quality,
    url: record.url,
    proxy: proxyLabel,
    ok: false,
    status: 0,
    ttfbMs: 0,
    totalMs: 0,
    bytes: 0,
  };
  let res;
  try {
    res = await httpRequest(record.url, {
      headers: { range: `bytes=0-${CN_MAX_BYTES - 1}`, accept: '*/*', 'user-agent': CN_USER_AGENT },
      timeoutMs,
      maxBytes: CN_MAX_BYTES,
      proxy,
      maxRedirects: 5,
    });
    if ([400, 405, 416, 501].includes(res.status)) {
      res = await httpRequest(record.url, {
        headers: { accept: '*/*', 'user-agent': CN_USER_AGENT },
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

/** 接入点国内连通性：经代理拉脚本前 64KB，失败再回退整段（上限 512KB）。 */
async function probeEndpoint(
  record: { sourceId: string; url: string; role: 'primary' | 'candidate' },
  proxy: ProxyConfig,
  timeoutMs: number,
): Promise<CnEndpointRow> {
  const started = Date.now();
  const base: CnEndpointRow = {
    sourceId: record.sourceId,
    url: record.url,
    role: record.role,
    ok: false,
    status: 0,
    ttfbMs: 0,
    totalMs: 0,
    bytes: 0,
  };
  let res;
  try {
    res = await httpRequest(record.url, {
      headers: { range: 'bytes=0-65535', accept: '*/*', 'user-agent': CN_USER_AGENT },
      timeoutMs,
      maxBytes: 65_536,
      proxy,
      maxRedirects: 5,
    });
    if ([400, 405, 416, 501].includes(res.status)) {
      res = await httpRequest(record.url, {
        headers: { accept: '*/*', 'user-agent': CN_USER_AGENT },
        timeoutMs,
        maxBytes: 524_288,
        proxy,
        maxRedirects: 5,
      });
    }
  } catch (e) {
    return { ...base, totalMs: Date.now() - started, error: errorMessage(e).slice(0, 300) };
  }

  const elapsed = Math.max(1, Date.now() - started);
  const reachable = (res.status === 200 || res.status === 206) && res.body.length > 0;
  return {
    ...base,
    ok: reachable,
    status: res.status,
    ttfbMs: Math.round(res.firstByteMs),
    totalMs: elapsed,
    bytes: res.body.length,
    error: reachable ? undefined : `HTTP ${res.status}`,
  };
}

interface EndpointRecord {
  sourceId: string;
  url: string;
  role: 'primary' | 'candidate';
}

async function loadEndpointRecords(path: string): Promise<EndpointRecord[]> {
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) {
      log.warn(`接入点补测跳过：${path} 无法识别（${parsed.error.issues[0]?.message ?? ''}）`);
      return [];
    }
    return parsed.data.sources.flatMap((source) =>
      source.endpoints.map((endpoint) => ({
        sourceId: source.id,
        url: endpoint.url,
        role: endpoint.role,
      })),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn(`接入点补测跳过：读取 ${path} 失败（${errorMessage(e)}）`);
    return [];
  }
}

/** 同一 URL 只测一次，再按来源展开；镜像 URL 基本各不相同，去重收益有限但无害。 */
async function probeEndpoints(
  path: string,
  proxy: ProxyConfig,
  concurrency: number,
  timeoutMs: number,
): Promise<CnEndpointRow[]> {
  const records = await loadEndpointRecords(path);
  if (!records.length) return [];
  const unique = new Map<string, EndpointRecord>();
  for (const record of records) if (!unique.has(record.url)) unique.set(record.url, record);
  const probed = new Map<string, CnEndpointRow>();
  await mapLimit([...unique.values()], Math.max(1, concurrency), async (record) => {
    const row = await probeEndpoint(record, proxy, timeoutMs);
    probed.set(record.url, row);
  });
  return records.map((record) => {
    const row = probed.get(record.url);
    return row
      ? { ...row, sourceId: record.sourceId, role: record.role }
      : { ...record, ok: false, status: 0, ttfbMs: 0, totalMs: 0, bytes: 0, error: '未测' };
  });
}

/** 国内补测（只测已解析 URL，不执行脚本，避免代理凭据暴露给第三方脚本）。 */
export async function cnVerify(opts: CnVerifyOptions): Promise<CnFile> {
  const raw = JSON.parse(await readFile(opts.urlsPath, 'utf8')) as UrlsFile;
  let urls = raw.urls ?? [];
  if (opts.platform) urls = urls.filter((u) => u.platform === opts.platform);
  urls = selectCnUrls(urls, opts.scope ?? 'failed');
  if (opts.limit) urls = urls.slice(0, opts.limit);

  // 同一 URL 只测一次，但保留 sourceId/platform 归属。
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  log.step(`国内补测：${unique.length} 条 URL，代理 ${opts.proxyLabel ?? opts.proxy.label}，并发 ${opts.concurrency ?? 5}`);
  await opts.onProgress?.({
    stage: 'loading',
    done: 0,
    total: unique.length,
    unit: '地址',
    message: `开始补测 ${unique.length} 个播放地址`,
  });
  const label = opts.proxyLabel ?? opts.proxy.label;
  let completed = 0;
  const rows = await mapLimit(unique, Math.max(1, opts.concurrency ?? 5), async (u) => {
    const row = await probeUrl(u, opts.proxy as ProxyConfig, opts.timeoutMs ?? 15_000, label);
    completed += 1;
    if (completed === unique.length || completed % 10 === 0) {
      await opts.onProgress?.({
        stage: 'sources',
        done: completed,
        total: unique.length,
        unit: '地址',
        message: `已补测 ${completed}/${unique.length} 个地址`,
      });
    }
    return row;
  });
  await opts.onProgress?.({
    stage: 'endpoints',
    done: unique.length,
    total: unique.length,
    unit: '地址',
    message: '地址补测完成，正在检查接入点',
  });
  const ok = rows.filter((r) => r.ok).length;
  const endpoints = opts.skipEndpoints
    ? undefined
    : await probeEndpoints(
        opts.statusPath ?? 'out/status.json',
        opts.proxy as ProxyConfig,
        opts.concurrency ?? 5,
        opts.timeoutMs ?? 15_000,
      );
  if (endpoints?.length) {
    const cnOk = endpoints.filter((row) => row.ok).length;
    log.success(`接入点补测完成：${cnOk}/${endpoints.length} 国内可达`);
  }
  const file: CnFile = {
    version: 1,
    generatedAt: nowIso(),
    mode: 'verify',
    proxy: label,
    summary: { tested: rows.length, ok },
    rows,
    ...(endpoints?.length ? { endpoints } : {}),
  };
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  log.success(`国内补测完成：${ok}/${rows.length} 可达（${opts.proxyLabel ?? opts.proxy.label}）`);
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
