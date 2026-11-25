import { describe, expect, it } from 'vitest';
import { mergeRepos } from '../src/discover';
import type { DiscoveryRepo } from '@lx/shared';

const base: DiscoveryRepo = {
  repo: 'owner/a',
  branch: 'main',
  pathPrefixes: [],
  exclude: ['node_modules'],
  enabled: true,
};

describe('mergeRepos', () => {
  it('adds custom repos and skips duplicates by repo and branch', () => {
    const custom: DiscoveryRepo[] = [
      { ...base },
      { ...base, repo: 'owner/b', branch: 'dev' },
      { ...base, repo: 'owner/b', branch: 'main' },
    ];
    const merged = mergeRepos([base], custom);
    expect(merged.map((repo) => `${repo.repo}@${repo.branch}`)).toEqual([
      'owner/a@main',
      'owner/b@dev',
      'owner/b@main',
    ]);
  });

  it('does not mutate the builtin list', () => {
    const builtin = [base];
    mergeRepos(builtin, [{ ...base, repo: 'owner/c' }]);
    expect(builtin).toHaveLength(1);
  });
});
