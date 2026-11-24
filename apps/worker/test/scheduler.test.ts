import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { DEFAULT_SETTINGS } from '../src/settings';
import {
  getSchedulerStatus,
  isDue,
  PROBE_INTERVAL_HOURS,
  PROXY_TEST_INTERVAL_HOURS,
  runScheduler,
  SCHEDULER_STATE_KEY,
} from '../src/scheduler';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T00:00:00.000Z');

interface FakeKv {
  map: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

function fakeKv(seed: Record<string, string> = {}): FakeKv {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function fakeEnv(kv: FakeKv): Env {
  return { SNAPSHOT: kv as unknown as KVNamespace } as unknown as Env;
}

describe('scheduler isDue', () => {
  it('无记录时立即到期', () => {
    expect(isDue(undefined, 4, NOW)).toBe(true);
  });

  it('未到间隔不触发，超过间隔触发', () => {
    expect(isDue(new Date(NOW - 3 * HOUR).toISOString(), 4, NOW)).toBe(false);
    expect(isDue(new Date(NOW - 5 * HOUR).toISOString(), 4, NOW)).toBe(true);
  });

  it('未来时间或非法时间按“未到期/到期”处理', () => {
    expect(isDue(new Date(NOW + HOUR).toISOString(), 4, NOW)).toBe(false);
    expect(isDue('not-a-date', 4, NOW)).toBe(true);
  });
});

describe('runScheduler', () => {
  function collector() {
    const types: string[] = [];
    let dispatch = 0;
    return {
      types,
      get dispatch() {
        return dispatch;
      },
      deps: {
        enqueue: async (_env: Env, input: { type: string }) => {
          types.push(input.type);
          return { ok: true, taskId: `task_${input.type}` };
        },
        dispatchNext: async () => {
          dispatch += 1;
          return { dispatched: true, message: '已派发' };
        },
      },
    };
  }

  it('首次把探测、自动发现、测活都建成任务，并尝试派发一次', async () => {
    const kv = fakeKv();
    const c = collector();
    const result = await runScheduler(fakeEnv(kv), NOW, c.deps);
    expect(result).toEqual({ probe: true, discovery: true, proxyTest: true });
    expect(c.types.sort()).toEqual(['discovery', 'probe', 'proxy-test']);
    expect(c.dispatch).toBe(1);
    const state = JSON.parse(kv.map.get(SCHEDULER_STATE_KEY) ?? '{}');
    expect(state.probe.ok).toBe(true);
    expect(state.discovery.ok).toBe(true);
    expect(state.proxyTest.ok).toBe(true);
  });

  it('同一间隔内不重复建任务，跨间隔后再次建任务', async () => {
    const kv = fakeKv();
    const c = collector();
    await runScheduler(fakeEnv(kv), NOW, c.deps);
    await runScheduler(fakeEnv(kv), NOW + 2 * HOUR, c.deps);
    expect(c.types.filter((type) => type === 'probe')).toHaveLength(1);
    await runScheduler(fakeEnv(kv), NOW + (PROBE_INTERVAL_HOURS + 1) * HOUR, c.deps);
    expect(c.types.filter((type) => type === 'probe')).toHaveLength(2);
  });

  it('手动触发时间也参与间隔判断', async () => {
    const kv = fakeKv({ 'run:probe:last': new Date(NOW - 1 * HOUR).toISOString() });
    const c = collector();
    const result = await runScheduler(fakeEnv(kv), NOW, c.deps);
    expect(result.probe).toBe(false);
    expect(c.types).not.toContain('probe');
  });

  it('建任务失败会记录错误，且不会在 5 分钟后反复重试', async () => {
    const kv = fakeKv();
    let calls = 0;
    const deps = {
      enqueue: async () => {
        calls += 1;
        return { ok: false, message: '未配置数据库' };
      },
      dispatchNext: async () => ({ dispatched: false, message: '跳过' }),
    };
    await runScheduler(fakeEnv(kv), NOW, deps);
    const state = JSON.parse(kv.map.get(SCHEDULER_STATE_KEY) ?? '{}');
    expect(state.probe).toEqual({ at: new Date(NOW).toISOString(), ok: false, error: '未配置数据库' });
    await runScheduler(fakeEnv(kv), NOW + 5 * 60_000, deps);
    expect(calls).toBe(3);
  });

  it('自动发现按自己的间隔独立触发', async () => {
    const kv = fakeKv();
    const c = collector();
    const deps = {
      ...c.deps,
      settings: {
        ...DEFAULT_SETTINGS,
        probeIntervalHours: 24,
        discoveryIntervalHours: 12,
      },
    };
    await runScheduler(fakeEnv(kv), NOW, deps);
    await runScheduler(fakeEnv(kv), NOW + 13 * HOUR, deps);
    expect(c.types.filter((type) => type === 'discovery')).toHaveLength(2);
    expect(c.types.filter((type) => type === 'probe')).toHaveLength(1);
  });
});

describe('getSchedulerStatus', () => {
  it('按最近一次定时或手动触发计算下次时间', async () => {
    const kv = fakeKv({
      [SCHEDULER_STATE_KEY]: JSON.stringify({
        probe: { at: new Date(NOW - 2 * HOUR).toISOString(), ok: true },
      }),
      'run:probe:last': new Date(NOW - 1 * HOUR).toISOString(),
      'run:proxy-test:last': new Date(NOW - 2 * HOUR).toISOString(),
    });
    const status = await getSchedulerStatus(fakeEnv(kv), NOW);
    expect(status.probe.intervalHours).toBe(PROBE_INTERVAL_HOURS);
    expect(status.probe.lastAt).toBe(new Date(NOW - 2 * HOUR).toISOString());
    expect(status.probe.manualAt).toBe(new Date(NOW - 1 * HOUR).toISOString());
    expect(status.probe.nextAt).toBe(new Date(NOW - 1 * HOUR + PROBE_INTERVAL_HOURS * HOUR).toISOString());
    expect(status.proxyTest.nextAt).toBe(new Date(NOW - 2 * HOUR + PROXY_TEST_INTERVAL_HOURS * HOUR).toISOString());
  });

  it('没有任何记录时下次时间等于当前时间', async () => {
    const status = await getSchedulerStatus(fakeEnv(fakeKv()), NOW);
    expect(status.probe.nextAt).toBe(new Date(NOW).toISOString());
  });
});
