import { SnapshotSchema, type ExportItem, type Snapshot, type SourceResult, type StatusEnvelope } from '@lx/shared';
import { Hono } from 'hono';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  clearLoginFailures,
  createSessionToken,
  hashPassword,
  loginAllowed,
  MIN_PASSWORD_LENGTH,
  noteLoginFailure,
  readCookie,
  SESSION_COOKIE,
  verifyPassword,
} from './auth';
import {
  countCandidates,
  getCandidates,
  getEvents,
  getLastRun,
  getRuns,
  getSetting,
  getSourceDaily,
  getSourceHistory,
  getSourcePlatformDaily,
  setCandidateState,
  touchSetting,
} from './db';
import type { Env } from './env';
import { ADMIN_PASSWORD_SETTING, SNAPSHOT_KEY } from './env';
import { filterSnapshot, parseList } from './filter';
import { handleIngest } from './ingest';
import { isStale } from './merge';
import { dispatchProbe, dispatchProxyTest, listProbeRuns } from './dispatch';
import { getUsage, recordKvPut, refreshUsage } from './usage';

type Ctx = { Bindings: Env };

// 整站需要登录，任何响应都不允许被共享缓存保存。
const CACHE_PRIVATE = 'private, no-store';

const CANDIDATE_STATES = ['new', 'qualified', 'rejected', 'promoted'];

function isSecure(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === 'https:';
}

async function readPasswordHash(env: Env): Promise<string | null> {
  return (await getSetting(env.DB, ADMIN_PASSWORD_SETTING)) ?? env.ADMIN_PASSWORD_HASH ?? null;
}

async function readSnapshot(env: Env): Promise<Snapshot | null> {
  const raw = await env.SNAPSHOT.get(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return SnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function notReady(): Response {
  return Response.json({ error: 'not_ready', message: '还没有任何检测结果，等待 Actions 首次上报' }, { status: 503 });
}

function notFound(message: string): Response {
  return Response.json({ error: 'not_found', message }, { status: 404 });
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function toExportItem(source: SourceResult): ExportItem {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    mirror: source.mirror,
    homepage: source.homepage,
    status: source.status,
    ok: source.stats.ok,
    tested: source.stats.tested,
    total: source.stats.total,
    platforms: source.platforms.map((platform) => ({
      key: platform.key,
      ok: platform.ok,
      tested: platform.tested,
      ms: platform.totalMs,
    })),
  };
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(items: ExportItem[]): string {
  const header = ['id', 'title', 'url', 'mirror', 'homepage', 'status', 'ok', 'tested', 'total', 'platforms'];
  const lines = [header.join(',')];
  for (const item of items) {
    const platforms = item.platforms
      .map((platform) => `${platform.key}:${platform.tested ? (platform.ok ? 'ok' : 'fail') : 'untested'}`)
      .join('|');
    lines.push(
      [
        item.id,
        item.title,
        item.url,
        item.mirror ?? '',
        item.homepage ?? '',
        item.status,
        item.ok,
        item.tested,
        item.total,
        platforms,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function createApi(): Hono<Ctx> {
  const api = new Hono<Ctx>();

  api.post('/ingest', handleIngest);

  api.get('/auth/me', (c) => c.json({ ok: true, site: c.env.SITE_NAME ?? 'LX 音源监测' }, 200, { 'cache-control': CACHE_PRIVATE }));

  api.post('/auth/login', async (c) => {
    if (!c.env.SESSION_SECRET) {
      return c.json({ error: 'not_configured', message: '服务端未配置会话密钥' }, 500);
    }
    const ip = c.req.header('cf-connecting-ip') ?? '127.0.0.1';
    if (!(await loginAllowed(c.env.SNAPSHOT, ip))) {
      return c.json(
        { error: 'too_many_attempts', message: '密码错误次数过多，请 10 分钟后再试' },
        429,
        { 'retry-after': '600', 'cache-control': CACHE_PRIVATE },
      );
    }

    let password = '';
    try {
      const body = await c.req.json<{ password?: unknown }>();
      password = typeof body.password === 'string' ? body.password : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (!password) return c.json({ error: 'bad_request', message: '请输入密码' }, 400);

    const stored = await readPasswordHash(c.env);
    if (!stored) return c.json({ error: 'not_configured', message: '服务端未设置登录密码' }, 500);

    if (!(await verifyPassword(password, stored))) {
      await noteLoginFailure(c.env.SNAPSHOT, ip);
      return c.json({ error: 'bad_password', message: '密码不正确' }, 401);
    }

    await clearLoginFailures(c.env.SNAPSHOT, ip);
    const token = await createSessionToken(c.env.SESSION_SECRET);
    return c.json({ ok: true }, 200, {
      'set-cookie': buildSessionCookie(token, isSecure(c.req.url)),
      'cache-control': CACHE_PRIVATE,
    });
  });

  api.post('/auth/logout', (c) =>
    c.json({ ok: true }, 200, {
      'set-cookie': buildClearSessionCookie(isSecure(c.req.url)),
      'cache-control': CACHE_PRIVATE,
    }),
  );

  api.post('/auth/change-password', async (c) => {
    let oldPassword = '';
    let newPassword = '';
    try {
      const body = await c.req.json<{ oldPassword?: unknown; newPassword?: unknown }>();
      oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
      newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: 'weak_password', message: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);
    }
    const stored = await readPasswordHash(c.env);
    if (!stored) return c.json({ error: 'not_configured', message: '服务端未设置登录密码' }, 500);
    if (!(await verifyPassword(oldPassword, stored))) {
      return c.json({ error: 'bad_password', message: '旧密码不正确' }, 400);
    }
    const hash = await hashPassword(newPassword);
    await touchSetting(c.env.DB, ADMIN_PASSWORD_SETTING, hash, new Date().toISOString());
    return c.json({ ok: true }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.get('/admin/candidates', async (c) => {
    const candidates = await getCandidates(c.env.DB, { limit: 500 });
    return c.json({ candidates, count: candidates.length }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.patch('/admin/candidates/:id', async (c) => {
    let state = '';
    try {
      const body = await c.req.json<{ state?: unknown }>();
      state = typeof body.state === 'string' ? body.state : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (!CANDIDATE_STATES.includes(state)) {
      return c.json({ error: 'bad_state', message: `未知候选状态：${state}` }, 400);
    }
    const id = c.req.param('id');
    const updated = await setCandidateState(c.env.DB, id, state, new Date().toISOString());
    if (!updated) return c.json({ error: 'not_found', message: `未知候选源：${id}` }, 404);
    return c.json({ ok: true, id, state }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 网页触发一次探测，避免每次都去 GitHub 手动点。
  api.post('/admin/run/probe', async (c) => {
    const last = await c.env.SNAPSHOT.get('run:probe:last');
    if (last) {
      return Response.json(
        { error: 'too_frequent', message: '刚刚已经触发过，请等一分钟再试' },
        { status: 429, headers: { 'retry-after': '60', 'cache-control': CACHE_PRIVATE } },
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      // 允许空请求体，全部使用默认参数。
    }
    const limit = typeof body.limit === 'string' ? body.limit.trim() : '';
    if (limit && !/^[1-9]\d{0,2}$/.test(limit)) {
      return Response.json(
        { error: 'bad_request', message: '“最多测几个源”只能是 1 到 999 的数字' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }

    const outcome = await dispatchProbe(c.env, {
      only: typeof body.only === 'string' ? body.only : '',
      limit,
      deep: body.deep === true,
      preferMirror: body.preferMirror === true,
      proxyId: typeof body.proxyId === 'string' ? body.proxyId.trim().slice(0, 64) : '',
    });
    if (!outcome.ok) {
      return Response.json(
        { error: 'dispatch_failed', message: outcome.message },
        { status: outcome.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }

    await recordKvPut(c.env);
    await c.env.SNAPSHOT.put('run:probe:last', outcome.dispatchedAt, { expirationTtl: 60 });
    return Response.json({ ok: true, dispatchedAt: outcome.dispatchedAt }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/admin/runs', async (c) => {
    const result = await listProbeRuns(c.env, 5);
    if (!result.ok) {
      return Response.json(
        { error: 'runs_failed', message: result.message },
        { status: result.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const lastDispatchedAt = await c.env.SNAPSHOT.get('run:probe:last');
    return Response.json({ runs: result.runs, lastDispatchedAt }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  // KV / D1 / Actions 用量。默认 5 分钟内复用缓存，?refresh=1 强制刷新。
  api.get('/admin/usage', async (c) => {
    const usage = await getUsage(c.env, { refresh: c.req.query('refresh') === '1' });
    return Response.json({ usage }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/usage/refresh', async (c) => {
    const usage = await refreshUsage(c.env);
    return Response.json({ usage }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  // 网页触发一次代理测活（全部或指定节点）。
  api.post('/admin/run/proxy-test', async (c) => {
    const last = await c.env.SNAPSHOT.get('run:proxy-test:last');
    if (last) {
      return Response.json(
        { error: 'too_frequent', message: '刚刚已经触发过测活，请等一分钟再试' },
        { status: 429, headers: { 'retry-after': '60', 'cache-control': CACHE_PRIVATE } },
      );
    }
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      // 空请求体表示测全部。
    }
    const outcome = await dispatchProxyTest(c.env, {
      proxyId: typeof body.proxyId === 'string' ? body.proxyId.trim().slice(0, 64) : '',
      subscriptionId: typeof body.subscriptionId === 'string' ? body.subscriptionId.trim().slice(0, 64) : '',
      concurrency: Number(body.concurrency) || 5,
    });
    if (!outcome.ok) {
      return Response.json(
        { error: 'dispatch_failed', message: outcome.message },
        { status: outcome.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    await recordKvPut(c.env);
    await c.env.SNAPSHOT.put('run:proxy-test:last', outcome.dispatchedAt, { expirationTtl: 60 });
    return Response.json({ ok: true, dispatchedAt: outcome.dispatchedAt }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/status', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const filtered = filterSnapshot(snapshot, {
      platforms: parseList(c.req.query('platform')),
      statuses: parseList(c.req.query('status')),
      q: c.req.query('q'),
    });
    const envelope: StatusEnvelope = {
      snapshot: filtered,
      serverTime: new Date().toISOString(),
      stale: isStale(filtered.generatedAt),
    };
    return Response.json(envelope, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/sources/:id', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const id = c.req.param('id');
    const source = snapshot.sources.find((item) => item.id === id);
    if (!source) return notFound(`未知来源：${id}`);

    const [history, daily, platformDaily] = await Promise.all([
      getSourceHistory(c.env.DB, id, 42),
      getSourceDaily(c.env.DB, id, 180),
      getSourcePlatformDaily(c.env.DB, id, 180),
    ]);

    return Response.json(
      { source, history, daily, platformDaily, generatedAt: snapshot.generatedAt },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.get('/history', async (c) => {
    const days = clampInt(c.req.query('days'), 14, 1, 90);
    const runs = await getRuns(c.env.DB, days * 6);
    return Response.json(runs, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/events', async (c) => {
    const limit = clampInt(c.req.query('limit'), 50, 1, 200);
    const events = await getEvents(c.env.DB, limit);
    return Response.json(events, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/candidates', async (c) => {
    const state = c.req.query('state');
    if (state && !['new', 'qualified', 'rejected', 'promoted'].includes(state)) {
      return Response.json({ error: 'bad_state', message: `未知候选状态：${state}` }, { status: 400 });
    }
    const limit = clampInt(c.req.query('limit'), 100, 1, 500);
    const candidates = await getCandidates(c.env.DB, { state, limit });
    return Response.json(candidates, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/export', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const items = snapshot.sources.map(toExportItem);
    const format = (c.req.query('format') ?? 'json').toLowerCase();
    if (format === 'csv') {
      return new Response(toCsv(items), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="lx-source-watch.csv"',
          'cache-control': CACHE_PRIVATE,
        },
      });
    }
    return Response.json(items, {
      headers: {
        'content-disposition': 'attachment; filename="lx-source-watch.json"',
        'cache-control': CACHE_PRIVATE,
      },
    });
  });

  api.get('/health', async (c) => {
    const [snapshot, lastRun, candidates] = await Promise.all([
      readSnapshot(c.env),
      getLastRun(c.env.DB),
      countCandidates(c.env.DB),
    ]);
    const stale = lastRun ? isStale(lastRun.finishedAt) : true;
    return Response.json(
      {
        ok: Boolean(lastRun) && !stale,
        lastRun,
        stale,
        sources: snapshot?.sources.length ?? 0,
        candidates,
        serverTime: new Date().toISOString(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });

  return api;
}
