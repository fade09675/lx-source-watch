export const SOURCE_STATUSES = ['available', 'partial', 'unavailable', 'untested'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface StatusMeta {
  label: string;
  short: string;
  color: string;
  tone: 'ok' | 'warn' | 'bad' | 'idle';
}

export const STATUS_META: Record<SourceStatus, StatusMeta> = {
  available: { label: '可用', short: '可用', color: '#10b981', tone: 'ok' },
  partial: { label: '部分可用', short: '部分', color: '#f59e0b', tone: 'warn' },
  unavailable: { label: '不可用', short: '失效', color: '#ef4444', tone: 'bad' },
  untested: { label: '未测试', short: '未测', color: '#94a3b8', tone: 'idle' },
};

export function computeSourceStatus(input: { tested: number; ok: number }): SourceStatus {
  if (input.tested <= 0) return 'untested';
  if (input.ok <= 0) return 'unavailable';
  if (input.ok >= input.tested) return 'available';
  return 'partial';
}

/** 平台格子的三态：通过 / 失败 / 未测。 */
export type PlatformTone = 'ok' | 'bad' | 'idle';

export function platformTone(tested: boolean, ok: boolean): PlatformTone {
  if (!tested) return 'idle';
  return ok ? 'ok' : 'bad';
}

export interface SnapshotSummary {
  total: number;
  available: number;
  partial: number;
  unavailable: number;
  untested: number;
  platformsOk: number;
  platformsTested: number;
}

/** 汇总一批源的状态；runner 与 Worker 合并局部复测时必须用同一套口径。 */
export function summarizeSources(
  sources: readonly { status: SourceStatus; stats: { ok: number; tested: number } }[],
): SnapshotSummary {
  const summary: SnapshotSummary = {
    total: sources.length,
    available: 0,
    partial: 0,
    unavailable: 0,
    untested: 0,
    platformsOk: 0,
    platformsTested: 0,
  };
  for (const source of sources) {
    summary[source.status] += 1;
    summary.platformsOk += source.stats.ok;
    summary.platformsTested += source.stats.tested;
  }
  return summary;
}
