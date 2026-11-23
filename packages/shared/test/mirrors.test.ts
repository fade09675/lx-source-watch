import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIRROR_TEMPLATES,
  MirrorTemplateListSchema,
  parseGitHubRawUrl,
  renderMirror,
  templateError,
} from '../src/mirrors';

const RAW = 'https://raw.githubusercontent.com/pdone/lx-music-source/main/jiexiang/latest.js';

describe('parseGitHubRawUrl', () => {
  it('拆出 owner/repo/branch/path', () => {
    expect(parseGitHubRawUrl(RAW)).toEqual({
      owner: 'pdone',
      repo: 'lx-music-source',
      branch: 'main',
      path: 'jiexiang/latest.js',
    });
  });

  it('非 raw 地址返回 null', () => {
    expect(parseGitHubRawUrl('https://example.com/a.js')).toBeNull();
  });
});

describe('renderMirror', () => {
  it('替换 {url}', () => {
    const parts = { ...parseGitHubRawUrl(RAW)!, url: RAW };
    expect(renderMirror('https://gh-proxy.com/{url}', parts)).toBe(`https://gh-proxy.com/${RAW}`);
  });

  it('替换路径占位符', () => {
    const parts = { ...parseGitHubRawUrl(RAW)!, url: RAW };
    expect(renderMirror('https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}', parts)).toBe(
      'https://cdn.jsdelivr.net/gh/pdone/lx-music-source@main/jiexiang/latest.js',
    );
  });
});

describe('templateError', () => {
  it('接受合法的两种写法', () => {
    expect(templateError('https://gh-proxy.com/{url}')).toBeNull();
    expect(templateError('https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}')).toBeNull();
  });

  it('拒绝 http、空白、缺占位符', () => {
    expect(templateError('http://gh-proxy.com/{url}')).toMatch(/https/);
    expect(templateError('https://gh-proxy.com/{url} extra')).toMatch(/空格/);
    expect(templateError('https://gh-proxy.com/proxy')).toMatch(/需要包含/);
  });
});

describe('默认模板', () => {
  it('恰好 8 条且全部合法', () => {
    expect(DEFAULT_MIRROR_TEMPLATES).toHaveLength(8);
    for (const template of DEFAULT_MIRROR_TEMPLATES) {
      expect(templateError(template.template)).toBeNull();
      expect(template.enabled).toBe(true);
    }
  });

  it('列表最多 10 条', () => {
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      id: `t-${index}`,
      name: `T${index}`,
      template: 'https://gh-proxy.com/{url}',
      enabled: true,
    }));
    expect(MirrorTemplateListSchema.safeParse(tooMany).success).toBe(false);
  });
});
