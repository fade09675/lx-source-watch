import { describe, expect, it } from 'vitest';
import type { SourceStatus } from '@lx/shared';
import { diffEvents, unavailableStreak } from '../src/events';
import { makePlatform, makeSnapshot, makeSource } from './fixtures';

const AT = '2026-11-23T10:00:00.000Z';

function ctx(prev: ReturnType<typeof makeSnapshot> | null, incoming: ReturnType<typeof makeSnapshot>, recent: Record<string, SourceStatus[]> = {}) {
  return {
    runId: 'run-2',
    at: AT,
    prev,
    incoming,
    recent: new Map(Object.entries(recent)),
  };
}

function available(id: string) {
  return makeSource({ id, platforms: [makePlatform({ key: 'wy', ok: true })], status: 'available' });
}

function partial(id: string) {
  return makeSource({
    id,
    platforms: [makePlatform({ key: 'wy', ok: true }), makePlatform({ key: 'kg', ok: false })],
    status: 'partial',
  });
}

function unavailable(id: string) {
  return makeSource({ id, platforms: [makePlatform({ key: 'wy', ok: false })], status: 'unavailable' });
}

describe('unavailableStreak', () => {
  it('只统计连续的 unavailable', () => {
    expect(unavailableStreak(['unavailable', 'unavailable', 'partial'], 'unavailable')).toBe(3);
    expect(unavailableStreak(['partial'], 'unavailable')).toBe(1);
    expect(unavailableStreak(['unavailable'], 'available')).toBe(0);
  });
});

describe('diffEvents', () => {
  it('新来源产生 new', () => {
    const prev = makeSnapshot([]);
    const events = diffEvents(ctx(prev, makeSnapshot([available('a')], { runId: 'run-2' })));
    expect(events.map((event) => event.type)).toEqual(['new']);
  });

  it('可用降为部分产生 degraded', () => {
    const prev = makeSnapshot([available('a')]);
    const events = diffEvents(ctx(prev, makeSnapshot([partial('a')], { runId: 'run-2' })));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('degraded');
    expect(events[0]?.message).toContain('部分');
  });

  it('从失效恢复产生 recovered', () => {
    const prev = makeSnapshot([unavailable('a')]);
    const events = diffEvents(ctx(prev, makeSnapshot([available('a')], { runId: 'run-2' })));
    expect(events.map((event) => event.type)).toEqual(['recovered']);
  });

  it('连续 3 轮失效才产生 failed，且只在第 3 轮', () => {
    const prev = makeSnapshot([unavailable('a')]);
    const incoming = makeSnapshot([unavailable('a')], { runId: 'run-2' });

    const third = diffEvents(ctx(prev, incoming, { a: ['unavailable', 'unavailable'] }));
    expect(third.map((event) => event.type)).toContain('failed');

    const second = diffEvents(ctx(prev, incoming, { a: ['unavailable'] }));
    expect(second.map((event) => event.type)).not.toContain('failed');

    const fourth = diffEvents(ctx(prev, incoming, { a: ['unavailable', 'unavailable', 'unavailable'] }));
    expect(fourth.map((event) => event.type)).not.toContain('failed');
  });
});
