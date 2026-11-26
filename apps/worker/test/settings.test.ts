import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

describe('normalizeSettings', () => {
  it('空输入回落到默认值', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('数值会夹在允许范围内', () => {
    const settings = normalizeSettings({
      probeIntervalHours: 999,
      probeConcurrency: 0,
      probeLimit: -5,
      cnMaxProxies: 99,
      retentionDetailDays: 1,
    });
    expect(settings.probeIntervalHours).toBe(24);
    expect(settings.probeConcurrency).toBe(1);
    expect(settings.probeLimit).toBe(0);
    expect(settings.cnMaxProxies).toBe(20);
    expect(settings.retentionDetailDays).toBe(3);
  });

  it('布尔值只接受真正的布尔', () => {
    const settings = normalizeSettings({
      probeEnabled: 'false',
      cnEnabled: 0,
      autoPromoteCandidates: false,
    });
    expect(settings.probeEnabled).toBe(true);
    expect(settings.cnEnabled).toBe(true);
    expect(settings.autoPromoteCandidates).toBe(false);
  });

  it('字符串数字也能解析', () => {
    const settings = normalizeSettings({ probeIntervalHours: '6', probeLimit: '50' });
    expect(settings.probeIntervalHours).toBe(6);
    expect(settings.probeLimit).toBe(50);
  });

  it('4E 新增运行参数会夹取并清理 UA', () => {
    const settings = normalizeSettings({
      cnMaxHops: 99,
      cnAutoSwitch: 'false',
      proxyFetchUserAgent: '  ClashforWindows/0.20.39  ',
      proxyTestConcurrency: 0,
      proxyTestTimeoutMs: 999_999,
    });
    expect(settings.cnMaxHops).toBe(5);
    expect(settings.cnAutoSwitch).toBe(true);
    expect(settings.proxyFetchUserAgent).toBe('ClashforWindows/0.20.39');
    expect(settings.proxyTestConcurrency).toBe(1);
    expect(settings.proxyTestTimeoutMs).toBe(90_000);
  });

  it('4E 默认值：跳板 5、自动换节点开、测活并发 5、超时 20 秒', () => {
    expect(DEFAULT_SETTINGS.cnMaxHops).toBe(5);
    expect(DEFAULT_SETTINGS.cnAutoSwitch).toBe(true);
    expect(DEFAULT_SETTINGS.proxyFetchUserAgent).toBe('');
    expect(DEFAULT_SETTINGS.proxyTestConcurrency).toBe(5);
    expect(DEFAULT_SETTINGS.proxyTestTimeoutMs).toBe(20_000);
  });

  it('阶段五额度护栏会夹取到安全范围', () => {
    const settings = normalizeSettings({ quotaKvWrites: 5000, quotaD1Writes: 1 });
    expect(settings.quotaKvWrites).toBe(1_000);
    expect(settings.quotaD1Writes).toBe(10_000);
  });

  it('阶段五默认护栏：KV 920、D1 90000', () => {
    expect(DEFAULT_SETTINGS.quotaKvWrites).toBe(920);
    expect(DEFAULT_SETTINGS.quotaD1Writes).toBe(90_000);
  });

  it('E3 自动收录门槛会夹取并保留默认值', () => {
    expect(DEFAULT_SETTINGS.autoPromoteMinPlatforms).toBe(2);
    expect(DEFAULT_SETTINGS.autoPromoteRequireTestablePlatform).toBe(true);
    const settings = normalizeSettings({
      autoPromoteMinPlatforms: 99,
      autoPromoteRequireTestablePlatform: 'false',
    });
    expect(settings.autoPromoteMinPlatforms).toBe(8);
    expect(settings.autoPromoteRequireTestablePlatform).toBe(true);
  });
});
