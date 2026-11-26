import type { Env } from './env';
import {
  createTask,
  dispatchNext as dispatchNextDefault,
  newRunId,
  updateTask,
  type DispatchNextResult,
  type TaskPayload,
  type TaskResult,
  type TaskType,
} from './tasks';
import { loadSettings, normalizeSettings, type AppSettings } from './settings';
import { runScheduledRetention } from './maintenance';

/** 默认间隔（设置里可改）。 */
export const PROBE_INTERVAL_HOURS = 4;
export const PROXY_TEST_INTERVAL_HOURS = 6;
export const DISCOVERY_INTERVAL_HOURS = 12;

export const SCHEDULER_STATE_KEY = 'scheduler:state';
export const RETENTION_STATE_KEY = 'retention:last';

const RETENTION_INTERVAL_MS = 86_400_000;

interface RetentionState {
  at: string;
  ok?: boolean;
  error?: string;
}

/** 兼容旧版本直接写 ISO 字符串的状态。 */
function parseRetentionState(raw: string | null): RetentionState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as RetentionState;
    if (value && typeof value.at === 'string') return value;
  } catch {
    // 旧值是 ISO 字符串。
  }
  return Number.isFinite(Date.parse(raw)) ? { at: raw } : null;
}

const MANUAL_KEYS = {
  probe: 'run:probe:last',
  proxyTest: 'run:proxy-test:last',
  discovery: 'run:discovery:last',
} as const;

export interface JobState {
  /** 最近一次尝试触发的时间（ISO）。 */
  at: string;
  ok: boolean;
  error?: string;
}

export interface SchedulerState {
  probe?: JobState;
  proxyTest?: JobState;
  /** 最近一次自动发现。 */
  discovery?: JobState;
}

export interface JobStatus {
  intervalHours: number;
  enabled: boolean;
  /** 最近一次定时触发时间。 */
  lastAt?: string;
  lastOk?: boolean;
  lastError?: string;
  /** 最近一次手动触发时间（来自 KV run:*:last）。 */
  manualAt?: string;
  /** 下一次应触发时间；没有记录时表示马上会触发。 */
  nextAt: string;
}

export interface SchedulerStatus {
  probe: JobStatus;
  proxyTest: JobStatus;
  discovery: JobStatus;
  retention: JobStatus;
  now: string;
}

export interface EnqueueInput {
  type: TaskType;
  payload: TaskPayload;
  priority?: number;
}

export interface EnqueueResult {
  ok: boolean;
  taskId?: string;
  message?: string;
}

export interface SchedulerDeps {
  /** 测试时可注入设置，跳过数据库。 */
  settings?: AppSettings;
  /** 测试时可注入建任务函数，跳过 D1。 */
  enqueue?: (env: Env, input: EnqueueInput) => Promise<EnqueueResult>;
  /** 测试时可注入派发函数。 */
  dispatchNext?: (env: Env) => Promise<DispatchNextResult>;
}

async function defaultEnqueue(env: Env, input: EnqueueInput): Promise<EnqueueResult> {
  if (!env.DB) return { ok: false, message: '未配置数据库，无法建任务' };
  const task = await createTask(env.DB, {
    type: input.type,
    payload: input.payload,
    priority: input.priority,
    source: 'schedule',
  });
  return { ok: true, taskId: task.id };
}

export function isDue(lastAt: string | undefined, intervalHours: number, now = Date.now()): boolean {
  if (!lastAt) return true;
  const parsed = Date.parse(lastAt);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed >= intervalHours * 3_600_000;
}

function laterIso(a: string | null | undefined, b: string | null | undefined): string | undefined {
  const left = a ? Date.parse(a) : Number.NaN;
  const right = b ? Date.parse(b) : Number.NaN;
  if (!Number.isFinite(left)) return Number.isFinite(right) ? new Date(right).toISOString() : undefined;
  if (!Number.isFinite(right)) return new Date(left).toISOString();
  return new Date(Math.max(left, right)).toISOString();
}

async function readState(env: Env): Promise<SchedulerState> {
  const raw = await env.SNAPSHOT.get(SCHEDULER_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as SchedulerState;
  } catch {
    return {};
  }
}

async function writeState(env: Env, state: SchedulerState): Promise<void> {
  await env.SNAPSHOT.put(SCHEDULER_STATE_KEY, JSON.stringify(state));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

function jobStatus(
  intervalHours: number,
  enabled: boolean,
  job: JobState | undefined,
  manualAt: string | null,
  now: number,
): JobStatus {
  const last = laterIso(job?.at, manualAt);
  const nextAt = last
    ? new Date(Date.parse(last) + intervalHours * 3_600_000).toISOString()
    : new Date(now).toISOString();
  return {
    intervalHours,
    enabled,
    lastAt: job?.at,
    lastOk: job?.ok,
    lastError: job?.error,
    manualAt: manualAt ?? undefined,
    nextAt,
  };
}

async function readSettings(env: Env, deps: SchedulerDeps): Promise<AppSettings> {
  if (deps.settings) return deps.settings;
  if (!env.DB) return normalizeSettings({});
  return loadSettings(env.DB);
}

/** 每天最多执行一次保留清理，并作为「数据清理」任务写入任务中心、运行记录与运行日志。 */
async function runRetentionIfDue(env: Env, settings: AppSettings, now: number): Promise<void> {
  if (!env.DB) return;
  try {
    const last = parseRetentionState(await env.SNAPSHOT.get(RETENTION_STATE_KEY));
    if (last && now - Date.parse(last.at) < RETENTION_INTERVAL_MS) return;
  } catch {
    // KV 读失败时继续尝试清理，避免因为状态读取失败一直不清理。
  }

  const at = new Date(now).toISOString();
  let retentionOk = false;
  let retentionError: string | undefined;
  let taskId: string;
  try {
    const task = await createTask(env.DB, {
      type: 'retention',
      source: 'schedule',
      priority: 9,
      payload: {
        detailDays: settings.retentionDetailDays,
        dailyDays: settings.retentionDailyDays,
        eventDays: settings.retentionEventDays,
      },
    });
    taskId = task.id;
  } catch (error) {
    console.warn('数据清理任务创建失败', errorMessage(error));
    return;
  }

  const runId = newRunId();
  const logKey = `run:${runId}:log`;
  const startedAt = at;
  const startedMs = Date.now();
  const lines = [
    `[${at}] 数据清理开始`,
    `保留策略：运行明细 ${settings.retentionDetailDays} 天，日汇总 ${settings.retentionDailyDays} 天，事件 ${settings.retentionEventDays} 天`,
  ];

  try {
    await env.DB.prepare(
      `INSERT INTO runs (run_id, task_id, trigger, status, message, log_key, generated_at, started_at, created_at,
                         total, available, partial, unavailable, untested, platforms_ok, platforms_tested,
                         runner, check_scope, duration_ms)
       VALUES (?, ?, 'schedule', 'running', '数据清理执行中', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 'worker', 'retention', 0)`,
    )
      .bind(runId, taskId, logKey, startedAt, startedAt, startedAt)
      .run();
    await env.DB.prepare('UPDATE tasks SET run_id = ? WHERE id = ?').bind(runId, taskId).run();
    await updateTask(env.DB, taskId, {
      status: 'running',
      startedAt,
      message: '数据清理执行中',
      progressDone: 0,
      progressTotal: 1,
    });
  } catch (error) {
    console.warn('数据清理运行记录创建失败', errorMessage(error));
    return;
  }

  try {
    const result = await runScheduledRetention(env, settings, new Date(now));
    const counts = {
      runs: result.detail.runs,
      sourceRuns: result.detail.sourceRuns,
      platformResults: result.detail.platformResults,
      sourceEndpoints: result.detail.sourceEndpoints,
      tasks: result.detail.tasks,
      proxyTestRuns: result.detail.proxyTestRuns,
      proxyTestResults: result.detail.proxyTestResults,
      sourceDaily: result.sourceDaily,
      platformDaily: result.platformDaily,
      events: result.events,
      activity: result.activity,
    };
    const summary =
      `清理完成：运行 ${counts.runs} 轮、接入点 ${counts.sourceEndpoints} 条、` +
      `日汇总 ${counts.sourceDaily}/${counts.platformDaily} 条、事件 ${counts.events} 条、操作记录 ${counts.activity} 条`;
    lines.push(
      `运行明细：删除运行 ${counts.runs} 轮、逐源 ${counts.sourceRuns} 条、平台 ${counts.platformResults} 条、接入点 ${counts.sourceEndpoints} 条、任务 ${counts.tasks} 条`,
      `代理测活：删除轮次 ${counts.proxyTestRuns} 条、明细 ${counts.proxyTestResults} 条`,
      `日汇总：source_daily ${counts.sourceDaily} 条、platform_daily ${counts.platformDaily} 条（截止 ${result.dailyCutoff}）`,
      `事件：events ${counts.events} 条、操作记录 ${counts.activity} 条（截止 ${result.eventCutoff}）`,
    );
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    lines.push(`[${finishedAt}] 数据清理完成，用时 ${durationMs}ms`);

    await env.DB.prepare(
      `UPDATE runs SET status = 'success', message = ?, generated_at = ?, duration_ms = ?, log_key = ? WHERE run_id = ?`,
    )
      .bind(summary, finishedAt, durationMs, logKey, runId)
      .run();
    await updateTask(env.DB, taskId, {
      status: 'succeeded',
      message: summary,
      finishedAt,
      progressDone: 1,
      progressTotal: 1,
      result: { kind: 'retention', summary, counts } satisfies TaskResult,
    });
    console.log(summary);
    retentionOk = true;
  } catch (error) {
    const message = errorMessage(error);
    retentionError = message;
    const finishedAt = new Date().toISOString();
    lines.push(`[${finishedAt}] 数据清理失败：${message}`);
    try {
      await env.DB.prepare(
        `UPDATE runs SET status = 'failed', message = ?, error = ?, generated_at = ?, duration_ms = ?, log_key = ? WHERE run_id = ?`,
      )
        .bind(`数据清理失败：${message}`, message, finishedAt, Date.now() - startedMs, logKey, runId)
        .run();
      await updateTask(env.DB, taskId, {
        status: 'failed',
        message: '数据清理失败',
        error: message,
        finishedAt,
        progressDone: 1,
        progressTotal: 1,
      });
    } catch (recordError) {
      console.warn('数据清理失败记录写入失败', errorMessage(recordError));
    }
    console.warn('数据清理失败', message);
  }

  try {
    await env.SNAPSHOT.put(logKey, lines.join('\n'), { expirationTtl: 14 * 86_400 });
  } catch {
    // 日志写失败不影响任务结果。
  }

  try {
    const state: RetentionState = { at, ok: retentionOk, error: retentionError };
    await env.SNAPSHOT.put(RETENTION_STATE_KEY, JSON.stringify(state));
  } catch {
    // 状态写入失败最多导致下一轮 cron 重试一次。
  }
}

/**
 * 由 Worker 的 Cron Trigger 每 5 分钟调用一次。
 *
 * 到点只负责“建任务”（排队），随后尝试派发一个任务；真正执行由 Actions 完成。
 * 触发失败也会记录时间并等下一个间隔，避免每 5 分钟反复打 GitHub。
 * 间隔与开关来自网页设置。
 */
export async function runScheduler(
  env: Env,
  now = Date.now(),
  deps: SchedulerDeps = {},
): Promise<{ probe: boolean; proxyTest: boolean; discovery: boolean }> {
  const settings = await readSettings(env, deps);
  const enqueueFn = deps.enqueue ?? defaultEnqueue;
  const dispatchFn = deps.dispatchNext ?? dispatchNextDefault;

  const state = await readState(env);
  const [manualProbe, manualProxy, manualDiscovery] = await Promise.all([
    env.SNAPSHOT.get(MANUAL_KEYS.probe),
    env.SNAPSHOT.get(MANUAL_KEYS.proxyTest),
    env.SNAPSHOT.get(MANUAL_KEYS.discovery),
  ]);

  const at = new Date(now).toISOString();
  const queued = { probe: false, proxyTest: false, discovery: false };
  let changed = false;

  const probeDue =
    settings.probeEnabled &&
    isDue(laterIso(state.probe?.at, manualProbe), settings.probeIntervalHours, now);
  const discoveryDue =
    settings.discoveryEnabled &&
    isDue(laterIso(state.discovery?.at, manualDiscovery), settings.discoveryIntervalHours, now);
  const proxyDue =
    settings.proxyTestEnabled &&
    isDue(laterIso(state.proxyTest?.at, manualProxy), settings.proxyTestIntervalHours, now);

  if (probeDue) {
    changed = true;
    try {
      const result = await enqueueFn(env, {
        type: 'probe',
        priority: 5,
        payload: {
          limit: settings.probeLimit > 0 ? String(settings.probeLimit) : undefined,
          concurrency: settings.probeConcurrency,
          deep: settings.probeDeep,
          preferMirror: settings.preferMirror,
          cn: settings.cnEnabled,
        },
      });
      state.probe = result.ok ? { at, ok: true } : { at, ok: false, error: result.message };
      queued.probe = result.ok;
    } catch (error) {
      state.probe = { at, ok: false, error: errorMessage(error) };
    }
  }

  if (discoveryDue) {
    changed = true;
    try {
      const result = await enqueueFn(env, {
        type: 'discovery',
        priority: 6,
        payload: { concurrency: 1, preferMirror: settings.preferMirror },
      });
      state.discovery = result.ok ? { at, ok: true } : { at, ok: false, error: result.message };
      queued.discovery = result.ok;
    } catch (error) {
      state.discovery = { at, ok: false, error: errorMessage(error) };
    }
  }

  if (proxyDue) {
    changed = true;
    try {
      const result = await enqueueFn(env, { type: 'proxy-test', priority: 7, payload: {} });
      state.proxyTest = result.ok ? { at, ok: true } : { at, ok: false, error: result.message };
      queued.proxyTest = result.ok;
    } catch (error) {
      state.proxyTest = { at, ok: false, error: errorMessage(error) };
    }
  }

  if (changed) {
    await writeState(env, state);
    if (queued.probe || queued.discovery || queued.proxyTest) {
      try {
        await dispatchFn(env);
      } catch {
        // 派发失败由下一次 cron 或任务中心手动重试，这里不阻断状态写入。
      }
    }
  }

  await runRetentionIfDue(env, settings, now);

  return queued;
}

/** 给工作台读取的定时状态。 */
export async function getSchedulerStatus(
  env: Env,
  now = Date.now(),
  deps: SchedulerDeps = {},
): Promise<SchedulerStatus> {
  const settings = await readSettings(env, deps);
  const state = await readState(env);
  const [manualProbe, manualProxy, manualDiscovery] = await Promise.all([
    env.SNAPSHOT.get(MANUAL_KEYS.probe),
    env.SNAPSHOT.get(MANUAL_KEYS.proxyTest),
    env.SNAPSHOT.get(MANUAL_KEYS.discovery),
  ]);
  const retention = parseRetentionState(await env.SNAPSHOT.get(RETENTION_STATE_KEY));
  const retentionLastAt = retention?.at;
  const retentionNextAt = retentionLastAt
    ? new Date(Date.parse(retentionLastAt) + RETENTION_INTERVAL_MS).toISOString()
    : new Date(now).toISOString();
  return {
    probe: jobStatus(settings.probeIntervalHours, settings.probeEnabled, state.probe, manualProbe, now),
    proxyTest: jobStatus(
      settings.proxyTestIntervalHours,
      settings.proxyTestEnabled,
      state.proxyTest,
      manualProxy,
      now,
    ),
    discovery: jobStatus(
      settings.discoveryIntervalHours,
      settings.discoveryEnabled,
      state.discovery,
      manualDiscovery,
      now,
    ),
    retention: {
      intervalHours: 24,
      enabled: true,
      lastAt: retentionLastAt,
      lastOk: retention?.ok,
      lastError: retention?.error,
      nextAt: retentionNextAt,
    },
    now: new Date(now).toISOString(),
  };
}
