import {
  toDay,
  type Candidate,
  type DailyRow,
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
  for (const source of snapshot.sources) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sources (id, title, category, url, mirror, homepage, storage, version, author, description, first_seen_at, last_seen_at, last_status, last_ok, last_tested, streak, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, category = excluded.category, url = excluded.url, mirror = excluded.mirror,
             homepage = excluded.homepage, storage = excluded.storage, version = excluded.version,
             author = excluded.author, description = excluded.description, last_seen_at = excluded.last_seen_at,
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
          now,
          now,
          source.status,
          source.stats.ok,
          source.stats.tested,
          computeStreak(recent.get(source.id) ?? [], source.status),
          now,
        ),
    );

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

  await maybeCleanup(db, day, now);

  return { sources: snapshot.sources.length, platforms, events: events.length, candidates: candidates.length };
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

/** 每天只清理一次：明细 14 天、日汇总/事件 180 天。 */
export async function maybeCleanup(db: D1Database, day: string, now: string): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'last_cleanup_day'").first<{ value: string }>();
  if (row?.value === day) return false;

  const detailCutoff = new Date(Date.parse(now) - DETAIL_RETENTION_DAYS * 86_400_000).toISOString();
  const dailyCutoff = new Date(Date.parse(now) - DAILY_RETENTION_DAYS * 86_400_000).toISOString();
  const dailyDayCutoff = toDay(dailyCutoff);
  const eventCutoff = new Date(Date.parse(now) - EVENT_RETENTION_DAYS * 86_400_000).toISOString();

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

export async function touchSetting(db: D1Database, key: string, value: string, now: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, now)
    .run();
}
