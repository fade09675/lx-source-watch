import { describe, expect, it } from 'vitest';
import { cnResultQuality } from '../src/cn/run.js';
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
