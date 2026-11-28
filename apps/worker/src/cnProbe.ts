import type { IngestUrl } from '@lx/shared';
import type { Env } from './env';
import { loadSettings } from './settings';
import { createTask, dispatchNext, updateTask, type TaskResult } from './tasks';

export const CN_INPUT_PREFIX = 'cn:input:';
export const CN_INPUT_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOG_TTL_SECONDS = 14 * 24 * 60 * 60;
const EMPTY_MESSAGE = '国内补测：本轮没有可补测的播放地址';

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

/**
 * 没有播放地址时也留一条可见任务/运行，避免任务中心完全看不到本轮补测。
 * 这不是失败的补测，只是没有可测对象。
 */
async function recordEmptyRun(env: Env, probeRunId: string): Promise<void> {
  const now = new Date().toISOString();
  const task = await createTask(env.DB, {
    type: 'cn-probe',
    source: 'system',
    priority: 4,
    payload: { probeRunId },
  });
  const runId = task.runId ?? '';
  const logKey = `run:${runId}:log`;
  await env.DB.prepare(
    `INSERT INTO runs (run_id, task_id, trigger, status, message, log_key, generated_at, started_at, created_at,
                       total, available, partial, unavailable, untested, platforms_ok, platforms_tested,
                       runner, check_scope, duration_ms)
     VALUES (?, ?, 'schedule', 'running', '国内补测准备中', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 'worker', 'cn', 0)`,
  )
    .bind(runId, task.id, logKey, now, now, now)
    .run();

  const counts = {
    selected: 0,
    tested: 0,
    ok: 0,
    failed: 0,
    sources: 0,
    endpoints: 0,
    available: 0,
    partial: 0,
    unavailable: 0,
    untested: 0,
    platformsOk: 0,
    platformsTested: 0,
    endpointsOk: 0,
    endpointsTotal: 0,
    cnOk: 0,
    cnTested: 0,
  };
  const log = [
    `[${now}] 国内补测开始`,
    `来源运行：${probeRunId}`,
    '本轮没有可补测的播放地址，跳过补测',
    `[${now}] 国内补测完成`,
  ].join('\n');

  await env.DB.prepare(
    `UPDATE runs SET status = 'success', message = ?, generated_at = ?, duration_ms = ?, log_key = ?,
        total = 0, available = 0, partial = 0, unavailable = 0, untested = 0,
        platforms_ok = 0, platforms_tested = 0, endpoints_ok = 0, endpoints_total = 0,
        cn_tested = 0, cn_ok = 0
      WHERE run_id = ?`,
  )
    .bind(EMPTY_MESSAGE, now, 0, logKey, runId)
    .run();
  await env.SNAPSHOT.put(logKey, log, { expirationTtl: LOG_TTL_SECONDS });
  await updateTask(env.DB, task.id, {
    status: 'succeeded',
    message: EMPTY_MESSAGE,
    finishedAt: now,
    progressDone: 1,
    progressTotal: 1,
    result: {
      kind: 'cn-probe',
      summary: EMPTY_MESSAGE,
      counts,
      warnings: ['本轮没有可补测的播放地址'],
    } satisfies TaskResult,
  });
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
  if (!selected.length) {
    await recordEmptyRun(env, input.probeRunId);
    return { created: true, reason: 'no-input', selected: 0 };
  }

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
