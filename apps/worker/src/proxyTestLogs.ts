export interface ProxyTestRunView {
  runId: string;
  taskId: string | null;
  trigger: string;
  startedAt: string | null;
  finishedAt: string;
  total: number;
  ok: number;
  kernelOk: number;
  skippedUdp: number;
  durationMs: number;
}

export interface ProxyTestResultView {
  proxyId: string;
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  subscriptionId: string | null;
  kernelOnly: boolean;
  ok: boolean;
  latencyMs: number;
  country: string;
  asn: string;
  error: string | null;
  testedAt: string;
}

interface ProxyTestRunRow {
  run_id: string;
  task_id: string | null;
  trigger: string;
  started_at: string | null;
  finished_at: string;
  total: number;
  ok: number;
  kernel_ok: number;
  skipped_udp: number;
  duration_ms: number;
}

interface ProxyTestResultRow {
  proxy_id: string;
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  subscription_id: string | null;
  kernel_only: number;
  ok: number;
  latency_ms: number;
  country: string;
  asn: string;
  error: string | null;
  tested_at: string;
}

function toRun(row: ProxyTestRunRow): ProxyTestRunView {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    total: row.total,
    ok: row.ok,
    kernelOk: row.kernel_ok,
    skippedUdp: row.skipped_udp,
    durationMs: row.duration_ms,
  };
}

function toResult(row: ProxyTestResultRow): ProxyTestResultView {
  return {
    proxyId: row.proxy_id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    subscriptionId: row.subscription_id,
    kernelOnly: row.kernel_only === 1,
    ok: row.ok === 1,
    latencyMs: row.latency_ms,
    country: row.country,
    asn: row.asn,
    error: row.error,
    testedAt: row.tested_at,
  };
}

export async function listProxyTestRuns(
  db: D1Database,
  options: { days?: number; limit?: number; now?: number } = {},
): Promise<ProxyTestRunView[]> {
  const days = Math.min(90, Math.max(1, options.days ?? 7));
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const now = options.now ?? Date.now();
  const cutoff = new Date(now - days * 24 * 3600 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT run_id, task_id, trigger, started_at, finished_at, total, ok,
              kernel_ok, skipped_udp, duration_ms
         FROM proxy_test_runs
        WHERE finished_at >= ?
        ORDER BY finished_at DESC
        LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<ProxyTestRunRow>();
  return (result.results ?? []).map(toRun);
}

export async function getProxyTestRun(
  db: D1Database,
  runId: string,
): Promise<{ run: ProxyTestRunView; results: ProxyTestResultView[] } | null> {
  const run = await db
    .prepare(
      `SELECT run_id, task_id, trigger, started_at, finished_at, total, ok,
              kernel_ok, skipped_udp, duration_ms
         FROM proxy_test_runs
        WHERE run_id = ?`,
    )
    .bind(runId)
    .first<ProxyTestRunRow>();
  if (!run) return null;

  const rows = await db
    .prepare(
      `SELECT proxy_id, name, protocol, host, port, subscription_id, kernel_only,
              ok, latency_ms, country, asn, error, tested_at
         FROM proxy_test_results
        WHERE run_id = ?
        ORDER BY ok ASC, latency_ms DESC, name ASC
        LIMIT 500`,
    )
    .bind(runId)
    .all<ProxyTestResultRow>();

  return { run: toRun(run), results: (rows.results ?? []).map(toResult) };
}
