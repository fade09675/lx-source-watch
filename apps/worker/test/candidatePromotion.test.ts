import { describe, expect, it } from 'vitest';
import { shouldSkipAutoPromotion } from '../src/candidatePromotion';
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
