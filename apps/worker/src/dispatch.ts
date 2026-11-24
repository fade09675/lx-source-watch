import type { Env } from './env';

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'fade09675/lx-source-watch';
const WORKFLOW_FILE = 'probe.yml';

export interface ProbeDispatchInput {
  only?: string;
  limit?: string;
  deep?: boolean;
  preferMirror?: boolean;
  /** 单轮源并发。 */
  concurrency?: number;
  /** 本轮是否跑国内补测。 */
  cn?: boolean;
  /** 本轮是否顺带做自动发现。 */
  discover?: boolean;
  /** 强制国内补测使用指定代理节点；留空则自动挑选。 */
  proxyId?: string;
  /** 关联的任务 id 与预分配的运行 id。 */
  taskId?: string;
  runId?: string;
}

export type DispatchResult =
  | { ok: true; dispatchedAt: string }
  | { ok: false; status: number; message: string };

export interface WorkflowRunView {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  /** 工作流标识：probe / proxy-test。 */
  workflow: string;
}

export type RunListResult =
  | { ok: true; runs: WorkflowRunView[] }
  | { ok: false; status: number; message: string };

function repoOf(env: Env): string {
  return env.GH_REPO?.trim() || DEFAULT_REPO;
}

function tokenOf(env: Env): string {
  return env.GH_DISPATCH_TOKEN?.trim() ?? '';
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'lx-source-watch',
    'x-github-api-version': '2022-11-28',
  };
}

function clean(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 触发一次探测工作流。GitHub 的派发接口成功时返回 204。 */
export async function dispatchProbe(env: Env, input: ProbeDispatchInput): Promise<DispatchResult> {
  const concurrency = Math.max(1, Math.min(8, Number(input.concurrency) || 4));
  return dispatchWorkflow(env, 'probe.yml', {
    only: clean(input.only),
    limit: clean(input.limit, 10),
    concurrency: String(concurrency),
    deep: input.deep ? 'true' : 'false',
    prefer_mirror: input.preferMirror ? 'true' : 'false',
    cn: input.cn === false ? 'false' : 'true',
    discover: input.discover ? 'true' : 'false',
    proxy_id: clean(input.proxyId, 64),
    task_id: clean(input.taskId, 64),
    run_id: clean(input.runId, 64),
  });
}

export interface ProxyTestDispatchInput {
  proxyId?: string;
  subscriptionId?: string;
  concurrency?: number;
  taskId?: string;
  runId?: string;
}

/** 触发代理测活工作流。 */
export async function dispatchProxyTest(env: Env, input: ProxyTestDispatchInput): Promise<DispatchResult> {
  const concurrency = Math.max(1, Math.min(10, Number(input.concurrency) || 5));
  return dispatchWorkflow(env, 'proxy-test.yml', {
    proxy_id: clean(input.proxyId, 64),
    sub_id: clean(input.subscriptionId, 64),
    concurrency: String(concurrency),
    task_id: clean(input.taskId, 64),
    run_id: clean(input.runId, 64),
  });
}

export interface ProxyFetchSubDispatchInput {
  subscriptionId: string;
  taskId?: string;
  runId?: string;
}

/** 403 兜底：让 Actions 去拉订阅，再回传文本。 */
export async function dispatchProxyFetchSub(
  env: Env,
  input: ProxyFetchSubDispatchInput,
): Promise<DispatchResult> {
  return dispatchWorkflow(env, 'proxy-fetch-sub.yml', {
    subscription_id: clean(input.subscriptionId, 64),
    task_id: clean(input.taskId, 64),
    run_id: clean(input.runId, 64),
  });
}

async function dispatchWorkflow(
  env: Env,
  workflow: string,
  inputs: Record<string, string>,
): Promise<DispatchResult> {
  const token = tokenOf(env);
  if (!token) return { ok: false, status: 503, message: '未配置触发令牌，无法从网页启动' };

  const payload = { ref: 'main', inputs };

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${repoOf(env)}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, status: 502, message: '连接 GitHub 失败，请稍后重试' };
  }

  if (response.status === 204) return { ok: true, dispatchedAt: new Date().toISOString() };
  if (response.status === 401) return { ok: false, status: 502, message: '触发令牌无效或已过期' };
  if (response.status === 403) return { ok: false, status: 502, message: '触发令牌没有“操作”写入权限' };
  if (response.status === 404) return { ok: false, status: 502, message: '仓库或工作流不存在' };
  if (response.status === 422) return { ok: false, status: 400, message: '触发参数不合法' };
  return { ok: false, status: 502, message: `GitHub 返回 HTTP ${response.status}` };
}

/** 读取探测工作流最近几次运行，用于网页上显示进度。 */
export async function listProbeRuns(env: Env, limit = 5): Promise<RunListResult> {
  return listWorkflowRuns(env, WORKFLOW_FILE, limit);
}

/** 读取任意工作流的最近运行。 */
export async function listWorkflowRuns(env: Env, workflow: string, limit = 5): Promise<RunListResult> {
  const token = tokenOf(env);
  if (!token) return { ok: false, status: 503, message: '未配置触发令牌，无法查询运行状态' };

  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API}/repos/${repoOf(env)}/actions/workflows/${workflow}/runs?per_page=${Math.min(20, Math.max(1, limit))}`,
      { headers: githubHeaders(token) },
    );
  } catch {
    return { ok: false, status: 502, message: '连接 GitHub 失败，请稍后重试' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: 502, message: '触发令牌无效或没有读取权限' };
  }
  if (!response.ok) return { ok: false, status: 502, message: `GitHub 返回 HTTP ${response.status}` };

  const body = (await response.json()) as { workflow_runs?: unknown };
  const list = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  const runs: WorkflowRunView[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    runs.push({
      id: typeof item.id === 'number' ? item.id : 0,
      name: typeof item.name === 'string' ? item.name : '音源探测',
      event: typeof item.event === 'string' ? item.event : '',
      status: typeof item.status === 'string' ? item.status : 'unknown',
      conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
      url: typeof item.html_url === 'string' ? item.html_url : '',
      workflow,
    });
  }
  return { ok: true, runs };
}

export type WorkflowRunsResult =
  | { ok: true; runs: WorkflowRunView[]; errors: string[] }
  | { ok: false; status: number; message: string };

/** 工作台用：一次取两类工作流的最近运行并合并排序。 */
export async function listAllRuns(env: Env, limitPerWorkflow = 6): Promise<WorkflowRunsResult> {
  const [probe, proxyTest] = await Promise.all([
    listWorkflowRuns(env, 'probe.yml', limitPerWorkflow),
    listWorkflowRuns(env, 'proxy-test.yml', limitPerWorkflow),
  ]);
  if (!probe.ok && !proxyTest.ok) {
    return { ok: false, status: probe.status, message: probe.message };
  }
  const runs = [...(probe.ok ? probe.runs : []), ...(proxyTest.ok ? proxyTest.runs : [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const errors: string[] = [];
  if (!probe.ok) errors.push(`探测：${probe.message}`);
  if (!proxyTest.ok) errors.push(`测活：${proxyTest.message}`);
  return { ok: true, runs, errors };
}
