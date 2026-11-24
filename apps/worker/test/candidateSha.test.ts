import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureCandidateSha, fetchCandidateSha256 } from '../src/candidateSha';

function fakeDb(): { db: D1Database; updates: unknown[][] } {
  const updates: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          updates.push(values);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, updates };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCandidateSha256', () => {
  it('computes the full sha256 of a GitHub raw script', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('abc', { status: 200, headers: { 'content-length': '3' } })),
    );
    const sha = await fetchCandidateSha256(
      'https://raw.githubusercontent.com/pdone/lx-music-source/main/a/latest.js',
    );
    expect(sha).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('refuses non-GitHub URLs without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchCandidateSha256('http://127.0.0.1/secret.js')).toBeNull();
    expect(await fetchCandidateSha256('https://example.com/a.js')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    expect(
      await fetchCandidateSha256('https://raw.githubusercontent.com/a/b/main/c.js'),
    ).toBeNull();
  });
});

describe('ensureCandidateSha', () => {
  it('keeps an existing fingerprint', async () => {
    const { db, updates } = fakeDb();
    const sha = await ensureCandidateSha(db, {
      id: 'c1',
      url: 'https://raw.githubusercontent.com/a/b/main/c.js',
      sha256: 'f'.repeat(64),
    });
    expect(sha).toBe('f'.repeat(64));
    expect(updates).toHaveLength(0);
  });

  it('writes a newly computed fingerprint back to D1', async () => {
    const { db, updates } = fakeDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('abc', { status: 200 })),
    );
    const sha = await ensureCandidateSha(db, {
      id: 'c2',
      url: 'https://raw.githubusercontent.com/a/b/main/c.js',
      sha256: undefined,
    });
    expect(sha).toHaveLength(64);
    expect(updates).toEqual([[sha, 'c2']]);
  });

  it('does not throw when the download fails', async () => {
    const { db } = fakeDb();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const sha = await ensureCandidateSha(db, {
      id: 'c3',
      url: 'https://raw.githubusercontent.com/a/b/main/c.js',
      sha256: undefined,
    });
    expect(sha).toBeNull();
  });
});
