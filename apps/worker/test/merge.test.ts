import { describe, expect, it } from 'vitest';
import { isStale, mergeSnapshot } from '../src/merge';
import { makePlatform, makeSnapshot, makeSource } from './fixtures';

describe('mergeSnapshot', () => {
  it('全量快照直接替换并重算 summary', () => {
    const prev = makeSnapshot([makeSource({ id: 'a', stats: { ok: 1, tested: 1, total: 1 } })]);
    const incoming = makeSnapshot(
      [
        makeSource({
          id: 'b',
          platforms: [makePlatform({ key: 'kg', ok: true }), makePlatform({ key: 'wy', ok: false })],
        }),
      ],
      { runId: 'run-2' },
    );

    const merged = mergeSnapshot(prev, incoming);
    expect(merged.runId).toBe('run-2');
    expect(merged.sources.map((source) => source.id)).toEqual(['b']);
    expect(merged.summary).toEqual({ total: 1, available: 0, partial: 1, unavailable: 0, untested: 0, platformsOk: 1, platformsTested: 2 });
  });

  it('局部快照按 id 合并，未测源保留', () => {
    const prev = makeSnapshot([
      makeSource({ id: 'a', stats: { ok: 1, tested: 1, total: 1 } }),
      makeSource({ id: 'b', stats: { ok: 0, tested: 1, total: 1 }, status: 'unavailable' }),
    ]);
    const incoming = makeSnapshot(
      [
        makeSource({ id: 'b', stats: { ok: 1, tested: 1, total: 1 }, status: 'available' }),
        makeSource({ id: 'c', platforms: [makePlatform({ key: 'kw', ok: false })] }),
      ],
      { runId: 'run-2', checkScope: 'partial' },
    );

    const merged = mergeSnapshot(prev, incoming);
    expect(merged.sources.map((source) => source.id)).toEqual(['a', 'b', 'c']);
    expect(merged.sources.find((source) => source.id === 'b')?.status).toBe('available');
    expect(merged.summary.total).toBe(3);
    expect(merged.summary.available).toBe(2);
  });

  it('没有上一轮时等同于全量', () => {
    const incoming = makeSnapshot([makeSource({ id: 'a' })]);
    expect(mergeSnapshot(null, incoming).sources).toHaveLength(1);
  });

  it('全量探测保留上一轮已测出的 CN 结果', () => {
    const cn = { tested: true, ok: true, ms: 88 };
    const prev = makeSnapshot([
      makeSource({
        id: 'a',
        platforms: [makePlatform({ key: 'kg', ok: false, cn })],
        endpoints: [
          {
            url: 'https://example.com/a.js',
            role: 'primary',
            ok: false,
            ms: 1,
            checkedAt: '2026-11-23T10:00:00.000Z',
            cn,
          },
        ],
      }),
    ]);
    const incoming = makeSnapshot([
      makeSource({
        id: 'a',
        platforms: [makePlatform({ key: 'kg', ok: false })],
        endpoints: [
          {
            url: 'https://example.com/a.js',
            role: 'primary',
            ok: false,
            ms: 1,
            checkedAt: '2026-11-23T10:00:00.000Z',
          },
        ],
      }),
    ]);

    const merged = mergeSnapshot(prev, incoming);
    expect(merged.sources[0]?.platforms[0]?.cn?.ok).toBe(true);
    expect(merged.sources[0]?.endpoints[0]?.cn?.ok).toBe(true);
  });
});

describe('isStale', () => {
  it('超过两个周期为过期', () => {
    const now = Date.parse('2026-11-23T10:00:00.000Z');
    expect(isStale('2026-11-23T08:30:00.000Z', now)).toBe(false);
    expect(isStale('2026-11-23T01:59:00.000Z', now)).toBe(true);
    expect(isStale('not-a-date', now)).toBe(true);
  });
});
