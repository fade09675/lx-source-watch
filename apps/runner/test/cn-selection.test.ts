import { describe, expect, it } from 'vitest';
import { cnPlatformStageQuality, cnResultQuality } from '../src/cn/run.js';
import type { CnFile, CnRow } from '../src/cn.js';

function file(tested: number, ok: number): CnFile {
  return { summary: { tested, ok }, rows: [] } as unknown as CnFile;
}

function rows(count: number, okCount: number): CnRow[] {
  return Array.from({ length: count }, (_, index) => ({ ok: index < okCount })) as unknown as CnRow[];
}

describe('cnResultQuality', () => {
  it('地址可达率过低时拒绝节点', () => {
    const quality = cnResultQuality(file(73, 2), rows(136, 1));
    expect(quality.usable).toBe(false);
    expect(quality.reason).toContain('地址可达');
  });

  it('平台可达率过低时拒绝节点', () => {
    const quality = cnResultQuality(file(0, 0), rows(136, 1));
    expect(quality.usable).toBe(false);
    expect(quality.reason).toContain('平台可达');
  });

  it('正常节点通过质量门槛', () => {
    const quality = cnResultQuality(file(62, 6), rows(136, 6));
    expect(quality.usable).toBe(true);
  });
});

describe('cnPlatformStageQuality', () => {
  it('阶段 1 平台通过率低于 10% 时提前拒绝', () => {
    const quality = cnPlatformStageQuality(rows(30, 1));
    expect(quality.usable).toBe(false);
    expect(quality.reason).toContain('平台可达');
  });

  it('阶段 1 样本不足 10 条不提前拒绝', () => {
    const quality = cnPlatformStageQuality(rows(5, 0));
    expect(quality.usable).toBe(true);
  });

  it('阶段 1 平台正常时通过', () => {
    const quality = cnPlatformStageQuality(rows(30, 12));
    expect(quality.usable).toBe(true);
  });
});
