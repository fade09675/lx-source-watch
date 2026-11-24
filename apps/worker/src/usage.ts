import type { Env } from './env';

const USAGE_KEY = 'usage:state';
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 7;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_REPO = 'fade09675/lx-source-watch';

export interface DayUsage {
  date: string;
  kvWrites: number;
  d1Writes: number;
  githubMinutes: number;
}

export interface UsageSnapshot {
  collectedAt: string;
  kv: {
    day: string;
    reads: number;
    writes: number;
    lists: number;
    deletes: number;
    storageBytes: number;
    storageDay?: string;
    /** Locally counted puts today; the display uses max(official, local). */
    localWrites?: number;
  };
  d1: { day: string; rowsRead: number; rowsWritten: number };
  github: { month: string; minutes: number; runs: number; private?: boolean };
  history: DayUsage[];
  /** Present when the Cloudflare Analytics query failed; kv/d1 are then stale. */
  cloudflareError?: string | null;
}

interface GithubRun {
  run_duration_ms?: number;
  run_started_at?: string;
  status?: string;
  created_at: string;
  updated_at: string;
}

interface CloudflareUsage {
  kv: UsageSnapshot['kv'];
  d1: UsageSnapshot['d1'];
  kvWritesByDay: Map<string, number>;
  d1WritesByDay: Map<string, number>;
}

const utcDay = (offset = 0): string => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

const monthStart = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

/**
 * A single job never runs for hours; anything longer is queue/cancel noise or
 * `updated_at` touched by log cleanup, and must not inflate the estimate.
 */
const MAX_RUN_MS = 60 * 60_000;

export function aggregateGithubRuns(
  runs: GithubRun[],
  month: string,
): { minutes: number; runs: number; byDay: Map<string, number> } {
  let minutes = 0;
  let count = 0;
  const byDay = new Map<string, number>();
  for (const run of runs) {
    const day = run.created_at.slice(0, 10);
    if (day < month) continue;
    if (run.status === 'queued') {
      count += 1;
      continue;
    }
    const started = Date.parse(run.run_started_at ?? run.created_at);
    const ended = Date.parse(run.updated_at);
    const raw = run.run_duration_ms ?? Math.max(0, ended - started);
    const ms = Number.isFinite(raw) ? Math.min(Math.max(0, raw), MAX_RUN_MS) : 0;
    minutes += ms / 60_000;
    byDay.set(day, (byDay.get(day) ?? 0) + ms / 60_000);
    count += 1;
  }
  return { minutes, runs: count, byDay };
}

/** KV storage is a daily gauge; pick the newest row we have (today's may lag). */
export function pickStorageRow<T extends { dimensions: { date: string } }>(rows: T[]): T | undefined {
  let latest: T | undefined;
  for (const row of rows) {
    if (!latest || row.dimensions.date > latest.dimensions.date) latest = row;
  }
  return latest;
}

function githubHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lx-source-watch-worker',
  };
  if (env.GH_DISPATCH_TOKEN) headers.Authorization = `Bearer ${env.GH_DISPATCH_TOKEN}`;
  return headers;
}

export async function collectGithub(env: Env): Promise<{
  month: string;
  minutes: number;
  runs: number;
  private?: boolean;
  byDay: Map<string, number>;
}> {
  const month = monthStart();
  const byDay = new Map<string, number>();
  const repo = env.GH_REPO ?? DEFAULT_REPO;
  let isPrivate: boolean | undefined;
  try {
    const metaResponse = await fetch(`https://api.github.com/repos/${repo}`, { headers: githubHeaders(env) });
    if (metaResponse.ok) {
      const meta = (await metaResponse.json()) as { private?: boolean };
      if (typeof meta.private === 'boolean') isPrivate = meta.private;
    }
  } catch {
    // Keep visibility unknown; the caller falls back to the previous snapshot.
  }
  if (isPrivate === false) {
    // Public repositories get unmetered standard runners. Counting minutes from
    // run timestamps is unreliable there, so report the month's run count only.
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?per_page=1&created=${encodeURIComponent(`>=${month}`)}`,
        { headers: githubHeaders(env) },
      );
      if (response.ok) {
        const data = (await response.json()) as { total_count?: number };
        return { month, minutes: 0, runs: Number(data.total_count ?? 0), private: false, byDay };
      }
    } catch {
      // Fall through to the empty snapshot.
    }
    return { month, minutes: 0, runs: 0, private: false, byDay };
  }
  let minutes = 0;
  let runs = 0;
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent(`>=${month}`)}`,
      { headers: githubHeaders(env) },
    );
    if (!response.ok) break;
    const data = (await response.json()) as { workflow_runs?: GithubRun[] };
    const pageRuns = data.workflow_runs ?? [];
    const agg = aggregateGithubRuns(pageRuns, month);
    minutes += agg.minutes;
    runs += agg.runs;
    for (const [day, value] of agg.byDay) byDay.set(day, (byDay.get(day) ?? 0) + value);
    if (pageRuns.length < 100) break;
  }
  return { month, minutes: Math.ceil(minutes), runs, private: isPrivate, byDay };
}

async function graphql(token: string, query: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = (await response.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
  if (!response.ok || data.errors?.length) {
    const detail = data.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw new Error(`Cloudflare ${response.status}: ${String(detail).slice(0, 300)}`);
  }
  return data.data ?? {};
}

export async function collectCloudflare(env: Env, days: string[]): Promise<CloudflareUsage | null> {
  const token = env.CF_ANALYTICS_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) return null;
  const since = days[0];
  const today = utcDay();
  const data = await graphql(
    token,
    `query {
      viewer { accounts(filter: {accountTag: "${accountId}"}) {
        kvOperationsAdaptiveGroups(limit: 500, filter: {date_geq: "${since}"}) {
          dimensions { date actionType }
          sum { requests }
        }
        kvStorageAdaptiveGroups(limit: 20, filter: {date_geq: "${since}"}) {
          dimensions { date }
          max { byteCount }
        }
        d1AnalyticsAdaptiveGroups(limit: 500, filter: {date_geq: "${since}"}) {
          dimensions { date databaseId }
          sum { rowsRead rowsWritten }
        }
      } }
    }`,
  );
  const account = ((data.viewer as { accounts?: Array<Record<string, unknown>> } | undefined)?.accounts?.[0] ?? {}) as Record<string, unknown>;
  const ops =
    (account.kvOperationsAdaptiveGroups as Array<{ dimensions: { date: string; actionType: string }; sum: { requests: number } }> | undefined) ?? [];
  const storage =
    (account.kvStorageAdaptiveGroups as Array<{ dimensions: { date: string }; max: { byteCount: number } }> | undefined) ?? [];
  const d1Rows =
    (account.d1AnalyticsAdaptiveGroups as Array<{ dimensions: { date: string; databaseId: string }; sum: { rowsRead: number; rowsWritten: number } }> | undefined) ?? [];

  const kvWritesByDay = new Map<string, number>();
  const kv: UsageSnapshot['kv'] = { day: today, reads: 0, writes: 0, lists: 0, deletes: 0, storageBytes: 0 };
  for (const item of ops) {
    const date = item.dimensions.date;
    const requests = item.sum.requests;
    if (item.dimensions.actionType === 'write') kvWritesByDay.set(date, (kvWritesByDay.get(date) ?? 0) + requests);
    if (date !== today) continue;
    if (item.dimensions.actionType === 'read') kv.reads += requests;
    if (item.dimensions.actionType === 'write') kv.writes += requests;
    if (item.dimensions.actionType === 'list') kv.lists += requests;
    if (item.dimensions.actionType === 'delete') kv.deletes += requests;
  }
  const latestStorage = pickStorageRow(storage);
  kv.storageBytes = latestStorage?.max.byteCount ?? 0;
  if (latestStorage) kv.storageDay = latestStorage.dimensions.date;

  const d1WritesByDay = new Map<string, number>();
  const d1 = { day: today, rowsRead: 0, rowsWritten: 0 };
  for (const item of d1Rows) {
    if (env.D1_ID && item.dimensions.databaseId !== env.D1_ID) continue;
    const date = item.dimensions.date;
    d1WritesByDay.set(date, (d1WritesByDay.get(date) ?? 0) + item.sum.rowsWritten);
    if (date !== today) continue;
    d1.rowsRead += item.sum.rowsRead;
    d1.rowsWritten += item.sum.rowsWritten;
  }
  return { kv, d1, kvWritesByDay, d1WritesByDay };
}

async function readPrevious(env: Env): Promise<UsageSnapshot | null> {
  const raw = await env.SNAPSHOT.get(USAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UsageSnapshot;
  } catch {
    return null;
  }
}

/** Count a KV put locally so a lagging analytics report cannot under-report. */
export async function recordKvPut(env: Env, puts = 1): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO kv_write_counter (day, puts, deletes) VALUES (?, ?, 0)
       ON CONFLICT(day) DO UPDATE SET puts = puts + excluded.puts, updated_at = datetime('now')`,
    )
      .bind(utcDay(), puts)
      .run();
  } catch {
    // Counter table can lag the deploy; usage stays readable either way.
  }
}

export async function recordKvDelete(env: Env, deletes = 1): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO kv_write_counter (day, puts, deletes) VALUES (?, 0, ?)
       ON CONFLICT(day) DO UPDATE SET deletes = deletes + excluded.deletes, updated_at = datetime('now')`,
    )
      .bind(utcDay(), deletes)
      .run();
  } catch {
    // ignore
  }
}

async function localKvToday(env: Env): Promise<{ puts: number; deletes: number }> {
  try {
    const row = await env.DB.prepare('SELECT puts, deletes FROM kv_write_counter WHERE day = ?')
      .bind(utcDay())
      .first<{ puts: number; deletes: number }>();
    return { puts: Number(row?.puts ?? 0), deletes: Number(row?.deletes ?? 0) };
  } catch {
    return { puts: 0, deletes: 0 };
  }
}

async function writeUsage(env: Env, snapshot: UsageSnapshot): Promise<void> {
  await recordKvPut(env);
  await env.SNAPSHOT.put(USAGE_KEY, JSON.stringify(snapshot));
}

/** Refresh from Cloudflare Analytics + GitHub. Falls back to the previous snapshot on errors. */
export async function refreshUsage(env: Env): Promise<UsageSnapshot> {
  const previous = await readPrevious(env);
  const [github, local] = await Promise.all([collectGithub(env), localKvToday(env)]);
  const days = Array.from({ length: HISTORY_DAYS }, (_, index) => utcDay(-index)).reverse();
  let cloudflare: CloudflareUsage | null = null;
  let cloudflareError: string | null = null;
  try {
    cloudflare = await collectCloudflare(env, days);
    if (!cloudflare) cloudflareError = '未配置 CF_ANALYTICS_TOKEN 或 CF_ACCOUNT_ID';
  } catch (error) {
    cloudflareError = error instanceof Error ? error.message : String(error);
  }

  const history: DayUsage[] = days.map((date) => {
    const prior = previous?.history?.find((item) => item.date === date);
    return {
      date,
      kvWrites: cloudflare?.kvWritesByDay.get(date) ?? prior?.kvWrites ?? 0,
      d1Writes: cloudflare?.d1WritesByDay.get(date) ?? prior?.d1Writes ?? 0,
      githubMinutes: github.private === false ? 0 : Math.ceil(github.byDay.get(date) ?? prior?.githubMinutes ?? 0),
    };
  });

  const officialWrites = cloudflare?.kv.writes;
  const km = cloudflare?.kv ?? previous?.kv;
  const localWrites = local.puts;
  // A counter inflated by a former bug is reset once; otherwise it only ratchets
  // upward so a lagging analytics report can never lower the guard below real use.
  const inflated = officialWrites !== undefined && localWrites > officialWrites + 200;
  const writes =
    officialWrites === undefined
      ? Math.max(km?.writes ?? 0, localWrites)
      : inflated
        ? officialWrites
        : Math.max(officialWrites, localWrites);
  const kv = {
    day: km?.day ?? utcDay(),
    reads: km?.reads ?? 0,
    writes,
    lists: km?.lists ?? 0,
    deletes: Math.max(km?.deletes ?? 0, local.deletes),
    storageBytes: km?.storageBytes ?? 0,
    storageDay: km?.storageDay,
    localWrites,
  };

  const snapshot: UsageSnapshot = {
    collectedAt: new Date().toISOString(),
    kv,
    d1: cloudflare?.d1 ?? previous?.d1 ?? { day: utcDay(), rowsRead: 0, rowsWritten: 0 },
    github: { month: github.month, minutes: github.minutes, runs: github.runs, private: github.private ?? previous?.github.private },
    history,
    cloudflareError: cloudflare ? null : cloudflareError,
  };

  await writeUsage(env, snapshot);
  return snapshot;
}

export async function getUsage(env: Env, options: { refresh?: boolean; maxAgeMs?: number } = {}): Promise<UsageSnapshot> {
  const previous = await readPrevious(env);
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const fresh = previous && Date.now() - Date.parse(previous.collectedAt) < maxAge;
  if (!options.refresh && fresh && previous) return previous;
  return refreshUsage(env);
}

/** 派发前的额度护栏：KV 写入或 D1 写入接近免费上限时暂停派发。 */
export const QUOTA_KV_WRITES = 920;
export const QUOTA_D1_WRITES = 90_000;

export interface QuotaCheck {
  ok: boolean;
  message?: string;
  kvWrites: number;
  d1Writes: number;
}

export async function checkQuota(env: Env): Promise<QuotaCheck> {
  try {
    const usage = await getUsage(env, { maxAgeMs: 15 * 60_000 });
    const kvWrites = usage.kv?.writes ?? 0;
    const d1Writes = usage.d1?.rowsWritten ?? 0;
    if (kvWrites >= QUOTA_KV_WRITES) {
      return {
        ok: false,
        message: `KV 写入已用 ${kvWrites}/1000，暂停派发，等 UTC 零点重置`,
        kvWrites,
        d1Writes,
      };
    }
    if (d1Writes >= QUOTA_D1_WRITES) {
      return {
        ok: false,
        message: `D1 写入已用 ${d1Writes}/100000，暂停派发，等 UTC 零点重置`,
        kvWrites,
        d1Writes,
      };
    }
    return { ok: true, kvWrites, d1Writes };
  } catch {
    // 额度读取失败不应阻断正常调度。
    return { ok: true, kvWrites: 0, d1Writes: 0 };
  }
}
