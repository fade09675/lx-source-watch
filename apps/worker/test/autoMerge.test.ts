import { describe, expect, it } from 'vitest';
import { planRegistryMerges, type RegistryMergeRow } from '../src/autoMerge';

const SHA = 'a'.repeat(64);

function row(over: Partial<RegistryMergeRow> & { id: string; url: string }): RegistryMergeRow {
  return {
    title: over.id,
    content_sha256: SHA,
    enabled: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('planRegistryMerges', () => {
  it('groups identical content and chooses the enabled official source', () => {
    const rows = [
      row({
        id: 'pdone-a',
        url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/a/latest.js',
      }),
      row({
        id: 'other-b',
        url: 'https://raw.githubusercontent.com/other/repo/main/b.js',
        created_at: '2025-01-01T00:00:00.000Z',
      }),
    ];
    const plans = planRegistryMerges(rows, new Map());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.canonicalId).toBe('pdone-a');
    expect(plans[0]?.duplicates).toEqual([
      expect.objectContaining({ sourceId: 'other-b' }),
    ]);
  });

  it('skips duplicates already aliased to the canonical source', () => {
    const rows = [
      row({
        id: 'canonical',
        url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/a/latest.js',
      }),
      row({
        id: 'alias',
        url: 'https://raw.githubusercontent.com/other/repo/main/b.js',
      }),
    ];
    const aliases = new Map([
      ['https://raw.githubusercontent.com/other/repo/main/b.js', 'canonical'],
    ]);
    expect(planRegistryMerges(rows, aliases)).toEqual([]);
  });

  it('ignores groups where all entries share one URL', () => {
    const rows = [
      row({ id: 'x', url: 'https://raw.githubusercontent.com/a/b/main/x.js' }),
      row({ id: 'x2', url: 'https://raw.githubusercontent.com/a/b/main/x.js/' }),
    ];
    expect(planRegistryMerges(rows, new Map())).toEqual([]);
  });

  it('skips a group whose canonical source is disabled', () => {
    const rows = [
      row({ id: 'off', url: 'https://raw.githubusercontent.com/a/b/main/a.js', enabled: 0 }),
      row({ id: 'off2', url: 'https://raw.githubusercontent.com/a/b/main/b.js', enabled: 0 }),
    ];
    expect(planRegistryMerges(rows, new Map())).toEqual([]);
  });

  it('caps the number of groups per run', () => {
    const rows = [
      row({ id: 'a1', url: 'https://raw.githubusercontent.com/a/b/main/1.js', content_sha256: '1'.repeat(64) }),
      row({ id: 'a2', url: 'https://raw.githubusercontent.com/a/b/main/2.js', content_sha256: '1'.repeat(64) }),
      row({ id: 'b1', url: 'https://raw.githubusercontent.com/a/b/main/3.js', content_sha256: '2'.repeat(64) }),
      row({ id: 'b2', url: 'https://raw.githubusercontent.com/a/b/main/4.js', content_sha256: '2'.repeat(64) }),
    ];
    expect(planRegistryMerges(rows, new Map(), 1)).toHaveLength(1);
  });
});
