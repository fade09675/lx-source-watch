import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { clampCutoff, executeRunPurge, type RunPurgePlan } from '../src/maintenance';

function plan(overrides: Partial<RunPurgePlan> = {}): RunPurgePlan {
  return {
    days: 30,
    cutoff: '2026-10-01T00:00:00.000Z',
    proxyCutoff: '2026-10-01T00:00:00.000Z',
    latestRunAt: '2026-11-01T00:00:00.000Z',
    latestProxyTestAt: null,
    clamped: false,
    runs: 1,
    sourceRuns: 0,
    platformResults: 0,
    tasks: 0,
    proxyTestRuns: 1,
    proxyTestResults: 0,
    ...overrides,
  };
}

describe('executeRunPurge', () => {
  it('先删任务再删测活轮次，避免子查询失效', async () => {
    const sqls: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          sqls.push(sql);
          return { bind: () => ({}) };
        },
        async batch() {
          return [];
        },
      },
    } as unknown as Env;
    await executeRunPurge(env, plan());
    const tasks = sqls.findIndex((sql) => sql.startsWith('DELETE FROM tasks'));
    const proxyRuns = sqls.findIndex((sql) => sql.startsWith('DELETE FROM proxy_test_runs'));
    expect(tasks).toBeGreaterThan(-1);
    expect(tasks).toBeLessThan(proxyRuns);
  });

  it('没有可删记录时不动数据库', async () => {
    const sqls: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          sqls.push(sql);
          return { bind: () => ({}) };
        },
        async batch() {
          return [];
        },
      },
    } as unknown as Env;
    await executeRunPurge(env, plan({ runs: 0, proxyTestRuns: 0 }));
    expect(sqls).toHaveLength(0);
  });
});

describe('clampCutoff', () => {
  it('截止时间早于最新记录时原样使用', () => {
    const result = clampCutoff('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    expect(result).toEqual({ cutoff: '2026-10-01T00:00:00.000Z', clamped: false });
  });

  it('截止时间晚于最新记录时收到最新记录，保证最新一轮不被删', () => {
    const result = clampCutoff('2026-12-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    expect(result).toEqual({ cutoff: '2026-11-01T00:00:00.000Z', clamped: true });
  });

  it('没有最新记录时使用请求的截止时间', () => {
    const result = clampCutoff('2026-10-01T00:00:00.000Z', null);
    expect(result).toEqual({ cutoff: '2026-10-01T00:00:00.000Z', clamped: false });
  });
});
