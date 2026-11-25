import { describe, expect, it } from 'vitest';
import { DiscoveryConfigSchema } from '@lx/shared';
import { rankEntries } from '../src/discover';

const repo = {
  repo: 'owner/repo',
  branch: 'main',
  pathPrefixes: [],
  exclude: ['node_modules', '.min.js'],
  enabled: true,
};

function entry(path: string, size = 1000) {
  return { path, type: 'blob', size, sha: path };
}

describe('rankEntries', () => {
  it('只保留限额内的 js，并优先 latest/index 等入口文件', () => {
    const ranked = rankEntries(
      [
        entry('docs/readme.md'),
        entry('node_modules/a.js'),
        entry('dist/b.min.js'),
        entry('sources/random-name.js'),
        entry('latest.js'),
      ],
      repo,
    );
    expect(ranked.map((item) => item.path)).toEqual(['latest.js', 'sources/random-name.js']);
  });

  it('遵守路径前缀', () => {
    const ranked = rankEntries(
      [entry('sources/a.js'), entry('other/b.js')],
      { ...repo, pathPrefixes: ['sources/'] },
    );
    expect(ranked.map((item) => item.path)).toEqual(['sources/a.js']);
  });

  it('过滤超过 2MB 的脚本', () => {
    const ranked = rankEntries([entry('big.js', 3 * 1024 * 1024), entry('small.js', 1024)], repo);
    expect(ranked.map((item) => item.path)).toEqual(['small.js']);
  });
});

describe('DiscoveryConfigSchema', () => {
  it('每仓库上限默认 5，可显式覆盖', () => {
    const base = { version: 1, repos: [repo] };
    expect(DiscoveryConfigSchema.parse(base).maxFetchPerRepo).toBe(5);
    expect(DiscoveryConfigSchema.parse({ ...base, maxFetchPerRepo: 3 }).maxFetchPerRepo).toBe(3);
  });
});
