import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createRunnerSubscriptionRoutes } from '../src/proxySubRoutes';

const app = createRunnerSubscriptionRoutes();
const env = { RUNNER_TOKEN: 'runner-token' } as unknown as Env;

describe('runner 订阅拉取路由', () => {
  it('无 token 返回 401', async () => {
    const res = await app.request('/proxy-subscriptions/sub-1', {}, env);
    expect(res.status).toBe(401);
  });

  it('错误 token 返回 401', async () => {
    const res = await app.request(
      '/proxy-subscriptions/sub-1',
      { headers: { authorization: 'Bearer wrong' } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('回传缺字段返回 400，不触碰数据库', async () => {
    const res = await app.request(
      '/proxy-subscription-result',
      {
        method: 'POST',
        headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_payload' });
  });

  it('非法 JSON 返回 400', async () => {
    const res = await app.request(
      '/proxy-subscription-result',
      {
        method: 'POST',
        headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' },
        body: 'not-json',
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
