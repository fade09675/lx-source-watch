import { Hono } from 'hono';
import type { Env } from './env';
import { decryptSecret, encryptSecret } from './proxyCrypto';
import { isKernelProtocol, parseProxyText, proxyKey, type ParsedProxy } from './proxyImport';

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
  last_ok_at: string | null;
  last_latency_ms: number | null;
  egress_ip: string | null;
  last_error: string | null;
  checked_at: string | null;
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

async function insertProxy(env: Env, node: ParsedProxy, now: string): Promise<void> {
  const kernelOnly = isKernelProtocol(node.protocol);
  const passwordEnc = node.password ? await encryptSecret(env, node.password) : '';
  const configEnc = node.config ? await encryptSecret(env, node.config) : '';
  await env.DB.prepare(
    `INSERT INTO proxies
      (id, name, protocol, host, port, username, password_enc, config_enc, kernel_only, engine, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
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
      now,
      now,
    )
    .run();
}

async function updateProxySecrets(env: Env, id: string, node: ParsedProxy, now: string): Promise<void> {
  const kernelOnly = isKernelProtocol(node.protocol);
  const passwordEnc = node.password ? await encryptSecret(env, node.password) : '';
  const configEnc = node.config ? await encryptSecret(env, node.config) : '';
  await env.DB.prepare(
    `UPDATE proxies SET name = ?, protocol = ?, host = ?, port = ?, username = ?,
      password_enc = COALESCE(NULLIF(?, ''), password_enc),
      config_enc = COALESCE(NULLIF(?, ''), config_enc),
      kernel_only = ?, engine = ?, updated_at = ? WHERE id = ?`,
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
      now,
      id,
    )
    .run();
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
    const rows = await listRows(c.env);
    return c.json({ items: rows.map(publicRow) });
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
    const existing = await listRows(c.env);
    const byKey = new Map(existing.map((row) => [proxyKey({ protocol: row.protocol, host: row.host, port: row.port, username: row.username }), row]));
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    for (const node of parsed.nodes) {
      const row = byKey.get(proxyKey(node));
      if (row) {
        await updateProxySecrets(c.env, row.id, node, now);
        updated += 1;
      } else {
        await insertProxy(c.env, node, now);
        added += 1;
      }
    }
    return c.json({
      ok: true,
      added,
      updated,
      total: parsed.nodes.length,
      kernelOnly: parsed.nodes.filter((node) => node.kernelOnly).length,
      warnings: parsed.warnings.slice(0, 5),
    });
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
