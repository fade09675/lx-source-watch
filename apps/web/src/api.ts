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
};
