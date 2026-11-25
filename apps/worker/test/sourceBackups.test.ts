import { describe, expect, it } from 'vitest';
import { findMatch } from '../src/sourceBackups';
import type { SourceRegistryRow } from '../src/sourceRegistry';

function row(id: string, title: string, author: string): SourceRegistryRow {
  return {
    id,
    title,
    author,
    category: '在线',
    storage: 'remote',
    url: `https://example.com/${id}.js`,
    path: '',
    homepage: '',
    origin: '',
    mirrors: [],
    contentSha256: null,
    enabled: true,
    trusted: true,
    notes: '',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const rows = [row('a', '统一音乐源', '作者甲'), row('b', '统一音乐源', '作者乙'), row('c', '另一音源', '作者甲')];

describe('findMatch', () => {
  it('matches title and author first', () => {
    expect(findMatch(rows, '统一音乐源', '作者甲')).toMatchObject({
      status: 'matched',
      matchKind: 'title-author',
      source: { id: 'a' },
    });
  });

  it('falls back to a unique title when author differs', () => {
    expect(findMatch(rows, '另一音源', '未知作者')).toMatchObject({
      status: 'matched',
      matchKind: 'title',
      source: { id: 'c' },
    });
  });

  it('reports ambiguous when several titles match and author cannot distinguish', () => {
    expect(findMatch(rows, '统一音乐源', '')).toMatchObject({
      status: 'ambiguous',
      matchKind: 'ambiguous',
    });
  });

  it('reports unmatched when no title matches', () => {
    expect(findMatch(rows, '不存在的源', '作者甲')).toMatchObject({
      status: 'unmatched',
    });
  });

  it('uses the manually selected source', () => {
    expect(findMatch(rows, '不存在的源', '', 'c')).toMatchObject({
      status: 'matched',
      matchKind: 'manual',
      source: { id: 'c' },
    });
    expect(findMatch(rows, '不存在的源', '', 'missing')).toMatchObject({ status: 'invalid' });
  });
});
