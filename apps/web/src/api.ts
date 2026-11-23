import type {
  ApiErrorBody,
  Candidate,
  EventItem,
  HealthResponse,
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
}

export interface RunProbeInput {
  only?: string;
  limit?: string;
  deep?: boolean;
  preferMirror?: boolean;
}

export interface RunStatusResult {
  runs: WorkflowRunView[];
  lastDispatchedAt?: string | null;
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

  candidates: () => request<CandidateList>('/api/admin/candidates'),
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
  workflowRuns: () => request<RunStatusResult>('/api/admin/runs'),
};
