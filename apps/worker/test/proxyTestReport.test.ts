import { ProxyTestReportSchema } from '@lx/shared';
import { describe, expect, it } from 'vitest';
import { proxyTestMessage, proxyTestStatus } from '../src/proxyTestReport';

function report(over: Record<string, unknown> = {}) {
  return ProxyTestReportSchema.parse({
    runId: 'run_proxy_1',
    total: 3,
    ok: 2,
    kernelOk: 1,
    skippedUdp: 2,
    durationMs: 12_000,
    results: [],
    ...over,
  });
}

describe('proxyTestStatus', () => {
  it('没有节点算失败', () => {
    expect(proxyTestStatus(report({ total: 0, ok: 0 }))).toBe('failed');
  });

  it('全部可用算成功', () => {
    expect(proxyTestStatus(report({ total: 3, ok: 3 }))).toBe('success');
  });

  it('部分可用算部分成功', () => {
    expect(proxyTestStatus(report({ total: 3, ok: 1 }))).toBe('partial');
  });

  it('全部失败算失败', () => {
    expect(proxyTestStatus(report({ total: 3, ok: 0 }))).toBe('failed');
  });
});

describe('proxyTestMessage', () => {
  it('包含通过数、内核与跳过 UDP', () => {
    const message = proxyTestMessage(report());
    expect(message).toContain('2/3 可用');
    expect(message).toContain('内核可用 1');
    expect(message).toContain('跳过 UDP 2');
  });
});
