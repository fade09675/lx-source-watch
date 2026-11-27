import type { Env } from './env';
import { listWorkflowRuns, type RunListResult } from './dispatch';
import { updateTask } from './tasks';

const RECONCILE_MIN_AGE_MS = 5 * 60_000;
const NO_RUN_FAIL_MS = 20 * 60_000;
const COMPLETE_GRACE_MS = 60_000;

const WORKFLOW_BY_TYPE: Record<string, string> = {
  probe: 'probe.yml',
  discovery: 'probe.yml',
  'source-test': 'probe.yml',
  'cn-probe': 'cn-probe.yml',
  'proxy-test': 'proxy-test.yml',
  'proxy-fetch-sub': 'proxy-fetch-sub.yml',
};

interface RunningTaskRow {
  id: string;
  type: string;
  started_at: string | null;
  run_id: string | null;
  github_run_id: string | null;
  message: string;
}

export interface WorkflowRunRef {
  id: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconcileResult {
  checked: number;
  matched: number;
  failed: number;
  errors: string[];
}

export function workflowForTask(type: string): string | undefined {
  return WORKFLOW_BY_TYPE[type];
}

/** 单并发下，任务开始后创建的第一条同工作流 run 就是它的 run。 */
export function pickRunForTask(
  task: { startedAt: string | null; githubRunId?: string },
  runs: WorkflowRunRef[],
): WorkflowRunRef | undefined {
  if (task.githubRunId) {
    const exact = runs.find((run) => String(run.id) === task.githubRunId);
    if (exact) return exact;
  }
  if (!task.startedAt) return undefined;
  const threshold = new Date(Date.parse(task.startedAt) - 120_000).toISOString();
  return runs
    .filter((run) => run.createdAt >= threshold)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

export async function reconcileTaskRuns(
  env: Env,
  now = Date.now(),
  deps: { listRuns?: (env: Env, workflow: string, limit: number) => Promise<RunListResult> } = {},
): Promise<ReconcileResult> {
  const listRunsFn = deps.listRuns ?? listWorkflowRuns;
  const cutoff = new Date(now - RECONCILE_MIN_AGE_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, type, started_at, run_id, github_run_id, message
       FROM tasks
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT 10`,
  )
    .bind(cutoff)
    .all<RunningTaskRow>();

  const result: ReconcileResult = { checked: 0, matched: 0, failed: 0, errors: [] };
  for (const row of rows.results) {
    const workflow = workflowForTask(row.type);
    if (!workflow) continue;
    result.checked += 1;
    const listed = await listRunsFn(env, workflow, 10);
    if (!listed.ok) {
      result.errors.push(`${workflow}: ${listed.message}`);
      continue;
    }
    const run = pickRunForTask({ startedAt: row.started_at, githubRunId: row.github_run_id ?? undefined }, listed.runs);
    if (!run) {
      const age = now - Date.parse(row.started_at ?? new Date(now).toISOString());
      if (age > NO_RUN_FAIL_MS) {
        await failTask(env, row, 'GitHub 工作流未启动（超时未找到运行）', now);
        result.failed += 1;
      }
      continue;
    }

    result.matched += 1;
    if (!row.github_run_id) {
      await env.DB.prepare('UPDATE tasks SET github_run_id = ? WHERE id = ?').bind(String(run.id), row.id).run();
    }
    if (run.status !== 'completed') {
      await env.DB.prepare("UPDATE tasks SET message = ? WHERE id = ? AND status = 'running'")
        .bind('Actions 运行中', row.id)
        .run();
      continue;
    }
    if (run.updatedAt && now - Date.parse(run.updatedAt) < COMPLETE_GRACE_MS) {
      continue;
    }
    const reason =
      run.conclusion === 'success'
        ? 'GitHub 工作流已完成，但没有收到回写'
        : `GitHub 工作流失败：${run.conclusion ?? 'unknown'}`;
    await failTask(env, row, reason, now);
    result.failed += 1;
  }
  return result;
}

async function failTask(env: Env, row: RunningTaskRow, reason: string, now: number): Promise<void> {
  const finishedAt = new Date(now).toISOString();
  await updateTask(env.DB, row.id, {
    status: 'failed',
    error: reason,
    message: reason,
    finishedAt,
  });
  if (row.run_id) {
    await env.DB.prepare(
      "UPDATE runs SET status = 'failed', message = ?, error = ? WHERE run_id = ? AND status IN ('running','queued')",
    )
      .bind(reason.slice(0, 200), reason.slice(0, 500), row.run_id)
      .run();
  }
}
