import {
  PERSISTENT_FAILURE_ROUNDS,
  STATUS_META,
  type EventItem,
  type Snapshot,
  type SourceStatus,
} from '@lx/shared';

export interface EventContext {
  runId: string;
  at: string;
  prev: Snapshot | null;
  incoming: Snapshot;
  /** 当前轮之前最近几轮的状态，newest first；用于判断“连续 N 轮失效”。 */
  recent: Map<string, SourceStatus[]>;
}

/** 当前轮已经失败；再数一数之前连续失败了几轮。 */
export function unavailableStreak(previousNewestFirst: readonly SourceStatus[], current: SourceStatus): number {
  if (current !== 'unavailable') return 0;
  let streak = 1;
  for (const status of previousNewestFirst) {
    if (status !== 'unavailable') break;
    streak += 1;
  }
  return streak;
}

function eventId(runId: string, sourceId: string, type: EventItem['type']): string {
  return `${runId}:${sourceId}:${type}`;
}

/**
 * 只在“跨越状态”时产生事件，避免每轮重复刷屏：
 * - new：上一轮不存在
 * - recovered：从非可用变为可用，或从 0 通过变为有通过
 * - degraded：可用变部分/失效，或部分变失效
 * - failed：连续 3 轮全平台失败（只在刚好达到 3 的那轮记一次）
 */
export function diffEvents(ctx: EventContext): EventItem[] {
  const { runId, at, prev, incoming, recent } = ctx;
  const prevById = new Map((prev?.sources ?? []).map((source) => [source.id, source]));
  const events: EventItem[] = [];

  for (const source of incoming.sources) {
    const before = prevById.get(source.id);
    const push = (type: EventItem['type'], message: string): void => {
      events.push({ id: eventId(runId, source.id, type), at, type, sourceId: source.id, title: source.title, message });
    };

    if (!before) {
      push('new', `新增来源，通过 ${source.stats.ok}/${source.stats.tested}`);
      continue;
    }

    const wasOk = before.stats.ok;
    const nowOk = source.stats.ok;
    const degraded =
      (before.status === 'available' && source.status !== 'available') ||
      (before.status === 'partial' && source.status === 'unavailable');
    const recovered = !degraded && (nowOk > wasOk && source.status === 'available' ? true : wasOk === 0 && nowOk > 0);

    if (degraded) {
      push(
        'degraded',
        `从「${STATUS_META[before.status].label}」降为「${STATUS_META[source.status].label}」，通过 ${nowOk}/${source.stats.tested}`,
      );
    } else if (recovered) {
      push('recovered', `恢复：通过 ${nowOk}/${source.stats.tested}`);
    }

    if (source.status === 'unavailable') {
      const streak = unavailableStreak(recent.get(source.id) ?? [], source.status);
      if (streak === PERSISTENT_FAILURE_ROUNDS) {
        push(
          'failed',
          `连续 ${PERSISTENT_FAILURE_ROUNDS} 轮全平台失败（${nowOk}/${source.stats.tested}），自动标记为持续失效`,
        );
      }
    }
  }

  return events;
}
