import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { aggregateGithubRuns, checkQuota, collectCloudflare, collectGithub, pickStorageRow } from '../src/usage';

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aggregateGithubRuns', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:01:00Z',
    status: 'completed',
    ...overrides,
  });

  it('skips runs outside the month', () => {
    const result = aggregateGithubRuns(
      [run({ created_at: '2026-10-31T23:00:00Z' }), run({ run_duration_ms: 120_000 })],
      '2026-11-01',
    );
    expect(result.runs).toBe(1);
    expect(result.minutes).toBe(2);
  });

  it('counts queued runs without adding minutes', () => {
    const result = aggregateGithubRuns([run({ status: 'queued' })], '2026-11-01');
    expect(result.runs).toBe(1);
    expect(result.minutes).toBe(0);
    expect(result.byDay.size).toBe(0);
  });

  it('caps a run at 60 minutes and falls back to timestamps', () => {
    const result = aggregateGithubRuns(
      [run({ run_duration_ms: 5 * 60 * 60_000 }), run({ run_duration_ms: undefined, updated_at: '2026-11-23T10:10:00Z' })],
      '2026-11-01',
    );
    expect(result.minutes).toBe(70);
  });
});

describe('pickStorageRow', () => {
  it('returns the newest date', () => {
    const picked = pickStorageRow([
      { dimensions: { date: '2026-11-20' }, max: { byteCount: 1 } },
      { dimensions: { date: TODAY }, max: { byteCount: 3 } },
      { dimensions: { date: YESTERDAY }, max: { byteCount: 2 } },
    ]);
    expect(picked?.max.byteCount).toBe(3);
  });

  it('returns undefined for an empty list', () => {
    expect(pickStorageRow([])).toBeUndefined();
  });
});

describe('collectGithub', () => {
  it('reports run count without minutes for a public repo', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/repos/fade09675/lx-source-watch')) {
        return new Response(JSON.stringify({ private: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ total_count: 42 }), { status: 200 });
    });
    const result = await collectGithub({ GH_REPO: 'fade09675/lx-source-watch' } as Env);
    expect(result.private).toBe(false);
    expect(result.runs).toBe(42);
    expect(result.minutes).toBe(0);
    expect(calls.some((url) => url.includes('/actions/runs'))).toBe(true);
  });

  it('aggregates pages for a private repo', async () => {
    let page = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/repos/o/r')) {
        return new Response(JSON.stringify({ private: true }), { status: 200 });
      }
      page += 1;
      if (page === 1) {
        return new Response(
          JSON.stringify({
            workflow_runs: Array.from({ length: 100 }, () => ({
              created_at: '2026-11-23T10:00:00Z',
              updated_at: '2026-11-23T10:01:00Z',
              run_duration_ms: 60_000,
            })),
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          workflow_runs: [
            { created_at: '2026-11-23T11:00:00Z', updated_at: '2026-11-23T11:02:00Z', run_duration_ms: 120_000 },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await collectGithub({ GH_REPO: 'o/r' } as Env);
    expect(result.private).toBe(true);
    expect(result.runs).toBe(101);
    expect(result.minutes).toBe(102);
  });
});

describe('collectCloudflare', () => {
  it('returns null without credentials', async () => {
    expect(await collectCloudflare({} as Env, ['2026-11-23'])).toBeNull();
  });

  it('parses KV actions, storage and D1 rows', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                {
                  kvOperationsAdaptiveGroups: [
                    { dimensions: { date: TODAY, actionType: 'read' }, sum: { requests: 10 } },
                    { dimensions: { date: TODAY, actionType: 'write' }, sum: { requests: 3 } },
                    { dimensions: { date: YESTERDAY, actionType: 'write' }, sum: { requests: 4 } },
                    { dimensions: { date: TODAY, actionType: 'list' }, sum: { requests: 2 } },
                    { dimensions: { date: TODAY, actionType: 'delete' }, sum: { requests: 1 } },
                  ],
                  kvStorageAdaptiveGroups: [
                    { dimensions: { date: YESTERDAY }, max: { byteCount: 100 } },
                    { dimensions: { date: TODAY }, max: { byteCount: 200 } },
                  ],
                  d1AnalyticsAdaptiveGroups: [
                    { dimensions: { date: TODAY, databaseId: 'db-1' }, sum: { rowsRead: 20, rowsWritten: 5 } },
                    { dimensions: { date: TODAY, databaseId: 'other' }, sum: { rowsRead: 99, rowsWritten: 99 } },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    });
    const result = await collectCloudflare(
      { CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'a', D1_ID: 'db-1' } as Env,
      [YESTERDAY, TODAY],
    );
    expect(result).not.toBeNull();
    expect(result?.kv.reads).toBe(10);
    expect(result?.kv.writes).toBe(3);
    expect(result?.kv.lists).toBe(2);
    expect(result?.kv.deletes).toBe(1);
    expect(result?.kv.storageBytes).toBe(200);
    expect(result?.kvWritesByDay.get(YESTERDAY)).toBe(4);
    expect(result?.d1.rowsRead).toBe(20);
    expect(result?.d1.rowsWritten).toBe(5);
    expect(result?.d1WritesByDay.get(TODAY)).toBe(5);
  });

  it('throws a readable error on GraphQL errors', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ errors: [{ message: 'not authorized' }] }), { status: 200 });
    });
    await expect(collectCloudflare({ CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'a' } as Env, ['2026-11-23'])).rejects.toThrow(
      'not authorized',
    );
  });
});

describe('checkQuota', () => {
  const envWith = (writes: number, rowsWritten: number): Env => {
    const snapshot = {
      collectedAt: new Date().toISOString(),
      kv: { day: TODAY, reads: 0, writes, lists: 0, deletes: 0, storageBytes: 0 },
      d1: { day: TODAY, rowsRead: 0, rowsWritten },
      github: { month: '2026-11', minutes: 0, runs: 0 },
      history: [],
    };
    return {
      SNAPSHOT: {
        async get(key: string) {
          return key === 'usage:state' ? JSON.stringify(snapshot) : null;
        },
        async put() {},
      } as unknown as KVNamespace,
    } as unknown as Env;
  };

  it('额度充足时允许派发', async () => {
    const result = await checkQuota(envWith(10, 1000));
    expect(result.ok).toBe(true);
    expect(result.kvWrites).toBe(10);
    expect(result.d1Writes).toBe(1000);
  });

  it('KV 写入接近上限时阻断', async () => {
    const result = await checkQuota(envWith(930, 1000));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('KV 写入');
  });

  it('D1 写入接近上限时阻断', async () => {
    const result = await checkQuota(envWith(10, 95_000));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('D1 写入');
  });
});
