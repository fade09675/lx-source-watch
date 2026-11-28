import { describe, expect, it } from 'vitest';
import { selectCnUrls } from '../src/cnProbe.js';

describe('selectCnUrls', () => {
  it('保留全部地址，不论海外是否通过', () => {
    const urls = [
      { sourceId: 'a', platform: 'kw', quality: '128k', url: 'https://x/1', resolveMs: 1, ok: false },
      { sourceId: 'a', platform: 'kw', quality: '320k', url: 'https://x/1', resolveMs: 1, ok: false },
      { sourceId: 'a', platform: 'tx', quality: '128k', url: 'https://x/2', resolveMs: 1, ok: true },
      { sourceId: 'b', platform: 'wy', quality: '128k', url: 'https://x/3', resolveMs: 1, ok: false },
      { sourceId: 'b', platform: 'wy', quality: '320k', url: 'https://x/4', resolveMs: 1, ok: true },
    ];
    const selected = selectCnUrls(urls);
    expect(selected.map((url) => url.url)).toEqual(['https://x/1', 'https://x/2', 'https://x/3', 'https://x/4']);
  });

  it('不按源截断，超过 200 条也全部保留', () => {
    const urls = Array.from({ length: 254 }, (_, index) => ({
      sourceId: `source-${index % 7}`,
      platform: 'kw',
      quality: '128k',
      url: `https://x/${index}`,
      resolveMs: 1,
      ok: index % 2 === 0,
    }));
    expect(selectCnUrls(urls)).toHaveLength(254);
  });
});
