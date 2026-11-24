import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateFileSchema } from '@lx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrichCandidates } from '../src/candidates.js';

const SCRIPT = `
// @name ${'超长名称'.repeat(60)}
// @version v${'9'.repeat(60)}
// @author ${'作者'.repeat(60)}
// @description ${'说明'.repeat(400)}
lx.send(lx.EVENT_NAMES.inited, {
  sources: { kw: { name: '酷我', actions: ['musicUrl'], qualitys: ['128k'] } },
});
`;

describe('enrichCandidates', () => {
  let base = '';
  let server: ReturnType<typeof createServer>;
  let dir = '';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(SCRIPT);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server 未启动');
    base = `http://127.0.0.1:${address.port}/latest.js`;
    dir = await mkdtemp(join(tmpdir(), 'lx-cand-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('把脚本头部超长字段截断到 schema 允许的长度', async () => {
    const candidatesPath = join(dir, 'candidates.json');
    await writeFile(
      candidatesPath,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        candidates: [
          {
            id: 'cand-test-1',
            repo: 'demo/repo',
            path: 'latest.js',
            url: base,
            sha: 'abcdef1234',
            state: 'new',
          },
        ],
      }),
    );

    await enrichCandidates({
      candidatesPath,
      outPath: candidatesPath,
      limit: 1,
      concurrency: 1,
      initTimeoutMs: 5000,
      allowPrivate: true,
    });
    const file = CandidateFileSchema.parse(JSON.parse(await readFile(candidatesPath, 'utf8')));
    const candidate = file.candidates[0];
    if (candidate?.state !== 'qualified') console.error('initError:', candidate?.initError);
    expect(candidate?.state).toBe('qualified');
    expect((candidate?.title ?? '').length).toBeLessThanOrEqual(160);
    expect((candidate?.version ?? '').length).toBeLessThanOrEqual(40);
    expect((candidate?.author ?? '').length).toBeLessThanOrEqual(80);
    expect((candidate?.description ?? '').length).toBeLessThanOrEqual(300);
  });
});
