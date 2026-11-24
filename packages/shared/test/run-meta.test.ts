import { describe, expect, it } from 'vitest';
import { RunMetaSchema } from '@lx/shared';

describe('RunMetaSchema', () => {
  it('补默认值', () => {
    const meta = RunMetaSchema.parse({});
    expect(meta.trigger).toBe('manual');
    expect(meta.status).toBeUndefined();
    expect(meta.warnings).toEqual([]);
    expect(meta.steps).toEqual([]);
    expect(meta.message).toBe('');
  });

  it('接受任务、步骤和日志', () => {
    const meta = RunMetaSchema.parse({
      taskId: 'task_1',
      trigger: 'schedule',
      status: 'partial',
      startedAt: '2026-11-24T10:00:00.000Z',
      message: '部分失败',
      warnings: ['主地址超时'],
      steps: [{ key: 'probe', label: '探测', status: 'success', durationMs: 1200 }],
      log: 'line1\nline2',
      counts: { endpointsOk: 3, endpointsTotal: 4, proxiesUsed: 1 },
    });
    expect(meta.steps[0]?.label).toBe('探测');
    expect(meta.counts?.endpointsTotal).toBe(4);
    expect(meta.counts?.cnTested).toBe(0);
  });

  it('拒绝未知触发方式与超长日志', () => {
    expect(RunMetaSchema.safeParse({ trigger: 'cron' }).success).toBe(false);
    expect(RunMetaSchema.safeParse({ log: 'x'.repeat(200_001) }).success).toBe(false);
  });
});
