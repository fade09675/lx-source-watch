import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNNER_CONFIG, normalizeRunnerConfig } from '../src/cn/runnerConfig';

describe('normalizeRunnerConfig', () => {
  it('空输入回落到默认值', () => {
    expect(normalizeRunnerConfig(undefined)).toEqual(DEFAULT_RUNNER_CONFIG);
    expect(normalizeRunnerConfig({})).toEqual(DEFAULT_RUNNER_CONFIG);
  });

  it('数值夹取范围，非法类型回落', () => {
    const config = normalizeRunnerConfig({
      cnMaxHops: 99,
      cnAutoSwitch: 'yes',
      proxyTestConcurrency: 0,
      proxyTestTimeoutMs: 1,
      proxyFetchUserAgent: '  UA/1.0  ',
    });
    expect(config.cnMaxHops).toBe(5);
    expect(config.cnAutoSwitch).toBe(true);
    expect(config.proxyTestConcurrency).toBe(1);
    expect(config.proxyTestTimeoutMs).toBe(5_000);
    expect(config.proxyFetchUserAgent).toBe('UA/1.0');
  });

  it('显式关闭自动换节点会保留', () => {
    expect(normalizeRunnerConfig({ cnAutoSwitch: false }).cnAutoSwitch).toBe(false);
  });
});
