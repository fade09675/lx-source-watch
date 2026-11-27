import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CandidateFileSchema,
  IngestPayloadSchema,
  SnapshotSchema,
  textToJsonl,
  type Candidate,
  type IngestPayload,
  type Snapshot,
} from '@lx/shared';
import { log } from './logger.js';
import type { CnFile } from './cn.js';
import { httpRequest } from './net/http.js';

export interface PublishOptions {
  snapshotPath: string;
  candidatesPath?: string;
  /** 本轮解析出的播放地址，供独立国内补测任务复用。 */
  urlsPath?: string;
  /** 国内补测结果；存在时合并进每个平台的 cn 字段。 */
  cnPath?: string;
  endpoint: string;
  secret: string;
  dryRun?: boolean;
  timeoutMs?: number;
  maxCandidates?: number;
  /** 仅本地联调时允许上报到 127.0.0.1。 */
  allowPrivate?: boolean;
  /** 任务系统：关联任务、触发方式与日志文件。 */
  taskId?: string;
  trigger?: 'schedule' | 'manual' | 'retry' | 'local';
  logPath?: string;
}

export async function readCnFile(path: string): Promise<CnFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CnFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn(`读取国内补测结果失败，忽略：${(e as Error).message}`);
    return null;
  }
}

/** 把国内补测行按 sourceId+platform 合并进快照；一个平台多条 URL 时任一可达即算可达。 */
export function applyCnResults(snapshot: Snapshot, cn: CnFile): void {
  const grouped = new Map<string, CnFile['rows']>();
  for (const row of cn.rows ?? []) {
    const key = `${row.sourceId}\u0000${row.platform}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  for (const source of snapshot.sources) {
    for (const platform of source.platforms) {
      const rows = grouped.get(`${source.id}\u0000${platform.key}`);
      if (!rows || !rows.length) continue;
      const okRow = rows.find((row) => row.ok);
      const best = okRow ?? rows[0]!;
      platform.cn = {
        tested: true,
        ok: Boolean(okRow),
        ms: best.totalMs || undefined,
        ttfbMs: best.ttfbMs || undefined,
        error: okRow ? undefined : best.error ?? `国内不可达（HTTP ${best.status}）`,
        httpStatus: best.status || undefined,
        proxy: cn.proxy,
      };
    }
  }

  const endpointRows = new Map<string, NonNullable<CnFile['endpoints']>>();
  for (const row of cn.endpoints ?? []) {
    const key = `${row.sourceId}\u0000${row.url}`;
    const list = endpointRows.get(key) ?? [];
    list.push(row);
    endpointRows.set(key, list);
  }
  if (!endpointRows.size) return;
  for (const source of snapshot.sources) {
    for (const endpoint of source.endpoints) {
      const rows = endpointRows.get(`${source.id}\u0000${endpoint.url}`);
      if (!rows?.length) continue;
      const okRow = rows.find((row) => row.ok);
      const best = okRow ?? rows[0]!;
      endpoint.cn = {
        tested: true,
        ok: Boolean(okRow),
        ms: best.totalMs || undefined,
        ttfbMs: best.ttfbMs || undefined,
        error: okRow ? undefined : best.error ?? `国内不可达（HTTP ${best.status}）`,
        httpStatus: best.status || undefined,
        proxy: cn.proxy,
      };
    }
  }
}

export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function readUrls(path: string | undefined) {
  if (!path) return undefined;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { urls?: unknown[] };
    return Array.isArray(raw.urls) ? raw.urls.slice(0, 1000) : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn(`读取地址文件失败，忽略：${(e as Error).message}`);
    return undefined;
  }
}

async function readCandidates(path: string | undefined, max: number): Promise<Candidate[] | undefined> {  if (!path) return undefined;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(raw)) {
      const list = raw as Candidate[];
      return list.slice(0, max);
    }
    const parsed = CandidateFileSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(`候选文件校验失败，忽略：${parsed.error.issues[0]?.message ?? ''}`);
      return undefined;
    }
    return parsed.data.candidates
      .filter((c) => c.initOk === true || c.state === 'new')
      .slice(0, max);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn(`读取候选文件失败，忽略：${(e as Error).message}`);
    return undefined;
  }
}

async function readLog(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const text = await readFile(path, 'utf8');
    return text.slice(0, 200_000);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn(`读取运行日志失败，忽略：${(e as Error).message}`);
    return undefined;
  }
}

/**
 * 把快照 + 候选摘要 POST 给 Worker。
 * 这里绝不执行任何音源代码，只做 JSON 校验与 HMAC 签名。
 */
export async function publishIngest(opts: PublishOptions): Promise<{ status: number; body: string }> {
  const snapshotRaw = await readFile(opts.snapshotPath, 'utf8');
  const snapshot = SnapshotSchema.parse(JSON.parse(snapshotRaw));
  if (opts.cnPath) {
    const cn = await readCnFile(opts.cnPath);
    if (cn) {
      applyCnResults(snapshot, cn);
      const platformCn = snapshot.sources.reduce((n, source) => n + source.platforms.filter((p) => p.cn?.tested).length, 0);
      const endpointCn = snapshot.sources.reduce((n, source) => n + source.endpoints.filter((e) => e.cn?.tested).length, 0);
      log.info(
        `已合并国内补测：${cn.summary.ok}/${cn.summary.tested} 条地址可达，命中 ${platformCn} 个平台、${endpointCn} 个接入点（${cn.proxy}）`,
      );
    }
  }
  const candidates = await readCandidates(opts.candidatesPath, opts.maxCandidates ?? 100);
  const urls = await readUrls(opts.urlsPath);
  const runLog = await readLog(opts.logPath);

  const meta = {
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    trigger: opts.trigger ?? (process.env.GITHUB_ACTIONS === 'true' ? 'schedule' : 'local'),
    ...(runLog ? { log: runLog, logJsonl: textToJsonl(runLog).slice(0, 200_000) } : {}),
  };
  const payload: IngestPayload = IngestPayloadSchema.parse({ snapshot, candidates, urls, meta });
  const body = JSON.stringify(payload);
  const signature = opts.secret ? signPayload(body, opts.secret) : 'dry-run';

  if (opts.dryRun) {
    const out = `${dirname(opts.snapshotPath)}/ingest-payload.json`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log.info(`dry-run：请求体 ${body.length} 字节，签名 ${signature.slice(0, 16)}…，已写入 ${out}`);
    return { status: 0, body: 'dry-run' };
  }

  log.step(`上报 ${opts.endpoint}（${(body.length / 1024).toFixed(1)} KB）`);
  const res = await httpRequest(opts.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-lx-signature': signature,
      'x-lx-timestamp': new Date().toISOString(),
      'user-agent': 'lx-source-watch/1.0',
    },
    body,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxRedirects: 0,
    allowPrivate: opts.allowPrivate,
  });

  const text = res.body.toString('utf8');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`上报失败：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  log.success(`上报成功：HTTP ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, body: text };
}
