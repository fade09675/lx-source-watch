import { Hono } from 'hono';
import type { Env } from './env';
import { decryptSecret, encryptSecret } from './proxyCrypto';
import { isKernelProtocol, parseProxyText, proxyKey, type ParseResult, type ParsedProxy } from './proxyImport';
import { completeTaskForRun, dispatchNext, refreshTaskState } from './tasks';

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
  last_country: string;
  last_asn: string;
  success_count: number;
  fail_count: number;
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
  kind: string;
  headers: string;
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
    country: row.last_country,
    asn: row.last_asn,
    successCount: row.success_count,
    failCount: row.fail_count,
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

export async function applyParsedNodes(env: Env, parsed: ParseResult, subscriptionId: string | null = null): Promise<ImportSummary> {
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
    headers: row.headers,
    kind: row.kind,
    enabled: row.enabled === 1,
    lastFetchAt: row.last_fetch_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodeCount: row.nodeCount,
  };
}

const DEFAULT_FETCH_UA = 'lx-source-watch/0.1 (+https://github.com/fade09675/lx-source-watch)';

type SubscriptionFetchFailure = Error & { status?: number; needsRunner?: boolean };

/** Worker 拉订阅被 401/403 拦截：前端可改派 Actions 拉取。 */
export function isNeedsRunnerError(error: unknown): error is SubscriptionFetchFailure {
  return error instanceof Error && (error as SubscriptionFetchFailure).needsRunner === true;
}

function subscriptionFetchFailure(message: string, status: number): SubscriptionFetchFailure {
  return Object.assign(new Error(message), { status, needsRunner: status === 401 || status === 403 });
}

/** 订阅自定义请求头：每行 `Key: value`，最多 20 条，忽略 Host/Content-Length 等危险头。 */
export function parseCustomHeaders(raw: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!key || !value || blocked.has(key)) continue;
    headers[key] = value.slice(0, 500);
    if (Object.keys(headers).length >= 20) break;
  }
  return headers;
}

export async function fetchSubscription(
  url: URL,
  userAgent: string,
  customHeaders?: string | null,
): Promise<{ parsed: ParseResult; bytes: number }> {
  const response = await fetch(url.toString(), {
    headers: {
      accept: 'text/plain,text/yaml,application/yaml,application/json,*/*',
      ...parseCustomHeaders(customHeaders),
      'user-agent': userAgent || DEFAULT_FETCH_UA,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw subscriptionFetchFailure(
        `订阅返回 HTTP ${response.status}：机场可能限制海外/机房 IP，或要求 Clash/Shadowrocket 等特定 UA。可换一个 UA 重试；仍不行就用「用 Actions 拉取」让 GitHub Actions 拉取，或把内容粘贴/上传导入。`,
        response.status,
      );
    }
    if (response.status === 404) {
      throw new Error('订阅返回 HTTP 404：链接可能已失效，请在浏览器里确认能否打开');
    }
    if (response.status === 429) {
      throw new Error('订阅返回 HTTP 429：请求太频繁，请稍后再试');
    }
    throw new Error(`订阅返回 HTTP ${response.status}`);
  }
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
  if (row.kind === 'file' || !row.url.trim()) {
    const message = '文件订阅不能在线刷新，请重新上传节点文件';
    await touchSubscription(env, row.id, `失败：${message}`);
    throw new Error(message);
  }
  try {
    const url = assertFetchable(row.url);
    const { parsed } = await fetchSubscription(url, row.user_agent, row.headers);
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

export function authRunner(env: Env, header: string | undefined): boolean {
  const expected = env.RUNNER_TOKEN ?? '';
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return Boolean(match) && match![1] === expected;
}

interface BundleSubscriptionInput {
  name?: string;
  url?: string;
  kind?: string;
  userAgent?: string;
  headers?: string;
  enabled?: boolean;
  lastFetchAt?: string | null;
  lastStatus?: string;
}

interface BundleNodeInput {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  config?: string;
  kernelOnly?: boolean;
  enabled?: boolean;
  subscriptionName?: string | null;
  lastOkAt?: string | null;
  lastCheckedAt?: string | null;
  lastLatencyMs?: number | null;
  lastError?: string | null;
  lastEgressIp?: string | null;
}

/** IPTV 导出里的时间形如 2026-11-13 04:10:35（东八区），统一转 ISO。 */
function bundleTime(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw.replace(' ', 'T')}+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function upsertBundleSubscription(env: Env, input: BundleSubscriptionInput, now: string): Promise<string | null> {
  const name = clean(input.name, 80);
  if (!name) return null;
  const kind = clean(input.kind, 20) === 'file' ? 'file' : 'url';
  const url = kind === 'file' ? '' : clean(input.url, 2000);
  const userAgent = clean(input.userAgent, 200);
  const headers = clean(input.headers, 2000);
  const enabled = input.enabled === false ? 0 : 1;
  const lastStatus = clean(input.lastStatus, 300);
  const lastFetchAt = bundleTime(input.lastFetchAt);

  const existing = await env.DB.prepare('SELECT id FROM proxy_subscriptions WHERE name = ?').bind(name).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE proxy_subscriptions SET url = ?, user_agent = ?, kind = ?, headers = ?, enabled = ?,
        last_fetch_at = COALESCE(?, last_fetch_at), last_status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(url, userAgent, kind, headers, enabled, lastFetchAt, lastStatus, now, existing.id)
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO proxy_subscriptions
      (id, name, url, user_agent, kind, headers, enabled, last_fetch_at, last_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, name, url, userAgent, kind, headers, enabled, lastFetchAt, lastStatus, now, now)
    .run();
  return id;
}

interface BundleNode {
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  config: string;
  kernelOnly: boolean;
  enabled: number;
  subscriptionId: string | null;
  lastOkAt: string | null;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastEgressIp: string | null;
}

const PLAIN_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']);

async function insertBundleProxy(env: Env, node: BundleNode, now: string): Promise<string> {
  const passwordEnc = node.password ? await encryptSecret(env, node.password) : '';
  const configEnc = node.config ? await encryptSecret(env, node.config) : '';
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO proxies
      (id, name, protocol, host, port, username, password_enc, config_enc, kernel_only, engine, enabled, sort_order,
       subscription_id, last_ok_at, last_latency_ms, egress_ip, last_error, checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      node.name.slice(0, 80),
      node.protocol,
      node.host,
      node.port,
      node.username,
      passwordEnc,
      configEnc,
      node.kernelOnly ? 1 : 0,
      node.kernelOnly ? 'mihomo' : '',
      node.enabled,
      node.subscriptionId,
      node.lastOkAt,
      node.lastLatencyMs,
      node.lastEgressIp,
      node.lastError,
      node.lastCheckedAt,
      now,
      now,
    )
    .run();
  return id;
}

async function updateBundleProxy(env: Env, id: string, node: BundleNode, now: string): Promise<void> {
  const passwordEnc = node.password ? await encryptSecret(env, node.password) : '';
  const configEnc = node.config ? await encryptSecret(env, node.config) : '';
  await env.DB.prepare(
    `UPDATE proxies SET name = ?, protocol = ?, host = ?, port = ?, username = ?,
      password_enc = COALESCE(NULLIF(?, ''), password_enc),
      config_enc = COALESCE(NULLIF(?, ''), config_enc),
      kernel_only = ?, engine = ?, enabled = ?, subscription_id = ?,
      last_ok_at = COALESCE(?, last_ok_at), last_latency_ms = COALESCE(?, last_latency_ms),
      egress_ip = COALESCE(?, egress_ip), last_error = ?, checked_at = COALESCE(?, checked_at),
      updated_at = ? WHERE id = ?`,
  )
    .bind(
      node.name.slice(0, 80),
      node.protocol,
      node.host,
      node.port,
      node.username,
      passwordEnc,
      configEnc,
      node.kernelOnly ? 1 : 0,
      node.kernelOnly ? 'mihomo' : '',
      node.enabled,
      node.subscriptionId,
      node.lastOkAt,
      node.lastLatencyMs,
      node.lastEgressIp,
      node.lastError,
      node.lastCheckedAt,
      now,
      id,
    )
    .run();
}

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

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

  /** 一次性导入导出包（订阅 + 节点快照），保留订阅归属、启停、密码与内核配置。 */
  api.post('/import-bundle', async (c) => {
    const raw = await c.req.text();
    if (!raw.trim()) return c.json({ error: 'empty_body', message: '请求体为空' }, 400);
    if (new TextEncoder().encode(raw).length > MAX_BUNDLE_BYTES) {
      return c.json({ error: 'too_large', message: '导入包超过 4MB' }, 413);
    }
    let body: { subscriptions?: unknown; nodes?: unknown } | null = null;
    try {
      body = JSON.parse(raw) as { subscriptions?: unknown; nodes?: unknown };
    } catch {
      return c.json({ error: 'bad_json', message: '导入包不是合法 JSON' }, 400);
    }
    const subscriptionsIn = Array.isArray(body?.subscriptions) ? (body.subscriptions as BundleSubscriptionInput[]) : [];
    const nodesIn = Array.isArray(body?.nodes) ? (body.nodes as BundleNodeInput[]) : [];
    if (!nodesIn.length) return c.json({ error: 'no_nodes', message: '导入包里没有节点' }, 400);
    if (nodesIn.length > 5000) return c.json({ error: 'too_many', message: '单次最多导入 5000 个节点' }, 400);

    const now = new Date().toISOString();
    const subIds = new Map<string, string>();
    for (const existing of await listSubscriptions(c.env)) subIds.set(existing.name, existing.id);
    for (const input of subscriptionsIn.slice(0, 100)) {
      const id = await upsertBundleSubscription(c.env, input, now);
      if (id) subIds.set(clean(input.name, 80), id);
    }

    const existing = await listRows(c.env);
    const byKey = new Map(existing.map((row) => [proxyKey({ protocol: row.protocol, host: row.host, port: row.port, username: row.username }), row]));

    let added = 0;
    let updated = 0;
    let disabled = 0;
    let kernelOnly = 0;
    const warnings: string[] = [];
    const perSubscription = new Map<string, number>();

    for (const input of nodesIn) {
      const protocol = clean(input.protocol, 20).toLowerCase();
      const host = clean(input.host, 200);
      const port = portOf(input.port);
      if (!protocol || !host || !port) {
        if (warnings.length < 10) warnings.push(`跳过无效节点：${clean(input.name, 40) || host || '(无名)'}`);
        continue;
      }
      const subName = clean(input.subscriptionName, 80);
      let subscriptionId: string | null = null;
      if (subName) {
        subscriptionId = subIds.get(subName) ?? null;
        if (!subscriptionId && warnings.length < 10) warnings.push(`订阅不存在：${subName}`);
      }
      const latency = Number(input.lastLatencyMs);
      const node: BundleNode = {
        name: clean(input.name, 80) || `${host}:${port}`,
        protocol,
        host,
        port,
        username: clean(input.username, 200),
        password: String(input.password ?? ''),
        config: String(input.config ?? ''),
        kernelOnly: input.kernelOnly === true || !PLAIN_PROTOCOLS.has(protocol),
        enabled: input.enabled === false ? 0 : 1,
        subscriptionId,
        lastOkAt: bundleTime(input.lastOkAt),
        lastCheckedAt: bundleTime(input.lastCheckedAt),
        lastLatencyMs: Number.isFinite(latency) && latency > 0 ? Math.round(latency) : null,
        lastError: clean(input.lastError, 500) || null,
        lastEgressIp: clean(input.lastEgressIp, 120) || null,
      };
      if (node.enabled === 0) disabled += 1;
      if (node.kernelOnly) kernelOnly += 1;
      if (subName) perSubscription.set(subName, (perSubscription.get(subName) ?? 0) + 1);

      const key = proxyKey(node);
      const row = byKey.get(key);
      if (row) {
        await updateBundleProxy(c.env, row.id, node, now);
        updated += 1;
      } else {
        const id = await insertBundleProxy(c.env, node, now);
        byKey.set(key, { id } as ProxyRow);
        added += 1;
      }
    }

    return c.json({
      ok: true,
      subscriptions: subIds.size,
      nodes: { added, updated, total: nodesIn.length, kernelOnly, disabled },
      perSubscription: Object.fromEntries(perSubscription),
      warnings,
    });
  });

  /** 从订阅地址拉取：创建/复用订阅源，再把节点挂在订阅下。 */
  api.post('/import-url', async (c) => {
    const body = await c.req
      .json<{ url?: string; name?: string; userAgent?: string; headers?: string }>()
      .catch(() => null);
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
      fetched = await fetchSubscription(url, clean(body?.userAgent, 200), clean(body?.headers, 2000));
    } catch (error) {
      if (isNeedsRunnerError(error)) {
        return c.json({ error: 'fetch_forbidden', message: error.message, needsRunner: true }, 502);
      }
      return c.json({ error: 'fetch_failed', message: error instanceof Error ? error.message : '拉取订阅失败' }, 502);
    }

    const subscriptions = await listSubscriptions(c.env);
    const existing = subscriptions.find((item) => item.url === url.toString());
    const now = new Date().toISOString();
    const name = clean(body?.name, 80) || existing?.name || url.hostname;
    let subscriptionId: string;
    if (existing) {
      subscriptionId = existing.id;
      await c.env.DB.prepare(
        'UPDATE proxy_subscriptions SET name = ?, user_agent = ?, headers = ?, updated_at = ? WHERE id = ?',
      )
        .bind(name, clean(body?.userAgent, 200), clean(body?.headers, 2000), now, existing.id)
        .run();
    } else {
      subscriptionId = crypto.randomUUID();
      await c.env.DB.prepare(
        'INSERT INTO proxy_subscriptions (id, name, url, user_agent, headers, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      )
        .bind(
          subscriptionId,
          name,
          url.toString(),
          clean(body?.userAgent, 200),
          clean(body?.headers, 2000),
          now,
          now,
        )
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
    const body = await c.req
      .json<{ name?: string; url?: string; userAgent?: string; headers?: string }>()
      .catch(() => null);
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
      'INSERT INTO proxy_subscriptions (id, name, url, user_agent, headers, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    )
      .bind(
        id,
        name,
        url.toString(),
        clean(body?.userAgent, 200),
        clean(body?.headers, 2000),
        now,
        now,
      )
      .run();
    return c.json({
      ok: true,
      created: true,
      subscription: {
        id,
        name,
        url: url.toString(),
        userAgent: clean(body?.userAgent, 200),
        headers: clean(body?.headers, 2000),
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
    if (row.kind === 'file' || !row.url.trim()) {
      return c.json({ error: 'file_subscription', message: '文件订阅不能在线刷新，请重新上传节点文件' }, 400);
    }
    try {
      const summary = await refreshSubscription(c.env, row);
      return c.json({ ok: true, ...summary });
    } catch (error) {
      if (isNeedsRunnerError(error)) {
        return c.json({ error: 'fetch_forbidden', message: error.message, needsRunner: true }, 502);
      }
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
      `UPDATE proxies SET last_ok_at = ?, last_latency_ms = ?, egress_ip = ?, last_country = ?, last_asn = ?,
         success_count = success_count + ?, fail_count = fail_count + ?,
         last_error = ?, checked_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        ok ? now : null,
        Number(body.latencyMs) || null,
        clean(body.egressIp, 120) || null,
        clean(body.country, 80),
        clean(body.asn, 80),
        ok ? 1 : 0,
        ok ? 0 : 1,
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
        subscriptionId: row.subscription_id ?? null,
        lastOkAt: row.last_ok_at,
        lastLatencyMs: row.last_latency_ms,
        successCount: row.success_count,
        failCount: row.fail_count,
        country: row.last_country,
        asn: row.last_asn,
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
      `UPDATE proxies SET last_ok_at = ?, last_latency_ms = ?, egress_ip = ?, last_country = ?, last_asn = ?,
         success_count = success_count + ?, fail_count = fail_count + ?,
         last_error = ?, checked_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        ok ? now : null,
        Number(body.latencyMs) || null,
        clean(body.egressIp, 120) || null,
        clean(body.country, 80),
        clean(body.asn, 80),
        ok ? 1 : 0,
        ok ? 0 : 1,
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
