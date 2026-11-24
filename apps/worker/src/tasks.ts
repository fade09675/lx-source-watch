import type { Env } from './env';
import {
  dispatchProbe,
  dispatchProxyTest,
  type DispatchResult,
  type ProbeDispatchInput,
  type ProxyTestDispatchInput,
} from './dispatch';
import { checkQuota } from './usage';

export type TaskType = 'probe' | 'discovery' | 'source-test' | 'proxy-test';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskSource = 'manual' | 'schedule' | 'api' | 'retry' | 'local';

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  probe: '音源探测',
  discovery: '自动发现',
  'source-test': '单源测试',
  'proxy-test': '代理测活',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running'];
const STALE_RUNNING_MS = 45 * 60 * 1000;

export interface TaskPayload {
  only?: string;
  limit?: string;
  deep?: boolean;
  preferMirror?: boolean;
  concurrency?: number;
  cn?: boolean;
  discover?: boolean;
  proxyId?: string;
  sourceId?: string;
  subscriptionId?: string;
}

export interface TaskView {
  id: string;
  type: TaskType;
  source: TaskSource;
  status: TaskStatus;
  priority: number;
  payload: TaskPayload;
  progress: { done: number; total: number; unit: string };
  message: string;
  runId?: string;
  githubRunId?: string;
  retryCount: number;
  retryOf?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface TaskRow {
  id: string;
  type: string;
  source: string;
  status: string;
  priority: number;
  payload: string;
  progress_done: number;
  progress_total: number;
  progress_unit: string;
  message: string;
  run_id: string | null;
  github_run_id: string | null;
  retry_count: number;
  retry_of: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

function randomId(length = 12): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, length);
}

export function newTaskId(): string {
  return `task_${randomId(14)}`;
}

export function newRunId(): string {
  return `run_${randomId(14)}`;
}

function parsePayload(raw: string): TaskPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TaskPayload) : {};
  } catch {
    return {};
  }
}

function toView(row: TaskRow): TaskView {
  return {
    id: row.id,
    type: row.type as TaskType,
    source: row.source as TaskSource,
    status: row.status as TaskStatus,
    priority: row.priority,
    payload: parsePayload(row.payload),
    progress: { done: row.progress_done, total: row.progress_total, unit: row.progress_unit },
    message: row.message,
    runId: row.run_id ?? undefined,
    githubRunId: row.github_run_id ?? undefined,
    retryCount: row.retry_count,
    retryOf: row.retry_of ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

export async function createTask(
  db: D1Database,
  input: {
    type: TaskType;
    source?: TaskSource;
    payload?: TaskPayload;
    priority?: number;
    id?: string;
    runId?: string;
    now?: string;
  },
): Promise<TaskView> {
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? newTaskId();
  const runId = input.runId ?? newRunId();
  await db
    .prepare(
      `INSERT INTO tasks (id, type, source, status, priority, payload, run_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.type,
      input.source ?? 'manual',
      Math.max(1, Math.min(9, input.priority ?? 5)),
      JSON.stringify(input.payload ?? {}),
      runId,
      now,
    )
    .run();
  const task = await getTask(db, id);
  if (!task) throw new Error('任务创建失败');
  return task;
}

export async function getTask(db: D1Database, id: string): Promise<TaskView | null> {
  const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
  return row ? toView(row) : null;
}

export async function listTasks(
  db: D1Database,
  options: { status?: TaskStatus; type?: TaskType; limit?: number } = {},
): Promise<TaskView[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (options.status) {
    clauses.push('status = ?');
    binds.push(options.status);
  }
  if (options.type) {
    clauses.push('type = ?');
    binds.push(options.type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = await db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ${limit}`)
    .bind(...binds)
    .all<TaskRow>();
  return rows.results.map(toView);
}

export async function countTasks(db: D1Database): Promise<Record<TaskStatus, number>> {
  const rows = await db
    .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    .all<{ status: string; n: number }>();
  const counts: Record<TaskStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of rows.results) {
    if (row.status in counts) counts[row.status as TaskStatus] = row.n;
  }
  return counts;
}

async function updateTask(
  db: D1Database,
  id: string,
  patch: {
    status?: TaskStatus;
    message?: string;
    error?: string | null;
    startedAt?: string;
    finishedAt?: string;
    heartbeatAt?: string;
    githubRunId?: string;
    progressDone?: number;
    progressTotal?: number;
    progressUnit?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.status) {
    sets.push('status = ?');
    binds.push(patch.status);
  }
  if (patch.message !== undefined) {
    sets.push('message = ?');
    binds.push(patch.message.slice(0, 500));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    binds.push(patch.error === null ? null : patch.error.slice(0, 1000));
  }
  if (patch.startedAt) {
    sets.push('started_at = ?');
    binds.push(patch.startedAt);
  }
  if (patch.finishedAt) {
    sets.push('finished_at = ?');
    binds.push(patch.finishedAt);
  }
  if (patch.heartbeatAt) {
    sets.push('last_heartbeat_at = ?');
    binds.push(patch.heartbeatAt);
  }
  if (patch.githubRunId) {
    sets.push('github_run_id = ?');
    binds.push(patch.githubRunId);
  }
  if (patch.progressDone !== undefined) {
    sets.push('progress_done = ?');
    binds.push(patch.progressDone);
  }
  if (patch.progressTotal !== undefined) {
    sets.push('progress_total = ?');
    binds.push(patch.progressTotal);
  }
  if (patch.progressUnit !== undefined) {
    sets.push('progress_unit = ?');
    binds.push(patch.progressUnit);
  }
  if (!sets.length) return;
  binds.push(id);
  await db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

/** 抢占派发锁；拿不到说明另一轮调度正在派发。 */
export async function acquireDispatchLock(
  db: D1Database,
  holder: string,
  ttlMs = 120_000,
  now = Date.now(),
): Promise<boolean> {
  const expiresAt = new Date(now + ttlMs).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO task_locks (name, holder, expires_at) VALUES ('dispatch', ?, ?)
       ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE task_locks.expires_at < ?`,
    )
    .bind(holder, expiresAt, new Date(now).toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseDispatchLock(db: D1Database, holder: string): Promise<void> {
  await db.prepare("DELETE FROM task_locks WHERE name = 'dispatch' AND holder = ?").bind(holder).run();
}

export function triggerOf(source: TaskSource): 'schedule' | 'manual' | 'retry' | 'local' {
  if (source === 'schedule') return 'schedule';
  if (source === 'retry') return 'retry';
  if (source === 'local') return 'local';
  return 'manual';
}

export function buildDispatch(
  type: TaskType,
  payload: TaskPayload,
  taskId?: string,
  runId?: string,
): { workflow: 'probe' | 'proxy-test'; probe?: ProbeDispatchInput; proxy?: ProxyTestDispatchInput } {
  if (type === 'proxy-test') {
    return {
      workflow: 'proxy-test',
      proxy: { proxyId: payload.proxyId, subscriptionId: payload.subscriptionId, concurrency: payload.concurrency },
    };
  }
  if (type === 'discovery') {
    return {
      workflow: 'probe',
      probe: {
        discover: true,
        limit: '1',
        cn: false,
        concurrency: payload.concurrency ?? 1,
        preferMirror: payload.preferMirror,
        taskId,
        runId,
      },
    };
  }
  if (type === 'source-test') {
    return {
      workflow: 'probe',
      probe: {
        only: payload.sourceId ?? payload.only,
        limit: '1',
        cn: false,
        concurrency: 1,
        preferMirror: payload.preferMirror ?? true,
        taskId,
        runId,
      },
    };
  }
  return {
    workflow: 'probe',
    probe: {
      only: payload.only,
      limit: payload.limit,
      deep: payload.deep,
      preferMirror: payload.preferMirror,
      concurrency: payload.concurrency,
      cn: payload.cn,
      discover: payload.discover,
      proxyId: payload.proxyId,
      taskId,
      runId,
    },
  };
}

/** 给运行写一条占位记录，任务卡与运行页在 Actions 完成前就能看到。 */
async function createPlaceholderRun(db: D1Database, task: TaskView, now: string): Promise<void> {
  if (!task.runId) return;
  await db
    .prepare(
      `INSERT INTO runs (run_id, task_id, trigger, status, message, generated_at, started_at, created_at, total, available, partial, unavailable, untested, platforms_ok, platforms_tested, runner, check_scope, duration_ms)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 'github-actions', 'all', 0)
       ON CONFLICT(run_id) DO NOTHING`,
    )
    .bind(
      task.runId,
      task.id,
      triggerOf(task.source),
      `已派发${TASK_TYPE_LABEL[task.type]}，等待 Actions 启动`,
      now,
      now,
      now,
    )
    .run();
}

export interface DispatchNextResult {
  dispatched: boolean;
  task?: TaskView;
  message: string;
}

/**
 * 单并发派发：拿到派发锁 → 确认没有运行中的任务 → 取优先级最高的排队任务 →
 * 占位运行 → 触发 Actions → 标记 running。
 */
export async function dispatchNext(
  env: Env,
  deps: {
    now?: string;
    dispatchProbe?: (env: Env, input: ProbeDispatchInput) => Promise<DispatchResult>;
    dispatchProxyTest?: (env: Env, input: ProxyTestDispatchInput) => Promise<DispatchResult>;
  } = {},
): Promise<DispatchNextResult> {
  const now = deps.now ?? new Date().toISOString();
  const dispatchProbeFn = deps.dispatchProbe ?? dispatchProbe;
  const dispatchProxyTestFn = deps.dispatchProxyTest ?? dispatchProxyTest;
  const holder = crypto.randomUUID();

  const locked = await acquireDispatchLock(env.DB, holder, 120_000, Date.parse(now));
  if (!locked) return { dispatched: false, message: '调度锁被占用，稍后重试' };

  try {
    const running = await env.DB.prepare("SELECT id FROM tasks WHERE status = 'running' LIMIT 1").first<{
      id: string;
    }>();
    if (running) return { dispatched: false, message: `已有任务运行中：${running.id}` };

    const row = await env.DB.prepare(
      "SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 1",
    ).first<TaskRow>();
    if (!row) return { dispatched: false, message: '没有排队中的任务' };
    const task = toView(row);

    const quota = await checkQuota(env);
    if (!quota.ok) {
      const message = quota.message ?? '额度不足，暂停派发';
      await updateTask(env.DB, task.id, { message });
      return { dispatched: false, task: (await getTask(env.DB, task.id)) ?? undefined, message };
    }

    await updateTask(env.DB, task.id, {
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      message: '已派发，等待 Actions 启动',
    });
    await createPlaceholderRun(env.DB, task, now);

    const plan = buildDispatch(task.type, task.payload, task.id, task.runId);
    let result: DispatchResult;
    try {
      result =
        plan.workflow === 'proxy-test'
          ? await dispatchProxyTestFn(env, plan.proxy ?? {})
          : await dispatchProbeFn(env, plan.probe ?? {});
    } catch (error) {
      result = { ok: false, status: 502, message: error instanceof Error ? error.message : String(error) };
    }

    if (!result.ok) {
      await updateTask(env.DB, task.id, {
        status: 'failed',
        error: result.message,
        finishedAt: new Date().toISOString(),
        message: '派发失败',
      });
      if (task.runId) {
        await env.DB.prepare(
          "UPDATE runs SET status = 'failed', message = ?, error = ? WHERE run_id = ? AND status = 'running'",
        )
          .bind('派发失败', result.message.slice(0, 500), task.runId)
          .run();
      }
      return { dispatched: false, task: (await getTask(env.DB, task.id)) ?? undefined, message: result.message };
    }

    await updateTask(env.DB, task.id, { message: 'Actions 已启动' });
    return { dispatched: true, task: (await getTask(env.DB, task.id)) ?? undefined, message: '已派发' };
  } finally {
    await releaseDispatchLock(env.DB, holder);
  }
}

/** 上报完成后，按运行结果给对应任务收尾。 */
export async function completeTaskForRun(env: Env, runId: string): Promise<void> {
  const run = await env.DB.prepare('SELECT task_id, status, message, error FROM runs WHERE run_id = ?')
    .bind(runId)
    .first<{ task_id: string | null; status: string; message: string; error: string | null }>();
  if (!run?.task_id) return;
  const task = await getTask(env.DB, run.task_id);
  if (!task || (task.status !== 'running' && task.status !== 'queued')) return;

  const failed = run.status === 'failed';
  await updateTask(env.DB, task.id, {
    status: failed ? 'failed' : 'succeeded',
    message: run.message || (failed ? '运行失败' : '运行完成'),
    error: failed ? run.error : null,
    finishedAt: new Date().toISOString(),
    progressDone: failed ? 0 : 1,
    progressTotal: 1,
  });
}

export async function cancelTask(env: Env, id: string): Promise<TaskView | null> {
  const task = await getTask(env.DB, id);
  if (!task) return null;
  if (task.status !== 'queued' && task.status !== 'running') return task;
  await updateTask(env.DB, id, {
    status: 'cancelled',
    message: '已取消',
    finishedAt: new Date().toISOString(),
  });
  if (task.runId) {
    await env.DB.prepare("UPDATE runs SET status = 'failed', message = '任务已取消' WHERE run_id = ? AND status = 'running'")
      .bind(task.runId)
      .run();
  }
  return getTask(env.DB, id);
}

/** 心跳超时的任务标记失败；由 Cron 每次调用。 */
export async function reapStaleTasks(env: Env, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - STALE_RUNNING_MS).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, run_id FROM tasks WHERE status = 'running' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)",
  )
    .bind(cutoff)
    .all<{ id: string; run_id: string | null }>();
  for (const row of rows.results) {
    await updateTask(env.DB, row.id, {
      status: 'failed',
      error: '任务超时未完成（心跳超过 45 分钟）',
      message: '任务超时',
      finishedAt: new Date().toISOString(),
    });
    if (row.run_id) {
      await env.DB.prepare("UPDATE runs SET status = 'failed', message = '任务超时未完成' WHERE run_id = ? AND status = 'running'")
        .bind(row.run_id)
        .run();
    }
  }
  return rows.results.length;
}

export interface TaskStateSnapshot {
  counts: Record<TaskStatus, number>;
  running: TaskView[];
  queued: TaskView[];
  updatedAt: string;
}

/** 写入 task_state，供工作台/调度快速读取。 */
export async function refreshTaskState(env: Env, now = new Date().toISOString()): Promise<TaskStateSnapshot> {
  const [counts, running, queued] = await Promise.all([
    countTasks(env.DB),
    listTasks(env.DB, { status: 'running', limit: 10 }),
    listTasks(env.DB, { status: 'queued', limit: 20 }),
  ]);
  const snapshot: TaskStateSnapshot = { counts, running, queued, updatedAt: now };
  await env.DB.prepare(
    "INSERT INTO task_state (id, payload, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
  )
    .bind(JSON.stringify(snapshot), now)
    .run();
  return snapshot;
}

/** 读取任务状态快照；从未刷新过时返回空壳。 */
export async function getTaskState(db: D1Database): Promise<TaskStateSnapshot> {
  const row = await db
    .prepare("SELECT payload, updated_at FROM task_state WHERE id = 'default'")
    .first<{ payload: string; updated_at: string }>();
  if (row) {
    try {
      const parsed = JSON.parse(row.payload) as TaskStateSnapshot;
      if (parsed && typeof parsed === 'object' && parsed.counts) return parsed;
    } catch {
      // 坏数据回落空壳
    }
  }
  const counts = await countTasks(db);
  return { counts, running: [], queued: [], updatedAt: new Date().toISOString() };
}

/** 是否有排队任务；调度用。 */
export async function hasQueuedTasks(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS hit FROM tasks WHERE status = 'queued' LIMIT 1").first<{ hit: number }>();
  return Boolean(row);
}
