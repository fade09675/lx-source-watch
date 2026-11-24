import { summarizeSources, type Snapshot, type SourceResult } from '@lx/shared';

export interface StatusFilter {
  platforms?: string[];
  statuses?: string[];
  /** 国内补测筛选：failed 只看至少一个平台国内不可达的源；ok 只看国内全可达的源。 */
  cn?: string;
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

function matchesCn(source: SourceResult, cn: string): boolean {
  if (!cn) return true;
  const tested = source.platforms.filter((platform) => platform.declared && platform.cn?.tested);
  if (cn === 'failed') return tested.some((platform) => !platform.cn?.ok);
  if (cn === 'ok') return tested.length > 0 && tested.every((platform) => platform.cn?.ok);
  if (cn === 'untested') return tested.length === 0;
  return true;
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
  const cn = filter.cn?.trim() ?? '';
  const q = filter.q?.trim() ?? '';

  if (platforms.length === 0 && statuses.length === 0 && !cn && !q) return snapshot;

  const sources = snapshot.sources.filter((source) => {
    if (statuses.length > 0 && !statuses.includes(source.status)) return false;
    if (!matchesPlatform(source, platforms)) return false;
    if (!matchesCn(source, cn)) return false;
    return matchesQuery(source, q);
  });

  return { ...snapshot, sources, summary: summarizeSources(sources) };
}
