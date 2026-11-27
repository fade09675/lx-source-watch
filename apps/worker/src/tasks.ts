import type { Env } from './env';
import {
  dispatchCnProbe,
  dispatchProbe,
  dispatchProxyFetchSub,
  dispatchProxyTest,
  type CnProbeDispatchInput,
  type DispatchResult,
  type ProbeDispatchInput,
  type ProxyFetchSubDispatchInput,
  type ProxyTestDispatchInput,
} from './dispatch';
import { checkQuota } from './usage';

export type TaskType = 'probe' | 'discovery' | 'source-test' | 'proxy-test' | 'proxy-fetch-sub' | 'retention' | 'cn-probe';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type TaskSource = 'manual' | 'schedule' | 'api' | 'retry' | 'local' | 'system';

export interface TaskResultSource {
  id: string;
  title: string;
  status: string;
  error?: string;
}

export interface TaskResultPlatform {
  sourceId: string;
  name: string;
  errorKind?: string;
  error?: string;
}

export interface TaskResultSubscription {
  id?: string;
  name: string;
  total: number;
  ok: number;
  fail: number;
}

export interface TaskResultCnFailure {
  sourceId: string;
  sourceTitle?: string;
  kind: 'platform' | 'endpoint';
  platform?: string;
  url?: string;
  error?: string;
}

/** 任务完成时写回的类型化结果；任务卡按 kind 渲染。 */
export interface TaskResult {
  kind: TaskType;
  summary: string;
  counts: Record<string, number>;
  failedSources?: TaskResultSource[];
  partialSources?: TaskResultSource[];
  okSources?: TaskResultSource[];
  failedPlatforms?: TaskResultPlatform[];
  okPlatforms?: TaskResultPlatform[];
  subscriptions?: TaskResultSubscription[];
  cnFailures?: TaskResultCnFailure[];
  warnings?: string[];
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  probe: '音源探测',
  discovery: '自动发现',
  'source-test': '单源测试',
  'proxy-test': '代理测活',
  'proxy-fetch-sub': '拉取订阅',
  retention: '数据清理',
  'cn-probe': '国内补测',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  partial: '部分成功',
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
  detailDays?: number;
  dailyDays?: number;
  eventDays?: number;
  probeRunId?: string;
  force?: boolean;
  /** 探测/补测任务使用：允许 job 回写本任务进度的短期令牌。 */
  progressToken?: string;
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
  result?: TaskResult;
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
  result: string | null;
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

function parseResult(raw: string | null): TaskResult | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TaskResult) : undefined;
  } catch {
    return undefined;
  }
}

function redactPayload(payload: TaskPayload): TaskPayload {
  // 进度令牌只给 Actions 的探测 job 用，不回传给管理端。
  const rest = { ...payload };
  delete rest.progressToken;
  return rest;
}

function toView(row: TaskRow, redact = true): TaskView {
  const payload = parsePayload(row.payload);
  return {
    id: row.id,
    type: row.type as TaskType,
    source: row.source as TaskSource,
    status: row.status as TaskStatus,
    priority: row.priority,
    payload: redact ? redactPayload(payload) : payload,
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
    result: parseResult(row.result),
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
  const payload: TaskPayload = { ...(input.payload ?? {}) };
  // 探测/补测 job 本身零密钥；给它们一个只能回写本任务进度的短期令牌。
  if (
    (input.type === 'probe' || input.type === 'source-test' || input.type === 'cn-probe') &&
    !payload.progressToken
  ) {
    payload.progressToken = randomId(32);
  }
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
      JSON.stringify(payload),
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

/** 仅服务端内部使用：保留 progressToken 供派发/进度校验，不返回给管理端。 */
export async function getTaskWithSecret(db: D1Database, id: string): Promise<TaskView | null> {
  const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
  return row ? toView(row, false) : null;
}

export interface TaskFilter {
  status?: TaskStatus;
  statuses?: TaskStatus[];
  type?: TaskType;
  source?: TaskSource;
  q?: string;
  limit?: number;
  offset?: number;
}

function taskWhere(options: TaskFilter): { where: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (options.status) {
    clauses.push('status = ?');
    binds.push(options.status);
  } else if (options.statuses && options.statuses.length > 0) {
    clauses.push(`status IN (${options.statuses.map(() => '?').join(',')})`);
    binds.push(...options.statuses);
  }
  if (options.type) {
    clauses.push('type = ?');
    binds.push(options.type);
  }
  if (options.source) {
    clauses.push('source = ?');
    binds.push(options.source);
  }
  if (options.q?.trim()) {
    clauses.push('(id LIKE ? OR message LIKE ? OR error LIKE ?)');
    const like = `%${options.q.trim()}%`;
    binds.push(like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

export async function listTasks(db: D1Database, options: TaskFilter = {}): Promise<TaskView[]> {
  const { where, binds } = taskWhere(options);
  const limit = options.limit === 0 ? 5000 : Math.max(1, Math.min(200, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = await db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<TaskRow>();
  return rows.results.map((row) => toView(row));
}

export async function countTasksFiltered(db: D1Database, options: TaskFilter = {}): Promise<number> {
  const { where, binds } = taskWhere(options);
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM tasks ${where}`).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countTasks(db: D1Database): Promise<Record<TaskStatus, number>> {
  const rows = await db
    .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    .all<{ status: string; n: number }>();
  const counts: Record<TaskStatus, number> = {
    queued: 0,
    running: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows.results) {
    if (row.status in counts) counts[row.status as TaskStatus] = row.n;
  }
  return counts;
}

export function serializeTaskResult(result: TaskResult): string {
  const full = JSON.stringify(result);
  if (full.length <= 12_000) return full;
  const trimmed = JSON.stringify({
    ...result,
    failedSources: result.failedSources?.slice(0, 3),
    partialSources: result.partialSources?.slice(0, 3),
    okSources: result.okSources?.slice(0, 3),
    failedPlatforms: result.failedPlatforms?.slice(0, 3),
    okPlatforms: result.okPlatforms?.slice(0, 3),
    subscriptions: result.subscriptions?.slice(0, 3),
    warnings: result.warnings?.slice(0, 3),
  });
  if (trimmed.length <= 12_000) return trimmed;
  return JSON.stringify({ kind: result.kind, summary: result.summary.slice(0, 500), counts: result.counts });
}

export async function updateTask(
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
    result?: TaskResult | null;
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
  if (patch.result !== undefined) {
    sets.push('result = ?');
    binds.push(patch.result === null ? null : serializeTaskResult(patch.result));
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
  if (source === 'system') return 'schedule';
  if (source === 'retry') return 'retry';
  if (source === 'local') return 'local';
  return 'manual';
}

export function buildDispatch(
  type: TaskType,
  payload: TaskPayload,
  taskId?: string,
  runId?: string,
): {
  workflow: 'probe' | 'proxy-test' | 'proxy-fetch-sub' | 'cn-probe';
  probe?: ProbeDispatchInput;
  proxy?: ProxyTestDispatchInput;
  fetchSub?: ProxyFetchSubDispatchInput;
  cnProbe?: CnProbeDispatchInput;
} {
  if (type === 'cn-probe') {
    return {
      workflow: 'cn-probe',
      cnProbe: {
        probeRunId: payload.probeRunId ?? '',
        taskId,
        runId,
        limit: payload.limit,
        progressToken: payload.progressToken,
      },
    };
  }
  if (type === 'proxy-fetch-sub') {
    return {
      workflow: 'proxy-fetch-sub',
      fetchSub: { subscriptionId: payload.subscriptionId ?? '', taskId, runId },
    };
  }
  if (type === 'proxy-test') {
    return {
      workflow: 'proxy-test',
      proxy: {
        proxyId: payload.proxyId,
        subscriptionId: payload.subscriptionId,
        concurrency: payload.concurrency,
        taskId,
        runId,
      },
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
        progressToken: payload.progressToken,
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
        progressToken: payload.progressToken,
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
      progressToken: payload.progressToken,
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
    dispatchProxyFetchSub?: (env: Env, input: ProxyFetchSubDispatchInput) => Promise<DispatchResult>;
    dispatchCnProbe?: (env: Env, input: CnProbeDispatchInput) => Promise<DispatchResult>;
  } = {},
): Promise<DispatchNextResult> {
  const now = deps.now ?? new Date().toISOString();
  const dispatchProbeFn = deps.dispatchProbe ?? dispatchProbe;
  const dispatchProxyTestFn = deps.dispatchProxyTest ?? dispatchProxyTest;
  const dispatchProxyFetchSubFn = deps.dispatchProxyFetchSub ?? dispatchProxyFetchSub;
  const dispatchCnProbeFn = deps.dispatchCnProbe ?? dispatchCnProbe;
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
    const task = toView(row, false);

    if (task.type === 'retention') {
      await updateTask(env.DB, task.id, {
        status: 'failed',
        error: '数据清理任务未由调度器启动',
        message: '数据清理未执行',
        finishedAt: now,
      });
      return { dispatched: false, task: (await getTask(env.DB, task.id)) ?? undefined, message: '数据清理未由调度器启动' };
    }

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
          : plan.workflow === 'proxy-fetch-sub'
            ? await dispatchProxyFetchSubFn(env, plan.fetchSub ?? { subscriptionId: '' })
            : plan.workflow === 'cn-probe'
              ? await dispatchCnProbeFn(env, plan.cnProbe ?? { probeRunId: '' })
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

interface RunResultRow {
  total: number;
  available: number;
  partial: number;
  unavailable: number;
  untested: number;
  platforms_ok: number;
  platforms_tested: number;
  endpoints_ok: number;
  endpoints_total: number;
  cn_tested: number;
  cn_ok: number;
  candidates_added: number;
  candidates_promoted: number;
  proxies_used: number;
  message: string;
  status: string;
  warnings: string;
}

/** 把一次运行翻译成任务卡能直接渲染的摘要。 */
async function buildTaskResult(env: Env, task: TaskView, runId: string): Promise<TaskResult | undefined> {
  const run = await env.DB.prepare(
    `SELECT total, available, partial, unavailable, untested,
            platforms_ok, platforms_tested, endpoints_ok, endpoints_total,
            cn_tested, cn_ok, candidates_added, candidates_promoted,
            proxies_used, message, status, warnings
       FROM runs WHERE run_id = ?`,
  )
    .bind(runId)
    .first<RunResultRow>();
  if (!run) return undefined;

  const counts: Record<string, number> = {
    total: run.total,
    available: run.available,
    partial: run.partial,
    unavailable: run.unavailable,
    untested: run.untested,
    platformsOk: run.platforms_ok,
    platformsTested: run.platforms_tested,
    endpointsOk: run.endpoints_ok,
    endpointsTotal: run.endpoints_total,
    cnTested: run.cn_tested,
    cnOk: run.cn_ok,
    candidatesAdded: run.candidates_added,
    candidatesPromoted: run.candidates_promoted,
  };

  if (task.type === 'proxy-test') {
    const [summary, subs] = await Promise.all([
      env.DB.prepare(
        'SELECT total, ok, kernel_ok, skipped_udp, duration_ms FROM proxy_test_runs WHERE run_id = ?',
      )
        .bind(runId)
        .first<{ total: number; ok: number; kernel_ok: number; skipped_udp: number; duration_ms: number }>(),
      env.DB.prepare(
        `SELECT r.subscription_id AS id, COALESCE(s.name, '未归属订阅') AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN r.ok = 1 THEN 1 ELSE 0 END) AS ok
           FROM proxy_test_results r
           LEFT JOIN proxy_subscriptions s ON s.id = r.subscription_id
          WHERE r.run_id = ?
          GROUP BY r.subscription_id
          ORDER BY total DESC`,
      )
        .bind(runId)
        .all<{ id: string | null; name: string; total: number; ok: number }>(),
    ]);
    const total = summary?.total ?? 0;
    const ok = summary?.ok ?? 0;
    counts.proxyTotal = total;
    counts.proxyOk = ok;
    counts.proxyFail = Math.max(0, total - ok);
    counts.kernelOk = summary?.kernel_ok ?? 0;
    counts.skippedUdp = summary?.skipped_udp ?? 0;
    counts.durationMs = summary?.duration_ms ?? 0;
    return {
      kind: task.type,
      summary: `测活 ${ok}/${total} 可用，内核 ${summary?.kernel_ok ?? 0} 个，跳过 UDP ${summary?.skipped_udp ?? 0} 个`,
      counts,
      subscriptions: subs.results.map((row) => ({
        id: row.id ?? undefined,
        name: row.name,
        total: row.total,
        ok: row.ok,
        fail: Math.max(0, row.total - row.ok),
      })),
    };
  }

  if (task.type === 'proxy-fetch-sub') {
    const sub = task.payload.subscriptionId
      ? await env.DB.prepare('SELECT name FROM proxy_subscriptions WHERE id = ?')
          .bind(task.payload.subscriptionId)
          .first<{ name: string }>()
      : null;
    const match = run.message.match(/新增\s*(\d+).*?更新\s*(\d+).*?共\s*(\d+)/);
    const added = match ? Number(match[1]) : 0;
    const updated = match ? Number(match[2]) : 0;
    const total = match ? Number(match[3]) : run.proxies_used;
    counts.added = added;
    counts.updated = updated;
    counts.total = total;
    return {
      kind: task.type,
      summary: `订阅「${sub?.name ?? '未知订阅'}」新增 ${added}、更新 ${updated}，共 ${total} 个节点`,
      counts,
    };
  }

  if (task.type === 'discovery') {
    return {
      kind: task.type,
      summary: `新增候选 ${run.candidates_added} 个，自动转正 ${run.candidates_promoted} 个`,
      counts,
      warnings: warningsOf(run.warnings),
    };
  }

  const sourceQuery = (condition: string, limit: number) =>
    env.DB.prepare(
      `SELECT sr.source_id AS id, COALESCE(r.title, sr.source_id) AS title,
              sr.status, sr.init_error AS error
         FROM source_runs sr
         LEFT JOIN source_registry r ON r.id = sr.source_id
        WHERE sr.run_id = ? AND ${condition}
        ORDER BY sr.source_id
        LIMIT ${limit}`,
    )
      .bind(runId)
      .all<{ id: string; title: string; status: string; error: string | null }>();
  const platformQuery = (condition: string, limit: number) =>
    env.DB.prepare(
      `SELECT source_id AS sourceId, COALESCE(name, platform) AS name, error_kind AS errorKind, error
         FROM platform_results
        WHERE run_id = ? AND tested = 1 AND ${condition}
        ORDER BY source_id, platform
        LIMIT ${limit}`,
    )
      .bind(runId)
      .all<{ sourceId: string; name: string; errorKind: string | null; error: string | null }>();

  const [failedSources, partialSources, okSources, failedPlatforms, okPlatforms] = await Promise.all([
    sourceQuery("sr.status = 'unavailable'", 8),
    sourceQuery("sr.status <> 'available' AND sr.status <> 'unavailable'", 8),
    sourceQuery("sr.status = 'available'", 8),
    platformQuery('ok = 0', 8),
    platformQuery('ok = 1', 20),
  ]);
  const sourceItem = (row: { id: string; title: string; status: string; error: string | null }): TaskResultSource => ({
    id: row.id,
    title: row.title,
    status: row.status,
    error: row.error ?? undefined,
  });
  const platformItem = (row: {
    sourceId: string;
    name: string;
    errorKind: string | null;
    error: string | null;
  }): TaskResultPlatform => ({
    sourceId: row.sourceId,
    name: row.name,
    errorKind: row.errorKind ?? undefined,
    error: row.error ?? undefined,
  });
  return {
    kind: task.type,
    summary: `源 ${run.total}（可用 ${run.available} / 部分 ${run.partial} / 失效 ${run.unavailable} / 未测 ${run.untested}），平台 ${run.platforms_ok}/${run.platforms_tested}，接入点 ${run.endpoints_ok}/${run.endpoints_total}`,
    counts,
    failedSources: failedSources.results.map(sourceItem),
    partialSources: partialSources.results.map(sourceItem),
    okSources: okSources.results.map(sourceItem),
    failedPlatforms: failedPlatforms.results.map(platformItem),
    okPlatforms: okPlatforms.results.map(platformItem),
    warnings: warningsOf(run.warnings),
  };
}

function warningsOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
  } catch {
    return [];
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

  const status: TaskStatus =
    run.status === 'failed' ? 'failed' : run.status === 'partial' ? 'partial' : 'succeeded';
  const result = await buildTaskResult(env, task, runId);
  const progressTotal = task.progress.total > 0 ? task.progress.total : 1;
  await updateTask(env.DB, task.id, {
    status,
    message: run.message || (status === 'failed' ? '运行失败' : '运行完成'),
    error: status === 'failed' ? run.error : null,
    finishedAt: new Date().toISOString(),
    progressDone: progressTotal,
    progressTotal,
    result: result ?? null,
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
