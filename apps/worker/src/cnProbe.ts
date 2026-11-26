import type { IngestUrl } from '@lx/shared';
import type { Env } from './env';
import { loadSettings } from './settings';
import { createTask, dispatchNext } from './tasks';

export const CN_INPUT_PREFIX = 'cn:input:';
export const CN_INPUT_TTL_SECONDS = 3 * 24 * 60 * 60;

export interface CnInput {
  probeRunId: string;
  createdAt: string;
  snapshot: unknown;
  urls: IngestUrl[];
}

function dedupe(urls: IngestUrl[]): IngestUrl[] {
  const seen = new Set<string>();
  const out: IngestUrl[] = [];
  for (const url of urls) {
    if (seen.has(url.url)) continue;
    seen.add(url.url);
    out.push(url);
  }
  return out;
}

/** 只保留海外未通过的地址；同源最多占四分之一，避免单个源吃满批次。 */
export function selectCnUrls(urls: IngestUrl[], cap = 200): IngestUrl[] {
  const failed = dedupe(urls.filter((url) => url.ok !== true));
  const perSource = new Map<string, number>();
  const maxPerSource = Math.max(1, Math.ceil(cap / 4));
  const out: IngestUrl[] = [];
  const overflow: IngestUrl[] = [];
  for (const url of failed) {
    const used = perSource.get(url.sourceId) ?? 0;
    if (used >= maxPerSource) {
      overflow.push(url);
      continue;
    }
    perSource.set(url.sourceId, used + 1);
    out.push(url);
    if (out.length >= cap) return out;
  }
  // 源数量不足时，单源上限会让批次填不满；按当前占比从少到多补齐，保持分布均衡。
  while (out.length < cap && overflow.length > 0) {
    overflow.sort((a, b) => (perSource.get(a.sourceId) ?? 0) - (perSource.get(b.sourceId) ?? 0));
    const url = overflow.shift() as IngestUrl;
    perSource.set(url.sourceId, (perSource.get(url.sourceId) ?? 0) + 1);
    out.push(url);
  }
  return out;
}

export async function enqueueCnProbe(
  env: Env,
  input: { probeRunId: string; snapshot: unknown; urls: IngestUrl[]; force?: boolean },
): Promise<{ created: boolean; reason?: string; selected?: number }> {
  const settings = await loadSettings(env.DB);
  if (!settings.cnEnabled) return { created: false, reason: 'disabled' };

  if (!input.force) {
    const latest = await env.DB.prepare(
      `SELECT created_at FROM tasks WHERE type = 'cn-probe' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ created_at: string }>();
    if (latest && Date.now() - Date.parse(latest.created_at) < 24 * 60 * 60 * 1000) {
      return { created: false, reason: 'cooldown' };
    }
    const active = await env.DB.prepare(
      `SELECT id FROM tasks WHERE type = 'cn-probe' AND status IN ('queued', 'running') LIMIT 1`,
    ).first<{ id: string }>();
    if (active) return { created: false, reason: 'already-queued' };
  }

  const selected = selectCnUrls(input.urls, 200);
  if (!selected.length) return { created: false, reason: 'no-input', selected: 0 };

  const task = await createTask(env.DB, {
    type: 'cn-probe',
    source: 'system',
    priority: 4,
    payload: { probeRunId: input.probeRunId },
  });
  const body: CnInput = {
    probeRunId: input.probeRunId,
    createdAt: new Date().toISOString(),
    snapshot: input.snapshot,
    urls: selected,
  };
  await env.SNAPSHOT.put(`${CN_INPUT_PREFIX}${input.probeRunId}`, JSON.stringify(body), {
    expirationTtl: CN_INPUT_TTL_SECONDS,
  });
  try {
    await dispatchNext(env);
  } catch {
    // 排队失败不影响探测入库；下一轮调度会继续派发。
  }
  return { created: true, selected: selected.length };
}

export async function readCnInput(env: Env, probeRunId: string): Promise<CnInput | null> {
  const raw = await env.SNAPSHOT.get(`${CN_INPUT_PREFIX}${probeRunId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CnInput;
  } catch {
    return null;
  }
}
