import { describe, expect, it } from 'vitest';
import { pickRunForTask, workflowForTask, type WorkflowRunRef } from '../src/taskReconcile.js';

function run(overrides: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:10:00Z',
    ...overrides,
  };
}

describe('workflowForTask', () => {
  it('按任务类型映射到对应 workflow', () => {
    expect(workflowForTask('probe')).toBe('probe.yml');
    expect(workflowForTask('discovery')).toBe('probe.yml');
    expect(workflowForTask('source-test')).toBe('probe.yml');
    expect(workflowForTask('cn-probe')).toBe('cn-probe.yml');
    expect(workflowForTask('proxy-test')).toBe('proxy-test.yml');
    expect(workflowForTask('proxy-fetch-sub')).toBe('proxy-fetch-sub.yml');
    expect(workflowForTask('retention')).toBeUndefined();
  });
});

describe('pickRunForTask', () => {
  it('优先匹配 githubRunId', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-11-27T00:00:10Z' }),
      run({ id: 2, createdAt: '2026-11-27T00:00:20Z' }),
    ];
    expect(pickRunForTask({ startedAt: '2026-11-27T00:00:00Z', githubRunId: '2' }, runs)?.id).toBe(2);
  });

  it('没有 run id 时取任务开始后最早的一条', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-11-27T00:00:30Z' }),
      run({ id: 2, createdAt: '2026-11-27T00:00:10Z' }),
      run({ id: 3, createdAt: '2026-11-26T23:50:00Z' }),
    ];
    expect(pickRunForTask({ startedAt: '2026-11-27T00:00:00Z' }, runs)?.id).toBe(2);
  });

  it('没有开始时间时返回 undefined', () => {
    expect(pickRunForTask({ startedAt: null }, [run()])).toBeUndefined();
  });
});
