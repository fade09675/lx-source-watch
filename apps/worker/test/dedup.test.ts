import { describe, expect, it } from 'vitest';
import {
  chooseCanonical,
  classifyDuplicate,
  comparableUrl,
  compareVersion,
  isOfficialUrl,
  type DedupEntry,
} from '../src/dedup';

function entry(patch: Partial<DedupEntry> = {}): DedupEntry {
  return {
    id: 'a',
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/a/latest.js',
    sha256: 'a'.repeat(64),
    title: 'A',
    author: 'x',
    version: '1.0.0',
    enabled: true,
    official: false,
    firstSeen: '2026-01-01T00:00:00.000Z',
    kind: 'registry',
    ...patch,
  };
}

describe('dedup', () => {
  it('prefers enabled, then official, then earliest, then higher version', () => {
    const disabled = entry({ id: 'disabled', enabled: false, official: true });
    const official = entry({ id: 'official', enabled: true, official: true, firstSeen: '2026-01-02T00:00:00.000Z' });
    const early = entry({ id: 'early', enabled: true, firstSeen: '2026-01-01T00:00:00.000Z' });
    const later = entry({ id: 'later', enabled: true, firstSeen: '2026-02-01T00:00:00.000Z', version: '2.0.0' });
    expect(chooseCanonical([disabled, official, early, later])?.id).toBe('official');
  });

  it('uses version when discovery time ties', () => {
    const a = entry({ id: 'a', version: '1.2.0', firstSeen: '2026-01-01T00:00:00.000Z' });
    const b = entry({ id: 'b', version: '1.10.0', firstSeen: '2026-01-01T00:00:00.000Z' });
    expect(chooseCanonical([a, b])?.id).toBe('b');
  });

  it('classifies same sha against registry as alias', () => {
    const canonical = entry({ id: 'canonical' });
    const decision = classifyDuplicate(
      { url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/b/latest.js', sha256: canonical.sha256 },
      { sha256: [canonical], url: [], similar: [] },
    );
    expect(decision.kind).toBe('same_sha256');
    expect(decision.action).toBe('alias');
    expect(decision.canonical?.id).toBe('canonical');
  });

  it('classifies same sha against another candidate as merge_candidates', () => {
    const canonical = entry({ id: 'c1', kind: 'candidate', enabled: true });
    const decision = classifyDuplicate(
      { url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/c2.js', sha256: canonical.sha256, kind: 'candidate' },
      { sha256: [canonical], url: [], similar: [] },
    );
    expect(decision.kind).toBe('same_sha256');
    expect(decision.action).toBe('merge_candidates');
  });

  it('falls back to URL identity', () => {
    const canonical = entry({ id: 'same-url' });
    const decision = classifyDuplicate(
      { url: canonical.url },
      { sha256: [], url: [canonical], similar: [] },
    );
    expect(decision.kind).toBe('same_url');
    expect(decision.action).toBe('alias');
  });

  it('only hints on same title/author with different content', () => {
    const other = entry({ id: 'other', sha256: 'b'.repeat(64) });
    const decision = classifyDuplicate(
      { url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/new.js', sha256: 'c'.repeat(64), title: 'A', author: 'x' },
      { sha256: [], url: [], similar: [other] },
    );
    expect(decision.kind).toBe('similar');
    expect(decision.action).toBe('hint');
  });

  it('recognizes official pdone URLs and normalizes URL', () => {
    expect(isOfficialUrl('https://raw.githubusercontent.com/pdone/lx-music-source/main/a.js')).toBe(true);
    expect(isOfficialUrl('https://raw.githubusercontent.com/someone/other/main/a.js')).toBe(false);
    expect(comparableUrl('https://EXAMPLE.com:443/a/b.js?t=1#x')).toBe('https://example.com/a/b.js');
  });

  it('compares versions numerically', () => {
    expect(compareVersion('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersion('v2.0.0', '2.0.1')).toBeLessThan(0);
  });
});
