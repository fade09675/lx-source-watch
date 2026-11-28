import { describe, expect, it } from 'vitest';
import { cnResultQuality } from '../src/cn/run.js';
import type { CnFile } from '../src/cn.js';

function file(tested: number, ok: number): CnFile {
  return { summary: { tested, ok }, rows: [] } as unknown as CnFile;
}

describe('cnResultQuality', () => {
  it('地址可达率过低时拒绝节点', () => {
    const quality = cnResultQuality(file(73, 2));
    expect(quality.usable).toBe(false);
    expect(quality.reason).toContain('地址可达');
  });

  it('样本不足 10 条时不提前拒绝', () => {
    expect(cnResultQuality(file(5, 0)).usable).toBe(true);
  });

  it('正常节点通过质量门槛', () => {
    expect(cnResultQuality(file(62, 6)).usable).toBe(true);
  });
});
