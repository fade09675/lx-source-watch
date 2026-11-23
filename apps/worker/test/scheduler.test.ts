import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
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
  it('首次两个任务都派发并写入状态', async () => {
    const kv = fakeKv();
    const calls = { probe: 0, proxy: 0 };
    await runScheduler(fakeEnv(kv), NOW, {
      dispatchProbe: async () => {
        calls.probe += 1;
        return { ok: true, dispatchedAt: new Date(NOW).toISOString() };
      },
      dispatchProxyTest: async () => {
        calls.proxy += 1;
        return { ok: true, dispatchedAt: new Date(NOW).toISOString() };
      },
    });
    expect(calls).toEqual({ probe: 1, proxy: 1 });
    const state = JSON.parse(kv.map.get(SCHEDULER_STATE_KEY) ?? '{}');
    expect(state.probe.ok).toBe(true);
    expect(state.proxyTest.ok).toBe(true);
  });

  it('同一间隔内不重复派发，跨间隔后再次派发', async () => {
    const kv = fakeKv();
    let probe = 0;
    const deps = {
      dispatchProbe: async () => {
        probe += 1;
        return { ok: true as const, dispatchedAt: new Date(NOW).toISOString() };
      },
      dispatchProxyTest: async () => ({ ok: true as const, dispatchedAt: new Date(NOW).toISOString() }),
    };
    await runScheduler(fakeEnv(kv), NOW, deps);
    await runScheduler(fakeEnv(kv), NOW + 2 * HOUR, deps);
    expect(probe).toBe(1);
    await runScheduler(fakeEnv(kv), NOW + (PROBE_INTERVAL_HOURS + 1) * HOUR, deps);
    expect(probe).toBe(2);
  });

  it('手动触发时间也参与间隔判断', async () => {
    const kv = fakeKv({ 'run:probe:last': new Date(NOW - 1 * HOUR).toISOString() });
    let probe = 0;
    await runScheduler(fakeEnv(kv), NOW, {
      dispatchProbe: async () => {
        probe += 1;
        return { ok: true, dispatchedAt: new Date(NOW).toISOString() };
      },
      dispatchProxyTest: async () => ({ ok: true, dispatchedAt: new Date(NOW).toISOString() }),
    });
    expect(probe).toBe(0);
  });

  it('派发失败会记录错误，且不会在 5 分钟后反复重试', async () => {
    const kv = fakeKv();
    let probe = 0;
    const deps = {
      dispatchProbe: async () => {
        probe += 1;
        return { ok: false as const, status: 503, message: '未配置触发令牌' };
      },
      dispatchProxyTest: async () => ({ ok: true as const, dispatchedAt: new Date(NOW).toISOString() }),
    };
    await runScheduler(fakeEnv(kv), NOW, deps);
    const state = JSON.parse(kv.map.get(SCHEDULER_STATE_KEY) ?? '{}');
    expect(state.probe).toEqual({ at: new Date(NOW).toISOString(), ok: false, error: '未配置触发令牌' });
    await runScheduler(fakeEnv(kv), NOW + 5 * 60_000, deps);
    expect(probe).toBe(1);
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
