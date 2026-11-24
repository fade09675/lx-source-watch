import {
  toDay,
  CandidateSchema,
  type Candidate,
  type DailyRow,
  type EndpointRow,
  type EventItem,
  type PlatformDailyRow,
  type RunSummary,
  type Snapshot,
  type SourceStatus,
  type SourceRunSummary,
} from '@lx/shared';

const DETAIL_RETENTION_DAYS = 14;
const DAILY_RETENTION_DAYS = 180;
const EVENT_RETENTION_DAYS = 180;

export interface WriteStats {
  sources: number;
  platforms: number;
  endpoints: number;
  events: number;
  candidates: number;
}

export async function alreadyIngested(db: D1Database, runId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS hit FROM runs WHERE run_id = ?').bind(runId).first<{ hit: number }>();
  return Boolean(row);
}

/** 取当前轮之前最近 N 轮的逐源状态（newest first），用于连续失败判定。 */
export async function loadRecentStatuses(
  db: D1Database,
  excludeRunId: string,
  rounds = 3,
): Promise<Map<string, SourceStatus[]>> {
  const runs = await db
    .prepare('SELECT run_id FROM runs WHERE run_id != ? ORDER BY generated_at DESC LIMIT ?')
    .bind(excludeRunId, rounds)
    .all<{ run_id: string }>();
  const runIds = runs.results.map((row) => row.run_id);
  const map = new Map<string, SourceStatus[]>();
  if (runIds.length === 0) return map;

  const placeholders = runIds.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT run_id, source_id, status FROM source_runs WHERE run_id IN (${placeholders})`)
    .bind(...runIds)
    .all<{ run_id: string; source_id: string; status: SourceStatus }>();

  const byRun = new Map<string, Map<string, SourceStatus>>();
  for (const row of rows.results) {
    const perRun = byRun.get(row.run_id) ?? new Map<string, SourceStatus>();
    perRun.set(row.source_id, row.status);
    byRun.set(row.run_id, perRun);
  }

  // runIds 已是从新到旧，按轮次拼接即可保证每个 source 的数组也是 newest first。
  for (const runId of runIds) {
    const perRun = byRun.get(runId);
    if (!perRun) continue;
    for (const [sourceId, status] of perRun) {
      const list = map.get(sourceId) ?? [];
      list.push(status);
      map.set(sourceId, list);
    }
  }
  return map;
}

/** 单次 batch 写入整轮结果：batch 在 D1 里算一次 query，且整体原子。 */
export async function writeSnapshot(db: D1Database, input: {
  snapshot: Snapshot;
  events: EventItem[];
  candidates: Candidate[];
  recent: Map<string, SourceStatus[]>;
  now?: string;
  retention?: RetentionOptions;
}): Promise<WriteStats> {
  const { snapshot, events, candidates, recent } = input;
  const now = input.now ?? new Date().toISOString();
  const day = toDay(snapshot.generatedAt);

  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `INSERT INTO runs (run_id, generated_at, duration_ms, runner, check_scope, total, available, partial, unavailable, untested, platforms_ok, platforms_tested, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .bind(
        snapshot.runId,
        snapshot.generatedAt,
        snapshot.durationMs,
        snapshot.runner,
        snapshot.checkScope,
        snapshot.summary.total,
        snapshot.summary.available,
        snapshot.summary.partial,
        snapshot.summary.unavailable,
        snapshot.summary.untested,
        snapshot.summary.platformsOk,
        snapshot.summary.platformsTested,
        now,
      ),
  );

  let platforms = 0;
  let endpoints = 0;
  for (const source of snapshot.sources) {
    const endpointsOk = source.endpoints.filter((endpoint) => endpoint.ok).length;
    statements.push(
      db
        .prepare(
          `INSERT INTO sources (id, title, category, url, mirror, homepage, storage, version, author, description, script_sha, endpoints_ok, endpoints_total, first_seen_at, last_seen_at, last_status, last_ok, last_tested, streak, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, category = excluded.category, url = excluded.url, mirror = excluded.mirror,
             homepage = excluded.homepage, storage = excluded.storage, version = excluded.version,
             author = excluded.author, description = excluded.description, script_sha = excluded.script_sha,
             endpoints_ok = excluded.endpoints_ok, endpoints_total = excluded.endpoints_total,
             last_seen_at = excluded.last_seen_at,
             last_status = excluded.last_status, last_ok = excluded.last_ok, last_tested = excluded.last_tested,
             streak = excluded.streak, updated_at = excluded.updated_at`,
        )
        .bind(
          source.id,
          source.title,
          source.category,
          source.url,
          source.mirror ?? null,
          source.homepage ?? null,
          source.storage,
          source.version ?? null,
          source.author ?? null,
          source.description ?? null,
          source.scriptSha ?? null,
          endpointsOk,
          source.endpoints.length,
          now,
          now,
          source.status,
          source.stats.ok,
          source.stats.tested,
          computeStreak(recent.get(source.id) ?? [], source.status),
          now,
        ),
    );

    for (const endpoint of source.endpoints) {
      statements.push(
        db
          .prepare(
            `INSERT INTO source_endpoints (run_id, source_id, url, role, ok, status, sha, version, version_state, bytes, ms, error, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id, source_id, url) DO NOTHING`,
          )
          .bind(
            snapshot.runId,
            source.id,
            endpoint.url,
            endpoint.role,
            endpoint.ok ? 1 : 0,
            endpoint.status ?? null,
            endpoint.sha ?? null,
            endpoint.version ?? null,
            endpoint.versionState ?? null,
            endpoint.bytes ?? null,
            endpoint.ms,
            endpoint.error ?? null,
            endpoint.checkedAt,
          ),
      );
      endpoints += 1;
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO source_runs (run_id, source_id, status, init_ok, init_error, ok, tested, total, duration_ms, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, source_id) DO NOTHING`,
        )
        .bind(
          snapshot.runId,
          source.id,
          source.status,
          source.initOk ? 1 : 0,
          source.initError ?? null,
          source.stats.ok,
          source.stats.tested,
          source.stats.total,
          source.durationMs,
          source.checkedAt,
        ),
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO source_daily (day, source_id, runs, ok_sum, tested_sum, total_sum, avg_ms, last_status)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(day, source_id) DO UPDATE SET
             runs = source_daily.runs + 1,
             ok_sum = source_daily.ok_sum + excluded.ok_sum,
             tested_sum = source_daily.tested_sum + excluded.tested_sum,
             total_sum = source_daily.total_sum + excluded.total_sum,
             avg_ms = ((COALESCE(source_daily.avg_ms, 0) * source_daily.runs) + COALESCE(excluded.avg_ms, 0)) / (source_daily.runs + 1),
             last_status = excluded.last_status`,
        )
        .bind(day, source.id, source.stats.ok, source.stats.tested, source.stats.total, source.durationMs, source.status),
    );

    for (const platform of source.platforms) {
      statements.push(
        db
          .prepare(
            `INSERT INTO platform_results (run_id, source_id, platform, name, declared, tested, ok, quality, resolve_ms, ttfb_ms, total_ms, error_kind, error, url_host, http_status, content_type, cn_tested, cn_ok, cn_ms, cn_ttfb_ms, cn_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id, source_id, platform) DO NOTHING`,
          )
          .bind(
            snapshot.runId,
            source.id,
            platform.key,
            platform.name,
            platform.declared ? 1 : 0,
            platform.tested ? 1 : 0,
            platform.ok ? 1 : 0,
            platform.quality ?? null,
            platform.resolveMs ?? null,
            platform.ttfbMs ?? null,
            platform.totalMs ?? null,
            platform.errorKind ?? null,
            platform.error ?? null,
            platform.urlHost ?? null,
            platform.httpStatus ?? null,
            platform.contentType ?? null,
            platform.cn ? (platform.cn.tested ? 1 : 0) : 0,
            platform.cn?.ok ? 1 : 0,
            platform.cn?.ms ?? null,
            platform.cn?.ttfbMs ?? null,
            platform.cn?.error ?? null,
          ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO platform_daily (day, source_id, platform, runs, ok_sum, tested_sum, avg_ms)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(day, source_id, platform) DO UPDATE SET
               runs = platform_daily.runs + 1,
               ok_sum = platform_daily.ok_sum + excluded.ok_sum,
               tested_sum = platform_daily.tested_sum + excluded.tested_sum,
               avg_ms = ((COALESCE(platform_daily.avg_ms, 0) * platform_daily.runs) + COALESCE(excluded.avg_ms, 0)) / (platform_daily.runs + 1)`,
          )
          .bind(
            day,
            source.id,
            platform.key,
            platform.ok ? 1 : 0,
            platform.tested ? 1 : 0,
            platform.totalMs ?? platform.resolveMs ?? null,
          ),
      );
      platforms += 1;
    }
  }

  for (const event of events) {
    statements.push(
      db
        .prepare('INSERT INTO events (id, at, type, source_id, title, message) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .bind(event.id, event.at, event.type, event.sourceId, event.title, event.message),
    );
  }

  for (const candidate of candidates) {
    statements.push(
      db
        .prepare(
          `INSERT INTO candidates (id, repo, path, url, sha, title, version, author, description, platforms, bytes, init_ok, init_error, state, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, version = excluded.version, author = excluded.author, description = excluded.description,
             platforms = excluded.platforms, bytes = excluded.bytes, init_ok = excluded.init_ok,
             init_error = excluded.init_error, state = excluded.state, last_seen = excluded.last_seen`,
        )
        .bind(
          candidate.id,
          candidate.repo,
          candidate.path,
          candidate.url,
          candidate.sha,
          candidate.title ?? null,
          candidate.version ?? null,
          candidate.author ?? null,
          candidate.description ?? null,
          JSON.stringify(candidate.platforms ?? []),
          candidate.bytes ?? null,
          candidate.initOk === undefined ? null : candidate.initOk ? 1 : 0,
          candidate.initError ?? null,
          candidate.state,
          candidate.firstSeen ?? now,
          candidate.lastSeen ?? now,
        ),
    );
  }

  // 单次 batch 的 statement 数远低于免费额度 1000；仍按 900 分块以防未来扩张。
  await runBatches(db, statements);

  await maybeCleanup(db, day, now, input.retention);

  return { sources: snapshot.sources.length, platforms, endpoints, events: events.length, candidates: candidates.length };
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const CHUNK = 900;
  for (let index = 0; index < statements.length; index += CHUNK) {
    await db.batch(statements.slice(index, index + CHUNK));
  }
}

function computeStreak(previousNewestFirst: readonly SourceStatus[], current: SourceStatus): number {
  if (current !== 'unavailable') return 0;
  let streak = 1;
  for (const status of previousNewestFirst) {
    if (status !== 'unavailable') break;
    streak += 1;
  }
  return streak;
}

export interface RetentionOptions {
  detailDays: number;
  dailyDays: number;
  eventDays: number;
}

const DEFAULT_RETENTION: RetentionOptions = {
  detailDays: DETAIL_RETENTION_DAYS,
  dailyDays: DAILY_RETENTION_DAYS,
  eventDays: EVENT_RETENTION_DAYS,
};

/** 每天只清理一次：默认明细 14 天、日汇总/事件 180 天，可被设置覆盖。 */
export async function maybeCleanup(
  db: D1Database,
  day: string,
  now: string,
  retention: RetentionOptions = DEFAULT_RETENTION,
): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'last_cleanup_day'").first<{ value: string }>();
  if (row?.value === day) return false;

  const detailCutoff = new Date(Date.parse(now) - retention.detailDays * 86_400_000).toISOString();
  const dailyCutoff = new Date(Date.parse(now) - retention.dailyDays * 86_400_000).toISOString();
  const dailyDayCutoff = toDay(dailyCutoff);
  const eventCutoff = new Date(Date.parse(now) - retention.eventDays * 86_400_000).toISOString();

  await db.batch([
    db.prepare('DELETE FROM platform_results WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)').bind(detailCutoff),
    db.prepare('DELETE FROM source_runs WHERE run_id IN (SELECT run_id FROM runs WHERE generated_at < ?)').bind(detailCutoff),
    db.prepare('DELETE FROM runs WHERE generated_at < ?').bind(detailCutoff),
    db.prepare('DELETE FROM source_daily WHERE day < ?').bind(dailyDayCutoff),
    db.prepare('DELETE FROM platform_daily WHERE day < ?').bind(dailyDayCutoff),
    db.prepare('DELETE FROM events WHERE at < ?').bind(eventCutoff),
    db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('last_cleanup_day', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(day, now),
  ]);
  return true;
}

/* ------------------------------- reads ------------------------------- */

interface RunRow {
  id: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  available: number;
  partial: number;
  unavailable: number;
  untested: number;
  platformsOk: number;
  platformsTested: number;
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    total: row.total,
    available: row.available,
    partial: row.partial,
    unavailable: row.unavailable,
    untested: row.untested,
    platformsOk: row.platformsOk,
    platformsTested: row.platformsTested,
  };
}

const RUN_COLUMNS = `run_id AS id, generated_at AS finishedAt, duration_ms AS durationMs, total, available, partial, unavailable, untested, platforms_ok AS platformsOk, platforms_tested AS platformsTested`;

export async function getRuns(db: D1Database, limit = 50): Promise<RunSummary[]> {
  const rows = await db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY generated_at DESC LIMIT ?`)
    .bind(limit)
    .all<RunRow>();
  return rows.results.map(toRunSummary);
}

export async function getLastRun(db: D1Database): Promise<RunSummary | null> {
  const row = await db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY generated_at DESC LIMIT 1`)
    .first<RunRow>();
  return row ? toRunSummary(row) : null;
}

export async function getSourceHistory(db: D1Database, sourceId: string, limit = 42): Promise<SourceRunSummary[]> {
  const rows = await db
    .prepare(
      `SELECT run_id AS runId, checked_at AS finishedAt, status, ok, tested, total, duration_ms AS durationMs
       FROM source_runs WHERE source_id = ? ORDER BY checked_at DESC LIMIT ?`,
    )
    .bind(sourceId, limit)
    .all<SourceRunSummary>();
  return rows.results;
}

export interface SourceMeta {
  id: string;
  version: string;
  scriptSha: string;
  status: string;
  endpointsOk: number;
  endpointsTotal: number;
  lastChangeAt: string;
  updatedAt: string;
}

/** 每个音源最新一轮的版本、接入点统计与状态，供网页管理列表合并。 */
export async function getSourceMetas(db: D1Database): Promise<Map<string, SourceMeta>> {
  const rows = await db
    .prepare(
      `SELECT id, version, script_sha AS scriptSha, last_status AS status,
              endpoints_ok AS endpointsOk, endpoints_total AS endpointsTotal,
              last_change_at AS lastChangeAt, updated_at AS updatedAt
         FROM sources`,
    )
    .all<SourceMeta>();
  return new Map(rows.results.map((row) => [row.id, row]));
}

export async function getSourceDaily(db: D1Database, sourceId: string, days = 180): Promise<DailyRow[]> {
  const rows = await db
    .prepare(
      `SELECT day, runs, ok_sum AS okSum, tested_sum AS testedSum, total_sum AS totalSum, last_status AS status, avg_ms AS avgMs
       FROM source_daily WHERE source_id = ? ORDER BY day ASC LIMIT ?`,
    )
    .bind(sourceId, days)
    .all<DailyRow>();
  return rows.results;
}

export async function getSourcePlatformDaily(
  db: D1Database,
  sourceId: string,
  days = 180,
): Promise<PlatformDailyRow[]> {
  const rows = await db
    .prepare(
      `SELECT day, SUM(ok_sum) AS okCount, SUM(tested_sum) AS testedCount, AVG(avg_ms) AS avgMs
       FROM platform_daily WHERE source_id = ? GROUP BY day ORDER BY day ASC LIMIT ?`,
    )
    .bind(sourceId, days)
    .all<PlatformDailyRow>();
  return rows.results;
}

export async function getEvents(db: D1Database, limit = 50): Promise<EventItem[]> {
  const rows = await db
    .prepare('SELECT id, at, type, source_id AS sourceId, title, message FROM events ORDER BY at DESC LIMIT ?')
    .bind(limit)
    .all<EventItem>();
  return rows.results;
}

export async function countCandidates(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM candidates').first<{ n: number }>();
  return row?.n ?? 0;
}

interface CandidateRow {
  id: string;
  repo: string;
  path: string;
  url: string;
  sha: string;
  title: string | null;
  version: string | null;
  author: string | null;
  description: string | null;
  platforms: string;
  bytes: number | null;
  initOk: number | null;
  initError: string | null;
  state: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

const CANDIDATE_COLUMNS = `id, repo, path, url, sha, title, version, author, description, platforms, bytes,  init_ok AS initOk, init_error AS initError, state, first_seen AS firstSeen, last_seen AS lastSeen`;

export async function getCandidates(
  db: D1Database,
  opts: { state?: string; limit?: number } = {},
): Promise<Candidate[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const stmt = db.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidates ${opts.state ? 'WHERE state = ?' : ''} ORDER BY last_seen DESC LIMIT ?`,
  );
  const rows = opts.state
    ? await stmt.bind(opts.state, limit).all<CandidateRow>()
    : await stmt.bind(limit).all<CandidateRow>();

  return rows.results.map(toCandidate);
}

function toCandidate(row: CandidateRow): Candidate {
  return CandidateSchema.parse({
    id: row.id,
    repo: row.repo,
    path: row.path,
    url: row.url,
    sha: row.sha,
    title: row.title ?? undefined,
    version: row.version ?? undefined,
    author: row.author ?? undefined,
    description: row.description ?? undefined,
    platforms: parseJsonArray(row.platforms),
    bytes: row.bytes ?? undefined,
    initOk: row.initOk === null ? undefined : Boolean(row.initOk),
    initError: row.initError ?? undefined,
    state: row.state,
    firstSeen: row.firstSeen ?? undefined,
    lastSeen: row.lastSeen ?? undefined,
  });
}

export async function getCandidate(db: D1Database, id: string): Promise<Candidate | null> {
  const row = await db.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE id = ?`).bind(id).first<CandidateRow>();
  return row ? toCandidate(row) : null;
}

function parseJsonArray(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function touchSetting(db: D1Database, key: string, value: string, now: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, now)
    .run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setCandidateState(db: D1Database, id: string, state: string, now: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE candidates SET state = ?, last_seen = COALESCE(last_seen, ?) WHERE id = ?')
    .bind(state, now, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 清理某个状态的候选（例如已拒绝的）。 */
export async function deleteCandidatesByState(db: D1Database, state: string): Promise<number> {
  const result = await db.prepare('DELETE FROM candidates WHERE state = ?').bind(state).run();
  return result.meta.changes ?? 0;
}

/** 候选数量按状态汇总。 */
export async function countCandidatesByState(db: D1Database): Promise<Record<string, number>> {
  const rows = await db.prepare('SELECT state, COUNT(*) AS n FROM candidates GROUP BY state').all<{ state: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of rows.results ?? []) out[row.state] = row.n;
  return out;
}

interface EndpointDbRow {
  url: string;
  role: string;
  ok: number;
  status: number | null;
  sha: string | null;
  version: string | null;
  version_state: string | null;
  bytes: number | null;
  ms: number;
  error: string | null;
  checked_at: string;
}

/** 取某个来源最近一轮的接入点检查结果（主地址排前面）。 */
export async function getSourceEndpoints(db: D1Database, sourceId: string, runId?: string): Promise<EndpointRow[]> {
  let target = runId;
  if (!target) {
    const latest = await db
      .prepare('SELECT run_id FROM source_runs WHERE source_id = ? ORDER BY checked_at DESC LIMIT 1')
      .bind(sourceId)
      .first<{ run_id: string }>();
    target = latest?.run_id;
  }
  if (!target) return [];

  const rows = await db
    .prepare(
      `SELECT url, role, ok, status, sha, version, version_state, bytes, ms, error, checked_at
       FROM source_endpoints
       WHERE run_id = ? AND source_id = ?
       ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, ok DESC, ms ASC`,
    )
    .bind(target, sourceId)
    .all<EndpointDbRow>();

  return rows.results.map((row) => ({
    url: row.url,
    role: row.role === 'primary' ? 'primary' : 'candidate',
    ok: Boolean(row.ok),
    status: row.status,
    sha: row.sha,
    version: row.version,
    versionState:
      row.version_state === 'synced' || row.version_state === 'lagging' || row.version_state === 'unknown'
        ? row.version_state
        : null,
    bytes: row.bytes,
    ms: row.ms,
    error: row.error,
    checkedAt: row.checked_at,
  }));
}

export interface RunSourceDetail {
  sourceId: string;
  title: string;
  category: string;
  status: SourceStatus;
  initOk: boolean;
  initError: string | null;
  ok: number;
  tested: number;
  total: number;
  durationMs: number;
}

export interface RunPlatformDetail {
  sourceId: string;
  platform: string;
  name: string;
  declared: boolean;
  tested: boolean;
  ok: boolean;
  totalMs: number | null;
  errorKind: string | null;
  error: string | null;
  urlHost: string | null;
  cnTested: boolean;
  cnOk: boolean;
  cnError: string | null;
}

export interface RunEndpointStat {
  sourceId: string;
  total: number;
  ok: number;
  failed: number;
  error: string | null;
}

export async function getRun(db: D1Database, runId: string): Promise<RunSummary | null> {
  const row = await db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
    .bind(runId)
    .first<RunRow>();
  return row ? toRunSummary(row) : null;
}

export async function getRunSources(db: D1Database, runId: string): Promise<RunSourceDetail[]> {
  const rows = await db
    .prepare(
      `SELECT sr.source_id AS sourceId, COALESCE(s.title, sr.source_id) AS title,
              COALESCE(s.category, '') AS category, sr.status, sr.init_ok AS initOk, sr.init_error AS initError,
              sr.ok, sr.tested, sr.total, sr.duration_ms AS durationMs
       FROM source_runs sr
       LEFT JOIN sources s ON s.id = sr.source_id
       WHERE sr.run_id = ?
       ORDER BY CASE sr.status WHEN 'unavailable' THEN 0 WHEN 'partial' THEN 1 WHEN 'untested' THEN 2 ELSE 3 END,
                sr.ok ASC, sr.source_id ASC`,
    )
    .bind(runId)
    .all<{
      sourceId: string;
      title: string;
      category: string;
      status: SourceStatus;
      initOk: number;
      initError: string | null;
      ok: number;
      tested: number;
      total: number;
      durationMs: number;
    }>();

  return rows.results.map((row) => ({
    sourceId: row.sourceId,
    title: row.title,
    category: row.category,
    status: row.status,
    initOk: Boolean(row.initOk),
    initError: row.initError,
    ok: row.ok,
    tested: row.tested,
    total: row.total,
    durationMs: row.durationMs,
  }));
}

export async function getRunPlatforms(db: D1Database, runId: string): Promise<RunPlatformDetail[]> {
  const rows = await db
    .prepare(
      `SELECT source_id AS sourceId, platform, name, declared, tested, ok, total_ms AS totalMs,
              error_kind AS errorKind, error, url_host AS urlHost,
              cn_tested AS cnTested, cn_ok AS cnOk, cn_error AS cnError
       FROM platform_results
       WHERE run_id = ?
       ORDER BY source_id, platform`,
    )
    .bind(runId)
    .all<{
      sourceId: string;
      platform: string;
      name: string;
      declared: number;
      tested: number;
      ok: number;
      totalMs: number | null;
      errorKind: string | null;
      error: string | null;
      urlHost: string | null;
      cnTested: number | null;
      cnOk: number | null;
      cnError: string | null;
    }>();

  return rows.results.map((row) => ({
    sourceId: row.sourceId,
    platform: row.platform,
    name: row.name,
    declared: Boolean(row.declared),
    tested: Boolean(row.tested),
    ok: Boolean(row.ok),
    totalMs: row.totalMs,
    errorKind: row.errorKind,
    error: row.error,
    urlHost: row.urlHost,
    cnTested: Boolean(row.cnTested),
    cnOk: Boolean(row.cnOk),
    cnError: row.cnError,
  }));
}

export async function getRunEndpointStats(db: D1Database, runId: string): Promise<RunEndpointStat[]> {
  const rows = await db
    .prepare(
      `SELECT source_id AS sourceId, COUNT(*) AS total,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
              MAX(CASE WHEN ok = 0 THEN error END) AS error
       FROM source_endpoints
       WHERE run_id = ?
       GROUP BY source_id`,
    )
    .bind(runId)
    .all<{ sourceId: string; total: number; ok: number; failed: number; error: string | null }>();
  return rows.results.map((row) => ({
    sourceId: row.sourceId,
    total: row.total,
    ok: row.ok,
    failed: row.failed,
    error: row.error,
  }));
}

export interface FailureKind {
  kind: string;
  count: number;
  sample: string | null;
}

export interface FailurePlatform {
  platform: string;
  name: string;
  tested: number;
  failed: number;
}

export interface FailureSource {
  sourceId: string;
  title: string;
  tested: number;
  failed: number;
  topError: string | null;
}

export interface FailureAggregate {
  days: number;
  runCount: number;
  platformTests: number;
  platformFailures: number;
  byKind: FailureKind[];
  byPlatform: FailurePlatform[];
  bySource: FailureSource[];
  recentRuns: RunSummary[];
}

/**
 * 失败聚合：只统计真正测过的平台（tested=1），避免把“未测”算成失败。
 * 数据量约 6 轮/天 × 7 天 × 90 平台 = 3,780 行，免费额度下可接受。
 */
export async function getFailureAggregate(db: D1Database, days = 7): Promise<FailureAggregate> {
  const window = Math.max(1, Math.min(30, Math.trunc(days)));
  const since = new Date(Date.now() - window * 86_400_000).toISOString();

  const [runRow, totalRow, kindRows, platformRows, sourceRows, recentRuns] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM runs WHERE generated_at >= ?').bind(since).first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS tests,
                SUM(CASE WHEN pr.ok = 0 THEN 1 ELSE 0 END) AS failed
         FROM platform_results pr
         JOIN runs r ON r.run_id = pr.run_id
         WHERE r.generated_at >= ? AND pr.tested = 1`,
      )
      .bind(since)
      .first<{ tests: number; failed: number | null }>(),
    db
      .prepare(
        `SELECT pr.error_kind AS kind, COUNT(*) AS count, MAX(pr.error) AS sample
         FROM platform_results pr
         JOIN runs r ON r.run_id = pr.run_id
         WHERE r.generated_at >= ? AND pr.tested = 1 AND pr.ok = 0
         GROUP BY pr.error_kind
         ORDER BY count DESC
         LIMIT 8`,
      )
      .bind(since)
      .all<{ kind: string; count: number; sample: string | null }>(),
    db
      .prepare(
        `SELECT pr.platform AS platform, MAX(pr.name) AS name,
                COUNT(*) AS tested,
                SUM(CASE WHEN pr.ok = 0 THEN 1 ELSE 0 END) AS failed
         FROM platform_results pr
         JOIN runs r ON r.run_id = pr.run_id
         WHERE r.generated_at >= ? AND pr.tested = 1
         GROUP BY pr.platform
         ORDER BY failed DESC, tested DESC
         LIMIT 15`,
      )
      .bind(since)
      .all<{ platform: string; name: string; tested: number; failed: number }>(),
    db
      .prepare(
        `SELECT pr.source_id AS sourceId, COALESCE(s.title, pr.source_id) AS title,
                COUNT(*) AS tested,
                SUM(CASE WHEN pr.ok = 0 THEN 1 ELSE 0 END) AS failed,
                MAX(pr.error) AS topError
         FROM platform_results pr
         JOIN runs r ON r.run_id = pr.run_id
         LEFT JOIN sources s ON s.id = pr.source_id
         WHERE r.generated_at >= ? AND pr.tested = 1
         GROUP BY pr.source_id
         ORDER BY failed DESC, tested DESC
         LIMIT 10`,
      )
      .bind(since)
      .all<{ sourceId: string; title: string; tested: number; failed: number; topError: string | null }>(),
    getRuns(db, 20),
  ]);

  return {
    days: window,
    runCount: runRow?.n ?? 0,
    platformTests: totalRow?.tests ?? 0,
    platformFailures: totalRow?.failed ?? 0,
    byKind: kindRows.results.map((row) => ({
      kind: row.kind ?? 'unknown',
      count: row.count,
      sample: row.sample,
    })),
    byPlatform: platformRows.results.map((row) => ({
      platform: row.platform,
      name: row.name,
      tested: row.tested,
      failed: row.failed,
    })),
    bySource: sourceRows.results.map((row) => ({
      sourceId: row.sourceId,
      title: row.title,
      tested: row.tested,
      failed: row.failed,
      topError: row.topError,
    })),
    recentRuns: recentRuns.filter((run) => run.finishedAt >= since),
  };
}
