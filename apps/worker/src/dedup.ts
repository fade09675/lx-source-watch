/**
 * Duplicate decisions for sources and candidates.
 *
 * Identity order:
 * 1. full content sha256 (strong, cross-URL)
 * 2. normalized URL (same address)
 * 3. same title + author with a different sha256 is only a hint
 */

export type DedupKind = 'same_sha256' | 'same_url' | 'similar' | 'unique';
export type DedupAction = 'alias' | 'merge_candidates' | 'hint' | 'none';
export type DedupEntryKind = 'registry' | 'candidate';

export interface DedupEntry {
  id: string;
  url: string;
  sha256: string | null;
  title: string;
  author: string;
  version: string;
  enabled: boolean;
  official: boolean;
  firstSeen: string;
  kind: DedupEntryKind;
}

export interface DedupTarget {
  url: string;
  sha256?: string | null;
  title?: string;
  author?: string;
  version?: string;
  enabled?: boolean;
  firstSeen?: string;
  kind?: DedupEntryKind;
}

export interface DedupMatchSet {
  sha256: DedupEntry[];
  url: DedupEntry[];
  similar: DedupEntry[];
}

export interface DedupDecision {
  kind: DedupKind;
  action: DedupAction;
  canonical: DedupEntry | null;
  reason: string;
  matches: DedupMatchSet;
}

interface RegistryDedupRow {
  id: string;
  url: string;
  content_sha256: string | null;
  title: string;
  author: string;
  created_at: string;
  enabled: number;
}

interface CandidateDedupRow {
  id: string;
  url: string;
  sha256: string | null;
  title: string | null;
  author: string | null;
  version: string | null;
  state: string;
  first_seen: string | null;
}

/** Normalize only for comparison, not for storage. Mirrors aliases.normalizeSourceUrl. */
export function comparableUrl(raw: string): string {
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

/** pdone/lx-music-source is the reference upstream for this project. */
export function isOfficialUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return /(^|\/)pdone\//i.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/** Higher version wins; non-numeric versions fall back to string compare. */
export function compareVersion(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

/**
 * Pick the canonical entry:
 * enabled first, then official upstream, then earliest discovery, then newest version.
 */
export function chooseCanonical(entries: readonly DedupEntry[]): DedupEntry | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.official !== b.official) return a.official ? -1 : 1;
    const seen = a.firstSeen.localeCompare(b.firstSeen);
    if (seen !== 0) return seen;
    return -compareVersion(a.version, b.version);
  });
  return sorted[0] ?? null;
}

function uniqueEntries(entries: readonly DedupEntry[]): DedupEntry[] {
  const seen = new Set<string>();
  const out: DedupEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Pure classification. DB lookups happen in lookupMatches; this function only
 * applies the rules so it can be tested without D1.
 */
export function classifyDuplicate(target: DedupTarget, matches: DedupMatchSet): DedupDecision {
  const shaMatches = uniqueEntries(matches.sha256).filter(
    (entry) => !(entry.url === comparableUrl(target.url) && target.kind === entry.kind),
  );
  if (target.sha256 && shaMatches.length > 0) {
    const canonical = chooseCanonical(shaMatches)!;
    return {
      kind: 'same_sha256',
      action: canonical.kind === 'registry' ? 'alias' : 'merge_candidates',
      canonical,
      reason: `内容 sha256 相同（${target.sha256.slice(0, 12)}…）`,
      matches,
    };
  }

  const urlMatches = uniqueEntries(matches.url);
  if (urlMatches.length > 0) {
    const canonical = chooseCanonical(urlMatches)!;
    return {
      kind: 'same_url',
      action: canonical.kind === 'registry' ? 'alias' : 'merge_candidates',
      canonical,
      reason: '地址相同',
      matches,
    };
  }

  const similar = uniqueEntries(matches.similar).filter((entry) => {
    if (!target.sha256 || !entry.sha256) return true;
    return entry.sha256 !== target.sha256;
  });
  if (similar.length > 0) {
    return {
      kind: 'similar',
      action: 'hint',
      canonical: chooseCanonical(similar),
      reason: '名称与作者相同，但内容 sha256 不同，仅提示',
      matches: { ...matches, similar },
    };
  }

  return { kind: 'unique', action: 'none', canonical: null, reason: '未发现重复', matches };
}

async function registryEntries(db: D1Database, where: string, binds: unknown[]): Promise<DedupEntry[]> {
  const rows = await db
    .prepare(
      `SELECT id, url, content_sha256, title, author, created_at, enabled
       FROM source_registry WHERE ${where} LIMIT 50`,
    )
    .bind(...binds)
    .all<RegistryDedupRow>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    url: comparableUrl(row.url),
    sha256: row.content_sha256 ?? null,
    title: row.title,
    author: row.author ?? '',
    version: '',
    enabled: row.enabled === 1,
    official: isOfficialUrl(row.url),
    firstSeen: row.created_at,
    kind: 'registry' as const,
  }));
}

async function candidateEntries(db: D1Database, where: string, binds: unknown[]): Promise<DedupEntry[]> {
  const rows = await db
    .prepare(
      `SELECT id, url, sha256, title, author, version, state, first_seen
       FROM candidates WHERE ${where} LIMIT 50`,
    )
    .bind(...binds)
    .all<CandidateDedupRow>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    url: comparableUrl(row.url),
    sha256: row.sha256 ?? null,
    title: row.title ?? '',
    author: row.author ?? '',
    version: row.version ?? '',
    enabled: row.state === 'promoted',
    official: isOfficialUrl(row.url),
    firstSeen: row.first_seen ?? '',
    kind: 'candidate' as const,
  }));
}

/** Look up strong, URL and similar matches for a candidate/source input. */
export async function lookupMatches(db: D1Database, target: DedupTarget): Promise<DedupMatchSet> {
  const url = comparableUrl(target.url);
  const [regSha, candSha, regUrl, candUrl, regSimilar, candSimilar] = await Promise.all([
    target.sha256 ? registryEntries(db, 'content_sha256 = ?', [target.sha256]) : Promise.resolve([]),
    target.sha256 ? candidateEntries(db, 'sha256 = ?', [target.sha256]) : Promise.resolve([]),
    registryEntries(db, 'url = ?', [target.url]),
    candidateEntries(db, 'url = ?', [target.url]),
    target.title && target.author
      ? registryEntries(db, "title = ? AND (author = ? OR author = '')", [target.title, target.author])
      : Promise.resolve([]),
    target.title && target.author
      ? candidateEntries(db, 'title = ? AND author = ?', [target.title, target.author])
      : Promise.resolve([]),
  ]);

  return {
    sha256: [...regSha, ...candSha],
    url: [...regUrl, ...candUrl],
    similar: [...regSimilar, ...candSimilar].filter((entry) => entry.url !== url),
  };
}

export async function decideDuplicate(db: D1Database, target: DedupTarget): Promise<DedupDecision> {
  const matches = await lookupMatches(db, target);
  return classifyDuplicate(target, matches);
}

export interface DuplicateEntryView {
  kind: DedupEntryKind;
  id: string;
  url: string;
  sha256: string;
  title: string;
  author: string;
  version: string;
  enabled: boolean;
  state: string;
  official: boolean;
  firstSeen: string;
}

export interface DuplicateGroup {
  sha256: string;
  canonical: DuplicateEntryView;
  entries: DuplicateEntryView[];
  /** True when every non-canonical URL is already an active alias of the canonical source. */
  merged: boolean;
}

export interface SimilarGroup {
  title: string;
  author: string;
  entries: DuplicateEntryView[];
}

export interface AliasView {
  url: string;
  canonicalSourceId: string;
  canonicalTitle: string;
  sha256: string | null;
  source: string;
  state: string;
  updatedAt: string;
}

export interface DuplicateOverview {
  groups: DuplicateGroup[];
  similar: SimilarGroup[];
  aliases: AliasView[];
  counts: { groups: number; duplicateUrls: number; mergedUrls: number; aliases: number; similar: number };
}

function toView(entry: DedupEntry, state = ''): DuplicateEntryView {
  return {
    kind: entry.kind,
    id: entry.id,
    url: entry.url,
    sha256: entry.sha256 ?? '',
    title: entry.title,
    author: entry.author,
    version: entry.version,
    enabled: entry.enabled,
    state,
    official: entry.official,
    firstSeen: entry.firstSeen,
  };
}

/**
 * Read-only overview of duplicate content groups, similar-name hints and aliases.
 * Small datasets (hundreds of rows), so grouping happens in JS for clarity.
 */
export async function listDuplicateOverview(db: D1Database, now = new Date().toISOString()): Promise<DuplicateOverview> {
  const [registry, candidates, aliasRows, titles] = await Promise.all([
    db
      .prepare(
        `SELECT id, url, content_sha256, title, author, created_at, enabled
         FROM source_registry WHERE content_sha256 IS NOT NULL AND content_sha256 <> '' LIMIT 1000`,
      )
      .all<RegistryDedupRow>(),
    db
      .prepare(
        `SELECT id, url, sha256, title, author, version, state, first_seen
         FROM candidates WHERE sha256 IS NOT NULL AND sha256 <> '' LIMIT 2000`,
      )
      .all<CandidateDedupRow>(),
    db
      .prepare('SELECT alias_url, canonical_source_id, sha256, source, state, updated_at FROM source_aliases WHERE state = \'active\' LIMIT 2000')
      .all<{ alias_url: string; canonical_source_id: string; sha256: string | null; source: string; state: string; updated_at: string }>(),
    db.prepare('SELECT id, title FROM source_registry LIMIT 1000').all<{ id: string; title: string }>(),
  ]);

  const titleById = new Map((titles.results ?? []).map((row) => [row.id, row.title]));
  const aliasByUrl = new Map(
    (aliasRows.results ?? []).map((row) => [comparableUrl(row.alias_url), row]),
  );

  const bySha = new Map<string, DedupEntry[]>();
  const stateById = new Map<string, string>();

  for (const row of registry.results ?? []) {
    const entry: DedupEntry = {
      id: row.id,
      url: comparableUrl(row.url),
      sha256: row.content_sha256,
      title: row.title,
      author: row.author ?? '',
      version: '',
      enabled: row.enabled === 1,
      official: isOfficialUrl(row.url),
      firstSeen: row.created_at,
      kind: 'registry',
    };
    const list = bySha.get(row.content_sha256!) ?? [];
    list.push(entry);
    bySha.set(row.content_sha256!, list);
  }

  for (const row of candidates.results ?? []) {
    const entry: DedupEntry = {
      id: row.id,
      url: comparableUrl(row.url),
      sha256: row.sha256,
      title: row.title ?? '',
      author: row.author ?? '',
      version: row.version ?? '',
      enabled: row.state === 'promoted',
      official: isOfficialUrl(row.url),
      firstSeen: row.first_seen ?? '',
      kind: 'candidate',
    };
    stateById.set(`candidate:${row.id}`, row.state);
    const list = bySha.get(row.sha256!) ?? [];
    list.push(entry);
    bySha.set(row.sha256!, list);
  }

  const groups: DuplicateGroup[] = [];
  let duplicateUrls = 0;
  let mergedUrls = 0;
  for (const [sha256, entries] of bySha) {
    const urls = new Set(entries.map((entry) => entry.url));
    if (urls.size < 2) continue;
    const canonical = chooseCanonical(entries)!;
    const others = entries.filter((entry) => entry !== canonical);
    const distinct = others.filter((entry) => entry.url !== canonical.url);
    let merged = true;
    for (const entry of distinct) {
      const alias = aliasByUrl.get(entry.url);
      if (!alias || alias.canonical_source_id !== canonical.id) {
        merged = false;
        break;
      }
    }
    duplicateUrls += distinct.length;
    if (merged) mergedUrls += distinct.length;
    groups.push({
      sha256,
      canonical: toView(canonical),
      entries: entries.map((entry) =>
        toView(entry, entry.kind === 'candidate' ? (stateById.get(`candidate:${entry.id}`) ?? '') : ''),
      ),
      merged,
    });
  }
  groups.sort((a, b) => b.entries.length - a.entries.length);

  const similarMap = new Map<string, DedupEntry[]>();
  for (const row of candidates.results ?? []) {
    if (!row.title || !row.author) continue;
    const key = `${row.title}\u0000${row.author}`;
    const entry: DedupEntry = {
      id: row.id,
      url: comparableUrl(row.url),
      sha256: row.sha256,
      title: row.title,
      author: row.author,
      version: row.version ?? '',
      enabled: row.state === 'promoted',
      official: isOfficialUrl(row.url),
      firstSeen: row.first_seen ?? '',
      kind: 'candidate',
    };
    const list = similarMap.get(key) ?? [];
    list.push(entry);
    similarMap.set(key, list);
  }
  const similar: SimilarGroup[] = [];
  for (const list of similarMap.values()) {
    const shas = new Set(list.map((entry) => entry.sha256).filter(Boolean));
    if (shas.size < 2) continue;
    similar.push({
      title: list[0]?.title ?? '',
      author: list[0]?.author ?? '',
      entries: list.map((entry) => toView(entry, stateById.get(`candidate:${entry.id}`) ?? '')),
    });
  }
  similar.sort((a, b) => b.entries.length - a.entries.length);

  const aliases: AliasView[] = (aliasRows.results ?? []).map((row) => ({
    url: row.alias_url,
    canonicalSourceId: row.canonical_source_id,
    canonicalTitle: titleById.get(row.canonical_source_id) ?? row.canonical_source_id,
    sha256: row.sha256,
    source: row.source,
    state: row.state,
    updatedAt: row.updated_at,
  }));

  return {
    groups,
    similar: similar.slice(0, 50),
    aliases,
    counts: {
      groups: groups.length,
      duplicateUrls,
      mergedUrls,
      aliases: aliases.length,
      similar: similar.length,
    },
  };
}

