import { describe, expect, it } from 'vitest';
import { autoPromoteGate, shouldSkipAutoPromotion } from '../src/candidatePromotion';
import type { Candidate } from '@lx/shared';
import type { DedupDecision, DedupKind } from '../src/dedup';

function decision(kind: DedupKind): DedupDecision {
  return {
    kind,
    action: kind === 'similar' ? 'hint' : kind === 'unique' ? 'none' : 'alias',
    canonical: null,
    reason: kind,
    matches: { sha256: [], url: [], similar: [] },
  };
}

describe('auto promotion dedup guard', () => {
  it('skips same-title/same-author candidates when content differs', () => {
    expect(shouldSkipAutoPromotion(decision('similar'))).toBe(true);
  });

  it('does not skip strong identity or unique candidates', () => {
    expect(shouldSkipAutoPromotion(decision('same_sha256'))).toBe(false);
    expect(shouldSkipAutoPromotion(decision('same_url'))).toBe(false);
    expect(shouldSkipAutoPromotion(decision('unique'))).toBe(false);
  });
});

const gateSettings = {
  autoPromoteMinPlatforms: 2,
  autoPromoteRequireTestablePlatform: true,
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'candidate-1',
    repo: 'owner/repo',
    path: 'source.js',
    url: 'https://raw.githubusercontent.com/owner/repo/main/source.js',
    sha: 'abcdef1',
    platforms: ['kw', 'tx'],
    initOk: true,
    firstSeen: '2026-11-26T00:00:00.000Z',
    state: 'qualified',
    ...overrides,
  };
}

describe('autoPromoteGate', () => {
  it('平台数达标且有可测试 key 时允许收录', () => {
    expect(autoPromoteGate(candidate(), gateSettings)).toEqual({ ok: true });
  });

  it('初始化未通过直接拒绝', () => {
    const result = autoPromoteGate(candidate({ initOk: false }), gateSettings);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('初始化');
  });

  it('声明平台少于门槛时拒绝', () => {
    const result = autoPromoteGate(candidate({ platforms: ['kw'] }), gateSettings);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('少于门槛');
  });

  it('没有任何可测试平台时拒绝', () => {
    const result = autoPromoteGate(candidate({ platforms: ['foo', 'bar'] }), gateSettings);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('可测试');
  });

  it('关闭可测试平台要求后允许未知 key', () => {
    const result = autoPromoteGate(
      candidate({ platforms: ['foo', 'bar'] }),
      { ...gateSettings, autoPromoteRequireTestablePlatform: false },
    );
    expect(result.ok).toBe(true);
  });
});
