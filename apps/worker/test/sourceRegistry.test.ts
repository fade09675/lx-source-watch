import { describe, expect, it } from 'vitest';
import {
  buildRegistryLinks,
  slugify,
  toPublicRegistry,
  validateSourceInput,
  type SourceRegistryRow,
} from '../src/sourceRegistry';

function row(patch: Partial<SourceRegistryRow> = {}): SourceRegistryRow {
  return {
    id: 'demo',
    title: '演示音源',
    author: '测试作者',
    category: '在线',
    storage: 'remote',
    url: 'https://raw.githubusercontent.com/owner/repo/main/demo.js',
    path: '',
    homepage: '',
    mirrors: [],
    contentSha256: null,
    enabled: true,
    trusted: false,
    notes: '',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('slugify', () => {
  it('turns English titles into ids', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  ---A_b  ')).toBe('a-b');
  });

  it('returns empty for Chinese-only titles', () => {
    expect(slugify('聚合音源')).toBe('');
  });
});

describe('validateSourceInput', () => {
  it('accepts a normal source and generates an id', () => {
    const result = validateSourceInput({
      title: 'Demo Source',
      author: '  作者A  ',
      url: 'https://raw.githubusercontent.com/o/r/main/a.js',
      mirrors: ['https://gh-proxy.com/https://raw.githubusercontent.com/o/r/main/a.js'],
    });
    expect(result.ok).toBe(true);
    expect(result.value?.id).toMatch(/^[a-z0-9][a-z0-9_-]{1,40}$/);
    expect(result.value?.author).toBe('作者A');
    expect(result.value?.enabled).toBe(true);
  });

  it('rejects invalid url, bad mirror and duplicate mirrors', () => {
    const result = validateSourceInput({
      title: 'X',
      url: 'ftp://example.com/a.js',
      mirrors: ['not-a-url', 'https://a.com/x', 'https://a.com/x'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('http');
    expect(result.errors.join()).toContain('镜像');
  });

  it('rejects more than 10 mirrors and empty title', () => {
    const result = validateSourceInput({
      title: '   ',
      url: 'https://example.com/a.js',
      mirrors: Array.from({ length: 11 }, (_, i) => `https://m${i}.example.com/a.js`),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('标题不能为空');
    expect(result.errors).toContain('镜像最多 10 个');
  });

  it('falls back to a random id for Chinese titles without an explicit id', () => {
    const result = validateSourceInput({ title: '聚合音源', url: 'https://example.com/a.js' });
    expect(result.ok).toBe(true);
    expect(result.value?.id).toMatch(/^src-[0-9a-f]{8}$/);
  });
});

describe('toPublicRegistry', () => {
  it('only exposes enabled sources with compatible fields', () => {
    const config = toPublicRegistry([
      row(),
      row({ id: 'off', title: '停用', enabled: false }),
      row({ id: 'mirror', title: '带镜像', mirrors: ['https://m.example.com/a.js'], notes: '备注' }),
    ]);
    expect(config.version).toBe(1);
    expect(config.sources).toHaveLength(2);
    expect(config.sources.map((item) => item.id)).toEqual(['demo', 'mirror']);
    expect(config.sources[1]).toMatchObject({
      mirrors: ['https://m.example.com/a.js'],
      notes: '备注',
      author: '测试作者',
    });
    expect(config.sources[0]).not.toHaveProperty('enabled');
  });
});

describe('buildRegistryLinks', () => {
  it('puts primary first, then custom mirrors, then template mirrors', () => {
    const links = buildRegistryLinks(
      'https://raw.githubusercontent.com/owner/repo/main/demo.js',
      ['https://custom.example.com/demo.js'],
    );
    expect(links[0]).toMatchObject({ label: '主地址', primary: true });
    expect(links[1]).toMatchObject({ label: '自定义镜像' });
    expect(links.length).toBeGreaterThan(2);
    expect(new Set(links.map((item) => item.url)).size).toBe(links.length);
  });

  it('returns only the primary for non-GitHub urls without custom mirrors', () => {
    const links = buildRegistryLinks('https://example.com/demo.js', []);
    expect(links).toHaveLength(1);
  });
});
