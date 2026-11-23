import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAudioUrl } from '../src/probe/stream.js';

let server: Server;
let base: string;

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(600, 0)]);
const FLAC = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(600, 0)]);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/mp3')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(MP3.length) });
      res.end(MP3);
      return;
    }
    if (url.startsWith('/flac')) {
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${FLAC.length - 1}/${FLAC.length}`,
      });
      res.end(FLAC);
      return;
    }
    if (url.startsWith('/json')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 403, msg: 'no permission' }));
      return;
    }
    if (url.startsWith('/html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>blocked</body></html>');
      return;
    }
    if (url.startsWith('/empty')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end();
      return;
    }
    if (url.startsWith('/404')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const opts = { allowPrivate: true, timeoutMs: 3000 };

describe('verifyAudioUrl', () => {
  it('ID3 头的 mp3 判定为可用', async () => {
    const r = await verifyAudioUrl(`${base}/mp3`, opts);
    expect(r.ok).toBe(true);
    expect(r.magic).toBe('mp3-id3');
    expect(r.status).toBe(200);
    expect(r.bytes).toBeGreaterThan(3);
  });

  it('206 + fLaC 也判定为可用', async () => {
    const r = await verifyAudioUrl(`${base}/flac`, opts);
    expect(r.ok).toBe(true);
    expect(r.magic).toBe('flac');
    expect(r.status).toBe(206);
  });

  it('JSON 错误响应判定为非音频', async () => {
    const r = await verifyAudioUrl(`${base}/json`, opts);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('stream_non_audio');
  });

  it('HTML 拦截页判定为非音频', async () => {
    const r = await verifyAudioUrl(`${base}/html`, opts);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('stream_non_audio');
  });

  it('空响应判定为不可用', async () => {
    const r = await verifyAudioUrl(`${base}/empty`, opts);
    expect(r.ok).toBe(false);
  });

  it('404 判定为 stream_http 并保留状态码', async () => {
    const r = await verifyAudioUrl(`${base}/404`, opts);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('stream_http');
    expect(r.error?.status).toBe(404);
  });

  it('私网地址默认被拦截', async () => {
    const r = await verifyAudioUrl(`${base}/mp3`, { timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('stream_network');
  });
});
