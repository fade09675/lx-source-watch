import type {
  ApiErrorBody,
  Candidate,
  EventItem,
  HealthResponse,
  MirrorTemplate,
  RunSummary,
  SourceDetailResponse,
  StatusEnvelope,
} from '@lx/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.assign(`/login?next=${next}`);
    throw new ApiError(401, 'unauthorized', '请先登录');
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const error = (body ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(response.status, error.error ?? 'http_error', error.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return body as T;
}

export interface StatusFilters {
  platforms?: string[];
  statuses?: string[];
  q?: string;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface CandidateList {
  candidates: Candidate[];
  count: number;
  counts?: Record<string, number>;
}

export interface AppSettingsView {
  probeEnabled: boolean;
  probeIntervalHours: number;
  probeLimit: number;
  probeConcurrency: number;
  probeDeep: boolean;
  preferMirror: boolean;
  cnEnabled: boolean;
  cnMaxProxies: number;
  cnConcurrency: number;
  proxyTestEnabled: boolean;
  proxyTestIntervalHours: number;
  discoveryEnabled: boolean;
  discoveryIntervalHours: number;
  autoPromoteCandidates: boolean;
  autoPromoteMaxPerRun: number;
  retentionDetailDays: number;
  retentionDailyDays: number;
  retentionEventDays: number;
  updatedAt?: string;
}

export interface SettingsResult {
  settings: AppSettingsView;
  scheduler: SchedulerStatus;
}

export interface SystemView {
  site: string;
  repo: string;
  schemaVersion: number;
  tokens: { github: boolean; cloudflare: boolean; runner: boolean; ingest: boolean };
  scheduler: SchedulerStatus;
  counts: { candidates: Record<string, number>; sources: number };
  serverTime: string;
}

export interface AdminProxy {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  kernelOnly: boolean;
  engine: string;
  enabled: boolean;
  subscriptionId: string | null;
  subscriptionName: string | null;
  hasPassword: boolean;
  hasConfig: boolean;
  lastOkAt: string | null;
  lastLatencyMs: number | null;
  egressIp: string | null;
  country: string;
  asn: string;
  successCount: number;
  failCount: number;
  lastError: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionItem {
  id: string;
  name: string;
  url: string;
  kind: 'url' | 'file';
  userAgent: string;
  enabled: boolean;
  lastFetchAt: string | null;
  lastStatus: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export interface SubscriptionList {
  items: SubscriptionItem[];
}

export interface SubscriptionInput {
  name?: string;
  url: string;
  userAgent?: string;
}

export interface SubscriptionPatch {
  name?: string;
  url?: string;
  enabled?: boolean;
  userAgent?: string;
}

export interface ProxyList {
  items: AdminProxy[];
}

export interface ProxyImportResult {
  ok: boolean;
  added: number;
  updated: number;
  total: number;
  kernelOnly: number;
  warnings: string[];
  source?: string;
  fetchedBytes?: number;
  subscription?: SubscriptionItem;
}

export interface ProxyInput {
  name?: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  config?: string;
}

export interface ProxyPatch {
  name?: string;
  enabled?: boolean;
  sortOrder?: number;
  password?: string;
  config?: string;
}

export interface WorkflowRunView {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  workflow: string;
}

export interface UsageDay {
  date: string;
  kvWrites: number;
  d1Writes: number;
  githubMinutes: number;
}

export interface UsageView {
  collectedAt: string;
  kv: {
    day: string;
    reads: number;
    writes: number;
    lists: number;
    deletes: number;
    storageBytes: number;
    storageDay?: string;
    localWrites?: number;
  };
  d1: { day: string; rowsRead: number; rowsWritten: number };
  github: { month: string; minutes: number; runs: number; private?: boolean };
  history: UsageDay[];
  cloudflareError?: string | null;
}

export interface SchedulerJobStatus {
  intervalHours: number;
  lastAt?: string;
  lastOk?: boolean;
  lastError?: string;
  manualAt?: string;
  nextAt: string;
  enabled?: boolean;
}

export interface SchedulerStatus {
  probe: SchedulerJobStatus;
  proxyTest: SchedulerJobStatus;
  discovery?: SchedulerJobStatus;
  now: string;
}

export interface WorkflowRunsResult {
  ok?: boolean;
  runs: WorkflowRunView[];
  errors: string[];
  lastProbeDispatchedAt?: string | null;
  lastProxyTestDispatchedAt?: string | null;
  scheduler?: SchedulerStatus;
}

/* ------------------------------- tasks ---------------------------------- */

export type TaskType = 'probe' | 'discovery' | 'source-test' | 'proxy-test';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskView {
  id: string;
  type: TaskType;
  source: string;
  status: TaskStatus;
  priority: number;
  payload: { limit?: number; concurrency?: number; deep?: boolean; preferMirror?: boolean; cn?: boolean; only?: string };
  progress: { done: number; total: number; unit: string };
  message: string;
  runId?: string;
  githubRunId?: string;
  retryCount: number;
  lastHeartbeatAt?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface TaskStateSnapshot {
  counts: Record<TaskStatus, number>;
  running: TaskView[];
  queued: TaskView[];
  updatedAt: string;
}

export interface TaskListResult {
  tasks: TaskView[];
  counts: Record<TaskStatus, number>;
  state: TaskStateSnapshot;
  labels: { types: Record<string, string>; statuses: Record<string, string> };
}

export interface CreateTaskResult {
  ok: boolean;
  task: TaskView;
  dispatch: { dispatched: boolean; message?: string };
  state: TaskStateSnapshot;
}

export interface RunSourceDetail {
  sourceId: string;
  title: string;
  category: string;
  status: string;
  initOk: boolean;
  initError: string | null;
  ok: number;
  tested: number;
  total: number;
  durationMs: number;
  version: string | null;
  scriptSha: string | null;
  endpointsOk: number;
  endpointsTotal: number;
}

export interface RunPlatformDetail {
  sourceId: string;
  platform: string;
  name: string;
  declared: boolean;
  tested: boolean;
  ok: boolean;
  quality: string | null;
  resolveMs: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  httpStatus: number | null;
  contentType: string | null;
  errorKind: string | null;
  error: string | null;
  urlHost: string | null;
  cnTested: boolean;
  cnOk: boolean;
  cnError: string | null;
}

export interface RunEndpointStat {
  sourceId: string;
  total: number;
  ok: number;
  failed: number;
  error: string | null;
}

export interface RunEndpointRow {
  sourceId: string;
  url: string;
  role: 'primary' | 'candidate';
  ok: boolean;
  status: number | null;
  sha: string | null;
  version: string | null;
  versionState: 'synced' | 'lagging' | 'unknown' | null;
  bytes: number | null;
  ms: number;
  error: string | null;
  checkedAt: string;
}

export interface RunDetailResult {
  run: RunSummary;
  sources: RunSourceDetail[];
  platforms: RunPlatformDetail[];
  endpoints: RunEndpointStat[];
  endpointRows: RunEndpointRow[];
}

export interface PlatformSummaryRow {
  platform: string;
  name: string;
  runs: number;
  tested: number;
  ok: number;
  failed: number;
  cnTested: number;
  cnOk: number;
  avgTotalMs: number | null;
  avgResolveMs: number | null;
  avgTtfbMs: number | null;
  topError: { kind: string | null; error: string; count: number } | null;
}

export interface PlatformSummary {
  days: number;
  runCount: number;
  rows: PlatformSummaryRow[];
}

export interface RunLogResult {
  runId: string;
  available: boolean;
  log: string;
  bytes: number;
}

export interface FailureKind {
  kind: string;
  count: number;
  sample: string | null;
}

export interface FailurePlatform {
  platform: string;
  name: string;
  tested: number;
  failed: number;
}

export interface FailureSource {
  sourceId: string;
  title: string;
  tested: number;
  failed: number;
  topError: string | null;
}

export interface FailureAggregate {
  days: number;
  runCount: number;
  platformTests: number;
  platformFailures: number;
  byKind: FailureKind[];
  byPlatform: FailurePlatform[];
  bySource: FailureSource[];
  recentRuns: RunSummary[];
}

export interface RunProbeInput {
  only?: string;
  limit?: string;
  deep?: boolean;
  preferMirror?: boolean;
}

export interface RunProxyTestInput {
  proxyId?: string;
  subscriptionId?: string;
  concurrency?: number;
}

export interface RunStatusResult {
  runs: WorkflowRunView[];
  lastDispatchedAt?: string | null;
}

export interface MirrorConfigView {
  templates: MirrorTemplate[];
  custom: boolean;
}

export interface SourceLink {
  url: string;
  label: string;
  primary: boolean;
}

export interface AdminSource {
  id: string;
  title: string;
  category: string;
  storage: 'remote' | 'repo';
  url: string;
  path: string;
  homepage: string;
  mirrors: string[];
  enabled: boolean;
  trusted: boolean;
  notes: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  version: string;
  sha: string;
  endpointsOk: number;
  endpointsTotal: number;
  lastChangeAt: string;
  lastCheckedAt: string;
  links: SourceLink[];
}

export interface SourceListResult {
  sources: AdminSource[];
  mirrorTemplates: MirrorTemplate[];
}

export interface SourceInputPayload {
  title?: string;
  category?: string;
  url?: string;
  homepage?: string;
  mirrors?: string[];
  enabled?: boolean;
  trusted?: boolean;
  notes?: string;
}

export const api = {
  me: () => request<{ ok: boolean; site: string }>('/api/auth/me'),
  login: (password: string) =>
    request<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),

  status: (filters: StatusFilters = {}) =>
    request<StatusEnvelope>(
      `/api/status${query({
        platform: filters.platforms?.join(','),
        status: filters.statuses?.join(','),
        q: filters.q,
      })}`,
    ),
  source: (id: string) => request<SourceDetailResponse>(`/api/sources/${encodeURIComponent(id)}`),
  history: (days = 14) => request<RunSummary[]>(`/api/history?days=${days}`),
  events: (limit = 50) => request<EventItem[]>(`/api/events?limit=${limit}`),
  health: () => request<HealthResponse>('/api/health'),

  candidates: (state?: string, q?: string) => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (q) params.set('q', q);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<CandidateList>(`/api/admin/candidates${suffix}`);
  },
  promoteCandidates: () =>
    request<{ promoted: string[]; skipped: number; errors: string[] }>('/api/admin/candidates/promote', {
      method: 'POST',
    }),
  deleteRejectedCandidates: () =>
    request<{ ok: boolean; deleted: number }>('/api/admin/candidates/rejected', { method: 'DELETE' }),
  setCandidateState: (id: string, state: string) =>
    request<{ ok: boolean; id: string; state: string }>(`/api/admin/candidates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    }),

  proxies: () => request<ProxyList>('/api/admin/proxies'),
  importProxies: (text: string) =>
    request<ProxyImportResult>('/api/admin/proxies/import', { method: 'POST', body: JSON.stringify({ text }) }),
  importProxyUrl: (url: string, name?: string, userAgent?: string) =>
    request<ProxyImportResult>('/api/admin/proxies/import-url', {
      method: 'POST',
      body: JSON.stringify({ url, name, userAgent }),
    }),
  createProxy: (input: ProxyInput) =>
    request<{ ok: boolean }>('/api/admin/proxies', { method: 'POST', body: JSON.stringify(input) }),
  updateProxy: (id: string, patch: ProxyPatch) =>
    request<{ ok: boolean }>(`/api/admin/proxies/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProxy: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/proxies/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  subscriptions: () => request<SubscriptionList>('/api/admin/proxies/subscriptions'),
  createSubscription: (input: SubscriptionInput) =>
    request<{ ok: boolean; subscription: SubscriptionItem; created?: boolean; duplicate?: boolean }>(
      '/api/admin/proxies/subscriptions',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  updateSubscription: (id: string, patch: SubscriptionPatch) =>
    request<{ ok: boolean }>(`/api/admin/proxies/subscriptions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSubscription: (id: string, nodes: 'delete_all' | 'keep' = 'delete_all') =>
    request<{ ok: boolean; deleted: number }>(
      `/api/admin/proxies/subscriptions/${encodeURIComponent(id)}?nodes=${nodes}`,
      { method: 'DELETE' },
    ),
  refreshSubscription: (id: string) =>
    request<ProxyImportResult>(`/api/admin/proxies/subscriptions/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),

  runProbe: (input: RunProbeInput = {}) =>
    request<{ ok: boolean; dispatchedAt: string }>('/api/admin/run/probe', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  runDiscovery: () =>
    request<{ ok: boolean; dispatchedAt: string }>('/api/admin/run/discovery', { method: 'POST' }),
  settings: () => request<SettingsResult>('/api/admin/settings'),
  saveSettings: (patch: Partial<AppSettingsView>) =>
    request<SettingsResult>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  resetSettings: () => request<SettingsResult>('/api/admin/settings/reset', { method: 'POST' }),
  system: () => request<SystemView>('/api/admin/system'),
  runProxyTest: (input: RunProxyTestInput = {}) =>
    request<{ ok: boolean; dispatchedAt: string }>('/api/admin/run/proxy-test', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  workflowRuns: () => request<RunStatusResult>('/api/admin/runs'),
  workflows: () => request<WorkflowRunsResult>('/api/admin/workflows'),
  tasks: (status?: TaskStatus, limit = 50) =>
    request<TaskListResult>(`/api/admin/tasks?limit=${limit}${status ? `&status=${status}` : ''}`),
  createTask: (input: { type: TaskType; payload?: TaskView['payload']; priority?: number }) =>
    request<CreateTaskResult>('/api/admin/tasks', { method: 'POST', body: JSON.stringify(input) }),
  cancelTask: (id: string) =>
    request<{ ok: boolean; task: TaskView }>(`/api/admin/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  dispatchTasks: () => request<{ dispatched: boolean; message?: string; state: TaskStateSnapshot }>('/api/admin/tasks/dispatch', { method: 'POST' }),
  reapTasks: () => request<{ ok: boolean; reaped: number; state: TaskStateSnapshot }>('/api/admin/tasks/reap', { method: 'POST' }),
  usage: (refresh = false) => request<{ usage: UsageView }>(`/api/admin/usage${refresh ? '?refresh=1' : ''}`),
  snapshots: (limit = 30) => request<{ runs: RunSummary[] }>(`/api/admin/snapshots?limit=${limit}`),
  snapshot: (runId: string) => request<RunDetailResult>(`/api/admin/snapshots/${encodeURIComponent(runId)}`),
  runLog: (runId: string) => request<RunLogResult>(`/api/admin/snapshots/${encodeURIComponent(runId)}/log`),
  failures: (days = 7) => request<FailureAggregate>(`/api/admin/failures?days=${days}`),
  platforms: (days = 7) => request<PlatformSummary>(`/api/admin/platforms?days=${days}`),

  mirrors: () => request<MirrorConfigView>('/api/admin/mirrors'),
  saveMirrors: (templates: MirrorTemplate[]) =>
    request<MirrorConfigView>('/api/admin/mirrors', {
      method: 'PUT',
      body: JSON.stringify({ templates }),
    }),
  resetMirrors: () => request<MirrorConfigView>('/api/admin/mirrors/reset', { method: 'POST' }),

  sources: () => request<SourceListResult>('/api/admin/sources'),
  createSource: (input: SourceInputPayload) =>
    request<{ source: AdminSource }>('/api/admin/sources', { method: 'POST', body: JSON.stringify(input) }),
  updateSource: (id: string, patch: SourceInputPayload) =>
    request<{ source: AdminSource }>(`/api/admin/sources/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSource: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/admin/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testSource: (id: string) =>
    request<{ ok: boolean; sourceId: string; dispatchedAt: string }>(
      `/api/admin/sources/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),
};
