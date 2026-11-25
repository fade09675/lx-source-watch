#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  CandidateFileSchema,
  DiscoveryConfigSchema,
  SnapshotSchema,
  type Quality,
} from '@lx/shared';
import { cnExecute, cnVerify } from './cn.js';
import { runProxyTest } from './cn/proxyTest.js';
import { runProxyFetch } from './cn/proxyFetch.js';
import { cnRun } from './cn/run.js';
import { enrichCandidates } from './candidates.js';
import { discoverCandidates } from './discover.js';
import { log } from './logger.js';
import { parseProxy } from './net/http.js';
import { publishIngest } from './publish.js';
import { runProbe } from './probe/run.js';
import { loadRegistry } from './registry.js';
import { errorMessage } from './util.js';

/**
 * 音源脚本是第三方代码：它们可能在 Promise 链或定时器里抛错。
 * Node 默认会把未处理拒绝升级为进程崩溃，这里降级为日志，保证单源失败不拖垮整轮。
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    log.debug(`已忽略未处理拒绝：${errorMessage(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log.error(`脚本异步异常（已忽略，继续本轮）：${errorMessage(err)}`);
  });
}

interface Args {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { positionals, flags };
}

function str(args: Args, name: string, fallback?: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : fallback;
}

function num(args: Args, name: string, fallback?: number): number | undefined {
  const v = str(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(args: Args, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function qualityArg(args: Args): Quality | 'auto' | undefined {
  const v = str(args, 'quality');
  if (!v) return undefined;
  return v as Quality | 'auto';
}

const HELP = `
lx-source-watch runner

用法：
  pnpm probe [选项]        监测来源清单并写出快照
  pnpm discover [选项]     从 GitHub 发现候选脚本
  pnpm candidates [选项]   对候选脚本做初始化体检
  pnpm cn [选项]           国内代理补测（verify=只测已解析 URL / --execute 重跑脚本）
  pnpm proxy-test [选项]   代理池测活：出口、地区、成功率写回
  pnpm proxy-fetch [选项]  Actions 侧拉取代理订阅并回传 Worker 解析
  pnpm publish [选项]      把快照 HMAC 签名后上报 Worker
  pnpm validate            校验清单/配置/快照/候选文件

probe:
  --registry <path>         来源清单，默认 sources/registry.json
  --out <path>              快照输出，默认 out/status.json
  --urls <path>             URL 清单，默认 out/urls.json
  --merge <path>            合并上一轮快照（未测来源保留）
  --only a,b                只测指定 id
  --limit <n>               最多测 n 个
  --mode default|deep|skip-verify
  --deep                    等价于 --mode deep（从最高音质开始）
  --skip-verify             只取链不拉流（调试用）
  --quality 128k|320k|flac|flac24bit
  --concurrency <n>         源并发，默认 2
  --platform-concurrency <n> 平台并发，默认 4
  --timeout <ms>            取链超时，默认 30000
  --platform-timeout <ms>   单平台总超时，默认 20000
  --stream-timeout <ms>     拉流超时，默认 12000
  --proxy <url>             出口代理（http/socks）
  --registry-url <url>      从接口读取音源清单（默认读 LX_REGISTRY_URL，失败回退本地文件）
  --prefer-mirror           下载脚本时先走镜像（国内网络建议开启）
  --config-url <url>        镜像模板接口（默认读 LX_CONFIG_URL，Actions 用 dash.dpdns.org）
  --mirror-timeout <ms>     镜像下载超时，默认 8000
  --run-id <id>             任务系统预分配的运行 id（留空自动生成）

discover:
  --config <path>           发现配置，默认 sources/discovery.json
  --out <path>              候选输出，默认 out/candidates.json
  --seed <path>             额外种子候选
  --max-fetch <n>           本跑最多抓取数（默认取配置）
  --token <token>           GitHub Token，默认读 GITHUB_TOKEN

cn:
  --urls-in <path>          默认 out/urls.json
  --out <path>              默认 out/cn.json
  --endpoint <url>          从 Worker 代理池取节点（默认读 INGEST_URL）
  --token <token>           Runner Token（默认读 RUNNER_TOKEN）
  --proxy-id <id>           指定代理节点
  --max-proxies <n>         最多预检几个节点，默认 8
  --max-hops <n>            内核节点最多试几个跳板，默认取设置（5）
  --all                     国内补测全部地址（默认只测海外未通过的地址）
  --status-in <path>        探测快照，用来补测接入点，默认 out/status.json
  --skip-endpoints          跳过接入点国内连通性补测
  --proxy <url>             直接指定代理，跳过代理池
  --execute                 走代理重新执行脚本（危险，仅 trusted 来源）
  --registry <path>
  --only a,b --platform kg --limit <n> --concurrency <n> --timeout <ms>

proxy-test:
  --endpoint <url>          默认读 INGEST_URL
  --token <token>           默认读 RUNNER_TOKEN
  --proxy-id <id>           只测指定节点
  --sub-id <id>             只测指定订阅下的节点
  --concurrency <n>         测活并发，默认取设置（5），最高 10
  --max-hops <n>            内核节点最多试几个跳板，默认取设置（5）
  --timeout <ms>            单节点超时，默认取设置（20000）
  --limit <n>               最多测 n 个（调试用）
  --allow-private           允许访问 127.0.0.1（仅本地联调）

proxy-fetch:
  --endpoint <url>          默认读 INGEST_URL
  --token <token>           默认读 RUNNER_TOKEN
  --sub-id <id>             订阅 id（必填，或环境变量 LX_SUBSCRIPTION_ID）
  --task-id <id>            关联任务 id
  --run-id <id>             关联运行 id
  --max-bytes <n>           订阅内容上限，默认 2MB

publish:
  --snapshot <path>         默认 out/status.json
  --cn <path>               国内补测结果，默认 out/cn.json（存在才合并）
  --candidates <path>       默认 out/candidates.json（存在才带）
  --endpoint <url>          默认读 INGEST_URL
  --secret <secret>         默认读 INGEST_SECRET
  --task-id <id>            关联的任务 id
  --trigger schedule|manual|retry|local  触发方式
  --log <path>              运行日志文件（存在才上报）
  --dry-run                 只生成本地请求体
  --allow-private           允许上报到 127.0.0.1（仅本地联调）

环境变量：
  LX_PROXY_URL / CN_PROXY_URL / INGEST_URL / INGEST_SECRET / RUNNER_TOKEN / GITHUB_TOKEN / RAW_BASE
  LX_PREFER_MIRROR=1 等价于 --prefer-mirror；INGEST_ALLOW_PRIVATE=1 等价于 --allow-private
`.trim();

async function cmdProbe(args: Args): Promise<void> {
  const mode = bool(args, 'deep') ? 'deep' : bool(args, 'skip-verify') ? 'skip-verify' : (str(args, 'mode') as 'default' | 'deep' | 'skip-verify' | undefined) ?? 'default';
  await runProbe({
    registryPath: str(args, 'registry', 'sources/registry.json') as string,
    registryUrl: str(args, 'registry-url') ?? process.env.LX_REGISTRY_URL,
    outPath: str(args, 'out', 'out/status.json') as string,
    urlsPath: str(args, 'urls', 'out/urls.json') as string,
    mergeFrom: str(args, 'merge'),
    only: splitList(str(args, 'only')),
    limit: num(args, 'limit'),
    sourceConcurrency: num(args, 'concurrency', 2),
    platformConcurrency: num(args, 'platform-concurrency', 4),
    mode,
    quality: qualityArg(args),
    requestTimeoutMs: num(args, 'timeout', 30_000),
    platformTimeoutMs: num(args, 'platform-timeout', 20_000),
    streamTimeoutMs: num(args, 'stream-timeout', 12_000),
    proxy: parseProxy(str(args, 'proxy') ?? process.env.LX_PROXY_URL),
    preferMirror: bool(args, 'prefer-mirror') || process.env.LX_PREFER_MIRROR === '1',
    configUrl: str(args, 'config-url') ?? process.env.LX_CONFIG_URL,
    mirrorTimeoutMs: num(args, 'mirror-timeout', 8_000),
    runId: str(args, 'run-id') ?? process.env.LX_RUN_ID,
  });
}

async function cmdDiscover(args: Args): Promise<void> {
  await discoverCandidates({
    configPath: str(args, 'config', 'sources/discovery.json') as string,
    outPath: str(args, 'out', 'out/candidates.json') as string,
    seedPath: str(args, 'seed'),
    maxFetchPerRun: num(args, 'max-fetch'),
    token: str(args, 'token'),
    proxy: parseProxy(str(args, 'proxy') ?? process.env.LX_PROXY_URL),
  });
}

async function cmdCandidates(args: Args): Promise<void> {
  await enrichCandidates({
    candidatesPath: str(args, 'in', 'out/candidates.json') as string,
    outPath: str(args, 'out'),
    limit: num(args, 'limit', 12),
    concurrency: num(args, 'concurrency', 3),
    proxy: parseProxy(str(args, 'proxy') ?? process.env.LX_PROXY_URL),
  });
}

async function cmdCn(args: Args): Promise<void> {
  const endpoint = str(args, 'endpoint') ?? process.env.INGEST_URL ?? '';
  const token = str(args, 'token') ?? process.env.RUNNER_TOKEN ?? '';
  if (!bool(args, 'execute') && endpoint && token && !str(args, 'proxy')) {
    await cnRun({
      urlsPath: str(args, 'urls-in', 'out/urls.json') as string,
      outPath: str(args, 'out', 'out/cn.json') as string,
      endpoint,
      token,
      preferredId: str(args, 'proxy-id'),
      maxProxies: num(args, 'max-proxies', 8),
      maxHops: num(args, 'max-hops', 0),
      concurrency: num(args, 'concurrency', 5),
      timeoutMs: num(args, 'timeout', 15_000),
      limit: num(args, 'limit'),
      platform: str(args, 'platform'),
      scope: bool(args, 'all') ? 'all' : 'failed',
      statusPath: str(args, 'status-in', 'out/status.json') as string,
      skipEndpoints: bool(args, 'skip-endpoints'),
      allowPrivate: bool(args, 'allow-private') || process.env.INGEST_ALLOW_PRIVATE === '1',
    });
    return;
  }

  const proxy = parseProxy(str(args, 'proxy') ?? process.env.CN_PROXY_URL);
  if (!proxy) throw new Error('缺少国内代理：传 --proxy、设置 CN_PROXY_URL，或用 --endpoint + --token 从代理池取');
  if (bool(args, 'execute')) {
    await cnExecute({
      registryPath: str(args, 'registry', 'sources/registry.json') as string,
      outPath: str(args, 'out', 'out/cn-execute.json') as string,
      proxy,
      only: splitList(str(args, 'only')),
      limit: num(args, 'limit', 5),
      concurrency: num(args, 'concurrency', 1),
      timeoutMs: num(args, 'timeout', 15_000),
      platform: str(args, 'platform'),
    });
    return;
  }
  await cnVerify({
    urlsPath: str(args, 'urls-in', 'out/urls.json') as string,
    outPath: str(args, 'out', 'out/cn.json') as string,
    proxy,
    concurrency: num(args, 'concurrency', 5),
    timeoutMs: num(args, 'timeout', 15_000),
    limit: num(args, 'limit'),
    platform: str(args, 'platform'),
    scope: bool(args, 'all') ? 'all' : 'failed',
    statusPath: str(args, 'status-in', 'out/status.json') as string,
    skipEndpoints: bool(args, 'skip-endpoints'),
  });
}

async function cmdProxyTest(args: Args): Promise<void> {
  const endpoint = str(args, 'endpoint') ?? process.env.INGEST_URL ?? '';
  const token = str(args, 'token') ?? process.env.RUNNER_TOKEN ?? '';
  if (!endpoint) throw new Error('缺少 --endpoint 或 INGEST_URL');
  if (!token) throw new Error('缺少 --token 或 RUNNER_TOKEN');
  const summary = await runProxyTest({
    endpoint,
    token,
    taskId: str(args, 'task-id') ?? process.env.LX_TASK_ID,
    runId: str(args, 'run-id') ?? process.env.LX_RUN_ID,
    proxyId: str(args, 'proxy-id'),
    subscriptionId: str(args, 'sub-id'),
    concurrency: num(args, 'concurrency', 0),
    maxHops: num(args, 'max-hops', 0),
    timeoutMs: num(args, 'timeout', 0),
    limit: num(args, 'limit'),
    allowPrivate: bool(args, 'allow-private') || process.env.INGEST_ALLOW_PRIVATE === '1',
  });
  log.success(
    `测活完成：${summary.ok}/${summary.total} 可用（内核 ${summary.kernelOk}），跳过 UDP ${summary.skippedUdp}，${Math.round(summary.durationMs / 1000)}s`,
  );
}

async function cmdProxyFetch(args: Args): Promise<void> {
  const endpoint = str(args, 'endpoint') ?? process.env.INGEST_URL ?? '';
  const token = str(args, 'token') ?? process.env.RUNNER_TOKEN ?? '';
  const subscriptionId = str(args, 'sub-id') ?? process.env.LX_SUBSCRIPTION_ID ?? '';
  if (!endpoint) throw new Error('缺少 --endpoint 或 INGEST_URL');
  if (!token) throw new Error('缺少 --token 或 RUNNER_TOKEN');
  if (!subscriptionId) throw new Error('缺少 --sub-id 或 LX_SUBSCRIPTION_ID');
  const code = await runProxyFetch({
    endpoint,
    token,
    subscriptionId,
    taskId: str(args, 'task-id') ?? process.env.LX_TASK_ID,
    runId: str(args, 'run-id') ?? process.env.LX_RUN_ID,
    maxBytes: num(args, 'max-bytes'),
  });
  if (code !== 0) process.exitCode = code;
}

async function cmdPublish(args: Args): Promise<void> {
  const endpoint = str(args, 'endpoint') ?? process.env.INGEST_URL ?? '';
  const secret = str(args, 'secret') ?? process.env.INGEST_SECRET ?? '';
  const dryRun = bool(args, 'dry-run');
  if (!dryRun && !endpoint) throw new Error('缺少 --endpoint 或 INGEST_URL');
  if (!dryRun && !secret) throw new Error('缺少 --secret 或 INGEST_SECRET');
  await publishIngest({
    snapshotPath: str(args, 'snapshot', 'out/status.json') as string,
    cnPath: str(args, 'cn', 'out/cn.json'),
    candidatesPath: str(args, 'candidates', 'out/candidates.json'),
    endpoint,
    secret,
    dryRun,
    taskId: str(args, 'task-id') ?? process.env.LX_TASK_ID,
    trigger: (str(args, 'trigger') ?? process.env.LX_TRIGGER) as
      | 'schedule'
      | 'manual'
      | 'retry'
      | 'local'
      | undefined,
    logPath: str(args, 'log') ?? process.env.LX_RUN_LOG,
    allowPrivate: bool(args, 'allow-private') || process.env.INGEST_ALLOW_PRIVATE === '1',
  });
}

async function cmdValidate(): Promise<void> {
  const errors: string[] = [];
  let registryCount = 0;
  try {
    const sources = await loadRegistry('sources/registry.json');
    registryCount = sources.length;
  } catch (e) {
    errors.push(`registry: ${(e as Error).message}`);
  }
  try {
    DiscoveryConfigSchema.parse(JSON.parse(await readFile('sources/discovery.json', 'utf8')));
  } catch (e) {
    errors.push(`discovery: ${(e as Error).message}`);
  }
  try {
    const snap = SnapshotSchema.parse(JSON.parse(await readFile('out/status.json', 'utf8')));
    log.info(`snapshot: ${snap.summary.total} 源 / ${snap.summary.platformsOk} 通过 / ${snap.summary.platformsTested} 已测`);
  } catch {
    log.info('snapshot: 尚无（跳过）');
  }
  try {
    const cand = CandidateFileSchema.parse(JSON.parse(await readFile('out/candidates.json', 'utf8')));
    log.info(`candidates: ${cand.candidates.length} 个`);
  } catch {
    log.info('candidates: 尚无（跳过）');
  }
  if (errors.length) {
    for (const e of errors) log.error(e);
    process.exitCode = 1;
    return;
  }
  log.success(`校验通过：来源 ${registryCount} 个`);
}

async function main(): Promise<void> {
  installProcessGuards();
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help')) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return;
  }
  const cmd = args.positionals[0];
  switch (cmd) {
    case 'probe':
      await cmdProbe(args);
      break;
    case 'discover':
      await cmdDiscover(args);
      break;
    case 'candidates':
      await cmdCandidates(args);
      break;
    case 'cn':
      await cmdCn(args);
      break;
    case 'proxy-test':
      await cmdProxyTest(args);
      break;
    case 'proxy-fetch':
      await cmdProxyFetch(args);
      break;
    case 'publish':
      await cmdPublish(args);
      break;
    case 'validate':
      await cmdValidate();
      break;
    case 'help':
    case undefined:
      // eslint-disable-next-line no-console
      console.log(HELP);
      break;
    default:
      log.error(`未知命令：${cmd}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  log.error((e as Error)?.stack ?? String(e));
  process.exitCode = 1;
});

export { parseArgs };
