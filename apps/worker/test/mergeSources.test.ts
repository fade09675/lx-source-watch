import { describe, expect, it } from 'vitest';
import { mergeMirrorLists } from '../src/mergeSources';

describe('mergeMirrorLists', () => {
  it('appends only new URLs, skipping the canonical URL and duplicates', () => {
    const canonical = 'https://raw.githubusercontent.com/pdone/lx-music-source/main/a/latest.js';
    const existing = ['https://gh-proxy.com/' + canonical];
    const result = mergeMirrorLists(canonical, existing, [
      canonical,
      'https://raw.githubusercontent.com/pdone/lx-music-source/main/b/latest.js',
      'https://gh-proxy.com/' + canonical,
      'https://raw.githubusercontent.com/pdone/lx-music-source/main/b/latest.js/',
    ]);
    expect(result.added).toEqual(['https://raw.githubusercontent.com/pdone/lx-music-source/main/b/latest.js']);
    expect(result.mirrors).toHaveLength(2);
  });

  it('returns empty added when everything already exists', () => {
    const canonical = 'https://example.com/a.js';
    const result = mergeMirrorLists(canonical, ['https://example.com/b.js'], ['https://EXAMPLE.com:443/b.js']);
    expect(result.added).toEqual([]);
    expect(result.mirrors).toEqual(['https://example.com/b.js']);
  });
});
