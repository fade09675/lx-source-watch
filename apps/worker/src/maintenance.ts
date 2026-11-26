import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from './env';
import type { AppSettings } from './settings';

const DAY_MS = 86_400_000;

export interface RunPurgeCounts {
  /** 将被删除的探测运行数。 */
  runs: number;
  /** 将被删除的逐源结果数。 */
  sourceRuns: number;
  /** 将被删除的逐平台结果数。 */
  platformResults: number;
  /** 将被删除的接入点结果数。 */
  sourceEndpoints: number;
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

export interface PlanRunPurgeOptions {
  /** 手动清理默认连带清掉旧操作记录；定时保留策略由事件天数单独处理。 */
  includeActivity?: boolean;
}

/** 按 Asia/Shanghai 的日历日计算保留截止日（day 列格式 YYYY-MM-DD）。 */
export function dayCutoff(now: Date, days: number): string {
  const target = new Date(now.getTime() - days * DAY_MS);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(target);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 只统计、不删除，供前端确认。 */
export async function planRunPurge(
  env: Env,
  days: number,
  now = new Date(),
  options: PlanRunPurgeOptions = {},
): Promise<RunPurgePlan> {
  const requested = new Date(now.getTime() - days * DAY_MS).toISOString();
  const includeActivity = options.includeActivity !== false;
  const latestRun = await env.DB.prepare('SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1').first<{
    generated_at: string;
  }>();
  const latestProxy = await env.DB.prepare(
    'SELECT finished_at FROM proxy_test_runs ORDER BY finished_at DESC LIMIT 1',
  ).first<{ finished_at: string }>();

  const runCutoff = clampCutoff(requested, latestRun?.generated_at ?? null);
  const proxyCutoff = clampCutoff(requested, latestProxy?.finished_at ?? null);

  const [runs, sourceRuns, platformResults, sourceEndpoints, tasks, proxyTestRuns, proxyTestResults, activity] =
    await Promise.all([
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
        'SELECT COUNT(*) AS n FROM source_endpoints WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)',
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
      includeActivity
        ? count(env.DB, 'SELECT COUNT(*) AS n FROM admin_activity WHERE at < ?', runCutoff.cutoff)
        : Promise.resolve(0),
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
    sourceEndpoints,
    tasks,
    proxyTestRuns,
    proxyTestResults,
    activity,
  };
}

/** 按预览结果删除；子表先删，避免留下孤儿记录。 */
export async function executeRunPurge(env: Env, plan: RunPurgePlan): Promise<void> {
  if (
    plan.runs === 0 &&
    plan.proxyTestRuns === 0 &&
    plan.activity === 0 &&
    plan.sourceEndpoints === 0
  ) {
    return;
  }
  const statements: D1PreparedStatement[] = [];
  if (plan.activity > 0) {
    statements.push(env.DB.prepare('DELETE FROM admin_activity WHERE at < ?').bind(plan.cutoff));
  }
  if (plan.runs > 0 || plan.proxyTestRuns > 0 || plan.sourceEndpoints > 0) {
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
        .prepare('DELETE FROM source_endpoints WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)')
        .bind(plan.cutoff),
      env.DB
        .prepare('DELETE FROM source_runs WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)')
        .bind(plan.cutoff),
      env.DB.prepare('DELETE FROM runs WHERE generated_at < ?').bind(plan.cutoff),
    );
  }
  await env.DB.batch(statements);
}

export interface ScheduledRetentionResult {
  detail: RunPurgePlan;
  sourceDaily: number;
  platformDaily: number;
  events: number;
  activity: number;
  dailyCutoff: string;
  eventCutoff: string;
}

/**
 * 按设置里的三个保留天数执行一次清理：
 * - 运行明细：runs 及其子表，始终保留最新一轮；
 * - 日汇总：source_daily / platform_daily；
 * - 事件：events / admin_activity。
 * 返回各类删除数量，供日志与测试使用。
 */
export async function runScheduledRetention(
  env: Env,
  settings: AppSettings,
  now = new Date(),
): Promise<ScheduledRetentionResult> {
  const detail = await planRunPurge(env, settings.retentionDetailDays, now, { includeActivity: false });
  await executeRunPurge(env, detail);

  const dailyCutoff = dayCutoff(now, settings.retentionDailyDays);
  const eventCutoff = new Date(now.getTime() - settings.retentionEventDays * DAY_MS).toISOString();

  const [sourceDaily, platformDaily, events, activity] = await Promise.all([
    count(env.DB, 'SELECT COUNT(*) AS n FROM source_daily WHERE day < ?', dailyCutoff),
    count(env.DB, 'SELECT COUNT(*) AS n FROM platform_daily WHERE day < ?', dailyCutoff),
    count(env.DB, 'SELECT COUNT(*) AS n FROM events WHERE at < ?', eventCutoff),
    count(env.DB, 'SELECT COUNT(*) AS n FROM admin_activity WHERE at < ?', eventCutoff),
  ]);

  const statements: D1PreparedStatement[] = [];
  if (sourceDaily > 0) statements.push(env.DB.prepare('DELETE FROM source_daily WHERE day < ?').bind(dailyCutoff));
  if (platformDaily > 0) statements.push(env.DB.prepare('DELETE FROM platform_daily WHERE day < ?').bind(dailyCutoff));
  if (events > 0) statements.push(env.DB.prepare('DELETE FROM events WHERE at < ?').bind(eventCutoff));
  if (activity > 0) statements.push(env.DB.prepare('DELETE FROM admin_activity WHERE at < ?').bind(eventCutoff));
  if (statements.length > 0) await env.DB.batch(statements);

  return {
    detail,
    sourceDaily,
    platformDaily,
    events,
    activity,
    dailyCutoff,
    eventCutoff,
  };
}
