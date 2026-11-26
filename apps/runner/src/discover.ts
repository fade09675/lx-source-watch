import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CandidateFileSchema,
  DiscoveryConfigSchema,
  DiscoveryRepoSchema,
  type Candidate,
  type CandidateFile,
  type DiscoveryConfig,
  type DiscoveryRepo,
} from '@lx/shared';
import { log } from './logger.js';
import { httpRequest, type ProxyConfig } from './net/http.js';

/** 仓库树批量并发数；控制 GitHub API 突发，同时保持结果按仓库顺序处理。 */
const TREE_FETCH_CONCURRENCY = 4;
import { errorMessage, nowIso, sha1Short } from './util.js';

export interface DiscoverOptions {
  configPath: string;
  outPath: string;
  seedPath?: string;
  maxFetchPerRun?: number;
  token?: string;
  proxy?: ProxyConfig;
  branchFallback?: string;
  /** 网页管理的自定义仓库配置地址；为空时读 LX_DISCOVERY_URL。 */
  discoveryUrl?: string;
  /** 测试/本地开发允许访问 localhost。 */
  allowPrivate?: boolean;
}

export interface DiscoverStats {
  repos: number;
  files: number;
  skipped: number;
  errors: string[];
}

export interface DiscoverOutput {
  file: CandidateFile;
  stats: DiscoverStats;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
  sha: string;
}

interface TreeResponse {
  tree?: TreeEntry[];
  truncated?: boolean;
  message?: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchTree(
  repo: string,
  branch: string,
  token: string | undefined,
  proxy: ProxyConfig | undefined,
): Promise<TreeResponse> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const res = await httpRequest(url, {
    headers: githubHeaders(token),
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    proxy,
  });
  if (res.status !== 200) {
    const hint = res.status === 403 ? '（可能是 GitHub API 限流，配置 GITHUB_TOKEN）' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  return JSON.parse(res.body.toString('utf8')) as TreeResponse;
}

async function fetchCustomRepos(
  url: string,
  proxy: ProxyConfig | undefined,
  allowPrivate = false,
): Promise<DiscoveryRepo[]> {
  const res = await httpRequest(url, {
    headers: { accept: 'application/json' },
    timeoutMs: 10_000,
    maxBytes: 1024 * 1024,
    proxy,
    allowPrivate,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const payload = JSON.parse(res.body.toString('utf8')) as { repos?: unknown };
  const parsed = DiscoveryRepoSchema.array().max(200).safeParse(payload.repos ?? []);
  if (!parsed.success) {
    throw new Error(`自定义仓库格式不正确：${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return parsed.data.filter((repo) => repo.enabled);
}

export function mergeRepos(builtin: DiscoveryRepo[], custom: DiscoveryRepo[]): DiscoveryRepo[] {
  const seen = new Set(builtin.map((repo) => `${repo.repo}@${repo.branch}`));
  const merged = [...builtin];
  for (const repo of custom) {
    const key = `${repo.repo}@${repo.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(repo);
  }
  return merged;
}

function shouldInclude(path: string, repo: DiscoveryConfig['repos'][number]): boolean {
  if (!path.endsWith('.js')) return false;
  if (repo.exclude.some((p) => path.includes(p))) return false;
  if (repo.pathPrefixes.length === 0) return true;
  return repo.pathPrefixes.some((p) => path.startsWith(p));
}

function scorePath(path: string): number {
  let score = 0;
  if (/(^|\/)(latest|index|main|source|src)\.js$/i.test(path)) score += 4;
  if (/latest/i.test(path)) score += 2;
  if (/(^|\/)(src|sources)\//i.test(path)) score += 1;
  if (/test|demo|example|sample/i.test(path)) score -= 4;
  if (/\.min\.js$/i.test(path)) score -= 2;
  if (path.split('/').length > 6) score -= 1;
  return score;
}

function rawUrl(repo: string, branch: string, path: string): string {
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`;
}

/** 过滤、打分并排序一个仓库的文件树；抽成纯函数便于测试。 */
export function rankEntries(entries: TreeEntry[], repo: DiscoveryRepo): TreeEntry[] {
  return entries
    .filter((e) => e.type === 'blob' && shouldInclude(e.path, repo))
    .filter((e) => (e.size ?? 0) <= 2 * 1024 * 1024)
    .sort((a, b) => scorePath(b.path) - scorePath(a.path) || (a.size ?? 0) - (b.size ?? 0));
}

/**
 * 扫描配置里的 GitHub 仓库，找出 .js 候选脚本。
 * 只记录链接与元数据，不复制第三方脚本到本仓库。
 */
export async function discoverCandidates(opts: DiscoverOptions): Promise<DiscoverOutput> {
  const configRaw = await readFile(opts.configPath, 'utf8');
  const config = DiscoveryConfigSchema.parse(JSON.parse(configRaw));
  const discoveryUrl = opts.discoveryUrl ?? process.env.LX_DISCOVERY_URL;
  let repos = config.repos;
  if (discoveryUrl) {
    try {
      const custom = await fetchCustomRepos(discoveryUrl, opts.proxy, opts.allowPrivate);
      repos = mergeRepos(config.repos, custom);
      if (custom.length) log.info(`已合并 ${custom.length} 个网页自定义仓库`);
    } catch (e) {
      log.warn(`自定义仓库读取失败，仅使用内置仓库：${errorMessage(e)}`);
    }
  }
  const maxFetch = Math.max(1, opts.maxFetchPerRun ?? config.maxFetchPerRun);
  const perRepo = Math.min(maxFetch, config.maxFetchPerRepo);
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const previous = await readJson<CandidateFile>(opts.outPath);
  const existing = new Map<string, Candidate>();
  for (const c of previous?.candidates ?? []) existing.set(c.id, c);

  const stats: DiscoverStats = { repos: 0, files: 0, skipped: 0, errors: [] };
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const now = nowIso();

  const enabledRepos = repos.filter((repo) => repo.enabled);
  for (let start = 0; start < enabledRepos.length; start += TREE_FETCH_CONCURRENCY) {
    if (found.length >= maxFetch) break;
    const batch = enabledRepos.slice(start, start + TREE_FETCH_CONCURRENCY);
    stats.repos += batch.length;
    for (const repo of batch) log.step(`扫描 ${repo.repo}@${repo.branch}`);
    const trees = await Promise.all(
      batch.map(async (repo) => {
        try {
          return { repo, tree: await fetchTree(repo.repo, repo.branch, token, opts.proxy) };
        } catch (e) {
          return { repo, error: errorMessage(e) };
        }
      }),
    );
    for (const item of trees) {
      if (found.length >= maxFetch) break;
      if ('error' in item) {
        const msg = `${item.repo.repo}: ${item.error}`;
        stats.errors.push(msg);
        log.warn(msg);
        continue;
      }
      const { repo, tree } = item;
      if (tree.truncated) log.warn(`${repo.repo} 文件树被截断，只扫描了部分文件`);
      const entries = rankEntries(tree.tree ?? [], repo);

      let repoFound = 0;
      for (const entry of entries) {
        if (found.length >= maxFetch || repoFound >= perRepo) break;
        const id = sha1Short(`${repo.repo}/${entry.path}`, 12);
        if (seen.has(id)) continue;
        seen.add(id);
        const prev = existing.get(id);
        if (prev?.state === 'rejected') {
          stats.skipped += 1;
          continue;
        }
        found.push({
          id,
          repo: repo.repo,
          path: entry.path,
          url: rawUrl(repo.repo, repo.branch, entry.path),
          sha: entry.sha,
          title: prev?.title,
          version: prev?.version,
          author: prev?.author,
          description: prev?.description,
          platforms: prev?.platforms ?? [],
          bytes: entry.size ?? prev?.bytes,
          initOk: prev?.initOk,
          initError: prev?.initError,
          state: prev?.state ?? 'new',
          firstSeen: prev?.firstSeen ?? now,
          lastSeen: now,
        });
        repoFound += 1;
      }
      stats.files += entries.length;
    }
  }

  if (opts.seedPath) {
    const seed = (await readJson<{ candidates?: Candidate[] }>(opts.seedPath))?.candidates ?? [];
    for (const c of seed) {
      if (found.length >= maxFetch + seed.length) break;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      found.push({ ...c, lastSeen: c.lastSeen ?? now, firstSeen: c.firstSeen ?? now });
    }
  }

  // 保留本轮未扫到的历史候选，避免候选页忽然清空。
  for (const c of existing.values()) {
    if (seen.has(c.id) || c.state === 'rejected') continue;
    found.push(c);
  }

  found.sort((a, b) => (b.initOk === true ? 1 : 0) - (a.initOk === true ? 1 : 0) || a.id.localeCompare(b.id));
  const file: CandidateFile = { version: 1, generatedAt: now, candidates: found };
  const validated = CandidateFileSchema.safeParse(file);
  if (!validated.success) {
    throw new Error(`候选清单校验失败：${validated.error.issues[0]?.message ?? 'unknown'}`);
  }
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, `${JSON.stringify(validated.data, null, 2)}\n`, 'utf8');
  log.success(`发现候选 ${found.length} 个（扫描 ${stats.repos} 个仓库，跳过已拒绝 ${stats.skipped}）`);
  return { file: validated.data, stats };
}
