import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { CnFile, CnProgressEvent } from '../cn.js';
import { cnRun } from './run.js';
import { httpRequest } from '../net/http.js';
import { log } from '../logger.js';
import { createProgressReporter } from '../progress.js';
import { errorMessage } from '../util.js';

export interface CnProbeTaskOptions {
  endpoint: string;
  token: string;
  probeRunId: string;
  taskId: string;
  runId: string;
  progressUrl?: string;
  progressToken?: string;
  limit?: number;
  preferredId?: string;
  maxProxies?: number;
  concurrency?: number;
  allowPrivate?: boolean;
}

interface CnInputFile {
  probeRunId: string;
  createdAt: string;
  snapshot: unknown;
  urls: unknown[];
}

function apiBase(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/api\/ingest\/?$/, '');
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function makeLog(cn: CnFile, started: number): string {
  const failed = cn.rows.filter((row) => !row.ok).slice(0, 12);
  return [
    `国内补测：测试 ${cn.summary.tested} 条，可达 ${cn.summary.ok} 条`,
    `代理 ${cn.proxy}，耗时 ${Date.now() - started}ms`,
    ...failed.map((row) => `失败 ${row.sourceId}/${row.platform}: ${row.error ?? `HTTP ${row.status}`}`),
  ].join('\n');
}

async function postResult(endpoint: string, token: string, body: Record<string, unknown>) {
  const res = await httpRequest(`${apiBase(endpoint)}/api/runner/cn-result`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 90_000,
    maxBytes: 64 * 1024,
    allowPrivate: true,
  });
  if (res.status !== 200) {
    throw new Error(`回传国内补测结果失败：HTTP ${res.status} ${res.body.toString('utf8').slice(0, 300)}`);
  }
}

export async function runCnProbeTask(options: CnProbeTaskOptions): Promise<CnFile> {
  const started = Date.now();
  const inputRes = await httpRequest(
    `${apiBase(options.endpoint)}/api/runner/cn-input/${encodeURIComponent(options.probeRunId)}`,
    {
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
      timeoutMs: 20_000,
      maxBytes: 2 * 1024 * 1024,
      allowPrivate: options.allowPrivate,
    },
  );
  if (inputRes.status !== 200) {
    throw new Error(`拉取补测输入失败：HTTP ${inputRes.status} ${inputRes.body.toString('utf8').slice(0, 200)}`);
  }
  const input = JSON.parse(inputRes.body.toString('utf8')) as CnInputFile;
  await mkdir('out', { recursive: true });
  await writeFile('out/status.json', JSON.stringify(input.snapshot), 'utf8');
  await writeFile(
    'out/urls.json',
    JSON.stringify({ version: 1, generatedAt: input.createdAt, urls: input.urls }),
    'utf8',
  );
  log.step(`国内补测任务：${input.urls.length} 个候选地址（来源运行 ${options.probeRunId}）`);

  const reporter = createProgressReporter({
    url: options.progressUrl,
    token: options.progressToken,
    taskId: options.taskId,
    runId: options.runId,
  });
  let lastDone = 0;
  let lastTotal = 0;
  const report = async (event: CnProgressEvent) => {
    // 换代理会从 0 重新测；任务进度只允许前进，避免进度条倒退。
    const done = Math.max(lastDone, event.done);
    const total = Math.max(lastTotal, event.total, done);
    lastDone = done;
    lastTotal = total;
    await reporter?.report({ ...event, done, total });
  };

  try {
    const cn = await cnRun({
      urlsPath: 'out/urls.json',
      outPath: 'out/cn.json',
      statusPath: 'out/status.json',
      endpoint: options.endpoint,
      token: options.token,
      preferredId: options.preferredId,
      maxProxies: options.maxProxies,
      concurrency: options.concurrency,
      limit: options.limit,
      scope: 'all',
      allowPrivate: options.allowPrivate,
      onProgress: report,
    });
    await report({
      stage: 'reporting',
      done: lastTotal,
      total: lastTotal,
      unit: '地址',
      message: '补测完成，正在回传结果',
    });
    const raw = await readFile('out/cn.json', 'utf8').catch(() => '');
    const file = (raw ? JSON.parse(raw) : cn) as CnFile;
    await postResult(options.endpoint, options.token, {
      runId: options.runId,
      taskId: options.taskId,
      probeRunId: options.probeRunId,
      selected: input.urls.length,
      cn: file,
      log: makeLog(file, started),
    });
    return file;
  } catch (error) {
    await postResult(options.endpoint, options.token, {
      runId: options.runId,
      taskId: options.taskId,
      probeRunId: options.probeRunId,
      cn: { version: 1, generatedAt: new Date().toISOString(), mode: 'verify', proxy: '', summary: { tested: 0, ok: 0 }, rows: [] },
      error: errorMessage(error).slice(0, 2000),
      log: `国内补测失败：${errorMessage(error)}`,
    }).catch(() => undefined);
    throw error;
  }
}
