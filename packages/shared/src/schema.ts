import { z } from 'zod';
import { ERROR_KINDS } from './errors.js';
import { QUALITY_PRIORITY } from './constants.js';
import { SOURCE_STATUSES, type SourceStatus } from './status.js';

const isoDateTime = z
  .string()
  .min(10)
  .refine((s) => !Number.isNaN(Date.parse(s)), '无效的 ISO 时间');

const httpUrl = z
  .string()
  .min(8)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, '必须是 http(s) URL');

export const QualitySchema = z.enum(QUALITY_PRIORITY);
export const SourceStatusSchema = z.enum(SOURCE_STATUSES);
export const ErrorKindSchema = z.enum(ERROR_KINDS);

export const CnResultSchema = z.object({
  tested: z.boolean(),
  ok: z.boolean(),
  ms: z.number().int().nonnegative().optional(),
  ttfbMs: z.number().int().nonnegative().optional(),
  errorKind: ErrorKindSchema.optional(),
  error: z.string().max(500).optional(),
  httpStatus: z.number().int().optional(),
  /** 代理标签（host:port），绝不包含账号密码。 */
  proxy: z.string().max(120).optional(),
});
export type CnResult = z.infer<typeof CnResultSchema>;

export const PlatformResultSchema = z.object({
  key: z.string().min(1).max(32),
  name: z.string().min(1).max(64),
  declared: z.boolean().default(true),
  tested: z.boolean(),
  ok: z.boolean(),
  quality: QualitySchema.optional(),
  /** 取链耗时（脚本调用平台接口到拿到 URL）。 */
  resolveMs: z.number().int().nonnegative().optional(),
  /** 拉流首字节耗时（含 DNS/TLS/重定向）。 */
  ttfbMs: z.number().int().nonnegative().optional(),
  /** 该平台本轮总耗时。 */
  totalMs: z.number().int().nonnegative().optional(),
  errorKind: ErrorKindSchema.optional(),
  error: z.string().max(500).optional(),
  urlHost: z.string().max(160).optional(),
  httpStatus: z.number().int().optional(),
  contentType: z.string().max(160).optional(),
  cn: CnResultSchema.optional(),
});
export type PlatformResult = z.infer<typeof PlatformResultSchema>;

export const SourceStatsSchema = z.object({
  ok: z.number().int().nonnegative(),
  tested: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type SourceStats = z.infer<typeof SourceStatsSchema>;

export const EndpointResultSchema = z.object({
  url: httpUrl,
  /** primary=清单主地址；candidate=镜像/加速候选。 */
  role: z.enum(['primary', 'candidate']),
  ok: z.boolean(),
  status: z.number().int().optional(),
  sha: z.string().max(64).optional(),
  /** 完整 sha256（十六进制），用于跨地址的内容去重；sha 是兼容用的短指纹。 */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  bytes: z.number().int().nonnegative().optional(),
  version: z.string().max(40).optional(),
  /** synced=与主地址同 sha；lagging=可下载但内容不同；unknown=主地址不可用无法比对。 */
  versionState: z.enum(['synced', 'lagging', 'unknown']).optional(),
  ms: z.number().int().nonnegative(),
  error: z.string().max(300).optional(),
  /** 国内代理补测结果；独立于海外下载是否成功。 */
  cn: CnResultSchema.optional(),
  checkedAt: isoDateTime,
});
export type EndpointResult = z.infer<typeof EndpointResultSchema>;

export const SourceResultSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  url: httpUrl,
  mirror: httpUrl.optional(),
  homepage: httpUrl.optional(),
  category: z.string().max(40).default('在线'),
  storage: z.enum(['remote', 'repo']),
  version: z.string().max(40).optional(),
  author: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  expire: z.string().max(40).optional(),
  /** 脚本内容的 sha256 前 16 位，用于发现“同源换皮”。 */
  scriptSha: z.string().max(64).optional(),
  /** 完整 sha256，用于跨音源判重。 */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** 所有接入点（主地址 + 镜像/加速候选）的下载检查结果。 */
  endpoints: z.array(EndpointResultSchema).max(16).default([]),
  status: SourceStatusSchema,
  /** 脚本能否完成 inited。 */
  initOk: z.boolean(),
  initError: z.string().max(500).optional(),
  stats: SourceStatsSchema,
  platforms: z.array(PlatformResultSchema),
  checkedAt: isoDateTime,
  durationMs: z.number().int().nonnegative(),
});
export type SourceResult = z.infer<typeof SourceResultSchema>;

export const SummarySchema = z.object({
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  untested: z.number().int().nonnegative(),
  platformsOk: z.number().int().nonnegative(),
  platformsTested: z.number().int().nonnegative(),
});
export type Summary = z.infer<typeof SummarySchema>;

export const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(6).max(64),
  generatedAt: isoDateTime,
  nextCheckAt: isoDateTime,
  intervalHours: z.number().positive().max(24),
  runner: z.enum(['github-actions', 'local', 'manual']),
  checkScope: z.enum(['all', 'partial']),
  durationMs: z.number().int().nonnegative(),
  summary: SummarySchema,
  sources: z.array(SourceResultSchema).max(300),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const CandidateSchema = z.object({
  id: z.string().min(6).max(64),
  repo: z.string().min(3).max(120),
  path: z.string().min(1).max(300),
  url: httpUrl,
  sha: z.string().min(6).max(64),
  /** 完整 sha256；下载体检后写入，用于跨仓库内容去重。 */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  title: z.string().max(160).optional(),
  version: z.string().max(40).optional(),
  author: z.string().max(80).optional(),
  description: z.string().max(300).optional(),
  platforms: z.array(z.string().max(32)).max(24).default([]),
  bytes: z.number().int().nonnegative().optional(),
  initOk: z.boolean().optional(),
  initError: z.string().max(300).optional(),
  state: z.enum(['new', 'qualified', 'rejected', 'promoted', 'duplicate']).default('new'),
  firstSeen: isoDateTime.optional(),
  lastSeen: isoDateTime.optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoDateTime,
  candidates: z.array(CandidateSchema).max(2000),
});
export type CandidateFile = z.infer<typeof CandidateFileSchema>;

export const RunStepSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  status: z.enum(['pending', 'running', 'success', 'skipped', 'failed']),
  startedAt: isoDateTime.optional(),
  finishedAt: isoDateTime.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  message: z.string().max(500).optional(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunCountsSchema = z.object({
  endpointsOk: z.number().int().nonnegative().default(0),
  endpointsTotal: z.number().int().nonnegative().default(0),
  cnTested: z.number().int().nonnegative().default(0),
  cnOk: z.number().int().nonnegative().default(0),
  candidatesAdded: z.number().int().nonnegative().default(0),
  candidatesPromoted: z.number().int().nonnegative().default(0),
  proxiesUsed: z.number().int().nonnegative().default(0),
});
export type RunCounts = z.infer<typeof RunCountsSchema>;

export const RunMetaSchema = z.object({
  taskId: z.string().min(1).max(64).optional(),
  trigger: z.enum(['schedule', 'manual', 'retry', 'local']).default('manual'),
  /** 不传时由 Worker 按快照结果推导。 */
  status: z.enum(['success', 'partial', 'failed']).optional(),
  startedAt: isoDateTime.optional(),
  message: z.string().max(500).default(''),
  error: z.string().max(1000).optional(),
  warnings: z.array(z.string().max(300)).max(50).default([]),
  steps: z.array(RunStepSchema).max(30).default([]),
  /** 本次运行的完整日志（通常几十 KB），由 Worker 写入 KV。 */
  log: z.string().max(200_000).optional(),
  counts: RunCountsSchema.optional(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const IngestPayloadSchema = z.object({
  snapshot: SnapshotSchema,
  /** 自动发现的新候选，只做静态元数据 + init 结果，不影响公开状态。 */
  candidates: z.array(CandidateSchema).max(200).optional(),
  /** 任务、触发方式、步骤与日志；旧版 runner 可省略。 */
  meta: RunMetaSchema.optional(),
});
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

/** 代理测活单节点结果，runner 回传给 Worker 用于任务完成与运行记录。 */
export const ProxyTestRowSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  protocol: z.string().max(24).optional(),
  host: z.string().max(255).optional(),
  port: z.number().int().nonnegative().max(65535).optional(),
  subscriptionId: z.string().max(64).nullable().optional(),
  kernelOnly: z.boolean().default(false),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().max(3_600_000),
  country: z.string().max(40).optional(),
  asn: z.string().max(40).optional(),
  error: z.string().max(300).optional(),
  testedAt: isoDateTime.optional(),
});
export type ProxyTestRow = z.infer<typeof ProxyTestRowSchema>;

export const ProxyTestReportSchema = z.object({
  runId: z.string().min(6).max(64),
  taskId: z.string().min(1).max(64).optional(),
  total: z.number().int().nonnegative().max(5000),
  ok: z.number().int().nonnegative().max(5000),
  kernelOk: z.number().int().nonnegative().max(5000).default(0),
  skippedUdp: z.number().int().nonnegative().max(5000).default(0),
  durationMs: z.number().int().nonnegative().max(24 * 3600 * 1000),
  results: z.array(ProxyTestRowSchema).max(5000).default([]),
});
export type ProxyTestReport = z.infer<typeof ProxyTestReportSchema>;

/* ------------------------------- registry -------------------------------- */

export const RegistrySourceSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id 只能包含小写字母、数字、- 和 _'),
    title: z.string().min(1).max(160),
    storage: z.enum(['remote', 'repo']).default('remote'),
    url: httpUrl.optional(),
    mirror: httpUrl.optional(),
    /** 显式声明的镜像/加速地址；未声明时按主地址自动生成候选。 */
    mirrors: z.array(httpUrl).max(10).default([]),
    path: z.string().max(300).optional(),
    homepage: httpUrl.optional(),
    category: z.string().max(40).default('在线'),
    enabled: z.boolean().default(true),
    /** 是否允许在“国内补测 --resolve”模式下执行（默认只测已解析 URL）。 */
    trusted: z.boolean().default(true),
    notes: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.storage === 'remote' && !v.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'remote 源必须提供 url' });
    }
    if (v.storage === 'repo' && !v.path) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'repo 源必须提供 path' });
    }
  });
export type RegistrySource = z.infer<typeof RegistrySourceSchema>;

export const RegistrySchema = z
  .object({
    version: z.literal(1),
    sources: z.array(RegistrySourceSchema).max(300),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of v.sources.entries()) {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'id'], message: `重复的 id: ${s.id}` });
      }
      seen.add(s.id);
    }
  });
export type Registry = z.infer<typeof RegistrySchema>;

/* ------------------------------- discovery ------------------------------- */

export const DiscoveryRepoSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式 owner/name'),
  branch: z.string().default('main'),
  /** 只扫描这些路径前缀；为空表示全仓库。 */
  pathPrefixes: z.array(z.string()).default([]),
  /** 排除包含这些片段的路径。 */
  exclude: z.array(z.string()).default(['node_modules', '.min.js', 'dist/']),
  enabled: z.boolean().default(true),
});
export type DiscoveryRepo = z.infer<typeof DiscoveryRepoSchema>;

export const DiscoveryConfigSchema = z.object({
  version: z.literal(1),
  repos: z.array(DiscoveryRepoSchema).max(50),
  /** 每次最多抓取多少个新脚本。 */
  maxFetchPerRun: z.number().int().positive().max(80).default(20),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/* --------------------------------- api ---------------------------------- */

export interface StatusEnvelope {
  snapshot: Snapshot;
  serverTime: string;
  /** 快照超过 2 个检测周期未更新。 */
  stale: boolean;
}

export interface SourceRunSummary {
  runId: string;
  finishedAt: string;
  status: SourceStatus;
  ok: number;
  tested: number;
  total: number;
  durationMs: number;
}

export interface DailyRow {
  day: string;
  runs: number;
  okSum: number;
  testedSum: number;
  totalSum: number;
  status: SourceStatus;
  avgMs: number | null;
}

export interface PlatformDailyRow {
  day: string;
  okCount: number;
  testedCount: number;
  avgMs: number | null;
}

export interface EndpointRow {
  url: string;
  role: 'primary' | 'candidate';
  ok: boolean;
  status: number | null;
  sha: string | null;
  /** 完整内容指纹（sha256 hex），用于跨 URL 判重；历史数据可能为空。 */
  sha256: string | null;
  version: string | null;
  versionState: 'synced' | 'lagging' | 'unknown' | null;
  bytes: number | null;
  ms: number;
  error: string | null;
  /** 国内代理补测结果（4B）；旧数据为 null。 */
  cn: CnResult | null;
  checkedAt: string;
}

export interface SourceDetailResponse {
  source: SourceResult;
  /** 最近一轮各接入点的下载检查结果。 */
  endpoints: EndpointRow[];
  history: SourceRunSummary[];
  daily: DailyRow[];
  platformDaily: PlatformDailyRow[];
  generatedAt: string;
}

export interface RunSummary {
  id: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  available: number;
  partial: number;
  unavailable: number;
  untested: number;
  platformsOk: number;
  platformsTested: number;
  /** 1A 起写入；旧数据可能为空。 */
  status?: 'success' | 'partial' | 'failed' | 'running';
  trigger?: string;
  message?: string;
  error?: string | null;
  taskId?: string | null;
  startedAt?: string | null;
  logKey?: string | null;
  /** 整轮运行的关键计数，1A 起写入；旧运行可能为空。 */
  counts?: RunCounts;
  /** 分步耗时（取清单、下载接入点、平台测试、国内补测、上报等）。 */
  steps?: RunStep[];
  /** 运行期间收集到的警告条数（详情里再展开具体内容）。 */
  warningCount?: number;
}

export interface EventItem {
  id: string;
  at: string;
  type: 'recovered' | 'degraded' | 'failed' | 'new' | 'updated' | 'merged';
  sourceId: string;
  title: string;
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  lastRun: RunSummary | null;
  stale: boolean;
  sources: number;
  candidates: number;
  serverTime: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

export interface ExportItem {
  id: string;
  title: string;
  url: string;
  mirror?: string;
  homepage?: string;
  status: SourceStatus;
  ok: number;
  tested: number;
  total: number;
  platforms: { key: string; ok: boolean; tested: boolean; ms?: number }[];
}
