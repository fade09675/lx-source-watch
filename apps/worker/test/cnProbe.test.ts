import { describe, expect, it } from 'vitest';
import { cnCooldownHours, selectCnUrls } from '../src/cnProbe.js';

describe('selectCnUrls', () => {
  it('只保留海外未通过的地址，并按 URL 去重', () => {
    const urls = [
      { sourceId: 'a', platform: 'kw', quality: '128k', url: 'https://x/1', resolveMs: 1, ok: false },
      { sourceId: 'a', platform: 'kw', quality: '320k', url: 'https://x/1', resolveMs: 1, ok: false },
      { sourceId: 'a', platform: 'tx', quality: '128k', url: 'https://x/2', resolveMs: 1, ok: true },
      { sourceId: 'b', platform: 'wy', quality: '128k', url: 'https://x/3', resolveMs: 1, ok: false },
    ];
    const selected = selectCnUrls(urls, 200);
    expect(selected.map((url) => url.url)).toEqual(['https://x/1', 'https://x/3']);
  });

  it('按源限制单源占用比例', () => {
    const urls = Array.from({ length: 12 }, (_, index) => ({
      sourceId: index < 8 ? 'a' : 'b',
      platform: 'kw',
      quality: '128k',
      url: `https://x/${index}`,
      resolveMs: 1,
      ok: false,
    }));
    const selected = selectCnUrls(urls, 4);
    expect(selected).toHaveLength(4);
    expect(selected.filter((url) => url.sourceId === 'a')).toHaveLength(2);
    expect(selected.filter((url) => url.sourceId === 'b')).toHaveLength(2);
  });
});

describe('cnCooldownHours', () => {
  it('正常补测冷却 24 小时，空跑冷却 6 小时', () => {
    expect(cnCooldownHours('国内补测：测试 2 条，可达 1 条（1 个源）')).toBe(24);
    expect(cnCooldownHours('国内补测：没有需要补测的地址')).toBe(6);
    expect(cnCooldownHours(null)).toBe(24);
  });
});
