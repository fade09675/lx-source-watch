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

/** 国内补测必须覆盖本轮全部播放地址：海外成败不代表国内可达性。 */
export function selectCnUrls(urls: IngestUrl[]): IngestUrl[] {
  return dedupe(urls);
}

export async function enqueueCnProbe(
  env: Env,
  input: { probeRunId: string; snapshot: unknown; urls: IngestUrl[]; force?: boolean },
): Promise<{ created: boolean; reason?: string; selected?: number }> {
  const settings = await loadSettings(env.DB);
  if (!settings.cnEnabled) return { created: false, reason: 'disabled' };

  if (!input.force) {
    const active = await env.DB.prepare(
      `SELECT id FROM tasks WHERE type = 'cn-probe' AND status IN ('queued', 'running') LIMIT 1`,
    ).first<{ id: string }>();
    if (active) return { created: false, reason: 'already-queued' };
  }

  const selected = selectCnUrls(input.urls);
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
