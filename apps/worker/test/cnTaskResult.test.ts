import { describe, expect, it } from 'vitest';
import { buildCnTaskResult } from '../src/cnTaskResult.js';

describe('buildCnTaskResult', () => {
  it('按源聚合 CN 状态并生成与探测一致的结构', () => {
    const result = buildCnTaskResult({
      rows: [
        { sourceId: 's1', platform: 'kw', ok: true },
        { sourceId: 's1', platform: 'tx', ok: false, error: 'HTTP 403' },
        { sourceId: 's2', platform: 'kw', ok: false, error: '请求超时' },
      ],
      endpoints: [
        { sourceId: 's1', url: 'https://a/1.js', ok: true },
        { sourceId: 's1', url: 'https://a/2.js', ok: false, error: 'HTTP 404' },
      ],
      sourceIds: new Set(['s1', 's2', 's3']),
      sourceTitles: new Map([
        ['s1', '源一'],
        ['s2', '源二'],
        ['s3', '源三'],
      ]),
      selected: 3,
      tested: 3,
      ok: 1,
    });

    expect(result.counts).toMatchObject({
      available: 0,
      partial: 1,
      unavailable: 1,
      untested: 1,
      platformsOk: 1,
      platformsTested: 3,
      endpointsOk: 1,
      endpointsTotal: 2,
      cnOk: 1,
      cnTested: 3,
    });
    expect(result.partialSources?.[0]).toMatchObject({ id: 's1', title: '源一', status: 'partial' });
    expect(result.failedSources?.[0]).toMatchObject({ id: 's2', title: '源二', status: 'unavailable' });
    expect(result.okSources).toEqual([]);
    expect(result.failedPlatforms?.map((item) => item.name)).toEqual(['源一 · tx', '源二 · kw']);
    expect(result.failedPlatforms?.[0]?.error).toBe('HTTP 403');
  });

  it('明细有上限但统计值不受上限影响', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      sourceId: 's1',
      platform: `p${index}`,
      ok: false,
      error: '请求超时',
    }));
    const result = buildCnTaskResult({
      rows,
      endpoints: [],
      sourceIds: new Set(['s1']),
      sourceTitles: new Map([['s1', '源一']]),
      selected: 25,
      tested: 25,
      ok: 0,
    });

    expect(result.counts.platformsOk).toBe(0);
    expect(result.counts.platformsTested).toBe(25);
    expect(result.counts.unavailable).toBe(1);
    expect(result.failedPlatforms).toHaveLength(20);
    expect(result.failedSources).toHaveLength(1);
  });

  it('全部通过的源只计入统计、明细最多 8 条', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `s${index}`);
    const result = buildCnTaskResult({
      rows: ids.map((sourceId) => ({ sourceId, platform: 'kw', ok: true })),
      endpoints: [],
      sourceIds: new Set(ids),
      sourceTitles: new Map(ids.map((id) => [id, id])),
      selected: 10,
      tested: 10,
      ok: 10,
    });

    expect(result.counts.available).toBe(10);
    expect(result.okSources).toHaveLength(8);
    expect(result.failedSources).toEqual([]);
  });

  it('长错误文本下任务结果仍不超过 12KB', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `s${index}`);
    const result = buildCnTaskResult({
      rows: ids.map((sourceId) => ({
        sourceId,
        platform: 'kw',
        ok: false,
        error: '国内补测失败原因'.repeat(30),
      })),
      endpoints: [],
      sourceIds: new Set(ids),
      sourceTitles: new Map(ids.map((id) => [id, '很长的音源标题'.repeat(5)])),
      selected: 30,
      tested: 30,
      ok: 0,
    });

    expect(JSON.stringify(result).length).toBeLessThan(12_000);
    expect(result.failedPlatforms).toHaveLength(20);
  });
});
