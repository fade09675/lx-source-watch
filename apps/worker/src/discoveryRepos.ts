export interface DiscoveryRepoRow {
  id: string;
  repo: string;
  branch: string;
  pathPrefixes: string[];
  enabled: boolean;
  notes: string;
  lastScannedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryRepoInput {
  repo?: string;
  branch?: string;
  pathPrefixes?: string[];
  enabled?: boolean;
  notes?: string;
}

interface RawRow {
  id: string;
  repo: string;
  branch: string;
  path_prefixes: string;
  enabled: number;
  notes: string;
  last_scanned_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function normalizePathPrefixes(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const prefix = item.trim().replace(/^\/+|\/+$/g, '');
    if (!prefix) continue;
    if (prefix.length > 200 || prefix.includes('..') || !PATH_PATTERN.test(prefix)) return null;
    if (!result.includes(prefix)) result.push(prefix);
  }
  if (result.length > 5) return null;
  return result;
}

function parsePrefixes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function fromRow(row: RawRow): DiscoveryRepoRow {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    pathPrefixes: parsePrefixes(row.path_prefixes),
    enabled: row.enabled === 1,
    notes: row.notes,
    lastScannedAt: row.last_scanned_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `id, repo, branch, path_prefixes, enabled, notes, last_scanned_at, last_error, created_at, updated_at`;

export async function listDiscoveryRepos(db: D1Database): Promise<DiscoveryRepoRow[]> {
  const result = await db
    .prepare(`SELECT ${COLUMNS} FROM discovery_repos ORDER BY created_at ASC`)
    .all<RawRow>();
  return (result.results ?? []).map(fromRow);
}

export async function getDiscoveryRepo(db: D1Database, id: string): Promise<DiscoveryRepoRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM discovery_repos WHERE id = ?`).bind(id).first<RawRow>();
  return row ? fromRow(row) : null;
}

export function validateDiscoveryRepoInput(
  input: DiscoveryRepoInput,
  base?: DiscoveryRepoRow,
): { ok: true; value: Omit<DiscoveryRepoRow, 'id' | 'createdAt' | 'updatedAt' | 'lastScannedAt' | 'lastError'> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const repo = text(input.repo ?? base?.repo, 120);
  if (!REPO_PATTERN.test(repo)) errors.push('仓库格式应为 owner/repo');

  const branch = text(input.branch ?? base?.branch ?? 'main', 80) || 'main';
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    errors.push('分支名不合法');
  }

  let pathPrefixes = base?.pathPrefixes ?? [];
  if (input.pathPrefixes !== undefined) {
    const normalized = normalizePathPrefixes(input.pathPrefixes);
    if (normalized === null) errors.push('路径前缀不合法：最多 5 个，只能是相对路径');
    else pathPrefixes = normalized;
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      repo,
      branch,
      pathPrefixes,
      enabled: input.enabled ?? base?.enabled ?? true,
      notes: text(input.notes ?? base?.notes, 200),
    },
  };
}

export async function createDiscoveryRepo(
  db: D1Database,
  input: DiscoveryRepoInput,
  now = new Date().toISOString(),
): Promise<{ ok: true; row: DiscoveryRepoRow } | { ok: false; errors: string[]; status?: number }> {
  const validated = validateDiscoveryRepoInput(input);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const value = validated.value;
  const existing = await db
    .prepare('SELECT id FROM discovery_repos WHERE repo = ? AND branch = ?')
    .bind(value.repo, value.branch)
    .first<{ id: string }>();
  if (existing) return { ok: false, errors: [`仓库已存在：${value.repo}@${value.branch}`], status: 409 };

  const id = `dr_${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO discovery_repos (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
    .bind(
      id,
      value.repo,
      value.branch,
      JSON.stringify(value.pathPrefixes),
      value.enabled ? 1 : 0,
      value.notes,
      now,
      now,
    )
    .run();
  const row = await getDiscoveryRepo(db, id);
  if (!row) return { ok: false, errors: ['写入后读取失败'] };
  return { ok: true, row };
}

export async function updateDiscoveryRepo(
  db: D1Database,
  id: string,
  input: DiscoveryRepoInput,
  now = new Date().toISOString(),
): Promise<{ ok: true; row: DiscoveryRepoRow } | { ok: false; errors: string[]; status?: number }> {
  const existing = await getDiscoveryRepo(db, id);
  if (!existing) return { ok: false, errors: ['仓库不存在'], status: 404 };
  const validated = validateDiscoveryRepoInput(input, existing);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const value = validated.value;
  const duplicate = await db
    .prepare('SELECT id FROM discovery_repos WHERE repo = ? AND branch = ? AND id <> ?')
    .bind(value.repo, value.branch, id)
    .first<{ id: string }>();
  if (duplicate) return { ok: false, errors: [`仓库已存在：${value.repo}@${value.branch}`], status: 409 };

  await db
    .prepare(
      `UPDATE discovery_repos
          SET repo = ?, branch = ?, path_prefixes = ?, enabled = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      value.repo,
      value.branch,
      JSON.stringify(value.pathPrefixes),
      value.enabled ? 1 : 0,
      value.notes,
      now,
      id,
    )
    .run();
  const row = await getDiscoveryRepo(db, id);
  if (!row) return { ok: false, errors: ['写入后读取失败'] };
  return { ok: true, row };
}

export async function deleteDiscoveryRepo(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM discovery_repos WHERE id = ?').bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Runner 公开配置：只下发启用的自定义仓库，内置仓库仍在仓库内 JSON。 */
export async function publicDiscoveryRepos(
  db: D1Database,
  limits: { maxFetchPerRun?: number; maxFetchPerRepo?: number } = {},
): Promise<{
  version: 1;
  maxFetchPerRun: number;
  maxFetchPerRepo: number;
  repos: { repo: string; branch: string; pathPrefixes?: string[] }[];
}> {
  const rows = await listDiscoveryRepos(db);
  return {
    version: 1,
    maxFetchPerRun: limits.maxFetchPerRun ?? 20,
    maxFetchPerRepo: limits.maxFetchPerRepo ?? 5,
    repos: rows
      .filter((row) => row.enabled)
      .slice(0, 200)
      .map((row) => ({
        repo: row.repo,
        branch: row.branch,
        ...(row.pathPrefixes.length ? { pathPrefixes: row.pathPrefixes } : {}),
      })),
  };
}
