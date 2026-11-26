import type { ProbeError } from './errors.js';

/** 瞬时失败重试前的等待时间：给 CDN/TLS 抖动一个恢复窗口。 */
export const RETRY_DELAY_MS = 600;

/** 只重试网络、超时、408/429/5xx 这类可能自愈的错误。 */
export function isTransientError(error: ProbeError | undefined): boolean {
  if (!error) return false;
  if (
    error.kind === 'resolve_network' ||
    error.kind === 'resolve_timeout' ||
    error.kind === 'stream_network' ||
    error.kind === 'stream_timeout'
  ) {
    return true;
  }
  if (error.kind === 'resolve_http' || error.kind === 'stream_http') {
    const status = error.status ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  return false;
}

/** 每次平台检测最多一次重试，避免把失败场景拖成双倍耗时。 */
export class RetryBudget {
  private used = 0;

  constructor(private readonly limit = 1) {}

  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
