import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cnVerify, type CnProgressEvent } from '../src/cn.js';

describe('cnVerify progress', () => {
  it('按地址回写单调进度', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cn-progress-'));
    try {
      const urlsPath = join(dir, 'urls.json');
      const outPath = join(dir, 'cn.json');
      const urls = Array.from({ length: 12 }, (_, index) => ({
        sourceId: `source-${index}`,
        platform: 'kw',
        quality: '128k',
        url: `http://127.0.0.1:1/${index}.mp3`,
        resolveMs: 1,
        ok: true,
      }));
      await writeFile(urlsPath, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), urls }), 'utf8');
      const events: CnProgressEvent[] = [];
      const file = await cnVerify({
        urlsPath,
        outPath,
        proxy: { url: 'http://127.0.0.1:1', label: 'fake' },
        concurrency: 6,
        timeoutMs: 200,
        scope: 'all',
        skipEndpoints: true,
        onProgress: (event) => {
          events.push(event);
        },
      });
      expect(file.summary.tested).toBe(12);
      expect(events[0]).toMatchObject({ stage: 'loading', done: 0, total: 12 });
      const sourceEvents = events.filter((event) => event.stage === 'sources');
      expect(sourceEvents.at(-1)).toMatchObject({ done: 12, total: 12, unit: '地址' });
      expect(events.some((event) => event.stage === 'endpoints')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
