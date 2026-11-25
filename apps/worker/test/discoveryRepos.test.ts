import { describe, expect, it } from 'vitest';
import {
  fromRow,
  normalizePathPrefixes,
  publicDiscoveryRepos,
  validateDiscoveryRepoInput,
} from '../src/discoveryRepos';

function fakeDb(rows: unknown[]) {
  return {
    prepare() {
      return {
        all: async () => ({ results: rows }),
      };
    },
  } as unknown as D1Database;
}

describe('discovery repos', () => {
  it('normalizes path prefixes', () => {
    expect(normalizePathPrefixes(['/sources/', 'sources', 'kulao//'])).toEqual(['sources', 'kulao']);
    expect(normalizePathPrefixes([])).toEqual([]);
    expect(normalizePathPrefixes(['a/b', 'c', 'd', 'e', 'f', 'g'])).toBeNull();
    expect(normalizePathPrefixes(['../secret'])).toBeNull();
    expect(normalizePathPrefixes('sources')).toBeNull();
  });

  it('validates repo, branch and path prefixes', () => {
    expect(validateDiscoveryRepoInput({ repo: 'owner/lx-music-source' }).ok).toBe(true);
    expect(validateDiscoveryRepoInput({ repo: 'https://github.com/owner/repo' })).toMatchObject({
      ok: false,
    });
    expect(validateDiscoveryRepoInput({ repo: 'owner/repo', branch: 'bad branch' }).ok).toBe(false);
    expect(
      validateDiscoveryRepoInput({ repo: 'owner/repo', pathPrefixes: ['../x'] }).ok,
    ).toBe(false);

    const parsed = validateDiscoveryRepoInput({
      repo: 'owner/repo',
      branch: 'dev',
      pathPrefixes: ['sources/'],
      enabled: false,
      notes: '  只收指定目录  ',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        repo: 'owner/repo',
        branch: 'dev',
        pathPrefixes: ['sources'],
        enabled: false,
        notes: '只收指定目录',
      });
    }
  });

  it('parses stored rows and only publishes enabled repos', async () => {
    const rows = [
      {
        id: 'dr_1',
        repo: 'owner/a',
        branch: 'main',
        path_prefixes: '["sources"]',
        enabled: 1,
        notes: '',
        last_scanned_at: null,
        last_error: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'dr_2',
        repo: 'owner/b',
        branch: 'dev',
        path_prefixes: '[]',
        enabled: 0,
        notes: 'off',
        last_scanned_at: null,
        last_error: null,
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    expect(fromRow(rows[0]!).pathPrefixes).toEqual(['sources']);
    const config = await publicDiscoveryRepos(fakeDb(rows));
    expect(config.maxFetchPerRun).toBe(20);
    expect(config.maxFetchPerRepo).toBe(5);
    expect(config.repos).toEqual([
      { repo: 'owner/a', branch: 'main', pathPrefixes: ['sources'] },
    ]);
  });
});
