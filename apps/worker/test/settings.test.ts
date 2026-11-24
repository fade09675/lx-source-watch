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
});
