import { summarizeSources, type PlatformResult, type Snapshot, type SourceResult } from '@lx/shared';

export function makePlatform(over: Partial<PlatformResult> & { key: string }): PlatformResult {
  const tested = over.tested ?? true;
  const base: PlatformResult = {
    key: over.key,
    name: over.name ?? over.key,
    declared: over.declared ?? true,
    tested,
    ok: over.ok ?? tested,
    totalMs: over.totalMs ?? 500,
  };
  return { ...base, ...over };
}

export function makeSource(over: Partial<SourceResult> & { id: string }): SourceResult {
  const platforms = over.platforms ?? [makePlatform({ key: 'wy', ok: true })];
  const stats = over.stats ?? {
    ok: platforms.filter((platform) => platform.ok).length,
    tested: platforms.filter((platform) => platform.tested).length,
    total: platforms.length,
  };
  const derivedStatus =
    stats.tested <= 0 ? 'untested' : stats.ok <= 0 ? 'unavailable' : stats.ok >= stats.tested ? 'available' : 'partial';

  const base: SourceResult = {
    id: over.id,
    title: over.title ?? over.id,
    url: over.url ?? `https://example.com/${over.id}.js`,
    category: over.category ?? '在线',
    storage: over.storage ?? 'remote',
    status: over.status ?? derivedStatus,
    initOk: over.initOk ?? true,
    stats,
    platforms,
    checkedAt: over.checkedAt ?? '2026-11-23T10:00:00.000Z',
    durationMs: over.durationMs ?? 1_000,
  };
  return { ...base, ...over };
}

export function makeSnapshot(sources: SourceResult[], over: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    schemaVersion: 1,
    runId: over.runId ?? 'run-1',
    generatedAt: over.generatedAt ?? '2026-11-23T10:00:00.000Z',
    nextCheckAt: over.nextCheckAt ?? '2026-11-23T14:00:00.000Z',
    intervalHours: 4,
    runner: over.runner ?? 'local',
    checkScope: over.checkScope ?? 'all',
    durationMs: over.durationMs ?? 5_000,
    summary: summarizeSources(sources),
    sources,
  };
  const merged = { ...base, ...over };
  return { ...merged, summary: summarizeSources(merged.sources), sources: merged.sources };
}
