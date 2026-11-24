import type { Env } from './env';
import { dispatchProbe, dispatchProxyTest, type DispatchResult } from './dispatch';
import { loadSettings, normalizeSettings, type AppSettings } from './settings';

/** 默认间隔（设置里可改）。 */
export const PROBE_INTERVAL_HOURS = 4;
export const PROXY_TEST_INTERVAL_HOURS = 6;
export const DISCOVERY_INTERVAL_HOURS = 12;

export const SCHEDULER_STATE_KEY = 'scheduler:state';

const MANUAL_KEYS = {
  probe: 'run:probe:last',
  proxyTest: 'run:proxy-test:last',
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
  /** 最近一次携带自动发现的探测。 */
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
  now: string;
}

export interface SchedulerDeps {
  /** 测试时可注入设置，跳过数据库。 */
  settings?: AppSettings;
  dispatchProbe?: (env: Env, input: Parameters<typeof dispatchProbe>[1]) => Promise<DispatchResult>;
  dispatchProxyTest?: (env: Env, input: Parameters<typeof dispatchProxyTest>[1]) => Promise<DispatchResult>;
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

/**
 * 由 Worker 的 Cron Trigger 每 5 分钟调用一次。
 *
 * 只有到点才真正派发 GitHub Actions，触发失败也会记录时间并等下一个间隔，
 * 避免每 5 分钟反复打 GitHub。间隔与开关来自网页设置。
 */
export async function runScheduler(
  env: Env,
  now = Date.now(),
  deps: SchedulerDeps = {},
): Promise<{ probe: boolean; proxyTest: boolean; discovery: boolean }> {
  const settings = await readSettings(env, deps);
  const dispatchProbeFn = deps.dispatchProbe ?? dispatchProbe;
  const dispatchProxyTestFn = deps.dispatchProxyTest ?? dispatchProxyTest;

  const state = await readState(env);
  const [manualProbe, manualProxy] = await Promise.all([
    env.SNAPSHOT.get(MANUAL_KEYS.probe),
    env.SNAPSHOT.get(MANUAL_KEYS.proxyTest),
  ]);

  const at = new Date(now).toISOString();
  const dispatched = { probe: false, proxyTest: false, discovery: false };
  let changed = false;

  const probeDue =
    settings.probeEnabled &&
    isDue(laterIso(state.probe?.at, manualProbe), settings.probeIntervalHours, now);
  const discoveryDue =
    probeDue &&
    settings.discoveryEnabled &&
    isDue(state.discovery?.at, settings.discoveryIntervalHours, now);

  if (probeDue) {
    dispatched.probe = true;
    dispatched.discovery = discoveryDue;
    changed = true;
    try {
      const result = await dispatchProbeFn(env, {
        limit: settings.probeLimit > 0 ? String(settings.probeLimit) : undefined,
        concurrency: settings.probeConcurrency,
        deep: settings.probeDeep,
        preferMirror: settings.preferMirror,
        cn: settings.cnEnabled,
        discover: discoveryDue,
      });
      state.probe = result.ok ? { at, ok: true } : { at, ok: false, error: result.message };
      if (result.ok && discoveryDue) state.discovery = { at, ok: true };
    } catch (error) {
      state.probe = { at, ok: false, error: errorMessage(error) };
    }
  }

  if (settings.proxyTestEnabled && isDue(laterIso(state.proxyTest?.at, manualProxy), settings.proxyTestIntervalHours, now)) {
    dispatched.proxyTest = true;
    changed = true;
    try {
      const result = await dispatchProxyTestFn(env, {});
      state.proxyTest = result.ok ? { at, ok: true } : { at, ok: false, error: result.message };
    } catch (error) {
      state.proxyTest = { at, ok: false, error: errorMessage(error) };
    }
  }

  if (changed) await writeState(env, state);
  return dispatched;
}

/** 给工作台读取的定时状态。 */
export async function getSchedulerStatus(
  env: Env,
  now = Date.now(),
  deps: SchedulerDeps = {},
): Promise<SchedulerStatus> {
  const settings = await readSettings(env, deps);
  const state = await readState(env);
  const [manualProbe, manualProxy] = await Promise.all([
    env.SNAPSHOT.get(MANUAL_KEYS.probe),
    env.SNAPSHOT.get(MANUAL_KEYS.proxyTest),
  ]);
  const discoveryLast = laterIso(state.discovery?.at, state.probe?.at);
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
      discoveryLast ?? null,
      now,
    ),
    now: new Date(now).toISOString(),
  };
}
