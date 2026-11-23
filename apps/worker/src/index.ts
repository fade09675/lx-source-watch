import { Hono } from 'hono';
import { createApi } from './api';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
  await next();
  c.header('access-control-allow-origin', '*');
  c.header('x-content-type-options', 'nosniff');
});

app.route('/api', createApi());

app.get('/', (c) =>
  c.json({
    name: c.env.SITE_NAME ?? 'LX 音源监测',
    status: '/api/status',
    health: '/api/health',
  }),
);

app.notFound((c) => c.json({ error: 'not_found', message: `未知路径：${new URL(c.req.url).pathname}` }, 404));

app.onError((error, c) => {
  console.error('worker error', error);
  return c.json({ error: 'internal_error', message: '服务内部错误' }, 500);
});

export default app;
