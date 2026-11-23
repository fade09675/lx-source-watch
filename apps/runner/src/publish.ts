import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CandidateFileSchema,
  IngestPayloadSchema,
  SnapshotSchema,
  type Candidate,
  type IngestPayload,
} from '@lx/shared';
import { log } from './logger.js';
import { httpRequest } from './net/http.js';

export interface PublishOptions {
  snapshotPath: string;
  candidatesPath?: string;
  endpoint: string;
  secret: string;
  dryRun?: boolean;
  timeoutMs?: number;
  maxCandidates?: number;
  /** 仅本地联调时允许上报到 127.0.0.1。 */
  allowPrivate?: boolean;
}

export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function readCandidates(path: string | undefined, max: number): Promise<Candidate[] | undefined> {
  if (!path) return undefined;
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

/**
 * 把快照 + 候选摘要 POST 给 Worker。
 * 这里绝不执行任何音源代码，只做 JSON 校验与 HMAC 签名。
 */
export async function publishIngest(opts: PublishOptions): Promise<{ status: number; body: string }> {
  const snapshotRaw = await readFile(opts.snapshotPath, 'utf8');
  const snapshot = SnapshotSchema.parse(JSON.parse(snapshotRaw));
  const candidates = await readCandidates(opts.candidatesPath, opts.maxCandidates ?? 100);

  const payload: IngestPayload = IngestPayloadSchema.parse({ snapshot, candidates });
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
