import { normalizeSourceUrl, upsertAlias } from './aliases';
import { getSourceRegistry, type SourceRegistryRow } from './sourceRegistry';

export interface MergeDuplicate {
  /** Alias URL to attach to the canonical source. */
  url: string;
  /** Registry id of the duplicate source; when set it is disabled (never deleted). */
  sourceId?: string;
  sha256?: string | null;
}

export interface MergeResult {
  ok: boolean;
  canonicalId: string;
  addedMirrors: string[];
  aliases: string[];
  disabled: string[];
  errors: string[];
}

/** Pure mirror merge used by tests and by mergeIntoCanonical. */
export function mergeMirrorLists(
  canonicalUrl: string,
  existing: readonly string[],
  incoming: readonly string[],
): { mirrors: string[]; added: string[] } {
  const seen = new Set<string>(existing.map((url) => normalizeSourceUrl(url)));
  const canonical = normalizeSourceUrl(canonicalUrl);
  const mirrors = [...existing];
  const added: string[] = [];
  for (const raw of incoming) {
    const url = normalizeSourceUrl(raw);
    if (!url || url === canonical || seen.has(url)) continue;
    seen.add(url);
    mirrors.push(raw.trim());
    added.push(raw.trim());
  }
  return { mirrors, added };
}

async function loadCanonical(db: D1Database, canonicalId: string): Promise<SourceRegistryRow | null> {
  return getSourceRegistry(db, canonicalId);
}

/**
 * Attach duplicate URLs to a canonical registry source:
 * - add each URL to the canonical mirrors (dedup by normalized URL);
 * - record an active alias;
 * - disable duplicate registry sources without deleting them.
 *
 * The caller is responsible for confirming that content really is identical.
 */
export async function mergeIntoCanonical(
  db: D1Database,
  canonicalId: string,
  duplicates: readonly MergeDuplicate[],
  now = new Date().toISOString(),
): Promise<MergeResult> {
  const result: MergeResult = {
    ok: false,
    canonicalId,
    addedMirrors: [],
    aliases: [],
    disabled: [],
    errors: [],
  };

  const canonical = await loadCanonical(db, canonicalId);
  if (!canonical) {
    result.errors.push(`主源不存在：${canonicalId}`);
    return result;
  }

  const urls = duplicates.map((item) => item.url).filter((url) => url.trim().length > 0);
  const { mirrors, added } = mergeMirrorLists(canonical.url, canonical.mirrors, urls);
  if (added.length > 0) {
    await db
      .prepare('UPDATE source_registry SET mirrors = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(mirrors), now, canonicalId)
      .run();
    result.addedMirrors = added;
  }

  for (const item of duplicates) {
    const aliasUrl = normalizeSourceUrl(item.url);
    if (!aliasUrl) continue;
    try {
      await upsertAlias(
        db,
        {
          url: aliasUrl,
          canonicalSourceId: canonicalId,
          sha256: item.sha256 ?? canonical.contentSha256 ?? null,
          source: 'merge',
          evidence: `自动合并到 ${canonicalId}`,
        },
        now,
      );
      result.aliases.push(aliasUrl);
    } catch (error) {
      result.errors.push(`别名写入失败：${aliasUrl}：${error instanceof Error ? error.message : String(error)}`);
    }

    if (item.sourceId && item.sourceId !== canonicalId) {
      const update = await db
        .prepare(
          `UPDATE source_registry
           SET enabled = 0,
               notes = CASE WHEN notes LIKE ? THEN notes ELSE notes || ? END,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(`%已合并到 ${canonicalId}%`, `\n已合并到 ${canonicalId}`, now, item.sourceId)
        .run();
      if ((update.meta?.changes ?? 0) > 0) result.disabled.push(item.sourceId);
    }
  }

  const auditId = `merge:${canonicalId}:${now}`;
  await db
    .prepare('INSERT INTO events (id, at, type, source_id, title, message) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(
      auditId,
      now,
      'merged',
      canonicalId,
      '重复源合并',
      `已将 ${duplicates.length} 个重复地址合并到 ${canonicalId}`,
    )
    .run();

  result.ok = result.errors.length === 0;
  return result;
}

/** Mark a candidate as a duplicate; never deletes the row. */
export async function markCandidateDuplicate(
  db: D1Database,
  candidateId: string,
  canonicalId: string,
  now = new Date().toISOString(),
): Promise<boolean> {
  const update = await db
    .prepare('UPDATE candidates SET state = ?, last_seen = ? WHERE id = ?')
    .bind('duplicate', now, candidateId);
  // state has no free-text column; the audit event records the canonical target.
  const result = await update.run();
  if ((result.meta?.changes ?? 0) === 0) return false;
  await db
    .prepare('INSERT INTO events (id, at, type, source_id, title, message) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(
      `dup:${candidateId}:${now}`,
      now,
      'merged',
      canonicalId,
      '候选重复',
      `候选 ${candidateId} 与 ${canonicalId} 内容相同，已标记为重复`,
    )
    .run();
  return true;
}
