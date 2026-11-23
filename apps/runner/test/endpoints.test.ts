import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EndpointCheck } from '../src/probe/endpoints';
import { checkEndpoints, chooseEndpoint, toEndpointResults } from '../src/probe/endpoints';
import type { ResolvedSource } from '../src/registry';
import { suggestedMirrors } from '../src/registry';

const script = (name: string, version: string, padding: string): string =>
  `// @name ${name}\n// @version ${version}\n// @description test\n${padding.repeat(20)}\n`;

const GOOD = script('Good', '1.2.3', 'a');
const OTHER = script('Good', '1.2.2', 'b');

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/good.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(GOOD);
      return;
    }
    if (pathname === '/other.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(OTHER);
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function source(endpoints: { url: string; role: 'primary' | 'candidate' }[]): ResolvedSource {
  return {
    id: 'test-source',
    title: 'Test',
    storage: 'remote',
    category: '在线',
    enabled: true,
    trusted: false,
    mirrors: [],
    resolvedUrl: endpoints[0]?.url ?? '',
    endpoints,
  };
}

describe('checkEndpoints', () => {
  it('marks candidate with the same sha as synced and a different one as lagging', async () => {
    const checks = await checkEndpoints(
      source([
        { url: `${base}/good.js`, role: 'primary' },
        { url: `${base}/good.js?mirror=1`, role: 'candidate' },
        { url: `${base}/other.js`, role: 'candidate' },
        { url: `${base}/missing.js`, role: 'candidate' },
      ]),
      { allowPrivate: true },
    );
    expect(checks).toHaveLength(4);
    expect(checks[0]?.ok).toBe(true);
    expect(checks[0]?.version).toBe('1.2.3');
    expect(checks[1]?.versionState).toBe('synced');
    expect(checks[2]?.versionState).toBe('lagging');
    expect(checks[3]?.ok).toBe(false);
    expect(checks[3]?.status).toBe(404);
    expect(checks[3]?.versionState).toBeUndefined();
  });

  it('marks candidates unknown when the primary is unavailable', async () => {
    const checks = await checkEndpoints(
      source([
        { url: `${base}/missing.js`, role: 'primary' },
        { url: `${base}/good.js`, role: 'candidate' },
      ]),
      { allowPrivate: true },
    );
    expect(checks[1]?.versionState).toBe('unknown');
  });

  it('drops code from the serialized results', async () => {
    const checks = await checkEndpoints(source([{ url: `${base}/good.js`, role: 'primary' }]), {
      allowPrivate: true,
    });
    expect(checks[0]?.code).toBeTruthy();
    const results = toEndpointResults(checks);
    expect('code' in (results[0] as object)).toBe(false);
  });
});

describe('suggestedMirrors', () => {
  it('为 raw.githubusercontent 生成八个候选加速地址', () => {
    const mirrors = suggestedMirrors('https://raw.githubusercontent.com/pdone/lx-music-source/main/jiexiang/latest.js');
    expect(mirrors).toHaveLength(8);
    expect(mirrors.some((url) => url.includes('cdn.jsdelivr.net/gh/pdone/lx-music-source@main/jiexiang/latest.js'))).toBe(true);
    expect(mirrors.some((url) => url.startsWith('https://gh-proxy.com/'))).toBe(true);
    expect(mirrors.some((url) => url.startsWith('https://rawcdn.githack.com/'))).toBe(true);
  });

  it('非 GitHub raw 地址不生成候选', () => {
    expect(suggestedMirrors('https://example.com/source.js')).toEqual([]);
  });

  it('使用自定义模板，跳过 disabled 项', () => {
    const mirrors = suggestedMirrors('https://raw.githubusercontent.com/pdone/lx-music-source/main/jiexiang/latest.js', [
      { id: 'one', name: 'One', template: 'https://one.example/{url}', enabled: true },
      { id: 'off', name: 'Off', template: 'https://off.example/{url}', enabled: false },
    ]);
    expect(mirrors).toEqual([
      'https://one.example/https://raw.githubusercontent.com/pdone/lx-music-source/main/jiexiang/latest.js',
    ]);
  });

  it('模板渲染结果去重', () => {
    const mirrors = suggestedMirrors('https://raw.githubusercontent.com/pdone/lx-music-source/main/a.js', [
      { id: 'a', name: 'A', template: 'https://same.example/{url}', enabled: true },
      { id: 'b', name: 'B', template: 'https://same.example/{url}', enabled: true },
    ]);
    expect(mirrors).toHaveLength(1);
  });
});

describe('chooseEndpoint', () => {
  const check = (over: Partial<EndpointCheck> & { role: 'primary' | 'candidate' }): EndpointCheck => ({
    url: `https://example.com/${over.role}.js`,
    ok: true,
    ms: 10,
    checkedAt: '2026-11-23T10:00:00.000Z',
    ...over,
  });

  it('prefers the primary when it is available', () => {
    const chosen = chooseEndpoint([check({ role: 'primary' }), check({ role: 'candidate', versionState: 'synced' })]);
    expect(chosen?.check.role).toBe('primary');
    expect(chosen?.warning).toBeUndefined();
  });

  it('falls back to a synced mirror with a warning', () => {
    const chosen = chooseEndpoint([
      check({ role: 'primary', ok: false, error: 'HTTP 502' }),
      check({ role: 'candidate', versionState: 'synced' }),
    ]);
    expect(chosen?.check.role).toBe('candidate');
    expect(chosen?.warning).toContain('同版本镜像');
  });

  it('uses a lagging mirror only as a last resort', () => {
    const chosen = chooseEndpoint([
      check({ role: 'primary', ok: false }),
      check({ role: 'candidate', versionState: 'lagging' }),
    ]);
    expect(chosen?.check.versionState).toBe('lagging');
    expect(chosen?.warning).toContain('版本不一致');
  });

  it('returns undefined when nothing is reachable', () => {
    expect(chooseEndpoint([check({ role: 'primary', ok: false }), check({ role: 'candidate', ok: false })])).toBeUndefined();
  });
});
