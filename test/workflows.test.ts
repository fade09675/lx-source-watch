import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  needs?: string | string[];
  'timeout-minutes'?: number;
  environment?: string;
  env?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on?: { schedule?: { cron?: string }[]; workflow_dispatch?: unknown };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = `${root}/.github/workflows/probe.yml`;

async function loadWorkflow(): Promise<Workflow> {
  const raw = await readFile(workflowPath, 'utf8');
  return parse(raw) as Workflow;
}

function checkoutStep(job: Job): Step {
  const step = job.steps.find((s) => s.uses?.startsWith('actions/checkout'));
  if (!step) throw new Error('缺少 actions/checkout');
  return step;
}

function namedStep(job: Job, name: string): Step {
  const step = job.steps.find((s) => s.name === name);
  if (!step) throw new Error(`缺少步骤：${name}`);
  return step;
}

describe('probe.yml', () => {
  it('由 Worker 定时触发，支持手动触发', async () => {
    const doc = await loadWorkflow();
    expect(doc.on?.schedule).toBeUndefined();
    expect(doc.on?.workflow_dispatch).toBeDefined();
  });

  it('只申请 contents: read，并保持单实例串行', async () => {
    const doc = await loadWorkflow();
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.concurrency).toEqual({ group: 'lx-probe', 'cancel-in-progress': false });
  });

  it('探测 job 不接触上报/部署密钥，且彻底禁用凭据持久化', async () => {
    const doc = await loadWorkflow();
    const probe = doc.jobs.probe;
    expect(probe).toBeDefined();
    const raw = JSON.stringify(probe);
    // 只有“自动发现”一步拿仓库自带的 GITHUB_TOKEN；探测与上报密钥一律不出现。
    expect(raw).not.toContain('secrets.INGEST_SECRET');
    expect(raw).not.toContain('secrets.CF_API_TOKEN');
    expect(raw).not.toContain('secrets.RUNNER_TOKEN');
    expect(JSON.stringify(namedStep(probe, '探测'))).not.toContain('secrets.');
    expect(JSON.stringify(namedStep(probe, '自动发现候选'))).toContain('secrets.GITHUB_TOKEN');
    expect(checkoutStep(probe).with?.['persist-credentials']).toBe(false);
    expect(probe['timeout-minutes']).toBeLessThanOrEqual(20);
  });

  it('探测命令支持手动参数且默认全量', async () => {
    const doc = await loadWorkflow();
    const step = namedStep(doc.jobs.probe, '探测');
    expect(step.run).toContain('pnpm probe');
    expect(step.run).toContain('--concurrency "${INPUT_CONCURRENCY:-4}"');
    expect(Object.keys(step.env ?? {}).sort()).toEqual([
      'INPUT_CONCURRENCY',
      'INPUT_DEEP',
      'INPUT_LIMIT',
      'INPUT_ONLY',
      'INPUT_PREFER_MIRROR',
    ]);
  });

  it('上传探测产物并在上报 job 中下载', async () => {
    const doc = await loadWorkflow();
    const upload = doc.jobs.probe.steps.find((s) => s.uses?.startsWith('actions/upload-artifact'));
    expect(upload?.with?.name).toBe('probe-result');
    expect(String(upload?.with?.path)).toContain('out/status.json');

    const publish = doc.jobs.publish;
    expect(publish.needs).toEqual(['probe', 'cn']);
    const downloads = publish.steps.filter((s) => s.uses?.startsWith('actions/download-artifact'));
    expect(downloads.map((step) => step.with?.name)).toEqual(['probe-result', 'cn-result', 'candidates-result']);
  });

  it('国内补测 job 不接触上报密钥，并缓存 mihomo 内核', async () => {
    const doc = await loadWorkflow();
    const cn = doc.jobs.cn;
    expect(cn).toBeDefined();
    expect(cn.needs).toBe('probe');
    expect(JSON.stringify(cn)).not.toContain('secrets.INGEST_SECRET');
    expect(JSON.stringify(cn)).toContain('secrets.RUNNER_TOKEN');
    expect(JSON.stringify(cn)).not.toContain('pnpm probe');

    const cache = cn.steps.find((s) => s.uses?.startsWith('actions/cache'));
    expect(cache?.with?.key).toBe('mihomo-v1.19.9');

    const download = cn.steps.find((s) => s.uses?.startsWith('actions/download-artifact'));
    expect(download?.with?.name).toBe('probe-result');

    const upload = cn.steps.find((s) => s.uses?.startsWith('actions/upload-artifact'));
    expect(upload?.with?.name).toBe('cn-result');
  });

  it('上报 job 只做 JSON 上报，不执行探测', async () => {
    const doc = await loadWorkflow();
    const publish = doc.jobs.publish;
    expect(JSON.stringify(publish)).not.toContain('pnpm probe');
    const ingest = namedStep(publish, '上报');
    expect(ingest.run).toContain('pnpm ingest');
    expect(ingest.run).toContain('--endpoint');
    expect(ingest.run).toContain('--cn');
    expect(ingest.if).toContain('INGEST_URL');
    expect(publish.env?.INGEST_SECRET).toContain('secrets.INGEST_SECRET');
    expect(publish.environment).toBe('production');
    expect(checkoutStep(publish).with?.['persist-credentials']).toBe(false);
  });

  it('手动触发可开关自动发现与国内补测，并透传并发', async () => {
    const doc = await loadWorkflow();
    const inputs = doc.on?.workflow_dispatch?.inputs ?? {};
    expect(inputs.concurrency).toBeDefined();
    expect(inputs.cn).toBeDefined();
    expect(inputs.discover).toBeDefined();

    const discover = namedStep(doc.jobs.probe, '自动发现候选');
    expect(String(discover.if)).toContain('inputs.discover');
    expect(String(doc.jobs.cn.if)).toContain('inputs.cn');
  });
});
