import { log } from '../logger.js';
import { errorMessage } from '../util.js';

export interface ProxyFetchOptions {
  endpoint: string;
  token: string;
  subscriptionId: string;
  taskId?: string;
  runId?: string;
  maxBytes?: number;
}

function apiBase(endpoint: string): string {
  return endpoint.replace(/\/api\/ingest\/?$/, '').replace(/\/+$/, '');
}

function parseHeaders(raw: string): Record<string, string> {
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (!name || !value || blocked.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

async function report(
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${base}/api/runner/proxy-subscription-result`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`回传失败：HTTP ${response.status}`);
  }
}

/** Actions 侧拉取订阅文本，Worker 解析入库；订阅地址只经 Worker 转发，不进 Actions 日志。 */
export async function runProxyFetch(options: ProxyFetchOptions): Promise<number> {
  const base = apiBase(options.endpoint);
  let status = 1;
  try {
    const metaResponse = await fetch(
      `${base}/api/runner/proxy-subscriptions/${encodeURIComponent(options.subscriptionId)}`,
      {
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!metaResponse.ok) {
      throw new Error(`取订阅信息失败：HTTP ${metaResponse.status}`);
    }
    const meta = (await metaResponse.json()) as {
      subscription?: { url?: string; userAgent?: string; headers?: string; name?: string };
    };
    const subscription = meta.subscription;
    if (!subscription?.url) throw new Error('订阅没有可拉取的地址（可能是文件订阅）');

    const headers: Record<string, string> = {
      'user-agent': subscription.userAgent || 'lx-source-watch-proxy-fetch/1.0',
      accept: '*/*',
      ...parseHeaders(subscription.headers ?? ''),
    };
    log.info(`拉取订阅「${subscription.name ?? options.subscriptionId}」…`);
    const startedAt = Date.now();
    const subResponse = await fetch(subscription.url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!subResponse.ok) {
      throw new Error(`订阅返回 HTTP ${subResponse.status}（可尝试在订阅里换 UA 或自定义请求头）`);
    }
    const buffer = await subResponse.arrayBuffer();
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (buffer.byteLength > maxBytes) {
      throw new Error(`订阅内容过大（${buffer.byteLength} 字节）`);
    }
    const text = new TextDecoder().decode(buffer);
    log.info(`拉取完成：${buffer.byteLength} 字节，${Date.now() - startedAt}ms，回传 Worker 解析`);

    await report(base, options.token, {
      runId: options.runId,
      taskId: options.taskId,
      subscriptionId: options.subscriptionId,
      text,
      bytes: buffer.byteLength,
    });
    status = 0;
  } catch (error) {
    const message = errorMessage(error);
    log.error(message);
    await report(base, options.token, {
      runId: options.runId,
      taskId: options.taskId,
      subscriptionId: options.subscriptionId,
      error: message,
    }).catch((reportError) => log.error(`错误回传失败：${errorMessage(reportError)}`));
  }
  return status;
}
