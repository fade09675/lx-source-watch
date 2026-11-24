import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchRegistry } from '../src/registry';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/registry') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version: 1,
          sources: [
            {
              id: 'demo',
              title: '演示',
              storage: 'remote',
              url: 'https://raw.githubusercontent.com/owner/repo/main/demo.js',
              category: '在线',
              enabled: true,
              trusted: false,
            },
          ],
        }),
      );
      return;
    }
    if (pathname === '/bad-schema') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, sources: [{ id: 'BAD ID', title: 'x' }] }));
      return;
    }
    if (pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not json</html>');
      return;
    }
    res.writeHead(500).end('boom');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchRegistry', () => {
  it('loads a registry over http and resolves suggested endpoints', async () => {
    const sources = await fetchRegistry(`${base}/registry`);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe('demo');
    expect(sources[0]?.endpoints[0]).toMatchObject({ role: 'primary' });
    expect(sources[0]?.endpoints.length).toBeGreaterThan(1);
  });

  it('rejects an invalid schema', async () => {
    await expect(fetchRegistry(`${base}/bad-schema`)).rejects.toThrow(/校验失败/);
  });

  it('rejects non-JSON responses', async () => {
    await expect(fetchRegistry(`${base}/html`)).rejects.toThrow(/不是合法 JSON/);
  });

  it('rejects non-2xx responses with the status code', async () => {
    await expect(fetchRegistry(`${base}/missing`)).rejects.toThrow(/HTTP 500/);
  });
});
