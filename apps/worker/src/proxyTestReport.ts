import { ProxyTestReportSchema, type ProxyTestReport } from '@lx/shared';
import { Hono } from 'hono';
import { authRunner } from './proxyRoutes';
import type { Env } from './env';
import { completeTaskForRun, dispatchNext, refreshTaskState } from './tasks';

interface RunRef {
  run_id: string;
  trigger: string;
  started_at: string | null;
}

export interface ProxyTestReportResult {
  ok: boolean;
  error?: 'run_not_found';
  runId: string;
  status?: 'success' | 'partial' | 'failed';
  total?: number;
  passed?: number;
}

export function proxyTestStatus(report: ProxyTestReport): 'success' | 'partial' | 'failed' {
  if (report.total <= 0) return 'failed';
  if (report.ok >= report.total) return 'success';
  if (report.ok > 0) return 'partial';
  return 'failed';
}

export function proxyTestMessage(report: ProxyTestReport): string {
  const parts = [`代理测活：${report.ok}/${report.total} 可用`];
  if (report.kernelOk > 0) parts.push(`内核可用 ${report.kernelOk}`);
  if (report.skippedUdp > 0) parts.push(`跳过 UDP ${report.skippedUdp}`);
  return parts.join('，');
}

/**
 * 接收 Actions 的代理测活结果：落日志、结束占位运行与任务，再排下一个任务。
 * 占位运行由 dispatchNext 创建，runId 由任务派发时传给 runner。
 */
export async function reportProxyTestResult(
  env: Env,
  input: unknown,
): Promise<ProxyTestReportResult> {
  const report = ProxyTestReportSchema.parse(input);
  const run = await env.DB.prepare(
    'SELECT run_id, trigger, started_at FROM runs WHERE run_id = ?',
  )
    .bind(report.runId)
    .first<RunRef>();
  if (!run) return { ok: false, error: 'run_not_found', runId: report.runId };

  const now = new Date().toISOString();
  const status = proxyTestStatus(report);
  const message = proxyTestMessage(report);
  const logKey = `run:${report.runId}:log`;
  const logLines = [
    `代理测活 ${now}`,
    `结果：${report.ok}/${report.total} 可用，内核 ${report.kernelOk}，跳过 UDP ${report.skippedUdp}，耗时 ${report.durationMs}ms`,
    ...report.results.map((row) => {
      const target = `${row.host ?? ''}:${row.port ?? ''}`;
      const detail = row.ok ? `${row.latencyMs ?? 0}ms` : row.error ?? '未知错误';
      return `[${row.ok ? 'OK' : 'FAIL'}] ${row.name || row.id} ${row.protocol ?? ''} ${target} ${detail}`;
    }),
  ];
  const steps = JSON.stringify([
    {
      key: 'proxy-test',
      label: '代理测活',
      status,
      durationMs: report.durationMs,
      message,
    },
  ]);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE runs
          SET status = ?, message = ?, duration_ms = ?, proxies_used = ?,
              steps = ?, log_key = ?
        WHERE run_id = ?`,
    ).bind(status, message, report.durationMs, report.total, steps, logKey, report.runId),
    env.DB.prepare(
      `INSERT INTO proxy_test_runs
         (run_id, task_id, trigger, started_at, finished_at, total, ok,
          kernel_ok, skipped_udp, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         total = excluded.total,
         ok = excluded.ok,
         kernel_ok = excluded.kernel_ok,
         skipped_udp = excluded.skipped_udp,
         duration_ms = excluded.duration_ms,
         finished_at = excluded.finished_at`,
    ).bind(
      report.runId,
      report.taskId ?? null,
      run.trigger || 'manual',
      run.started_at ?? now,
      now,
      report.total,
      report.ok,
      report.kernelOk,
      report.skippedUdp,
      report.durationMs,
      now,
    ),
    env.DB.prepare('DELETE FROM proxy_test_results WHERE run_id = ?').bind(report.runId),
  ];

  const insert = env.DB.prepare(
    `INSERT INTO proxy_test_results
       (run_id, proxy_id, name, protocol, host, port, subscription_id,
        kernel_only, ok, latency_ms, country, asn, error, tested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of report.results) {
    statements.push(
      insert.bind(
        report.runId,
        row.id,
        row.name ?? '',
        row.protocol ?? '',
        row.host ?? '',
        row.port ?? null,
        row.subscriptionId ?? null,
        row.kernelOnly ? 1 : 0,
        row.ok ? 1 : 0,
        row.latencyMs,
        row.country ?? '',
        row.asn ?? '',
        row.error ?? null,
        row.testedAt ?? now,
      ),
    );
  }

  try {
    await env.SNAPSHOT.put(logKey, logLines.join('\n'), { expirationTtl: 14 * 86_400 });
  } catch {
    // 日志写入失败不影响结果回写。
  }
  for (let i = 0; i < statements.length; i += 800) {
    await env.DB.batch(statements.slice(i, i + 800));
  }

  await completeTaskForRun(env, report.runId);
  await refreshTaskState(env);
  await dispatchNext(env);

  return {
    ok: true,
    runId: report.runId,
    status,
    total: report.total,
    passed: report.ok,
  };
}

/** Actions 回写代理测活结果（Bearer RUNNER_TOKEN，不走登录会话）。 */
export function createRunnerProxyTestReportRoutes(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.post('/proxy-test-result', async (c) => {
    if (!authRunner(c.env, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized', message: 'runner token 无效' }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_json', message: '请求体不是 JSON' }, 400);
    }
    try {
      const result = await reportProxyTestResult(c.env, body);
      if (!result.ok) {
        return c.json({ error: result.error, message: '运行记录不存在' }, 404);
      }
      return c.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return c.json(
        {
          error: 'bad_report',
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

  return api;
}
