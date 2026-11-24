/** Where an alias record came from. */
export type AliasSource = 'manual' | 'candidate' | 'probe' | 'merge';
/** Active aliases take part in dedup; ignored ones are kept for audit only. */
export type AliasState = 'active' | 'ignored';

export interface SourceAlias {
  url: string;
  canonicalSourceId: string;
  sha256: string | null;
  source: AliasSource;
  state: AliasState;
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface AliasInput {
  url: string;
  canonicalSourceId: string;
  sha256?: string | null;
  source?: AliasSource;
  evidence?: string;
}

interface AliasRow {
  alias_url: string;
  canonical_source_id: string;
  sha256: string | null;
  source: string;
  state: string;
  evidence: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `alias_url, canonical_source_id, sha256, source, state, evidence, created_at, updated_at`;

const SOURCES: AliasSource[] = ['manual', 'candidate', 'probe', 'merge'];

/**
 * Normalize a source URL for alias lookup.
 *
 * Rules (deliberately conservative — content identity is sha256's job):
 * - lowercase scheme/host, drop default ports and fragments;
 * - drop cache-busting query keys (`t`, `timestamp`, `_`, `cachebust`);
 * - strip trailing slashes on non-root paths.
 * Query strings that may select a different file (e.g. `?source=cihedai`) are kept.
 */
export function normalizeSourceUrl(raw: string): string {
  const value = raw.trim();
  try {
    const url = new URL(value);
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    for (const key of ['t', 'timestamp', '_', 'cachebust']) url.searchParams.delete(key);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value;
  }
}

function toAlias(row: AliasRow): SourceAlias {
  return {
    url: row.alias_url,
    canonicalSourceId: row.canonical_source_id,
    sha256: row.sha256 ?? null,
    source: SOURCES.includes(row.source as AliasSource) ? (row.source as AliasSource) : 'manual',
    state: row.state === 'ignored' ? 'ignored' : 'active',
    evidence: row.evidence ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAlias(db: D1Database, url: string): Promise<SourceAlias | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM source_aliases WHERE alias_url = ?`)
    .bind(normalizeSourceUrl(url))
    .first<AliasRow>();
  return row ? toAlias(row) : null;
}

export async function listAliases(
  db: D1Database,
  options: { canonicalSourceId?: string; state?: AliasState; limit?: number } = {},
): Promise<SourceAlias[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (options.canonicalSourceId) {
    where.push('canonical_source_id = ?');
    binds.push(options.canonicalSourceId);
  }
  if (options.state) {
    where.push('state = ?');
    binds.push(options.state);
  }
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const sql = `SELECT ${COLUMNS} FROM source_aliases${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
  const result = await db.prepare(sql).bind(...binds, limit).all<AliasRow>();
  return (result.results ?? []).map(toAlias);
}

export async function listAliasesForSource(db: D1Database, sourceId: string): Promise<SourceAlias[]> {
  return listAliases(db, { canonicalSourceId: sourceId, state: 'active', limit: 200 });
}

/** Upsert by normalized alias URL. Re-pointing an alias updates its canonical source. */
export async function upsertAlias(db: D1Database, input: AliasInput, now = new Date().toISOString()): Promise<SourceAlias> {
  const url = normalizeSourceUrl(input.url);
  await db
    .prepare(
      `INSERT INTO source_aliases (alias_url, canonical_source_id, sha256, source, state, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(alias_url) DO UPDATE SET
         canonical_source_id = excluded.canonical_source_id,
         sha256 = COALESCE(excluded.sha256, source_aliases.sha256),
         source = excluded.source,
         state = 'active',
         evidence = excluded.evidence,
         updated_at = excluded.updated_at`,
    )
    .bind(
      url,
      input.canonicalSourceId,
      input.sha256 ?? null,
      input.source ?? 'manual',
      input.evidence ?? '',
      now,
      now,
    )
    .run();
  const saved = await getAlias(db, url);
  if (!saved) throw new Error('别名写入后读取失败');
  return saved;
}

export async function setAliasState(
  db: D1Database,
  url: string,
  state: AliasState,
  now = new Date().toISOString(),
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE source_aliases SET state = ?, updated_at = ? WHERE alias_url = ?')
    .bind(state, now, normalizeSourceUrl(url))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteAlias(db: D1Database, url: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM source_aliases WHERE alias_url = ?')
    .bind(normalizeSourceUrl(url))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function countAliases(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM source_aliases WHERE state = \'active\'').first<{ n: number }>();
  return Number(row?.n ?? 0);
}
