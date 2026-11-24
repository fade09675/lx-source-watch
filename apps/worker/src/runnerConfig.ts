import { Hono } from 'hono';
import type { Env } from './env';
import { authRunner } from './proxyRoutes';
import { loadSettings } from './settings';

/** Actions 侧运行参数：由设置页统一管理，CLI 未显式指定时使用。 */
export interface RunnerConfigView {
  cnMaxHops: number;
  cnAutoSwitch: boolean;
  proxyTestConcurrency: number;
  proxyTestTimeoutMs: number;
  proxyFetchUserAgent: string;
}

export function createRunnerConfigRoutes(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.use('*', async (c, next) => {
    if (!authRunner(c.env, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized', message: 'runner token 无效' }, 401);
    }
    await next();
  });

  api.get('/', async (c) => {
    const settings = await loadSettings(c.env.DB);
    const config: RunnerConfigView = {
      cnMaxHops: settings.cnMaxHops,
      cnAutoSwitch: settings.cnAutoSwitch,
      proxyTestConcurrency: settings.proxyTestConcurrency,
      proxyTestTimeoutMs: settings.proxyTestTimeoutMs,
      proxyFetchUserAgent: settings.proxyFetchUserAgent,
    };
    return c.json({ ok: true, config });
  });

  return api;
}
