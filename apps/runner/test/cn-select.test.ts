import { describe, expect, it } from 'vitest';
import { selectCnUrls } from '../src/cn.js';
import type { UrlRecord } from '../src/probe/platform.js';

function row(url: string, ok: boolean | null): UrlRecord {
  return { sourceId: 's', platform: 'kg', quality: '128k', url, resolveMs: 1, ok };
}

describe('selectCnUrls', () => {
  it('默认只挑海外没跑通的地址', () => {
    const urls = [row('https://a/1.mp3', false), row('https://a/2.mp3', true), row('https://a/3.mp3', null)];
    expect(selectCnUrls(urls, 'failed').map((u) => u.url)).toEqual(['https://a/1.mp3', 'https://a/3.mp3']);
  });

  it('all 保留全部，便于手动排查', () => {
    const urls = [row('https://a/1.mp3', false), row('https://a/2.mp3', true)];
    expect(selectCnUrls(urls, 'all')).toHaveLength(2);
  });
});
