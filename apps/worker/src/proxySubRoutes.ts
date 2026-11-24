import { Hono } from 'hono';
import type { Env } from './env';
import { parseProxyText } from './proxyImport';
import { applyParsedNodes } from './proxyRoutes';
import { completeTaskForRun, dispatchNext, refreshTaskState } from './tasks';

function authorized(env: Env, header: string | undefined): boolean {
  const token = env.RUNNER_TOKEN;
  if (!token) return false;
  return header === `Bearer ${token}`;
}

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  user_agent: string;
  headers: string;
  kind: string;
}

/**
 * 403 兜底：Actions 侧先取订阅地址与自定义头，拉取文本后回传；
 * Worker 只负责解析入库和任务收尾。订阅 URL 不出现在 Actions 日志里。
 */
export function createRunnerSubscriptionRoutes(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.use('*', async (c, next) => {
    if (!authorized(c.env, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized', message: 'runner token 无效' }, 401);
    }
    await next();
  });

  api.get('/proxy-subscriptions/:id', async (c) => {
    const row = await c.env.DB.prepare(
      'SELECT id, name, url, user_agent, headers, kind FROM proxy_subscriptions WHERE id = ?',
    )
      .bind(c.req.param('id'))
      .first<SubscriptionRow>();
    if (!row) return c.json({ error: 'not_found', message: '订阅不存在' }, 404);
    if (!row.url) return c.json({ error: 'file_subscription', message: '文件订阅没有可拉取的地址' }, 400);
    return c.json({
      ok: true,
      subscription: {
        id: row.id,
        name: row.name,
        url: row.url,
        userAgent: row.user_agent,
        headers: row.headers,
        kind: row.kind,
      },
    });
  });

  api.post('/proxy-subscription-result', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      runId?: string;
      taskId?: string;
      subscriptionId?: string;
      text?: string;
      bytes?: number;
      error?: string;
    } | null;
    if (!body) return c.json({ error: 'bad_json' }, 400);
    const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
    const subscriptionId = typeof body.subscriptionId === 'string' ? body.subscriptionId.trim() : '';
    if (!runId || !subscriptionId) {
      return c.json({ error: 'bad_payload', message: '缺少 runId 或 subscriptionId' }, 400);
    }
    const run = await c.env.DB.prepare('SELECT run_id FROM runs WHERE run_id = ?').bind(runId).first<{
      run_id: string;
    }>();
    if (!run) return c.json({ error: 'run_not_found', message: '运行记录不存在' }, 404);

    const now = new Date().toISOString();
    const fail = async (message: string) => {
      await c.env.DB.prepare(
        'UPDATE runs SET status = ?, message = ?, error = ?, generated_at = ? WHERE run_id = ?',
      )
        .bind('failed', message, message, now, runId)
        .run();
      await completeTaskForRun(c.env, runId);
      await refreshTaskState(c.env).catch(() => undefined);
      await dispatchNext(c.env).catch(() => undefined);
      return c.json({ ok: false, status: 'failed', message }, 200);
    };

    if (body.error) return fail(body.error.slice(0, 500));
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return fail('订阅内容为空');

    const parsed = parseProxyText(text);
    if (!parsed.nodes.length) return fail(parsed.warnings[0] ?? '没有识别到节点');

    const summary = await applyParsedNodes(c.env, parsed, subscriptionId);
    await c.env.DB.prepare(
      'UPDATE proxy_subscriptions SET last_fetch_at = ?, last_status = ?, updated_at = ? WHERE id = ?',
    )
      .bind(now, `成功：新增 ${summary.added}，更新 ${summary.updated}`, now, subscriptionId)
      .run();

    const message = `订阅拉取：新增 ${summary.added}，更新 ${summary.updated}，共 ${summary.total} 个节点`;
    await c.env.DB.prepare(
      `UPDATE runs SET status = ?, message = ?, generated_at = ?,
         proxies_used = ? WHERE run_id = ?`,
    )
      .bind('success', message, now, summary.total, runId)
      .run();
    await completeTaskForRun(c.env, runId);
    await refreshTaskState(c.env).catch(() => undefined);
    await dispatchNext(c.env).catch(() => undefined);

    return c.json({ ok: true, status: 'success', message, ...summary, warnings: parsed.warnings });
  });

  return api;
}
