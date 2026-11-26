import { describe, expect, it } from 'vitest';
import { RepoUrlError, parseRepoUrl } from '../src/lib/repoUrl';

describe('parseRepoUrl', () => {
  it('parses a repository home page', () => {
    expect(parseRepoUrl('https://github.com/pdone/lx-music-source')).toEqual({
      repo: 'pdone/lx-music-source',
      branch: 'main',
      pathPrefixes: [],
    });
  });

  it('parses tree branch and directory', () => {
    expect(parseRepoUrl('https://github.com/tfappstore/lx-music-source/tree/main/kulao/')).toEqual({
      repo: 'tfappstore/lx-music-source',
      branch: 'main',
      pathPrefixes: ['kulao'],
    });
  });

  it('handles .git, trailing slashes and ssh links', () => {
    expect(parseRepoUrl('https://github.com/shellsec/lx-music-source.git/').repo).toBe(
      'shellsec/lx-music-source',
    );
    expect(parseRepoUrl('git@github.com:hwxlikemi/lxs.git').repo).toBe('hwxlikemi/lxs');
  });

  it('accepts owner/repo and a custom fallback branch', () => {
    expect(parseRepoUrl('cdyUuu/lx-music-xinghai-source', 'master')).toEqual({
      repo: 'cdyUuu/lx-music-xinghai-source',
      branch: 'master',
      pathPrefixes: [],
    });
  });

  it('rejects file links', () => {
    expect(() =>
      parseRepoUrl('https://github.com/owner/repo/blob/main/source.js'),
    ).toThrow(RepoUrlError);
  });

  it('rejects non-GitHub hosts', () => {
    expect(() => parseRepoUrl('https://example.com/owner/repo')).toThrow(RepoUrlError);
  });
});
