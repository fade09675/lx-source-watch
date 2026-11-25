import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from './env';

const DAY_MS = 86_400_000;

export interface RunPurgeCounts {
  /** 将被删除的探测运行数。 */
  runs: number;
  /** 将被删除的逐源结果数。 */
  sourceRuns: number;
  /** 将被删除的逐平台结果数。 */
  platformResults: number;
  /** 将被删除的任务记录数。 */
  tasks: number;
  /** 将被删除的测活轮次数。 */
  proxyTestRuns: number;
  /** 将被删除的测活明细数。 */
  proxyTestResults: number;
  /** 将被删除的操作记录数。 */
  activity: number;
}

export interface RunPurgePlan extends RunPurgeCounts {
  /** 前端传入的保留天数。 */
  days: number;
  /** 实际使用的截止时间（早于该时间的记录会被删除）。 */
  cutoff: string;
  /** 测活记录实际使用的截止时间。 */
  proxyCutoff: string;
  /** 最新一轮探测运行的时间，始终保留。 */
  latestRunAt: string | null;
  /** 最新一轮测活的时间，始终保留。 */
  latestProxyTestAt: string | null;
  /** 是否因为要保住最新一轮而把截止时间提前了。 */
  clamped: boolean;
}

/** 截止时间不能超过最新一条记录，否则会把最新一轮也删掉。 */
export function clampCutoff(requested: string, latest: string | null): { cutoff: string; clamped: boolean } {
  if (!latest || requested <= latest) return { cutoff: requested, clamped: false };
  return { cutoff: latest, clamped: true };
}

async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 只统计、不删除，供前端确认。 */
export async function planRunPurge(env: Env, days: number, now = new Date()): Promise<RunPurgePlan> {
  const requested = new Date(now.getTime() - days * DAY_MS).toISOString();
  const latestRun = await env.DB.prepare('SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1').first<{
    generated_at: string;
  }>();
  const latestProxy = await env.DB.prepare(
    'SELECT finished_at FROM proxy_test_runs ORDER BY finished_at DESC LIMIT 1',
  ).first<{ finished_at: string }>();

  const runCutoff = clampCutoff(requested, latestRun?.generated_at ?? null);
  const proxyCutoff = clampCutoff(requested, latestProxy?.finished_at ?? null);

  const [runs, sourceRuns, platformResults, tasks, proxyTestRuns, proxyTestResults, activity] = await Promise.all([
    count(env.DB, 'SELECT COUNT(*) AS n FROM runs WHERE generated_at < ?', runCutoff.cutoff),
    count(
      env.DB,
      'SELECT COUNT(*) AS n FROM source_runs WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)',
      runCutoff.cutoff,
    ),
    count(
      env.DB,
      'SELECT COUNT(*) AS n FROM platform_results WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)',
      runCutoff.cutoff,
    ),
    count(
      env.DB,
      'SELECT COUNT(*) AS n FROM tasks WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?) OR run_id IN (SELECT run_id FROM proxy_test_runs WHERE finished_at < ?)',
      runCutoff.cutoff,
      proxyCutoff.cutoff,
    ),
    count(env.DB, 'SELECT COUNT(*) AS n FROM proxy_test_runs WHERE finished_at < ?', proxyCutoff.cutoff),
    count(
      env.DB,
      'SELECT COUNT(*) AS n FROM proxy_test_results WHERE run_id IN (SELECT run_id FROM proxy_test_runs WHERE finished_at < ?)',
      proxyCutoff.cutoff,
    ),
    count(env.DB, 'SELECT COUNT(*) AS n FROM admin_activity WHERE at < ?', runCutoff.cutoff),
  ]);

  return {
    days,
    cutoff: runCutoff.cutoff,
    proxyCutoff: proxyCutoff.cutoff,
    latestRunAt: latestRun?.generated_at ?? null,
    latestProxyTestAt: latestProxy?.finished_at ?? null,
    clamped: runCutoff.clamped || proxyCutoff.clamped,
    runs,
    sourceRuns,
    platformResults,
    tasks,
    proxyTestRuns,
    proxyTestResults,
    activity,
  };
}

/** 按预览结果删除；子表先删，避免留下孤儿记录。 */
export async function executeRunPurge(env: Env, plan: RunPurgePlan): Promise<void> {
  if (plan.runs === 0 && plan.proxyTestRuns === 0 && plan.activity === 0) return;
  const statements: D1PreparedStatement[] = [];
  if (plan.activity > 0) {
    statements.push(env.DB.prepare('DELETE FROM admin_activity WHERE at < ?').bind(plan.cutoff));
  }
  if (plan.runs > 0 || plan.proxyTestRuns > 0) {
    statements.push(
      env.DB
        .prepare('DELETE FROM proxy_test_results WHERE run_id IN (SELECT run_id FROM proxy_test_runs WHERE finished_at < ?)')
        .bind(plan.proxyCutoff),
      // 任务要在 runs / proxy_test_runs 删除前清理，子查询才查得到旧记录。
      env.DB
        .prepare(
          'DELETE FROM tasks WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?) OR run_id IN (SELECT run_id FROM proxy_test_runs WHERE finished_at < ?)',
        )
        .bind(plan.cutoff, plan.proxyCutoff),
      env.DB.prepare('DELETE FROM proxy_test_runs WHERE finished_at < ?').bind(plan.proxyCutoff),
      env.DB
        .prepare('DELETE FROM platform_results WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)')
        .bind(plan.cutoff),
      env.DB
        .prepare('DELETE FROM source_runs WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)')
        .bind(plan.cutoff),
      env.DB.prepare('DELETE FROM runs WHERE generated_at < ?').bind(plan.cutoff),
    );
  }
  await env.DB.batch(statements);
}
