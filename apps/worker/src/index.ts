import { Hono } from 'hono';
import { createApi } from './api';
import { readCookie, SESSION_COOKIE, verifySessionToken } from './auth';
import type { Env } from './env';
import { createAdminProxyRoutes, createRunnerProxyRoutes } from './proxyRoutes';

const app = new Hono<{ Bindings: Env }>();

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/ingest',
  '/api/runner/proxies',
  '/favicon.ico',
  '/favicon.svg',
  '/robots.txt',
]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/assets/');
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

app.route('/api/admin/proxies', createAdminProxyRoutes());
app.route('/api/runner/proxies', createRunnerProxyRoutes());
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

export default app;
