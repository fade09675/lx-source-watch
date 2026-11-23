import { Hono } from 'hono';
import type { Env } from './env';
import { decryptSecret, encryptSecret } from './proxyCrypto';
import { isKernelProtocol, parseProxyText, proxyKey, type ParseResult, type ParsedProxy } from './proxyImport';

interface ProxyRow {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  config_enc: string;
  kernel_only: number;
  engine: string;
  enabled: number;
  sort_order: number;
  subscription_id: string | null;
  last_ok_at: string | null;
  last_latency_ms: number | null;
  egress_ip: string | null;
  last_error: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  user_agent: string;
  enabled: number;
  last_fetch_at: string | null;
  last_status: string;
  created_at: string;
  updated_at: string;
}

const MAX_TEXT_BYTES = 512 * 1024;

function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function portOf(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
}

function publicRow(row: ProxyRow) {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username,
    kernelOnly: row.kernel_only === 1,
    engine: row.engine,
    enabled: row.enabled === 1,
    subscriptionId: row.subscription_id ?? null,
    hasPassword: Boolean(row.password_enc),
    hasConfig: Boolean(row.config_enc),
    lastOkAt: row.last_ok_at,
    lastLatencyMs: row.last_latency_ms,
    egressIp: row.egress_ip,
    lastError: row.last_error,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listRows(env: Env): Promise<ProxyRow[]> {
  const result = await env.DB.prepare('SELECT * FROM proxies ORDER BY sort_order, created_at').all<ProxyRow>();
  return result.results ?? [];
}

async function insertProxy(env: Env, node: ParsedProxy, now: string, subscriptionId: string | null = null): Promise<void> {
  const kernelOnly = isKernelProtocol(node.protocol);
  const passwordEnc = node.password ? await encryptSecret(env, node.password) : '';
  const configEnc = node.config ? await encryptSecret(env, node.config) : '';
  await env.DB.prepare(
    `INSERT INTO proxies
      (id, name, protocol, host, port, username, password_enc, config_enc, kernel_only, engine, enabled, sort_order, subscription_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      node.name.slice(0, 80),
      node.protocol,
      node.host,
      node.port,
      node.username,
      passwordEnc,
      configEnc,
      kernelOnly ? 1 : 0,
      kernelOnly ? 'mihomo' : '',
      subscriptionId,
      now,
      now,
    )
    .run();
}

async function updateProxySecrets(
  env: Env,
  id: string,
  node: ParsedProxy,
  now: string,
  subscriptionId: string | null = null,
): Promise<void> {
  const kernelOnly = isKernelProtocol(node.protocol);
  const passwordEnc = node.password ? await encryptSecret(env, node.password) : '';
  const configEnc = node.config ? await encryptSecret(env, node.config) : '';
  await env.DB.prepare(
    `UPDATE proxies SET name = ?, protocol = ?, host = ?, port = ?, username = ?,
      password_enc = COALESCE(NULLIF(?, ''), password_enc),
      config_enc = COALESCE(NULLIF(?, ''), config_enc),
      kernel_only = ?, engine = ?, subscription_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      node.name.slice(0, 80),
      node.protocol,
      node.host,
      node.port,
      node.username,
      passwordEnc,
      configEnc,
      kernelOnly ? 1 : 0,
      kernelOnly ? 'mihomo' : '',
      subscriptionId,
      now,
      id,
    )
    .run();
}

interface ImportSummary {
  added: number;
  updated: number;
  total: number;
  kernelOnly: number;
  warnings: string[];
}

async function applyParsedNodes(env: Env, parsed: ParseResult, subscriptionId: string | null = null): Promise<ImportSummary> {
  const existing = await listRows(env);
  const byKey = new Map(existing.map((row) => [proxyKey({ protocol: row.protocol, host: row.host, port: row.port, username: row.username }), row]));
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  for (const node of parsed.nodes) {
    const row = byKey.get(proxyKey(node));
    if (row) {
      await updateProxySecrets(env, row.id, node, now, subscriptionId);
      updated += 1;
    } else {
      await insertProxy(env, node, now, subscriptionId);
      added += 1;
    }
  }
  return {
    added,
    updated,
    total: parsed.nodes.length,
    kernelOnly: parsed.nodes.filter((node) => node.kernelOnly).length,
    warnings: parsed.warnings.slice(0, 5),
  };
}

type SubscriptionItem = SubscriptionRow & { nodeCount: number };

async function listSubscriptions(env: Env): Promise<SubscriptionItem[]> {
  const result = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM proxies p WHERE p.subscription_id = s.id) AS node_count
     FROM proxy_subscriptions s ORDER BY s.created_at`,
  ).all<SubscriptionRow & { node_count: number }>();
  return (result.results ?? []).map((row) => ({ ...row, nodeCount: row.node_count }));
}

function publicSubscription(row: SubscriptionItem) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    userAgent: row.user_agent,
    enabled: row.enabled === 1,
    lastFetchAt: row.last_fetch_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodeCount: row.nodeCount,
  };
}

async function fetchSubscription(url: URL, userAgent: string): Promise<{ parsed: ParseResult; bytes: number }> {
  const response = await fetch(url.toString(), {
    headers: {
      'user-agent': userAgent || 'lx-source-watch/0.1 (+https://github.com/fade09675/lx-source-watch)',
      accept: 'text/plain,text/yaml,application/yaml,application/json,*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`订阅返回 HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_FETCH_BYTES) throw new Error('订阅内容超过 1MB');
  const text = new TextDecoder().decode(buffer);
  if (!text.trim()) throw new Error('订阅内容为空');
  const parsed = parseProxyText(text);
  if (!parsed.nodes.length) throw new Error(parsed.warnings[0] ?? '没有识别到节点');
  return { parsed, bytes: buffer.byteLength };
}

async function touchSubscription(env: Env, id: string, status: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE proxy_subscriptions SET last_fetch_at = ?, last_status = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(now, status.slice(0, 300), now, id)
    .run();
}

async function refreshSubscription(env: Env, row: SubscriptionRow): Promise<ImportSummary> {
  try {
    const url = assertFetchable(row.url);
    const { parsed } = await fetchSubscription(url, row.user_agent);
    const summary = await applyParsedNodes(env, parsed, row.id);
    await touchSubscription(env, row.id, `成功：新增 ${summary.added}，更新 ${summary.updated}`);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : '拉取失败';
    await touchSubscription(env, row.id, `失败：${message}`);
    throw error;
  }
}

const MAX_FETCH_BYTES = 1024 * 1024;
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/i;

function assertFetchable(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('订阅地址不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('订阅地址必须是 http/https');
  if (url.username || url.password) throw new Error('订阅地址不能带账号密码');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问内网地址');
  }
  return url;
}

function authRunner(env: Env, header: string | undefined): boolean {
  const expected = env.RUNNER_TOKEN ?? '';
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return Boolean(match) && match![1] === expected;
}

export function createAdminProxyRoutes(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.get('/', async (c) => {
    const [rows, subscriptions] = await Promise.all([listRows(c.env), listSubscriptions(c.env)]);
    const names = new Map(subscriptions.map((item) => [item.id, item.name]));
    return c.json({
      items: rows.map((row) => ({
        ...publicRow(row),
        subscriptionName: row.subscription_id ? (names.get(row.subscription_id) ?? null) : null,
      })),
    });
  });

  api.post('/', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const protocol = clean(body.protocol, 20).toLowerCase();
    const node: ParsedProxy = {
      name: clean(body.name, 80) || `${clean(body.host, 100)}:${portOf(body.port)}`,
      protocol,
      host: clean(body.host, 200),
      port: portOf(body.port),
      username: clean(body.username, 200),
      password: String(body.password ?? ''),
      kernelOnly: isKernelProtocol(protocol),
      config: typeof body.config === 'string' ? body.config : undefined,
    };
    if (!node.host || !node.port) return c.json({ error: 'bad_target', message: '主机或端口不合法' }, 400);
    await insertProxy(c.env, node, new Date().toISOString());
    return c.json({ ok: true });
  });

  api.post('/import', async (c) => {
    const body = await c.req.json<{ text?: string }>().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) return c.json({ error: 'empty_text', message: '请粘贴订阅内容' }, 400);
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
      return c.json({ error: 'too_large', message: '订阅内容超过 512KB' }, 413);
    }
    const parsed = parseProxyText(text);
    if (!parsed.nodes.length) {
      return c.json({ error: 'no_nodes', message: parsed.warnings[0] ?? '没有识别到节点' }, 400);
    }
    const result = await applyParsedNodes(c.env, parsed);
    return c.json({ ok: true, ...result });
  });

  /** 从订阅地址拉取：创建/复用订阅源，再把节点挂在订阅下。 */
  api.post('/import-url', async (c) => {
    const body = await c.req.json<{ url?: string; name?: string; userAgent?: string }>().catch(() => null);
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!raw) return c.json({ error: 'empty_url', message: '请填写订阅地址' }, 400);
    let url: URL;
    try {
      url = assertFetchable(raw);
    } catch (error) {
      return c.json({ error: 'bad_url', message: error instanceof Error ? error.message : '订阅地址不合法' }, 400);
    }

    let fetched: { parsed: ParseResult; bytes: number };
    try {
      fetched = await fetchSubscription(url, clean(body?.userAgent, 200));
    } catch (error) {
      return c.json({ error: 'fetch_failed', message: error instanceof Error ? error.message : '拉取订阅失败' }, 502);
    }

    const subscriptions = await listSubscriptions(c.env);
    const existing = subscriptions.find((item) => item.url === url.toString());
    const now = new Date().toISOString();
    const name = clean(body?.name, 80) || existing?.name || url.hostname;
    let subscriptionId: string;
    if (existing) {
      subscriptionId = existing.id;
      await c.env.DB.prepare('UPDATE proxy_subscriptions SET name = ?, user_agent = ?, updated_at = ? WHERE id = ?')
        .bind(name, clean(body?.userAgent, 200), now, existing.id)
        .run();
    } else {
      subscriptionId = crypto.randomUUID();
      await c.env.DB.prepare(
        'INSERT INTO proxy_subscriptions (id, name, url, user_agent, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      )
        .bind(subscriptionId, name, url.toString(), clean(body?.userAgent, 200), now, now)
        .run();
    }

    const result = await applyParsedNodes(c.env, fetched.parsed, subscriptionId);
    await touchSubscription(c.env, subscriptionId, `成功：新增 ${result.added}，更新 ${result.updated}`);
    return c.json({
      ok: true,
      subscription: { id: subscriptionId, name, url: url.toString() },
      fetchedBytes: fetched.bytes,
      ...result,
    });
  });

  api.get('/subscriptions', async (c) => {
    const items = await listSubscriptions(c.env);
    return c.json({ items: items.map(publicSubscription) });
  });

  api.post('/subscriptions', async (c) => {
    const body = await c.req.json<{ name?: string; url?: string; userAgent?: string }>().catch(() => null);
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!raw) return c.json({ error: 'empty_url', message: '请填写订阅地址' }, 400);
    let url: URL;
    try {
      url = assertFetchable(raw);
    } catch (error) {
      return c.json({ error: 'bad_url', message: error instanceof Error ? error.message : '订阅地址不合法' }, 400);
    }
    const existing = (await listSubscriptions(c.env)).find((item) => item.url === url.toString());
    if (existing) {
      return c.json({ ok: true, subscription: publicSubscription(existing), duplicate: true });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const name = clean(body?.name, 80) || url.hostname;
    await c.env.DB.prepare(
      'INSERT INTO proxy_subscriptions (id, name, url, user_agent, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    )
      .bind(id, name, url.toString(), clean(body?.userAgent, 200), now, now)
      .run();
    return c.json({
      ok: true,
      created: true,
      subscription: {
        id,
        name,
        url: url.toString(),
        userAgent: clean(body?.userAgent, 200),
        enabled: true,
        lastFetchAt: null,
        lastStatus: '未拉取',
        createdAt: now,
        updatedAt: now,
        nodeCount: 0,
      },
    });
  });

  api.patch('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ name?: string; url?: string; enabled?: boolean; userAgent?: string }>().catch(() => null);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const row = await c.env.DB.prepare('SELECT * FROM proxy_subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (typeof body.name === 'string' && body.name.trim()) {
      sets.push('name = ?');
      values.push(clean(body.name, 80));
    }
    if (typeof body.url === 'string' && body.url.trim()) {
      try {
        values.push(assertFetchable(body.url).toString());
        sets.push('url = ?');
      } catch (error) {
        return c.json({ error: 'bad_url', message: error instanceof Error ? error.message : '订阅地址不合法' }, 400);
      }
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (typeof body.userAgent === 'string') {
      sets.push('user_agent = ?');
      values.push(clean(body.userAgent, 200));
    }
    if (!sets.length) return c.json({ ok: true, unchanged: true });
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    await c.env.DB.prepare(`UPDATE proxy_subscriptions SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
    return c.json({ ok: true });
  });

  api.delete('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const mode = c.req.query('nodes') ?? 'delete_all';
    const row = await c.env.DB.prepare('SELECT * FROM proxy_subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    let deleted = 0;
    if (mode === 'delete_all') {
      const result = await c.env.DB.prepare('DELETE FROM proxies WHERE subscription_id = ?').bind(id).run();
      deleted = result.meta.changes ?? 0;
    } else {
      await c.env.DB.prepare('UPDATE proxies SET subscription_id = NULL WHERE subscription_id = ?').bind(id).run();
    }
    await c.env.DB.prepare('DELETE FROM proxy_subscriptions WHERE id = ?').bind(id).run();
    return c.json({ ok: true, deleted });
  });

  api.post('/subscriptions/:id/refresh', async (c) => {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare('SELECT * FROM proxy_subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    try {
      const summary = await refreshSubscription(c.env, row);
      return c.json({ ok: true, ...summary });
    } catch (error) {
      return c.json({ error: 'fetch_failed', message: error instanceof Error ? error.message : '刷新失败' }, 502);
    }
  });

  api.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const row = await c.env.DB.prepare('SELECT * FROM proxies WHERE id = ?').bind(id).first<ProxyRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (typeof body.name === 'string') {
      sets.push('name = ?');
      values.push(clean(body.name, 80) || row.name);
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (body.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      values.push(Number(body.sortOrder) || 0);
    }
    if (typeof body.password === 'string' && body.password) {
      sets.push('password_enc = ?');
      values.push(await encryptSecret(c.env, body.password));
    }
    if (typeof body.config === 'string' && body.config) {
      sets.push('config_enc = ?');
      values.push(await encryptSecret(c.env, body.config));
    }
    if (!sets.length) return c.json({ ok: true, unchanged: true });
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    await c.env.DB.prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
    return c.json({ ok: true });
  });

  api.delete('/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM proxies WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  api.post('/:id/check', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const ok = body.ok === true;
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE proxies SET last_ok_at = ?, last_latency_ms = ?, egress_ip = ?, last_error = ?, checked_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        ok ? now : null,
        Number(body.latencyMs) || null,
        clean(body.egressIp, 120) || null,
        ok ? null : clean(body.error, 500) || '不可用',
        now,
        now,
        id,
      )
      .run();
    return c.json({ ok: true });
  });

  return api;
}

/** 供 Actions 的 cn job 拉取启用节点（Bearer RUNNER_TOKEN，不经登录会话）。 */
export function createRunnerProxyRoutes(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.use('*', async (c, next) => {
    if (!authRunner(c.env, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized', message: 'runner token 无效' }, 401);
    }
    await next();
  });

  api.get('/', async (c) => {
    const rows = await listRows(c.env);
    const items = [];
    for (const row of rows) {
      if (row.enabled !== 1) continue;
      items.push({
        id: row.id,
        name: row.name,
        protocol: row.protocol,
        host: row.host,
        port: row.port,
        username: row.username,
        password: await decryptSecret(c.env, row.password_enc),
        config: await decryptSecret(c.env, row.config_enc),
        kernelOnly: row.kernel_only === 1,
        engine: row.engine,
        lastOkAt: row.last_ok_at,
      });
    }
    return c.json({ items });
  });

  api.post('/:id/check', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const ok = body.ok === true;
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE proxies SET last_ok_at = ?, last_latency_ms = ?, egress_ip = ?, last_error = ?, checked_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(ok ? now : null, Number(body.latencyMs) || null, clean(body.egressIp, 120) || null, ok ? null : clean(body.error, 500) || '不可用', now, now, id)
      .run();
    return c.json({ ok: true });
  });

  return api;
}
