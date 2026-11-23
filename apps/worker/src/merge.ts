import { INTERVAL_HOURS, summarizeSources, type Snapshot, type SourceResult } from '@lx/shared';

/**
 * 合并局部复测（checkScope=partial）与上一轮快照。
 * 全量快照直接替换，但仍重算 summary，防止 runner 传来的汇总与明细不一致。
 */
export function mergeSnapshot(prev: Snapshot | null, incoming: Snapshot): Snapshot {
  const incomingSources = new Map<string, SourceResult>();
  for (const source of incoming.sources) incomingSources.set(source.id, source);

  if (!prev || incoming.checkScope === 'all') {
    const sources = [...incomingSources.values()];
    return { ...incoming, sources, summary: summarizeSources(sources) };
  }

  const merged = new Map<string, SourceResult>();
  for (const source of prev.sources) merged.set(source.id, source);
  for (const [id, source] of incomingSources) merged.set(id, source);

  const sources = [...merged.values()];
  return { ...incoming, sources, summary: summarizeSources(sources) };
}

/** 快照超过两个检测周期没更新即视为过期（默认 8 小时）。 */
export function isStale(
  generatedAt: string,
  now: number = Date.now(),
  intervalHours: number = INTERVAL_HOURS,
): boolean {
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return true;
  return now - generated > intervalHours * 2 * 3_600_000;
}
