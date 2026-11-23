import { summarizeSources, type Snapshot, type SourceResult } from '@lx/shared';

export interface StatusFilter {
  platforms?: string[];
  statuses?: string[];
  q?: string;
}

export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesPlatform(source: SourceResult, platforms: string[]): boolean {
  if (platforms.length === 0) return true;
  const wanted = new Set(platforms);
  return source.platforms.some((platform) => platform.declared && wanted.has(platform.key));
}

function matchesQuery(source: SourceResult, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [source.id, source.title, source.author ?? '', source.description ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** 过滤只作用于返回给客户端的快照，不改变 KV 里的完整数据。 */
export function filterSnapshot(snapshot: Snapshot, filter: StatusFilter): Snapshot {
  const platforms = filter.platforms ?? [];
  const statuses = filter.statuses ?? [];
  const q = filter.q?.trim() ?? '';

  if (platforms.length === 0 && statuses.length === 0 && !q) return snapshot;

  const sources = snapshot.sources.filter((source) => {
    if (statuses.length > 0 && !statuses.includes(source.status)) return false;
    if (!matchesPlatform(source, platforms)) return false;
    return matchesQuery(source, q);
  });

  return { ...snapshot, sources, summary: summarizeSources(sources) };
}
