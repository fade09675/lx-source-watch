import type { TaskResult } from './tasks';

export interface CnPlatformInput {
  sourceId: string;
  platform: string;
  ok: boolean;
  error?: string;
  status?: number;
}

export interface CnEndpointInput {
  sourceId: string;
  url: string;
  ok: boolean;
  error?: string;
  status?: number;
}

export interface CnTaskResultInput {
  rows: CnPlatformInput[];
  endpoints: CnEndpointInput[];
  sourceIds: Set<string>;
  sourceTitles: Map<string, string>;
  selected: number;
  tested: number;
  ok: number;
}

type CnSourceStatus = 'available' | 'partial' | 'unavailable' | 'untested';

/**
 * 国内补测任务卡与音源探测共用同一套 7 项指标和失败明细结构。
 * 来源状态按“该源本轮 CN 平台结果”聚合：全通过可用、部分通过部分、全失败失效。
 */
export function buildCnTaskResult(input: CnTaskResultInput): TaskResult {
  const rowsBySource = new Map<string, CnPlatformInput[]>();
  for (const row of input.rows) {
    const list = rowsBySource.get(row.sourceId) ?? [];
    list.push(row);
    rowsBySource.set(row.sourceId, list);
  }

  const sourceStatus = (rows: CnPlatformInput[]): CnSourceStatus => {
    if (rows.length === 0) return 'untested';
    const ok = rows.filter((row) => row.ok).length;
    if (ok === rows.length) return 'available';
    if (ok === 0) return 'unavailable';
    return 'partial';
  };

  const sourceItem = (sourceId: string, status: CnSourceStatus) => {
    const rows = rowsBySource.get(sourceId) ?? [];
    const ok = rows.filter((row) => row.ok).length;
    const firstError = rows.find((row) => !row.ok)?.error;
    return {
      id: sourceId,
      title: input.sourceTitles.get(sourceId) ?? sourceId,
      status,
      ...(firstError ? { error: firstError.slice(0, 160) } : { error: `国内补测 ${ok}/${rows.length} 可达` }),
    };
  };

  const byStatus = (status: CnSourceStatus) =>
    [...input.sourceIds].filter((sourceId) => sourceStatus(rowsBySource.get(sourceId) ?? []) === status);

  const availableIds = byStatus('available');
  const partialIds = byStatus('partial');
  const unavailableIds = byStatus('unavailable');
  const failedSources = unavailableIds.slice(0, 8).map((id) => sourceItem(id, 'unavailable'));
  const partialSources = partialIds.slice(0, 8).map((id) => sourceItem(id, 'partial'));
  const okSources = availableIds.slice(0, 8).map((id) => sourceItem(id, 'available'));

  const platformName = (row: CnPlatformInput) =>
    `${input.sourceTitles.get(row.sourceId) ?? row.sourceId} · ${row.platform}`;
  const platformError = (row: CnPlatformInput) =>
    (row.error ?? `HTTP ${row.status ?? '-'}`).slice(0, 160);

  const failedPlatforms = input.rows
    .filter((row) => !row.ok)
    .slice(0, 20)
    .map((row) => ({
      sourceId: row.sourceId,
      name: platformName(row),
      error: platformError(row),
    }));
  const okPlatforms = input.rows
    .filter((row) => row.ok)
    .slice(0, 20)
    .map((row) => ({
      sourceId: row.sourceId,
      name: platformName(row),
    }));

  const platformsTested = input.rows.length;
  const platformsOk = input.rows.filter((row) => row.ok).length;
  const endpointsOk = input.endpoints.filter((row) => row.ok).length;
  const untested = [...input.sourceIds].filter(
    (sourceId) => (rowsBySource.get(sourceId) ?? []).length === 0,
  ).length;

  return {
    kind: 'cn-probe',
    summary: `国内补测：测试 ${input.tested} 条，可达 ${input.ok} 条（${input.sourceIds.size} 个源）`,
    counts: {
      selected: input.selected,
      tested: input.tested,
      ok: input.ok,
      failed: Math.max(0, input.tested - input.ok),
      sources: input.sourceIds.size,
      endpoints: input.endpoints.length,
      available: availableIds.length,
      partial: partialIds.length,
      unavailable: unavailableIds.length,
      untested,
      platformsOk,
      platformsTested,
      endpointsOk,
      endpointsTotal: input.endpoints.length,
      cnOk: input.ok,
      cnTested: input.tested,
    },
    failedSources,
    partialSources,
    okSources,
    failedPlatforms,
    okPlatforms,
  };
}
