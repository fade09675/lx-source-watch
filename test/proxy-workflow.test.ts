import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, { steps?: Array<Record<string, unknown>>; env?: Record<string, string> }>;
}

const workflow = parse(readFileSync('.github/workflows/proxy-test.yml', 'utf8')) as Workflow;

describe('proxy-test workflow', () => {
  it('由 Worker 定时触发，也能手动触发', () => {
    const on = workflow.on ?? {};
    expect(on.schedule).toBeUndefined();
    expect(on.workflow_dispatch).toBeTruthy();
  });

  it('只读权限，且不接触上报密钥', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const text = JSON.stringify(workflow);
    expect(text).not.toContain('secrets.INGEST_SECRET');
    expect(text).toContain('secrets.RUNNER_TOKEN');
  });

  it('缓存 mihomo 并调用 proxy-test', () => {
    const steps = Object.values(workflow.jobs ?? {})[0]?.steps ?? [];
    const text = JSON.stringify(steps);
    expect(text).toContain('mihomo-v1.19.9');
    expect(text).toContain('pnpm proxy-test');
    expect(text).toContain('--max-hops 5');
  });
});
