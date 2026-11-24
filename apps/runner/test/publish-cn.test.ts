import type { Snapshot, SourceResult } from '@lx/shared';
import { describe, expect, it } from 'vitest';
import type { CnFile } from '../src/cn.js';
import { applyCnResults, readCnFile } from '../src/publish.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function platform(key: string, ok: boolean) {
  return {
    key,
    name: key,
    declared: true,
    tested: true,
    ok,
    totalMs: 500,
  };
}

function snapshot(): Snapshot {
  const source = {
    id: 'demo',
    title: '演示源',
    url: 'https://example.com/demo.js',
    category: '在线',
    storage: 'remote',
    status: 'available',
    initOk: true,
    stats: { ok: 2, tested: 2, total: 3 },
    platforms: [platform('kg', true), platform('wy', false), platform('mg', true)],
    checkedAt: '2026-11-23T12:00:00.000Z',
    durationMs: 1000,
  } as unknown as SourceResult;
  return {
    schemaVersion: 1,
    runId: 'run-demo',
    generatedAt: '2026-11-23T12:00:00.000Z',
    nextCheckAt: '2026-11-23T16:00:00.000Z',
    intervalHours: 4,
    runner: 'local',
    checkScope: 'all',
    durationMs: 1000,
    summary: { total: 1, available: 1, partial: 0, unavailable: 0, untested: 0, platformsOk: 2, platformsTested: 2 },
    sources: [source],
  } as Snapshot;
}

function cnFile(rows: CnFile['rows'], endpoints?: CnFile['endpoints']): CnFile {
  return {
    version: 1,
    generatedAt: '2026-11-23T12:05:00.000Z',
    mode: 'verify',
    proxy: '上海电信',
    summary: { tested: rows.length, ok: rows.filter((row) => row.ok).length },
    rows,
    ...(endpoints ? { endpoints } : {}),
  };
}

describe('applyCnResults', () => {
  it('任一 URL 可达即标记国内可达，并写入耗时与代理名', () => {
    const doc = snapshot();
    applyCnResults(
      doc,
      cnFile([
        { sourceId: 'demo', platform: 'kg', url: 'https://a', proxy: '上海电信', ok: false, status: 403, ttfbMs: 0, totalMs: 0, bytes: 0, error: 'HTTP 403' },
        { sourceId: 'demo', platform: 'kg', url: 'https://b', proxy: '上海电信', ok: true, status: 206, ttfbMs: 120, totalMs: 320, bytes: 1000 },
      ]),
    );
    const kg = doc.sources[0]?.platforms.find((item) => item.key === 'kg');
    expect(kg?.cn).toMatchObject({ tested: true, ok: true, ms: 320, ttfbMs: 120, proxy: '上海电信' });
  });

  it('全部失败时记录国内不可达与 HTTP 状态', () => {
    const doc = snapshot();
    applyCnResults(
      doc,
      cnFile([{ sourceId: 'demo', platform: 'wy', url: 'https://a', proxy: '上海电信', ok: false, status: 403, ttfbMs: 0, totalMs: 0, bytes: 0, error: 'HTTP 403' }]),
    );
    const wy = doc.sources[0]?.platforms.find((item) => item.key === 'wy');
    expect(wy?.cn?.ok).toBe(false);
    expect(wy?.cn?.error).toContain('HTTP 403');
  });

  it('没有补测行的平台保持未测', () => {
    const doc = snapshot();
    applyCnResults(doc, cnFile([]));
    expect(doc.sources[0]?.platforms.find((item) => item.key === 'mg')?.cn).toBeUndefined();
  });

  it('接入点补测按 sourceId+url 合并，不存在的镜像保持未测', () => {
    const doc = snapshot();
    doc.sources[0]!.endpoints = [
      { url: 'https://example.com/demo.js', role: 'primary', ok: true, ms: 80, checkedAt: '2026-11-23T12:00:00.000Z' },
      { url: 'https://cdn.example.com/demo.js', role: 'candidate', ok: false, ms: 90, checkedAt: '2026-11-23T12:00:00.000Z' },
    ];
    applyCnResults(
      doc,
      cnFile(
        [],
        [
          {
            sourceId: 'demo',
            url: 'https://example.com/demo.js',
            role: 'primary',
            ok: true,
            status: 206,
            ttfbMs: 120,
            totalMs: 460,
            bytes: 4096,
          },
        ],
      ),
    );
    const [primary, mirror] = doc.sources[0]!.endpoints;
    expect(primary?.cn).toMatchObject({ tested: true, ok: true, ms: 460, proxy: '上海电信' });
    expect(mirror?.cn).toBeUndefined();
  });

  it('接入点全失败时写入国内错误', () => {
    const doc = snapshot();
    doc.sources[0]!.endpoints = [
      { url: 'https://example.com/demo.js', role: 'primary', ok: true, ms: 80, checkedAt: '2026-11-23T12:00:00.000Z' },
    ];
    applyCnResults(
      doc,
      cnFile(
        [],
        [
          {
            sourceId: 'demo',
            url: 'https://example.com/demo.js',
            role: 'primary',
            ok: false,
            status: 0,
            ttfbMs: 0,
            totalMs: 15000,
            bytes: 0,
            error: '请求超时（15000ms）',
          },
        ],
      ),
    );
    expect(doc.sources[0]!.endpoints[0]!.cn).toMatchObject({ tested: true, ok: false, error: '请求超时（15000ms）' });
  });
});

describe('readCnFile', () => {
  it('文件不存在时返回 null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lx-cn-'));
    expect(await readCnFile(join(dir, 'missing.json'))).toBeNull();
  });

  it('读取合法 JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lx-cn-'));
    const path = join(dir, 'cn.json');
    const payload = cnFile([]);
    await writeFile(path, JSON.stringify(payload), 'utf8');
    expect(await readCnFile(path)).toMatchObject({ proxy: '上海电信' });
  });
});
