import { Hono } from 'hono';
import { recordAdminActivity } from './activity';
import { createApi } from './api';
import { readCookie, SESSION_COOKIE, verifySessionToken } from './auth';
import type { Env } from './env';
import { createAdminProxyRoutes, createRunnerProxyRoutes } from './proxyRoutes';
import { createRunnerProxyTestReportRoutes } from './proxyTestReport';
import { createRunnerSubscriptionRoutes } from './proxySubRoutes';
import { createRunnerConfigRoutes } from './runnerConfig';
import { runScheduler } from './scheduler';
import { reapStaleTasks, refreshTaskState } from './tasks';

const app = new Hono<{ Bindings: Env }>();

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/ingest',
  '/api/runner/proxies',
  '/api/config/mirrors',
  '/api/config/sources',
  '/api/config/discovery',
  '/api/health',
  '/favicon.ico',
  '/favicon.svg',
  '/robots.txt',
]);

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith('/assets/') ||
    pathname === '/api/runner' ||
    pathname.startsWith('/api/runner/')
  );
}

// 统一安全响应头；包括静态资源与接口。
app.use('*', async (c, next) => {
  await next();
  const headers = new Headers(c.res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('content-security-policy', CSP);
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (new URL(c.req.url).protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

// 整站登录：除了登录页、登录接口、上报接口和静态资源，一律要求会话。
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (isPublicPath(url.pathname)) return next();

  const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
  const allowed = await verifySessionToken(c.env.SESSION_SECRET ?? '', token);
  if (allowed) return next();

  if (url.pathname.startsWith('/api/')) {
    return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
  }
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const target = `${url.pathname}${url.search}`;
    return c.redirect(`/login?next=${encodeURIComponent(target)}`);
  }
  return c.json({ error: 'unauthorized', message: '请先登录' }, 401);
});

// 后台操作记录：所有会改数据的请求都留痕；只读请求不记，失败也记。
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const tracked = path.startsWith('/api/admin') || path === '/api/auth/change-password';
  if (!tracked) return next();
  const method = c.req.method.toUpperCase();
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  await next();
  if (!mutating || path.endsWith('/admin/proxies/preview')) return;

  let message = '';
  let recordTarget = '';
  if (c.res.status >= 400) {
    try {
      const body = (await c.res.clone().json()) as { message?: unknown; error?: unknown };
      const text = typeof body.message === 'string' ? body.message : body.error;
      if (typeof text === 'string') message = text;
    } catch {
      // 非 JSON 错误体就不记录详情。
    }
  } else if (path === '/api/admin/tasks' && method === 'POST') {
    try {
      const body = (await c.res.clone().json()) as { task?: { id?: unknown } };
      if (typeof body.task?.id === 'string') recordTarget = body.task.id;
    } catch {
      // 响应不是 JSON 时忽略。
    }
  }
  const task = recordAdminActivity(c.env, { method, path, status: c.res.status, message, target: recordTarget });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
});

app.route('/api/admin/proxies', createAdminProxyRoutes());
app.route('/api/runner/proxies', createRunnerProxyRoutes());
app.route('/api/runner/config', createRunnerConfigRoutes());
app.route('/api/runner', createRunnerProxyTestReportRoutes());
app.route('/api/runner', createRunnerSubscriptionRoutes());
app.route('/api', createApi());

app.all('/api/*', (c) =>
  c.json({ error: 'not_found', message: `未知接口：${new URL(c.req.url).pathname}` }, 404),
);

app.all('*', async (c) => {
  if (!c.env.ASSETS) {
    return c.text('前端资源未构建：请先运行 pnpm --filter @lx/web build', 503);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error('worker error', error);
  return c.json({ error: 'internal_error', message: '服务内部错误' }, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Cloudflare Cron Trigger：每 5 分钟醒一次，由 scheduler 决定是否到点。
   * GitHub 自己的 schedule 在新仓库上经常不触发，这里用 Worker 定时兜底。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await runScheduler(env);
          await reapStaleTasks(env);
          await refreshTaskState(env);
        } catch (error) {
          console.error('scheduler error', error);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
