import type { D1Database } from '@cloudflare/workers-types';
import { chooseCanonical, comparableUrl, isOfficialUrl, type DedupEntry } from './dedup';
import { mergeIntoCanonical } from './mergeSources';

/** 一轮上报后自动合并的注册表重复组上限，避免单次请求写太多行。 */
const MAX_GROUPS_PER_RUN = 5;
const MAX_ROWS = 1000;

export interface RegistryMergeRow {
  id: string;
  title: string;
  url: string;
  content_sha256: string | null;
  enabled: number;
  created_at: string;
}

export interface RegistryMergePlan {
  sha256: string;
  canonicalId: string;
  canonicalUrl: string;
  duplicates: { url: string; sourceId: string }[];
}

export interface AutoMergeResult {
  groups: number;
  merged: number;
  aliases: string[];
  disabled: string[];
  errors: string[];
}

function toEntry(row: RegistryMergeRow): DedupEntry {
  return {
    id: row.id,
    url: comparableUrl(row.url),
    sha256: row.content_sha256,
    title: row.title,
    author: '',
    version: '',
    enabled: row.enabled === 1,
    official: isOfficialUrl(row.url),
    firstSeen: row.created_at,
    kind: 'registry',
  };
}

/**
 * 纯规划：按 sha256 分组，选出主源，列出还没别名的重复地址。
 * 已有 active 别名指向同一主源的地址不再重复处理。
 */
export function planRegistryMerges(
  rows: readonly RegistryMergeRow[],
  activeAliases: ReadonlyMap<string, string>,
  maxGroups = MAX_GROUPS_PER_RUN,
): RegistryMergePlan[] {
  const bySha = new Map<string, DedupEntry[]>();
  for (const row of rows) {
    if (!row.content_sha256) continue;
    const entry = toEntry(row);
    const list = bySha.get(row.content_sha256) ?? [];
    list.push(entry);
    bySha.set(row.content_sha256, list);
  }

  const plans: RegistryMergePlan[] = [];
  for (const [sha256, entries] of bySha) {
    const urls = new Set(entries.map((entry) => entry.url));
    if (urls.size < 2) continue;
    const canonical = chooseCanonical(entries);
    if (!canonical || !canonical.enabled) continue;
    const duplicates: { url: string; sourceId: string }[] = [];
    for (const entry of entries) {
      if (entry.id === canonical.id) continue;
      if (entry.url === canonical.url) continue;
      const aliasedTo = activeAliases.get(entry.url);
      if (aliasedTo === canonical.id) continue;
      duplicates.push({ url: entry.url, sourceId: entry.id });
    }
    if (duplicates.length === 0) continue;
    plans.push({ sha256, canonicalId: canonical.id, canonicalUrl: canonical.url, duplicates });
  }

  plans.sort((a, b) => b.duplicates.length - a.duplicates.length);
  return plans.slice(0, Math.max(0, maxGroups));
}

/**
 * 探测上报后调用：把注册表里内容相同、但还没建立别名的源自动并入主源。
 * 重复源只停用不删除；任何异常都只记录，不影响上报。
 */
export async function autoMergeRegistryDuplicates(
  env: { DB: D1Database },
  now = new Date().toISOString(),
): Promise<AutoMergeResult> {
  const result: AutoMergeResult = { groups: 0, merged: 0, aliases: [], disabled: [], errors: [] };

  const rows = await env.DB.prepare(
    `SELECT id, title, url, content_sha256, enabled, created_at
     FROM source_registry
     WHERE content_sha256 IS NOT NULL AND content_sha256 <> ''
     LIMIT ${MAX_ROWS}`,
  ).all<RegistryMergeRow>();

  const aliasRows = await env.DB.prepare(
    `SELECT alias_url, canonical_source_id FROM source_aliases WHERE state = 'active' LIMIT 2000`,
  ).all<{ alias_url: string; canonical_source_id: string }>();

  const aliases = new Map<string, string>();
  for (const row of aliasRows.results ?? []) {
    aliases.set(comparableUrl(row.alias_url), row.canonical_source_id);
  }

  const plans = planRegistryMerges(rows.results ?? [], aliases);
  result.groups = plans.length;
  for (const plan of plans) {
    try {
      const merged = await mergeIntoCanonical(env.DB, plan.canonicalId, plan.duplicates, now);
      if (!merged.ok) {
        result.errors.push(`${plan.canonicalId}: ${merged.errors.join('；')}`);
        continue;
      }
      result.merged += 1;
      result.aliases.push(...merged.aliases);
      result.disabled.push(...merged.disabled);
    } catch (error) {
      result.errors.push(
        `${plan.canonicalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
