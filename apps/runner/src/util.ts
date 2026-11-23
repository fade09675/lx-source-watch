import { createHash, randomBytes } from 'node:crypto';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha1Short(data: string, len = 10): string {
  return createHash('sha1').update(data).digest('hex').slice(0, len);
}

export function randomId(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 固定并发、保持结果顺序。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name;
  // 注意：vm 沙箱里抛出的 Error 来自另一个 realm，instanceof 会失败，必须鸭子类型。
  if (isRecord(e)) {
    for (const key of ['message', 'error', 'msg', 'reason', 'errorMessage', 'errMsg']) {
      const v = e[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    const status = e.status ?? e.statusCode;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return `HTTP ${status}`;
    }
    try {
      const json = JSON.stringify(e);
      if (json && json !== '{}') return json;
    } catch {
      // 忽略循环引用
    }
    return '脚本抛出空错误对象';
  }
  return String(e);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function clampMs(ms: number, max = 60_000): number {
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.min(Math.round(ms), max);
}
