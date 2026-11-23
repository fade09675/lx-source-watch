import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { dispatchProbe, listProbeRuns } from '../src/dispatch';

function envWith(overrides: Partial<Env> = {}): Env {
  return { GH_DISPATCH_TOKEN: 'test-token', ...overrides } as unknown as Env;
}

describe('dispatchProbe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有配置令牌时返回 503', async () => {
    const result = await dispatchProbe({} as Env, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('成功派发时提交工作流和参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchProbe(envWith(), { limit: '3', deep: true, preferMirror: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dispatchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/fade09675/lx-source-watch/actions/workflows/probe.yml/dispatches');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { ref: string; inputs: Record<string, string> };
    expect(body.ref).toBe('main');
    expect(body.inputs).toMatchObject({ limit: '3', deep: 'true', prefer_mirror: 'true' });
  });

  it('令牌无效时给出中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const result = await dispatchProbe(envWith(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('无效');
  });

  it('权限不足时给出中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    const result = await dispatchProbe(envWith(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('权限');
  });

  it('参数不合法时返回 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 422 })));
    const result = await dispatchProbe(envWith(), { only: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});

describe('listProbeRuns', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('把 GitHub 字段转成页面用的结构', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 42,
                name: '音源探测',
                event: 'workflow_dispatch',
                status: 'completed',
                conclusion: 'success',
                created_at: '2026-11-23T15:29:36Z',
                updated_at: '2026-11-23T15:31:20Z',
                html_url: 'https://github.com/fade09675/lx-source-watch/actions/runs/42',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await listProbeRuns(envWith(), 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({ id: 42, status: 'completed', conclusion: 'success' });
    }
  });

  it('没有令牌时返回 503', async () => {
    const result = await listProbeRuns({} as Env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });
});
