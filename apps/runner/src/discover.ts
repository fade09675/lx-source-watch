import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CandidateFileSchema,
  DiscoveryConfigSchema,
  type Candidate,
  type CandidateFile,
  type DiscoveryConfig,
} from '@lx/shared';
import { log } from './logger.js';
import { httpRequest, type ProxyConfig } from './net/http.js';
import { errorMessage, nowIso, sha1Short } from './util.js';

export interface DiscoverOptions {
  configPath: string;
  outPath: string;
  seedPath?: string;
  maxFetchPerRun?: number;
  token?: string;
  proxy?: ProxyConfig;
  branchFallback?: string;
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

/**
 * 扫描配置里的 GitHub 仓库，找出 .js 候选脚本。
 * 只记录链接与元数据，不复制第三方脚本到本仓库。
 */
export async function discoverCandidates(opts: DiscoverOptions): Promise<DiscoverOutput> {
  const configRaw = await readFile(opts.configPath, 'utf8');
  const config = DiscoveryConfigSchema.parse(JSON.parse(configRaw));
  const maxFetch = Math.max(1, opts.maxFetchPerRun ?? config.maxFetchPerRun);
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const previous = await readJson<CandidateFile>(opts.outPath);
  const existing = new Map<string, Candidate>();
  for (const c of previous?.candidates ?? []) existing.set(c.id, c);

  const stats: DiscoverStats = { repos: 0, files: 0, skipped: 0, errors: [] };
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const now = nowIso();

  for (const repo of config.repos) {
    if (!repo.enabled) continue;
    if (found.length >= maxFetch) break;
    stats.repos += 1;
    log.step(`扫描 ${repo.repo}@${repo.branch}`);
    let tree: TreeResponse;
    try {
      tree = await fetchTree(repo.repo, repo.branch, token, opts.proxy);
    } catch (e) {
      const msg = `${repo.repo}: ${errorMessage(e)}`;
      stats.errors.push(msg);
      log.warn(msg);
      continue;
    }
    if (tree.truncated) log.warn(`${repo.repo} 文件树被截断，只扫描了部分文件`);
    const entries = (tree.tree ?? [])
      .filter((e) => e.type === 'blob' && shouldInclude(e.path, repo))
      .filter((e) => (e.size ?? 0) <= 2 * 1024 * 1024)
      .sort((a, b) => scorePath(b.path) - scorePath(a.path) || (a.size ?? 0) - (b.size ?? 0));

    for (const entry of entries) {
      if (found.length >= maxFetch) break;
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
    }
    stats.files += entries.length;
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
