import { describe, expect, it } from 'vitest';
import { assessSourceQuality } from '../src/quality.js';
import type { SourceResult } from '../src/schema.js';

function makeSource(overrides: Partial<SourceResult> = {}): SourceResult {
  const platforms = Array.from({ length: 6 }, (_, index) => ({
    key: `p${index}`,
    name: `平台${index}`,
    declared: true,
    tested: true,
    ok: true,
  }));
  const endpoints = Array.from({ length: 9 }, (_, index) => ({
    url: `https://example.com/${index}.js`,
    role: index === 0 ? 'primary' : 'mirror',
    ok: true,
  }));
  return {
    id: 'source-1',
    title: '测试源',
    url: 'https://example.com/source.js',
    status: 'available',
    initOk: true,
    checkedAt: new Date().toISOString(),
    stats: { ok: 6, tested: 6, total: 6 },
    platforms,
    endpoints,
    via: 'primary',
    ...overrides,
  } as unknown as SourceResult;
}

describe('assessSourceQuality', () => {
  it('全平台、全接入点通过且新鲜时推荐', () => {
    const quality = assessSourceQuality(makeSource());
    expect(quality.tier).toBe('excellent');
    expect(quality.recommended).toBe(true);
    expect(quality.score).toBeGreaterThanOrEqual(90);
    expect(quality.platformRate).toBe(1);
    expect(quality.endpointRate).toBe(1);
  });

  it('部分平台失败但仍在测试时只算一般', () => {
    const source = makeSource({
      status: 'partial',
      platforms: Array.from({ length: 6 }, (_, index) => ({
        key: `p${index}`,
        name: `平台${index}`,
        declared: true,
        tested: true,
        ok: index < 3,
      })),
      endpoints: Array.from({ length: 9 }, (_, index) => ({
        url: `https://example.com/${index}.js`,
        role: index === 0 ? 'primary' : 'mirror',
        ok: index < 5,
      })),
    });
    const quality = assessSourceQuality(source);
    expect(quality.tier).toBe('limited');
    expect(quality.recommended).toBe(false);
  });

  it('结果过期时不推荐', () => {
    const source = makeSource({
      checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    const quality = assessSourceQuality(source);
    expect(quality.tier).toBe('limited');
    expect(quality.recommended).toBe(false);
    expect(quality.reasons.join('')).toContain('过期');
  });

  it('初始化失败时判为差且不推荐', () => {
    const quality = assessSourceQuality(makeSource({ initOk: false, status: 'unavailable' }));
    expect(quality.tier).toBe('poor');
    expect(quality.recommended).toBe(false);
    expect(quality.reasons).toContain('脚本初始化失败');
  });

  it('国内补测全部失败时不推荐', () => {
    const source = makeSource({
      platforms: Array.from({ length: 6 }, (_, index) => ({
        key: `p${index}`,
        name: `平台${index}`,
        declared: true,
        tested: true,
        ok: true,
        cn: { tested: true, ok: false, error: '请求超时' },
      })),
    });
    const quality = assessSourceQuality(source);
    expect(quality.tier).toBe('limited');
    expect(quality.recommended).toBe(false);
  });

  it('没有测试结果时是未测', () => {
    const source = makeSource({
      status: 'untested',
      platforms: [],
      endpoints: [],
      stats: { ok: 0, tested: 0, total: 0 },
    });
    const quality = assessSourceQuality(source);
    expect(quality.tier).toBe('untested');
    expect(quality.recommended).toBe(false);
  });
});
