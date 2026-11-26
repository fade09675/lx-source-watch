import { Hono } from 'hono';
import {
  CnProbeResultSchema,
  SnapshotSchema,
  type CnProbeResult,
  type CnProbeRow,
  type Snapshot,
} from '@lx/shared';
import type { Env } from './env';
import { readCnInput } from './cnProbe';
import { dispatchNext, refreshTaskState, updateTask, type TaskResultCnFailure } from './tasks';
import { SNAPSHOT_KEY } from './env';

const LOG_TTL_SECONDS = 14 * 24 * 60 * 60;

function authorized(env: Env, header: string | undefined): boolean {
  const token = env.RUNNER_TOKEN;
  return Boolean(token) && header === `Bearer ${token}`;
}

function cnResult(row: CnProbeRow) {
  return {
    tested: true,
    ok: row.ok,
    ...(row.totalMs !== undefined ? { ms: row.totalMs } : {}),
    ...(row.ttfbMs !== undefined ? { ttfbMs: row.ttfbMs } : {}),
    ...(row.status !== undefined ? { httpStatus: row.status } : {}),
    ...(row.error ? { error: row.error.slice(0, 500) } : {}),
    ...(row.proxy ? { proxy: row.proxy } : {}),
  };
}

function applyToSnapshot(snapshot: Snapshot, body: CnProbeResult): Snapshot {
  const rows = new Map(body.cn.rows.map((row) => [`${row.sourceId}\u0000${row.platform}`, row]));
  const endpointRows = new Map(
    (body.cn.endpoints ?? []).map((row) => [`${row.sourceId}\u0000${row.url}`, row]),
  );
  const sources = snapshot.sources.map((source) => {
    const platforms = source.platforms.map((platform) => {
      const row = rows.get(`${source.id}\u0000${platform.key}`);
      return row ? { ...platform, cn: cnResult(row) } : platform;
    });
    const endpoints = source.endpoints.map((endpoint) => {
      const row = endpointRows.get(`${source.id}\u0000${endpoint.url}`);
      if (!row) return endpoint;
      return {
        ...endpoint,
        cn: {
          tested: true,
          ok: row.ok,
          ...(row.totalMs !== undefined ? { ms: row.totalMs } : {}),
          ...(row.ttfbMs !== undefined ? { ttfbMs: row.ttfbMs } : {}),
          ...(row.status !== undefined ? { httpStatus: row.status } : {}),
          ...(row.error ? { error: row.error.slice(0, 500) } : {}),
        },
      };
    });
    return { ...source, platforms, endpoints };
  });
  return { ...snapshot, sources };
}

export function createCnProbeRoutes(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.use('*', async (c, next) => {
    if (!authorized(c.env, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized', message: 'runner token 无效' }, 401);
    }
    await next();
  });

  api.get('/cn-input/:probeRunId', async (c) => {
    const input = await readCnInput(c.env, c.req.param('probeRunId'));
    if (!input) return c.json({ error: 'not_found', message: '补测输入不存在或已过期' }, 404);
    return c.json(input);
  });

  api.post('/cn-result', async (c) => {
    let parsed: CnProbeResult;
    try {
      parsed = CnProbeResultSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'bad_payload', message: '补测结果格式不正确' }, 400);
    }
    const run = await c.env.DB.prepare(
      'SELECT run_id, task_id, status, started_at FROM runs WHERE run_id = ?',
    )
      .bind(parsed.runId)
      .first<{ run_id: string; task_id: string | null; status: string; started_at: string | null }>();
    if (!run) return c.json({ error: 'run_not_found', message: '运行不存在' }, 404);

    const now = new Date().toISOString();
    const durationMs = run.started_at
      ? Math.max(0, Date.now() - Date.parse(run.started_at))
      : 0;
    const logKey = `run:${parsed.runId}:log`;
    if (parsed.error) {
      const message = `国内补测失败：${parsed.error.slice(0, 500)}`;
      await c.env.DB.prepare(
        `UPDATE runs SET status = 'failed', message = ?, error = ?, runner = 'github-actions',
            check_scope = 'cn', trigger = 'schedule', generated_at = ?, log_key = ?, duration_ms = ?
          WHERE run_id = ?`,
      )
        .bind(message, parsed.error.slice(0, 500), now, logKey, durationMs, parsed.runId)
        .run();
      if (parsed.log) {
        await c.env.SNAPSHOT.put(logKey, parsed.log, { expirationTtl: LOG_TTL_SECONDS });
      }
      await updateTask(c.env.DB, parsed.taskId, {
        status: 'failed',
        message,
        error: parsed.error.slice(0, 500),
        finishedAt: now,
      });
      await refreshTaskState(c.env);
      return c.json({ ok: true, runId: parsed.runId, failed: true });
    }

    const sourceIds = new Set(parsed.cn.rows.map((row) => row.sourceId));
    const tested = parsed.cn.summary.tested;
    const ok = parsed.cn.summary.ok;

    for (const row of parsed.cn.rows) {
      await c.env.DB.prepare(
        `UPDATE platform_results
            SET cn_tested = 1, cn_ok = ?, cn_ms = ?, cn_ttfb_ms = ?, cn_error = ?
          WHERE run_id = ? AND source_id = ? AND platform = ?`,
      )
        .bind(
          row.ok ? 1 : 0,
          row.totalMs ?? null,
          row.ttfbMs ?? null,
          row.error?.slice(0, 500) ?? null,
          parsed.probeRunId,
          row.sourceId,
          row.platform,
        )
        .run();
    }
    for (const row of parsed.cn.endpoints ?? []) {
      await c.env.DB.prepare(
        `UPDATE source_endpoints
            SET cn_ok = ?, cn_ms = ?, cn_ttfb_ms = ?, cn_error = ?, cn_proxy = ?, cn_checked_at = ?
          WHERE run_id = ? AND url = ?`,
      )
        .bind(
          row.ok ? 1 : 0,
          row.totalMs ?? null,
          row.ttfbMs ?? null,
          row.error?.slice(0, 500) ?? null,
          parsed.cn.proxy ?? null,
          now,
          parsed.probeRunId,
          row.url,
        )
        .run();
    }

    let sourceTitles = new Map<string, string>();
    const raw = await c.env.SNAPSHOT.get(SNAPSHOT_KEY);
    if (raw) {
      try {
        const snapshot = SnapshotSchema.parse(JSON.parse(raw));
        sourceTitles = new Map(snapshot.sources.map((source) => [source.id, source.title]));
        await c.env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(applyToSnapshot(snapshot, parsed)));
      } catch {
        // 快照损坏时仍保留 D1 结果，不阻断任务收尾。
      }
    }

    const selected = parsed.selected ?? tested;
    const message = `国内补测：测试 ${tested} 条，可达 ${ok} 条（${sourceIds.size} 个源）`;
    const endpoints = parsed.cn.endpoints ?? [];
    const cnFailures: TaskResultCnFailure[] = [
      ...parsed.cn.rows
        .filter((row) => !row.ok)
        .slice(0, 8)
        .map((row) => ({
          sourceId: row.sourceId,
          sourceTitle: sourceTitles.get(row.sourceId),
          kind: 'platform' as const,
          platform: row.platform,
          error: row.error?.slice(0, 300) ?? `HTTP ${row.status ?? '-'}`,
        })),
      ...endpoints
        .filter((row) => !row.ok)
        .slice(0, 4)
        .map((row) => ({
          sourceId: row.sourceId,
          sourceTitle: sourceTitles.get(row.sourceId),
          kind: 'endpoint' as const,
          url: row.url,
          error: row.error?.slice(0, 300) ?? `HTTP ${row.status ?? '-'}`,
        })),
    ];
    await c.env.DB.prepare(
      `UPDATE runs SET status = 'success', message = ?, error = NULL, generated_at = ?,
          runner = 'github-actions', check_scope = 'cn', trigger = 'schedule', log_key = ?,
          total = ?, available = 0, partial = 0, unavailable = 0, untested = 0,
          platforms_ok = ?, platforms_tested = ?, endpoints_ok = ?, endpoints_total = ?,
          cn_tested = ?, cn_ok = ?, duration_ms = ?
        WHERE run_id = ?`,
    )
      .bind(
        message,
        now,
        logKey,
        sourceIds.size,
        ok,
        tested,
        endpoints.filter((row) => row.ok).length,
        endpoints.length,
        tested,
        ok,
        durationMs,
        parsed.runId,
      )
      .run();

    if (parsed.log) {
      await c.env.SNAPSHOT.put(logKey, parsed.log, { expirationTtl: LOG_TTL_SECONDS });
    }

    await updateTask(c.env.DB, parsed.taskId, {
      status: 'succeeded',
      message,
      error: null,
      finishedAt: now,
      progressDone: 1,
      progressTotal: 1,
      result: {
        kind: 'cn-probe',
        summary: message,
        counts: {
          selected,
          tested,
          ok,
          failed: Math.max(0, tested - ok),
          sources: sourceIds.size,
          endpoints: endpoints.length,
        },
        cnFailures,
      },
    });
    try {
      await dispatchNext(c.env);
    } catch {
      // 派发失败不影响结果入库。
    }
    await refreshTaskState(c.env);

    return c.json({ ok: true, runId: parsed.runId, tested, okCount: ok, sources: sourceIds.size });
  });

  return api;
}
