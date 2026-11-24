import { log } from '../logger.js';
import { errorMessage } from '../util.js';

export interface RunnerConfig {
  cnMaxHops: number;
  cnAutoSwitch: boolean;
  proxyTestConcurrency: number;
  proxyTestTimeoutMs: number;
  proxyFetchUserAgent: string;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  cnMaxHops: 5,
  cnAutoSwitch: true,
  proxyTestConcurrency: 5,
  proxyTestTimeoutMs: 20_000,
  proxyFetchUserAgent: '',
};

function int(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 兜底默认值，避免旧版 Worker 没有 /api/runner/config 时直接失败。 */
export function normalizeRunnerConfig(raw: unknown): RunnerConfig {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    cnMaxHops: int(input.cnMaxHops, DEFAULT_RUNNER_CONFIG.cnMaxHops, 1, 5),
    cnAutoSwitch:
      typeof input.cnAutoSwitch === 'boolean' ? input.cnAutoSwitch : DEFAULT_RUNNER_CONFIG.cnAutoSwitch,
    proxyTestConcurrency: int(
      input.proxyTestConcurrency,
      DEFAULT_RUNNER_CONFIG.proxyTestConcurrency,
      1,
      10,
    ),
    proxyTestTimeoutMs: int(input.proxyTestTimeoutMs, DEFAULT_RUNNER_CONFIG.proxyTestTimeoutMs, 5_000, 90_000),
    proxyFetchUserAgent:
      typeof input.proxyFetchUserAgent === 'string'
        ? input.proxyFetchUserAgent.trim().slice(0, 200)
        : DEFAULT_RUNNER_CONFIG.proxyFetchUserAgent,
  };
}

function apiBase(endpoint: string): string {
  return endpoint.replace(/\/api\/ingest\/?$/, '').replace(/\/+$/, '');
}

/** 从 Worker 读取运行参数；读取失败时用默认值，不阻塞探测/测活。 */
export async function fetchRunnerConfig(endpoint: string, token: string): Promise<RunnerConfig> {
  try {
    const response = await fetch(`${apiBase(endpoint)}/api/runner/config`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { config?: unknown };
    return normalizeRunnerConfig(body.config);
  } catch (error) {
    log.warn(`读取 Runner 设置失败，使用默认值：${errorMessage(error)}`);
    return { ...DEFAULT_RUNNER_CONFIG };
  }
}
