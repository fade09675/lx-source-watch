import { describe, expect, it } from 'vitest';
import {
  buildDispatch,
  newRunId,
  newTaskId,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
  triggerOf,
} from '../src/tasks';

describe('tasks 纯函数', () => {
  it('triggerOf 把来源映射成运行触发方式', () => {
    expect(triggerOf('schedule')).toBe('schedule');
    expect(triggerOf('retry')).toBe('retry');
    expect(triggerOf('local')).toBe('local');
    expect(triggerOf('manual')).toBe('manual');
    expect(triggerOf('api')).toBe('manual');
  });

  it('probe 任务透传参数与 task/run id', () => {
    const plan = buildDispatch(
      'probe',
      {
        only: 'pdone-qingliang',
        limit: '3',
        deep: true,
        cn: true,
        preferMirror: true,
        concurrency: 2,
        discover: true,
        proxyId: 'proxy-1',
      },
      'task-1',
      'run-1',
    );
    expect(plan.workflow).toBe('probe');
    expect(plan.probe).toMatchObject({
      only: 'pdone-qingliang',
      limit: '3',
      deep: true,
      cn: true,
      preferMirror: true,
      concurrency: 2,
      discover: true,
      proxyId: 'proxy-1',
      taskId: 'task-1',
      runId: 'run-1',
    });
  });

  it('discovery 任务固定单轮、只发现、不测国内', () => {
    const plan = buildDispatch('discovery', { concurrency: 2, preferMirror: true }, 'task-2', 'run-2');
    expect(plan.workflow).toBe('probe');
    expect(plan.probe).toMatchObject({
      discover: true,
      limit: '1',
      cn: false,
      concurrency: 2,
      taskId: 'task-2',
      runId: 'run-2',
    });
  });

  it('source-test 任务固定只测一个源、不测国内', () => {
    const plan = buildDispatch('source-test', { sourceId: 'src-1' }, 'task-3', 'run-3');
    expect(plan.workflow).toBe('probe');
    expect(plan.probe).toMatchObject({
      only: 'src-1',
      limit: '1',
      cn: false,
      concurrency: 1,
      preferMirror: true,
      taskId: 'task-3',
      runId: 'run-3',
    });
  });

  it('source-test 的 sourceId 优先于 only', () => {
    const plan = buildDispatch('source-test', { only: 'legacy', sourceId: 'src-2' }, 'task-4', 'run-4');
    expect(plan.probe?.only).toBe('src-2');
  });

  it('proxy-test 走独立工作流', () => {
    const plan = buildDispatch(
      'proxy-test',
      { proxyId: 'proxy-1', subscriptionId: 'sub-1', concurrency: 3 },
      'task-5',
      'run-5',
    );
    expect(plan.workflow).toBe('proxy-test');
    expect(plan.probe).toBeUndefined();
    expect(plan.proxy).toMatchObject({
      proxyId: 'proxy-1',
      subscriptionId: 'sub-1',
      concurrency: 3,
      taskId: 'task-5',
      runId: 'run-5',
    });
  });

  it('proxy-fetch-sub 走订阅拉取工作流', () => {
    const plan = buildDispatch('proxy-fetch-sub', { subscriptionId: 'sub-9' }, 'task-6', 'run-6');
    expect(plan.workflow).toBe('proxy-fetch-sub');
    expect(plan.fetchSub).toEqual({ subscriptionId: 'sub-9', taskId: 'task-6', runId: 'run-6' });
  });

  it('任务 id 与运行 id 格式稳定且不重复', () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a).toMatch(/^task_[0-9a-f]{14}$/);
    expect(newRunId()).toMatch(/^run_[0-9a-f]{14}$/);
    expect(a).not.toBe(b);
  });

  it('类型与状态都有中文标签', () => {
    expect(Object.keys(TASK_TYPE_LABEL).sort()).toEqual(['discovery', 'probe', 'proxy-fetch-sub', 'proxy-test', 'source-test']);
    expect(Object.keys(TASK_STATUS_LABEL).sort()).toEqual(['cancelled', 'failed', 'queued', 'running', 'succeeded']);
  });
});
