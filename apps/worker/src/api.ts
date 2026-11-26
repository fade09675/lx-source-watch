import { SCHEMA_VERSION, SnapshotSchema, type ExportItem, type Snapshot, type SourceResult, type StatusEnvelope } from '@lx/shared';
import { Hono } from 'hono';
import { toCsv } from './csv';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  clearLoginFailures,
  createSessionToken,
  hashPassword,
  loginAllowed,
  MIN_PASSWORD_LENGTH,
  noteLoginFailure,
  readCookie,
  SESSION_COOKIE,
  verifyPassword,
} from './auth';
import {
  countCandidates,
  countCandidatesByState,
  deleteCandidatesByState,
  getCandidate,
  getCandidates,
  getEvents,
  getFailureAggregate,
  getLastRun,
  getPlatformSummary,
  getRun,
  getRunEndpointRows,
  getRunEndpointStats,
  getRunPlatforms,
  getRuns,
  getRunsPage,
  getRunSources,
  getSetting,
  getSourceDaily,
  getSourceEndpoints,
  getSourceHistory,
  getSourceMetas,
  getSourcePlatformDaily,
  setCandidateState,
  touchSetting,
} from './db';
import type { Env } from './env';
import { ADMIN_PASSWORD_SETTING, SNAPSHOT_KEY } from './env';
import { filterSnapshot, parseList } from './filter';
import { handleIngest } from './ingest';
import { getProxyTestRun, listProxyTestRuns } from './proxyTestLogs';
import { isStale } from './merge';
import { dispatchProbe, dispatchProxyTest, listAllRuns, listProbeRuns } from './dispatch';
import { getUsage, recordKvPut, refreshUsage } from './usage';
import { getMirrorTemplates, resetMirrorTemplates, saveMirrorTemplates, MirrorConfigError } from './mirrors';
import {
  buildRegistryLinks,
  createSourceRegistry,
  deleteSourceRegistry,
  getSourceRegistry,
  listSourceRegistry,
  toPublicRegistry,
  updateSourceRegistry,
  type SourceInput,
} from './sourceRegistry';
import { getSchedulerStatus } from './scheduler';
import { autoPromoteCandidates, promoteCandidate } from './candidatePromotion';
import { loadSettings, resetSettings, saveSettings } from './settings';
import { executeRunPurge, planRunPurge } from './maintenance';
import { listDuplicateOverview } from './dedup';
import { markCandidateDuplicate, mergeIntoCanonical } from './mergeSources';
import { listAliases, setAliasState } from './aliases';
import {
  cancelTask,
  countTasks,
  countTasksFiltered,
  createTask,
  dispatchNext,
  getTask,
  getTaskState,
  listTasks,
  reapStaleTasks,
  refreshTaskState,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
  type TaskPayload,
  type TaskSource,
  type TaskStatus,
  type TaskType,
} from './tasks';
import { listAdminActivity } from './activity';
import {
  createDiscoveryRepo,
  deleteDiscoveryRepo,
  listDiscoveryRepos,
  publicDiscoveryRepos,
  updateDiscoveryRepo,
} from './discoveryRepos';
import { importBackupUrls, previewBackupUrls, type BackupImportItem } from './sourceBackups';

type Ctx = { Bindings: Env };

// 整站需要登录，任何响应都不允许被共享缓存保存。
const CACHE_PRIVATE = 'private, no-store';

const CANDIDATE_STATES = ['new', 'qualified', 'rejected', 'promoted', 'duplicate'];

function isSecure(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === 'https:';
}

async function readPasswordHash(env: Env): Promise<string | null> {
  return (await getSetting(env.DB, ADMIN_PASSWORD_SETTING)) ?? env.ADMIN_PASSWORD_HASH ?? null;
}

async function readSnapshot(env: Env): Promise<Snapshot | null> {
  const raw = await env.SNAPSHOT.get(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return SnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function notReady(): Response {
  return Response.json({ error: 'not_ready', message: '还没有任何检测结果，等待 Actions 首次上报' }, { status: 503 });
}

function notFound(message: string): Response {
  return Response.json({ error: 'not_found', message }, { status: 404 });
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function toExportItem(source: SourceResult): ExportItem {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    mirror: source.mirror,
    homepage: source.homepage,
    status: source.status,
    ok: source.stats.ok,
    tested: source.stats.tested,
    total: source.stats.total,
    platforms: source.platforms.map((platform) => ({
      key: platform.key,
      ok: platform.ok,
      tested: platform.tested,
      ms: platform.totalMs,
    })),
  };
}

export function createApi(): Hono<Ctx> {
  const api = new Hono<Ctx>();

  api.post('/ingest', handleIngest);

  api.get('/auth/me', (c) => c.json({ ok: true, site: c.env.SITE_NAME ?? 'LX 音源监测' }, 200, { 'cache-control': CACHE_PRIVATE }));

  api.post('/auth/login', async (c) => {
    if (!c.env.SESSION_SECRET) {
      return c.json({ error: 'not_configured', message: '服务端未配置会话密钥' }, 500);
    }
    const ip = c.req.header('cf-connecting-ip') ?? '127.0.0.1';
    if (!(await loginAllowed(c.env.SNAPSHOT, ip))) {
      return c.json(
        { error: 'too_many_attempts', message: '密码错误次数过多，请 10 分钟后再试' },
        429,
        { 'retry-after': '600', 'cache-control': CACHE_PRIVATE },
      );
    }

    let password = '';
    try {
      const body = await c.req.json<{ password?: unknown }>();
      password = typeof body.password === 'string' ? body.password : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (!password) return c.json({ error: 'bad_request', message: '请输入密码' }, 400);

    const stored = await readPasswordHash(c.env);
    if (!stored) return c.json({ error: 'not_configured', message: '服务端未设置登录密码' }, 500);

    if (!(await verifyPassword(password, stored))) {
      await noteLoginFailure(c.env.SNAPSHOT, ip);
      return c.json({ error: 'bad_password', message: '密码不正确' }, 401);
    }

    await clearLoginFailures(c.env.SNAPSHOT, ip);
    const token = await createSessionToken(c.env.SESSION_SECRET);
    return c.json({ ok: true }, 200, {
      'set-cookie': buildSessionCookie(token, isSecure(c.req.url)),
      'cache-control': CACHE_PRIVATE,
    });
  });

  api.post('/auth/logout', (c) =>
    c.json({ ok: true }, 200, {
      'set-cookie': buildClearSessionCookie(isSecure(c.req.url)),
      'cache-control': CACHE_PRIVATE,
    }),
  );

  api.post('/auth/change-password', async (c) => {
    let oldPassword = '';
    let newPassword = '';
    try {
      const body = await c.req.json<{ oldPassword?: unknown; newPassword?: unknown }>();
      oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
      newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: 'weak_password', message: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);
    }
    const stored = await readPasswordHash(c.env);
    if (!stored) return c.json({ error: 'not_configured', message: '服务端未设置登录密码' }, 500);
    if (!(await verifyPassword(oldPassword, stored))) {
      return c.json({ error: 'bad_password', message: '旧密码不正确' }, 400);
    }
    const hash = await hashPassword(newPassword);
    await touchSetting(c.env.DB, ADMIN_PASSWORD_SETTING, hash, new Date().toISOString());
    return c.json({ ok: true }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 运行参数：调度、并发、国内补测、自动收录与数据保留。
  api.get('/admin/settings', async (c) => {
    const [settings, scheduler] = await Promise.all([loadSettings(c.env.DB), getSchedulerStatus(c.env)]);
    return c.json({ settings, scheduler }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.put('/admin/settings', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'bad_request', message: '设置必须是对象' }, 400);
    }
    const settings = await saveSettings(c.env.DB, body);
    const scheduler = await getSchedulerStatus(c.env);
    return c.json({ settings, scheduler }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.post('/admin/settings/reset', async (c) => {
    const settings = await resetSettings(c.env.DB);
    const scheduler = await getSchedulerStatus(c.env);
    return c.json({ settings, scheduler }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 清理旧运行：先预览，确认后再删；永远保留最新一轮探测与测活。
  api.post('/admin/runs/purge', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400);
    }
    const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const days = Number(input.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return c.json({ error: 'bad_days', message: '保留天数必须是 1–3650 的整数' }, 400);
    }
    const dryRun = input.dryRun === true;
    const plan = await planRunPurge(c.env, days);
    if (dryRun) {
      return c.json({ preview: plan }, 200, { 'cache-control': CACHE_PRIVATE });
    }
    await executeRunPurge(c.env, plan);
    return c.json({ result: plan }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 系统信息：用来确认部署版本与三类令牌是否配置。
  api.get('/admin/system', async (c) => {
    const [scheduler, candidateCounts, registry] = await Promise.all([
      getSchedulerStatus(c.env),
      countCandidatesByState(c.env.DB),
      listSourceRegistry(c.env.DB),
    ]);
    return c.json(
      {
        site: c.env.SITE_NAME ?? 'LX 音源监测',
        repo: c.env.GH_REPO ?? 'fade09675/lx-source-watch',
        schemaVersion: SCHEMA_VERSION,
        tokens: {
          github: Boolean(c.env.GH_DISPATCH_TOKEN),
          cloudflare: Boolean(c.env.CF_ANALYTICS_TOKEN),
          runner: Boolean(c.env.RUNNER_TOKEN),
          ingest: Boolean(c.env.INGEST_SECRET),
        },
        scheduler,
        counts: { candidates: candidateCounts, sources: registry.length },
        serverTime: new Date().toISOString(),
      },
      200,
      { 'cache-control': CACHE_PRIVATE },
    );
  });

  // 手动跑一次“自动发现”，只发现不探测，结果进候选列表。
  api.post('/admin/run/discovery', async (c) => {
    const key = 'run:discovery:last';
    if (await c.env.SNAPSHOT.get(key)) {
      return c.json({ error: 'too_frequent', message: '刚刚已经触发过，请等一分钟再试' }, 429, {
        'retry-after': '60',
        'cache-control': CACHE_PRIVATE,
      });
    }
    const result = await dispatchProbe(c.env, { discover: true, limit: '1', cn: false });
    if (!result.ok) {
      return c.json({ error: 'dispatch_failed', message: result.message }, 503, { 'cache-control': CACHE_PRIVATE });
    }
    const now = new Date().toISOString();
    await recordKvPut(c.env);
    await c.env.SNAPSHOT.put(key, now, { expirationTtl: 60 });
    return c.json({ ok: true, dispatchedAt: now }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.get('/admin/candidates', async (c) => {
    const state = c.req.query('state');
    if (state && !CANDIDATE_STATES.includes(state)) {
      return c.json({ error: 'bad_state', message: `未知候选状态：${state}` }, 400);
    }
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const [candidates, counts] = await Promise.all([
      getCandidates(c.env.DB, { limit: 500 }),
      countCandidatesByState(c.env.DB),
    ]);
    const filtered = candidates.filter((item) => {
      if (state && item.state !== state) return false;
      if (!q) return true;
      return [item.id, item.repo, item.path, item.title ?? '', item.author ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
    return c.json({ candidates: filtered, count: filtered.length, counts }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 立即执行一次自动收录，把已通过初始化的候选转成正式音源。
  api.post('/admin/candidates/promote', async (c) => {
    const result = await autoPromoteCandidates(c.env);
    return c.json(result, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.delete('/admin/candidates/rejected', async (c) => {
    const deleted = await deleteCandidatesByState(c.env.DB, 'rejected');
    return c.json({ ok: true, deleted }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.patch('/admin/candidates/:id', async (c) => {
    let state = '';
    try {
      const body = await c.req.json<{ state?: unknown }>();
      state = typeof body.state === 'string' ? body.state : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (!CANDIDATE_STATES.includes(state)) {
      return c.json({ error: 'bad_state', message: `未知候选状态：${state}` }, 400);
    }
    const id = c.req.param('id');
    if (state === 'promoted') {
      const outcome = await promoteCandidate(c.env, id);
      if (!outcome.ok) {
        return c.json({ error: 'promote_failed', message: outcome.error ?? '收录失败' }, 400, {
          'cache-control': CACHE_PRIVATE,
        });
      }
      return c.json({ ok: true, id: outcome.id ?? id, state }, 200, { 'cache-control': CACHE_PRIVATE });
    }
    const updated = await setCandidateState(c.env.DB, id, state, new Date().toISOString());
    if (!updated) return c.json({ error: 'not_found', message: `未知候选源：${id}` }, 404);
    return c.json({ ok: true, id, state }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 重复内容与别名：只读总览。
  api.get('/admin/duplicates', async (c) => {
    const overview = await listDuplicateOverview(c.env.DB);
    return c.json(overview, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 确认重复后执行合并：主源追加镜像、写别名、停用重复源（不删除）。
  api.post('/admin/duplicates/merge', async (c) => {
    let body: { canonicalId?: unknown; duplicates?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    const canonicalId = typeof body.canonicalId === 'string' ? body.canonicalId.trim() : '';
    if (!canonicalId) return c.json({ error: 'bad_request', message: '缺少主源 id' }, 400);

    const canonical = await getSourceRegistry(c.env.DB, canonicalId);
    if (!canonical) return c.json({ error: 'not_found', message: `主源不存在：${canonicalId}` }, 404);
    const canonicalSha = canonical.contentSha256?.trim() ?? '';
    if (!canonicalSha) {
      return c.json({ error: 'missing_sha', message: '主源还没有内容指纹，等下一轮探测完成后再合并' }, 400);
    }

    const rawDuplicates = Array.isArray(body.duplicates) ? body.duplicates : [];
    if (rawDuplicates.length === 0) return c.json({ error: 'bad_request', message: '缺少要合并的重复项' }, 400);
    if (rawDuplicates.length > 50) return c.json({ error: 'bad_request', message: '一次最多合并 50 项' }, 400);

    const now = new Date().toISOString();
    const registryDuplicates: { url: string; sourceId: string; sha256: string }[] = [];
    const candidateDuplicates: { url: string; id: string; sha256: string }[] = [];
    const errors: string[] = [];

    for (const raw of rawDuplicates) {
      const item = (raw ?? {}) as { url?: unknown; sourceId?: unknown };
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      const sourceId = typeof item.sourceId === 'string' ? item.sourceId.trim() : '';
      if (!url) {
        errors.push('存在没有地址的重复项');
        continue;
      }
      if (sourceId) {
        const registryRow = await getSourceRegistry(c.env.DB, sourceId);
        if (registryRow) {
          if ((registryRow.contentSha256 ?? '') !== canonicalSha) {
            errors.push(`${sourceId} 的内容指纹与主源不一致`);
            continue;
          }
          if (sourceId !== canonicalId) registryDuplicates.push({ url, sourceId, sha256: canonicalSha });
          continue;
        }
        const candidate = await getCandidate(c.env.DB, sourceId);
        if (!candidate) {
          errors.push(`${sourceId} 不存在`);
          continue;
        }
        if ((candidate.sha256 ?? '') !== canonicalSha) {
          errors.push(`${sourceId} 的内容指纹与主源不一致`);
          continue;
        }
        candidateDuplicates.push({ url, id: candidate.id, sha256: canonicalSha });
        continue;
      }
      errors.push(`${url} 缺少来源 id，无法确认内容一致`);
    }

    if (errors.length > 0) {
      return c.json({ error: 'sha_mismatch', message: '没有通过内容校验，未执行合并', errors }, 400, {
        'cache-control': CACHE_PRIVATE,
      });
    }
    if (registryDuplicates.length === 0 && candidateDuplicates.length === 0) {
      return c.json({ error: 'bad_request', message: '没有可合并的重复项' }, 400);
    }

    const merge = await mergeIntoCanonical(
      c.env.DB,
      canonicalId,
      [
        ...registryDuplicates.map((item) => ({ url: item.url, sourceId: item.sourceId, sha256: item.sha256 })),
        ...candidateDuplicates.map((item) => ({ url: item.url, sha256: item.sha256 })),
      ],
      now,
    );

    const markedCandidates: string[] = [];
    for (const item of candidateDuplicates) {
      if (await markCandidateDuplicate(c.env.DB, item.id, canonicalId, now)) markedCandidates.push(item.id);
    }

    return c.json(
      {
        ok: merge.ok,
        canonicalId,
        aliases: merge.aliases,
        addedMirrors: merge.addedMirrors,
        disabled: merge.disabled,
        candidatesMarked: markedCandidates,
        errors: merge.errors,
      },
      200,
      { 'cache-control': CACHE_PRIVATE },
    );
  });

  api.get('/admin/aliases', async (c) => {
    const sourceId = c.req.query('sourceId')?.trim();
    const aliases = await listAliases(c.env.DB, { canonicalSourceId: sourceId || undefined, limit: 1000 });
    return c.json({ aliases, count: aliases.length }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.post('/admin/aliases/ignore', async (c) => {
    let url = '';
    try {
      const body = await c.req.json<{ url?: unknown }>();
      url = typeof body.url === 'string' ? body.url.trim() : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (!url) return c.json({ error: 'bad_request', message: '缺少别名地址' }, 400);
    const ok = await setAliasState(c.env.DB, url, 'ignored');
    if (!ok) return c.json({ error: 'not_found', message: '别名不存在' }, 404);
    return c.json({ ok: true, url, state: 'ignored' }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  api.post('/admin/aliases/restore', async (c) => {
    let url = '';
    try {
      const body = await c.req.json<{ url?: unknown }>();
      url = typeof body.url === 'string' ? body.url.trim() : '';
    } catch {
      return c.json({ error: 'bad_request', message: '请求格式错误' }, 400);
    }
    if (!url) return c.json({ error: 'bad_request', message: '缺少别名地址' }, 400);
    const ok = await setAliasState(c.env.DB, url, 'active');
    if (!ok) return c.json({ error: 'not_found', message: '别名不存在' }, 404);
    return c.json({ ok: true, url, state: 'active' }, 200, { 'cache-control': CACHE_PRIVATE });
  });

  // 网页触发一次探测，避免每次都去 GitHub 手动点。
  api.post('/admin/run/probe', async (c) => {
    const last = await c.env.SNAPSHOT.get('run:probe:last');
    if (last) {
      return Response.json(
        { error: 'too_frequent', message: '刚刚已经触发过，请等一分钟再试' },
        { status: 429, headers: { 'retry-after': '60', 'cache-control': CACHE_PRIVATE } },
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      // 允许空请求体，全部使用默认参数。
    }
    const limit = typeof body.limit === 'string' ? body.limit.trim() : '';
    if (limit && !/^[1-9]\d{0,2}$/.test(limit)) {
      return Response.json(
        { error: 'bad_request', message: '“最多测几个源”只能是 1 到 999 的数字' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }

    const outcome = await dispatchProbe(c.env, {
      only: typeof body.only === 'string' ? body.only : '',
      limit,
      deep: body.deep === true,
      preferMirror: body.preferMirror === true,
      proxyId: typeof body.proxyId === 'string' ? body.proxyId.trim().slice(0, 64) : '',
    });
    if (!outcome.ok) {
      return Response.json(
        { error: 'dispatch_failed', message: outcome.message },
        { status: outcome.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }

    await recordKvPut(c.env);
    await c.env.SNAPSHOT.put('run:probe:last', outcome.dispatchedAt, { expirationTtl: 60 });
    return Response.json({ ok: true, dispatchedAt: outcome.dispatchedAt }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/admin/runs', async (c) => {
    const result = await listProbeRuns(c.env, 5);
    if (!result.ok) {
      return Response.json(
        { error: 'runs_failed', message: result.message },
        { status: result.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const lastDispatchedAt = await c.env.SNAPSHOT.get('run:probe:last');
    return Response.json({ runs: result.runs, lastDispatchedAt }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  // 快照运行记录（每轮 ingest 一条），与上面的 GitHub 工作流运行区分开。
  api.get('/admin/snapshots', async (c) => {
    const raw = Number(c.req.query('limit') ?? 10);
    // limit=0 表示“全部”，直接交给 SQLite 的 LIMIT -1；其余夹在 1–200。
    const limit = Number.isFinite(raw) ? Math.max(0, Math.min(200, Math.trunc(raw))) : 10;
    const rawOffset = Number(c.req.query('offset') ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    const status = (c.req.query('status') ?? '').trim();
    const trigger = (c.req.query('trigger') ?? '').trim();
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    const days = clampInt(c.req.query('days'), 30, 1, 90);
    const page = await getRunsPage(c.env.DB, { limit, offset, status, trigger, q, days });
    return Response.json(
      { ...page, limit, offset },
      { headers: { 'cache-control': 'private, max-age=15' } },
    );
  });

  api.get('/admin/snapshots/:runId', async (c) => {
    const runId = c.req.param('runId');
    const run = await getRun(c.env.DB, runId);
    if (!run) {
      return Response.json(
        { error: 'not_found', message: `未知运行记录：${runId}` },
        { status: 404, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const [sources, platforms, endpoints, endpointRows] = await Promise.all([
      getRunSources(c.env.DB, runId),
      getRunPlatforms(c.env.DB, runId),
      getRunEndpointStats(c.env.DB, runId),
      getRunEndpointRows(c.env.DB, runId),
    ]);
    return Response.json(
      { run, sources, platforms, endpoints, endpointRows },
      { headers: { 'cache-control': 'private, max-age=30' } },
    );
  });

  // 运行日志：runner 在上报的 meta.log 里带上来，存 KV，详情页内嵌展示。
  api.get('/admin/snapshots/:runId/log', async (c) => {
    const runId = c.req.param('runId');
    const run = await getRun(c.env.DB, runId);
    if (!run) {
      return Response.json(
        { error: 'not_found', message: `未知运行记录：${runId}` },
        { status: 404, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const log = await c.env.SNAPSHOT.get(`run:${runId}:log`);
    return Response.json(
      {
        runId,
        available: Boolean(log),
        log: log ?? '',
        bytes: log ? new TextEncoder().encode(log).byteLength : 0,
      },
      { headers: { 'cache-control': 'private, max-age=30' } },
    );
  });

  // 最近 N 天的失败聚合：按错误类型 / 平台 / 源统计，只算真正测过的。
  api.get('/admin/proxy-tests', async (c) => {
    const days = clampInt(c.req.query('days'), 7, 1, 90);
    const limit = clampInt(c.req.query('limit'), 50, 1, 200);
    const runs = await listProxyTestRuns(c.env.DB, { days, limit });
    return Response.json({ days, runs }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/admin/proxy-tests/:runId', async (c) => {
    const detail = await getProxyTestRun(c.env.DB, c.req.param('runId'));
    if (!detail) {
      return Response.json(
        { error: 'not_found', message: '测活记录不存在' },
        { status: 404, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    return Response.json(detail, { headers: { 'cache-control': 'private, max-age=15' } });
  });

  api.get('/admin/failures', async (c) => {
    const raw = Number(c.req.query('days') ?? 7);
    const days = Number.isFinite(raw) ? Math.max(1, Math.min(30, Math.trunc(raw))) : 7;
    const aggregate = await getFailureAggregate(c.env.DB, days);
    return Response.json(aggregate, { headers: { 'cache-control': 'private, max-age=60' } });
  });

  // 平台汇总：一段时间内每个平台的通过率、耗时和首要错误。
  api.get('/admin/platforms', async (c) => {
    const raw = Number(c.req.query('days') ?? 7);
    const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.trunc(raw))) : 7;
    const summary = await getPlatformSummary(c.env.DB, days);
    return Response.json(summary, { headers: { 'cache-control': 'private, max-age=60' } });
  });

  // 工作台：探测 + 测活两类工作流的最近运行。
  api.get('/admin/workflows', async (c) => {
    const result = await listAllRuns(c.env, 6);
    // 未配置令牌 / GitHub 暂时不可用时也返回 200：工作台仍要能显示额度与
    // 定时计划，把失败作为 errors 展示，而不是整页报错。
    const runs = 'runs' in result ? result.runs : [];
    const baseErrors = 'errors' in result && Array.isArray(result.errors) ? result.errors : [];
    const errors = result.ok ? baseErrors : [result.message ?? '查询运行状态失败', ...baseErrors];
    const [lastProbeDispatchedAt, lastProxyTestDispatchedAt, scheduler] = await Promise.all([
      c.env.SNAPSHOT.get('run:probe:last'),
      c.env.SNAPSHOT.get('run:proxy-test:last'),
      getSchedulerStatus(c.env),
    ]);
    return Response.json(
      {
        ok: result.ok,
        runs,
        errors,
        lastProbeDispatchedAt,
        lastProxyTestDispatchedAt,
        scheduler,
      },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  // KV / D1 / Actions 用量。默认 5 分钟内复用缓存，?refresh=1 强制刷新。
  api.get('/admin/usage', async (c) => {
    const usage = await getUsage(c.env, { refresh: c.req.query('refresh') === '1' });
    return Response.json({ usage }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/usage/refresh', async (c) => {
    const usage = await refreshUsage(c.env);
    return Response.json({ usage }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  // 网页触发一次代理测活（全部或指定节点）。
  api.post('/admin/run/proxy-test', async (c) => {
    const last = await c.env.SNAPSHOT.get('run:proxy-test:last');
    if (last) {
      return Response.json(
        { error: 'too_frequent', message: '刚刚已经触发过测活，请等一分钟再试' },
        { status: 429, headers: { 'retry-after': '60', 'cache-control': CACHE_PRIVATE } },
      );
    }
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      // 空请求体表示测全部。
    }
    const outcome = await dispatchProxyTest(c.env, {
      proxyId: typeof body.proxyId === 'string' ? body.proxyId.trim().slice(0, 64) : '',
      subscriptionId: typeof body.subscriptionId === 'string' ? body.subscriptionId.trim().slice(0, 64) : '',
      concurrency: Number(body.concurrency) || 5,
    });
    if (!outcome.ok) {
      return Response.json(
        { error: 'dispatch_failed', message: outcome.message },
        { status: outcome.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    await recordKvPut(c.env);
    await c.env.SNAPSHOT.put('run:proxy-test:last', outcome.dispatchedAt, { expirationTtl: 60 });
    return Response.json({ ok: true, dispatchedAt: outcome.dispatchedAt }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  // 加速镜像模板：网页可替换内置 8 条，探测任务通过公开接口读取。
  api.get('/admin/mirrors', async (c) => {
    const config = await getMirrorTemplates(c.env.DB);
    return Response.json(config, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.put('/admin/mirrors', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json(
        { error: 'bad_request', message: '请求体不是合法 JSON' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    try {
      const config = await saveMirrorTemplates(c.env.DB, (body as { templates?: unknown })?.templates);
      return Response.json(config, { headers: { 'cache-control': CACHE_PRIVATE } });
    } catch (error) {
      if (error instanceof MirrorConfigError) {
        return Response.json(
          { error: 'bad_templates', message: error.message, issues: error.issues },
          { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
        );
      }
      throw error;
    }
  });

  api.post('/admin/mirrors/reset', async (c) => {
    const config = await resetMirrorTemplates(c.env.DB);
    return Response.json(config, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  // 音源注册表：网页增删改查，探测任务通过公开接口读取启用的音源。
  api.get('/admin/sources', async (c) => {
    const [rows, metas, config] = await Promise.all([
      listSourceRegistry(c.env.DB),
      getSourceMetas(c.env.DB),
      getMirrorTemplates(c.env.DB),
    ]);
    const sources = rows.map((row) => {
      const meta = metas.get(row.id);
      return {
        ...row,
        status: meta?.status ?? 'untested',
        version: meta?.version ?? '',
        sha: meta?.scriptSha ?? '',
        endpointsOk: meta?.endpointsOk ?? 0,
        endpointsTotal: meta?.endpointsTotal ?? 0,
        lastChangeAt: meta?.lastChangeAt ?? '',
        lastCheckedAt: meta?.updatedAt ?? '',
        links: buildRegistryLinks(row.url, row.mirrors, config.templates),
      };
    });
    return Response.json(
      { sources, mirrorTemplates: config.templates },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.post('/admin/sources', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json(
        { error: 'bad_request', message: '请求体不是合法 JSON' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const result = await createSourceRegistry(c.env.DB, body as SourceInput);
    if (!result.ok) {
      return Response.json(
        { error: 'bad_source', message: result.errors.join('；'), errors: result.errors },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    return Response.json({ source: result.row }, { status: 201, headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.patch('/admin/sources/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json(
        { error: 'bad_request', message: '请求体不是合法 JSON' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const result = await updateSourceRegistry(c.env.DB, c.req.param('id'), body as SourceInput);
    if (!result.ok) {
      return Response.json(
        { error: result.status === 404 ? 'not_found' : 'bad_source', message: result.errors.join('；'), errors: result.errors },
        { status: result.status ?? 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    return Response.json({ source: result.row }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.delete('/admin/sources/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await getSourceRegistry(c.env.DB, id);
    if (!existing) {
      return Response.json(
        { error: 'not_found', message: '音源不存在' },
        { status: 404, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    await deleteSourceRegistry(c.env.DB, id);
    return Response.json({ ok: true, id }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/sources/:id/test', async (c) => {
    const id = c.req.param('id');
    const existing = await getSourceRegistry(c.env.DB, id);
    if (!existing) {
      return Response.json(
        { error: 'not_found', message: '音源不存在' },
        { status: 404, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const last = await c.env.SNAPSHOT.get('run:source-test:last');
    if (last) {
      const age = Date.now() - Date.parse(last);
      if (Number.isFinite(age) && age < 30_000) {
        return Response.json(
          { error: 'rate_limited', message: '刚触发过，请 30 秒后再试' },
          { status: 429, headers: { 'cache-control': CACHE_PRIVATE } },
        );
      }
    }
    const outcome = await dispatchProbe(c.env, { only: id, limit: '1', preferMirror: true });
    if (!outcome.ok) {
      return Response.json(
        { error: 'dispatch_failed', message: outcome.message },
        { status: outcome.status, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    await recordKvPut(c.env);
    await c.env.SNAPSHOT.put('run:source-test:last', outcome.dispatchedAt, { expirationTtl: 60 });
    return Response.json(
      { ok: true, sourceId: id, dispatchedAt: outcome.dispatchedAt },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.get('/admin/discovery-repos', async (c) => {
    const repos = await listDiscoveryRepos(c.env.DB);
    return Response.json({ repos }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/discovery-repos', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, { status: 400 });
    }
    const result = await createDiscoveryRepo(c.env.DB, body as Record<string, unknown>);
    if (!result.ok) {
      return Response.json(
        { error: result.status === 409 ? 'conflict' : 'bad_repo', message: result.errors.join('；'), errors: result.errors },
        { status: result.status ?? 400 },
      );
    }
    return Response.json({ repo: result.row }, { status: 201, headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.patch('/admin/discovery-repos/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, { status: 400 });
    }
    const result = await updateDiscoveryRepo(c.env.DB, c.req.param('id'), body as Record<string, unknown>);
    if (!result.ok) {
      return Response.json(
        { error: result.status === 404 ? 'not_found' : result.status === 409 ? 'conflict' : 'bad_repo', message: result.errors.join('；'), errors: result.errors },
        { status: result.status ?? 400 },
      );
    }
    return Response.json({ repo: result.row }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.delete('/admin/discovery-repos/:id', async (c) => {
    const ok = await deleteDiscoveryRepo(c.env.DB, c.req.param('id'));
    if (!ok) return Response.json({ error: 'not_found', message: '仓库不存在' }, { status: 404 });
    return Response.json({ ok: true }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/sources/backups/preview', async (c) => {
    let body: { text?: string; urls?: string[]; sourceId?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, { status: 400 });
    }
    if (!body.text?.trim() && !body.urls?.length) {
      return Response.json({ error: 'bad_request', message: '请粘贴至少一个备用地址' }, { status: 400 });
    }
    const preview = await previewBackupUrls(c.env, body);
    return Response.json(preview, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/sources/backups/import', async (c) => {
    let body: { items?: BackupImportItem[] };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'bad_request', message: '请求体不是合法 JSON' }, { status: 400 });
    }
    if (!Array.isArray(body.items) || !body.items.length) {
      return Response.json({ error: 'bad_request', message: '没有可导入的地址' }, { status: 400 });
    }
    const result = await importBackupUrls(c.env, body.items);
    return Response.json(result, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  const TASK_TYPES: TaskType[] = ['probe', 'discovery', 'source-test', 'proxy-test', 'proxy-fetch-sub', 'retention', 'cn-probe'];
  const TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'];
  const TASK_SOURCES: TaskSource[] = ['manual', 'schedule', 'api', 'retry', 'local'];
  const FINISHED_STATUSES: TaskStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

  api.get('/admin/tasks', async (c) => {
    const status = c.req.query('status');
    const type = c.req.query('type');
    const source = c.req.query('source');
    const q = c.req.query('q');
    if (status && status !== 'finished' && !TASK_STATUSES.includes(status as TaskStatus)) {
      return Response.json({ error: 'bad_status', message: `未知任务状态：${status}` }, { status: 400 });
    }
    if (type && !TASK_TYPES.includes(type as TaskType)) {
      return Response.json({ error: 'bad_type', message: `未知任务类型：${type}` }, { status: 400 });
    }
    if (source && !TASK_SOURCES.includes(source as TaskSource)) {
      return Response.json({ error: 'bad_source', message: `未知任务来源：${source}` }, { status: 400 });
    }
    const limit = clampInt(c.req.query('limit'), 20, 0, 100);
    const offset = clampInt(c.req.query('offset'), 0, 0, 100_000);
    const filter = {
      status: status && status !== 'finished' ? (status as TaskStatus) : undefined,
      statuses: status === 'finished' ? FINISHED_STATUSES : undefined,
      type: type as TaskType | undefined,
      source: source as TaskSource | undefined,
      q: q?.slice(0, 100),
      limit,
      offset,
    };
    const [tasks, total, state, counts] = await Promise.all([
      listTasks(c.env.DB, filter),
      countTasksFiltered(c.env.DB, filter),
      getTaskState(c.env.DB),
      countTasks(c.env.DB),
    ]);
    return Response.json(
      {
        tasks,
        total,
        limit,
        offset,
        counts,
        state: { ...state, counts },
        labels: { types: TASK_TYPE_LABEL, statuses: TASK_STATUS_LABEL },
      },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.get('/admin/activity', async (c) => {
    const limit = clampInt(c.req.query('limit'), 20, 0, 100);
    const offset = clampInt(c.req.query('offset'), 0, 0, 100_000);
    const okRaw = c.req.query('ok');
    const result = await listAdminActivity(c.env.DB, {
      limit,
      offset,
      ok: okRaw === undefined ? undefined : okRaw === '1' || okRaw === 'true',
    });
    return Response.json(
      { items: result.items, total: result.total, limit, offset },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.post('/admin/tasks', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      type?: string;
      payload?: TaskPayload;
      priority?: number;
    } | null;
    if (!body?.type || !TASK_TYPES.includes(body.type as TaskType)) {
      return Response.json(
        { error: 'bad_type', message: `任务类型必须是：${TASK_TYPES.join(' / ')}` },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const type = body.type as TaskType;
    if (type === 'retention') {
      return Response.json(
        { error: 'bad_type', message: '数据清理任务只由调度器自动创建' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    if (type === 'cn-probe' && !body.payload?.probeRunId) {
      return Response.json(
        { error: 'bad_payload', message: '国内补测任务需要 payload.probeRunId' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const payload = body.payload ?? {};
    if (type === 'cn-probe' && payload.limit !== undefined) {
      const limit = Number(payload.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return Response.json(
          { error: 'bad_payload', message: '国内补测 limit 必须是 1–200 的整数' },
          { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
        );
      }
      payload.limit = String(limit);
    }
    if (type === 'source-test' && !payload.only) {
      return Response.json(
        { error: 'bad_payload', message: '单源测试需要 payload.only' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    if (type === 'proxy-fetch-sub' && !payload.subscriptionId) {
      return Response.json(
        { error: 'bad_payload', message: '拉取订阅需要 payload.subscriptionId' },
        { status: 400, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const task = await createTask(c.env.DB, {
      type,
      payload,
      priority: body.priority,
      source: 'manual',
    });
    const dispatch = await dispatchNext(c.env);
    const state = await refreshTaskState(c.env);
    const latest = (await getTask(c.env.DB, task.id)) ?? task;
    return Response.json(
      { ok: true, task: latest, dispatch, state },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.post('/admin/tasks/dispatch', async (c) => {
    const dispatch = await dispatchNext(c.env);
    const state = await refreshTaskState(c.env);
    return Response.json({ ...dispatch, state }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/tasks/reap', async (c) => {
    const reaped = await reapStaleTasks(c.env);
    const state = await refreshTaskState(c.env);
    return Response.json({ ok: true, reaped, state }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.post('/admin/tasks/:id/cancel', async (c) => {
    const task = await cancelTask(c.env, c.req.param('id'));
    if (!task) {
      return Response.json(
        { error: 'not_found', message: '任务不存在或已结束' },
        { status: 404, headers: { 'cache-control': CACHE_PRIVATE } },
      );
    }
    const state = await refreshTaskState(c.env);
    return Response.json({ ok: true, task, state }, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/config/sources', async (c) => {
    const rows = await listSourceRegistry(c.env.DB);
    return Response.json(toPublicRegistry(rows), {
      headers: { 'cache-control': 'public, max-age=60, s-maxage=300' },
    });
  });

  api.get('/config/discovery', async (c) => {
    const config = await publicDiscoveryRepos(c.env.DB);
    return Response.json(config, {
      headers: { 'cache-control': 'public, max-age=60, s-maxage=300' },
    });
  });

  api.get('/config/mirrors', async (c) => {
    const config = await getMirrorTemplates(c.env.DB);
    return Response.json(
      { templates: config.templates },
      { headers: { 'cache-control': 'public, max-age=300, s-maxage=600' } },
    );
  });

  api.get('/status', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const cn = c.req.query('cn');
    if (cn && !['failed', 'ok', 'untested'].includes(cn)) {
      return c.json({ error: 'bad_request', message: '国内筛选只支持 failed、ok、untested' }, 400);
    }
    const filtered = filterSnapshot(snapshot, {
      platforms: parseList(c.req.query('platform')),
      statuses: parseList(c.req.query('status')),
      cn,
      q: c.req.query('q'),
    });
    const envelope: StatusEnvelope = {
      snapshot: filtered,
      serverTime: new Date().toISOString(),
      stale: isStale(filtered.generatedAt),
    };
    return Response.json(envelope, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/sources/:id', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const id = c.req.param('id');
    const source = snapshot.sources.find((item) => item.id === id);
    if (!source) return notFound(`未知来源：${id}`);

    const [endpoints, history, daily, platformDaily] = await Promise.all([
      getSourceEndpoints(c.env.DB, id),
      getSourceHistory(c.env.DB, id, 42),
      getSourceDaily(c.env.DB, id, 180),
      getSourcePlatformDaily(c.env.DB, id, 180),
    ]);

    return Response.json(
      { source, endpoints, history, daily, platformDaily, generatedAt: snapshot.generatedAt },
      { headers: { 'cache-control': CACHE_PRIVATE } },
    );
  });

  api.get('/history', async (c) => {
    const days = clampInt(c.req.query('days'), 14, 1, 90);
    const runs = await getRuns(c.env.DB, days * 6);
    return Response.json(runs, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/events', async (c) => {
    const limit = clampInt(c.req.query('limit'), 50, 1, 200);
    const events = await getEvents(c.env.DB, limit);
    return Response.json(events, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/candidates', async (c) => {
    const state = c.req.query('state');
    if (state && !['new', 'qualified', 'rejected', 'promoted'].includes(state)) {
      return Response.json({ error: 'bad_state', message: `未知候选状态：${state}` }, { status: 400 });
    }
    const limit = clampInt(c.req.query('limit'), 100, 1, 500);
    const candidates = await getCandidates(c.env.DB, { state, limit });
    return Response.json(candidates, { headers: { 'cache-control': CACHE_PRIVATE } });
  });

  api.get('/export', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const items = snapshot.sources.map(toExportItem);
    const format = (c.req.query('format') ?? 'json').toLowerCase();
    if (format === 'csv') {
      return new Response(toCsv(items), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="lx-source-watch.csv"',
          'cache-control': CACHE_PRIVATE,
        },
      });
    }
    return Response.json(items, {
      headers: {
        'content-disposition': 'attachment; filename="lx-source-watch.json"',
        'cache-control': CACHE_PRIVATE,
      },
    });
  });

  api.get('/health', async (c) => {
    const [snapshot, lastRun, candidates] = await Promise.all([
      readSnapshot(c.env),
      getLastRun(c.env.DB),
      countCandidates(c.env.DB),
    ]);
    const stale = lastRun ? isStale(lastRun.finishedAt) : true;
    return Response.json(
      {
        ok: Boolean(lastRun) && !stale,
        lastRun,
        stale,
        sources: snapshot?.sources.length ?? 0,
        candidates,
        serverTime: new Date().toISOString(),
      },
      { headers: { 'cache-control': 'public, max-age=10, s-maxage=30' } },
    );
  });

  return api;
}
