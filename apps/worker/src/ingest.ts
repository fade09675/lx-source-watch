import { IngestPayloadSchema, SnapshotSchema, type Snapshot } from '@lx/shared';
import type { Context } from 'hono';
import { alreadyIngested, loadRecentStatuses, writeSnapshot } from './db';
import { SNAPSHOT_KEY, type Env } from './env';
import { diffEvents } from './events';
import { verifySignature } from './hmac';
import { mergeSnapshot } from './merge';
import { recordKvPut } from './usage';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

type Ctx = Context<{ Bindings: Env }>;

function fail(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

async function readPrev(env: Env): Promise<Snapshot | null> {
  const raw = await env.SNAPSHOT.get(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return SnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Actions 上报入口：HMAC 校验 → runId 幂等 → 与 KV 上一轮合并 → D1 落库 → KV 最新快照。
 * D1 先写、KV 后写：D1 失败时展示层不变；KV 失败时上报方带同一 runId 重试即可补齐。
 */
export async function handleIngest(c: Ctx): Promise<Response> {
  const env = c.env;
  if (!env.INGEST_SECRET) return fail(500, 'not_configured', 'Worker 未配置 INGEST_SECRET');

  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large', '上报正文超过 2MB');
  }

  const body = await c.req.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large', '上报正文超过 2MB');
  }

  const verify = await verifySignature({
    body,
    secret: env.INGEST_SECRET,
    signature: c.req.header('x-lx-signature') ?? null,
    timestamp: c.req.header('x-lx-timestamp') ?? null,
  });
  if (!verify.ok) return fail(401, 'bad_signature', `签名校验失败：${verify.reason ?? 'unknown'}`);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return fail(400, 'bad_json', '正文不是合法 JSON');
  }

  const parsed = IngestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(400, 'bad_payload', `载荷不合法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }

  const { snapshot, candidates = [] } = parsed.data;
  const now = new Date().toISOString();

  if (await alreadyIngested(env.DB, snapshot.runId)) {
    // 幂等：重复上报只刷新 KV 展示层，不再写明细。
    const prev = await readPrev(env);
    const merged = mergeSnapshot(prev, snapshot);
    await recordKvPut(env);
    await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(merged));
    return Response.json({ ok: true, duplicate: true, runId: snapshot.runId, sources: merged.sources.length });
  }

  const prev = await readPrev(env);
  const merged = mergeSnapshot(prev, snapshot);
  const recent = await loadRecentStatuses(env.DB, snapshot.runId, 3);
  const events = diffEvents({
    runId: snapshot.runId,
    at: merged.generatedAt,
    prev,
    incoming: merged,
    recent,
  });

  const stats = await writeSnapshot(env.DB, {
    snapshot: merged,
    events,
    candidates,
    recent,
    now,
  });

  await recordKvPut(env);
  await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(merged));

  return Response.json({
    ok: true,
    duplicate: false,
    runId: snapshot.runId,
    sources: stats.sources,
    platforms: stats.platforms,
    events: stats.events,
    candidates: stats.candidates,
  });
}
