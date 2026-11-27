import { Hono } from 'hono';
import type { Env } from './env.js';
import { getTaskWithSecret, updateTask } from './tasks.js';

interface ProgressBody {
  taskId?: string;
  runId?: string;
  token?: string;
  stage?: string;
  done?: number;
  total?: number;
  unit?: string;
  message?: string;
}

const STAGES = new Set(['loading', 'sources', 'endpoints', 'reporting', 'publishing']);

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100000, Math.trunc(parsed))) : 0;
}

/**
 * 探测 job 零密钥，但需要让任务中心看到逐源进度。
 * 这里只接受探测/单源任务自带的一次性 progressToken，且只更新该任务。
 */
export function createRunnerProgressRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/progress', async (c) => {
    let body: ProgressBody;
    try {
      body = await c.req.json<ProgressBody>();
    } catch {
      return c.json({ error: 'bad_request', message: '请求体不是 JSON' }, 400);
    }

    const taskId = text(body.taskId, 64);
    const runId = text(body.runId, 64);
    const token = text(body.token, 160);
    if (!taskId || !runId || !token) {
      return c.json({ error: 'bad_request', message: '缺少 taskId/runId/token' }, 400);
    }

    const task = await getTaskWithSecret(c.env.DB, taskId);
    if (!task) return c.json({ error: 'not_found', message: '任务不存在' }, 404);
    if (
      task.type !== 'probe' &&
      task.type !== 'source-test' &&
      task.type !== 'cn-probe' &&
      task.type !== 'discovery' &&
      task.type !== 'proxy-test'
    ) {
      return c.json({ error: 'bad_request', message: '该任务不支持进度回写' }, 400);
    }
    if (task.payload.progressToken !== token) {
      return c.json({ error: 'forbidden', message: '进度令牌无效' }, 403);
    }
    if (task.status !== 'running') {
      return c.json({ error: 'conflict', message: `任务状态为 ${task.status}，不再接收进度` }, 409);
    }
    if (task.runId && task.runId !== runId) {
      return c.json({ error: 'conflict', message: '运行 id 与任务不匹配' }, 409);
    }

    const done = count(body.done);
    const total = Math.max(done, count(body.total));
    const stage = text(body.stage, 32);
    const unit = text(body.unit, 16) || '源';
    const message = text(body.message, 200) || (total > 0 ? `${done}/${total} ${unit}` : '探测中');

    await updateTask(c.env.DB, task.id, {
      progressDone: done,
      progressTotal: total,
      progressUnit: unit,
      message,
      heartbeatAt: new Date().toISOString(),
    });

    return c.json({ ok: true, stage: STAGES.has(stage) ? stage : 'sources', done, total });
  });

  return app;
}
