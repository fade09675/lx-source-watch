import { describe, expect, it } from 'vitest';
import { ProbeError } from '../src/probe/errors.js';
import { RetryBudget, isTransientError } from '../src/probe/retry.js';

describe('isTransientError', () => {
  it('网络和超时错误可重试', () => {
    expect(isTransientError(new ProbeError('resolve_network', 'ECONNRESET'))).toBe(true);
    expect(isTransientError(new ProbeError('resolve_timeout', '取链超时'))).toBe(true);
    expect(isTransientError(new ProbeError('stream_network', 'socket hang up'))).toBe(true);
    expect(isTransientError(new ProbeError('stream_timeout', '拉流超时'))).toBe(true);
  });

  it('HTTP 5xx、408、429 可重试，4xx 不重试', () => {
    expect(isTransientError(new ProbeError('resolve_http', 'HTTP 500', 500))).toBe(true);
    expect(isTransientError(new ProbeError('stream_http', 'HTTP 503', 503))).toBe(true);
    expect(isTransientError(new ProbeError('stream_http', 'HTTP 408', 408))).toBe(true);
    expect(isTransientError(new ProbeError('stream_http', 'HTTP 429', 429))).toBe(true);
    expect(isTransientError(new ProbeError('stream_http', 'HTTP 404', 404))).toBe(false);
    expect(isTransientError(new ProbeError('resolve_http', 'HTTP 403', 403))).toBe(false);
  });

  it('内容错误、空地址和脚本错误不重试', () => {
    expect(isTransientError(new ProbeError('stream_non_audio', '返回 HTML'))).toBe(false);
    expect(isTransientError(new ProbeError('resolve_empty', '空地址'))).toBe(false);
    expect(isTransientError(new ProbeError('script', '脚本异常'))).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('RetryBudget', () => {
  it('每个平台只允许一次重试', () => {
    const budget = new RetryBudget();
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });
});
