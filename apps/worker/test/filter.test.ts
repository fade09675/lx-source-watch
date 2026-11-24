import { describe, expect, it } from 'vitest';
import { filterSnapshot, parseList } from '../src/filter';
import { makePlatform, makeSnapshot, makeSource } from './fixtures';

function sample() {
  const untested = makeSource({
    id: 'a',
    title: '酷狗测试源',
    author: 'tester',
    platforms: [makePlatform({ key: 'kg', tested: false, ok: false })],
    stats: { ok: 0, tested: 0, total: 1 },
    status: 'untested',
  });
  const working = makeSource({
    id: 'b',
    title: '网易源',
    platforms: [makePlatform({ key: 'wy', ok: true })],
    stats: { ok: 1, tested: 1, total: 1 },
    status: 'available',
  });
  return makeSnapshot([untested, working]);
}

describe('filterSnapshot', () => {
  it('平台过滤保留“已声明但未测”的源', () => {
    const filtered = filterSnapshot(sample(), { platforms: ['kg'] });
    expect(filtered.sources.map((source) => source.id)).toEqual(['a']);
    expect(filtered.summary.total).toBe(1);
    expect(filtered.summary.untested).toBe(1);
  });

  it('状态过滤', () => {
    const filtered = filterSnapshot(sample(), { statuses: ['available'] });
    expect(filtered.sources.map((source) => source.id)).toEqual(['b']);
  });

  it('关键词匹配标题与作者', () => {
    expect(filterSnapshot(sample(), { q: '酷狗' }).sources.map((source) => source.id)).toEqual(['a']);
    expect(filterSnapshot(sample(), { q: 'tester' }).sources.map((source) => source.id)).toEqual(['a']);
    expect(filterSnapshot(sample(), { q: 'nothing' }).sources).toHaveLength(0);
  });

  it('国内补测筛选', () => {
    const bad = makeSource({
      id: 'c',
      platforms: [makePlatform({ key: 'kw', cn: { tested: true, ok: false, error: '连接超时' } })],
      stats: { ok: 1, tested: 1, total: 1 },
      status: 'available',
    });
    const good = makeSource({
      id: 'd',
      platforms: [makePlatform({ key: 'kg', cn: { tested: true, ok: true, ms: 120 } })],
      stats: { ok: 1, tested: 1, total: 1 },
      status: 'available',
    });
    const snapshot = makeSnapshot([bad, good, ...sample().sources]);

    expect(filterSnapshot(snapshot, { cn: 'failed' }).sources.map((source) => source.id)).toEqual(['c']);
    expect(filterSnapshot(snapshot, { cn: 'ok' }).sources.map((source) => source.id)).toEqual(['d']);
    expect(filterSnapshot(snapshot, { cn: 'untested' }).sources.map((source) => source.id)).toEqual(['a', 'b']);
  });

  it('空过滤返回原对象', () => {
    const snapshot = sample();
    expect(filterSnapshot(snapshot, {})).toBe(snapshot);
    expect(filterSnapshot(snapshot, { platforms: [], statuses: [], q: '  ' })).toBe(snapshot);
  });
});

describe('parseList', () => {
  it('逗号切分并去空白', () => {
    expect(parseList('kg, tx ,,wy')).toEqual(['kg', 'tx', 'wy']);
    expect(parseList(undefined)).toEqual([]);
  });
});
