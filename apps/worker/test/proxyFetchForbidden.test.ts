import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSubscription, isNeedsRunnerError } from '../src/proxyRoutes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('订阅 403 兜底标记', () => {
  it('403 抛出 needsRunner 错误，提示可用 Actions 拉取', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));

    const error = await fetchSubscription(new URL('https://example.com/sub'), '').catch((e: unknown) => e);

    expect(isNeedsRunnerError(error)).toBe(true);
    expect((error as { status?: number }).status).toBe(403);
    expect((error as Error).message).toContain('用 Actions 拉取');
  });

  it('普通 500 不标记 needsRunner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const error = await fetchSubscription(new URL('https://example.com/sub'), '').catch((e: unknown) => e);

    expect(isNeedsRunnerError(error)).toBe(false);
    expect((error as Error).message).toContain('HTTP 500');
  });
});
