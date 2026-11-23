import { describe, expect, it } from 'vitest';
import { computeSourceStatus, platformTone } from '../src/status.js';
import { ERROR_KINDS, errorGroup } from '../src/errors.js';
import { safeUrlHost } from '../src/format.js';

describe('computeSourceStatus', () => {
  it('没有测过任何平台时是 untested', () => {
    expect(computeSourceStatus({ tested: 0, ok: 0 })).toBe('untested');
  });

  it('全部平台失败时是 unavailable', () => {
    expect(computeSourceStatus({ tested: 5, ok: 0 })).toBe('unavailable');
  });

  it('全部平台通过时是 available', () => {
    expect(computeSourceStatus({ tested: 5, ok: 5 })).toBe('available');
  });

  it('部分通过时是 partial', () => {
    expect(computeSourceStatus({ tested: 5, ok: 3 })).toBe('partial');
  });
});

describe('platformTone', () => {
  it('未测、失败、通过各有独立色调', () => {
    expect(platformTone(false, false)).toBe('idle');
    expect(platformTone(true, false)).toBe('bad');
    expect(platformTone(true, true)).toBe('ok');
  });
});

describe('errorGroup', () => {
  it('把 12 类错误归入 5 组', () => {
    expect(errorGroup('init')).toBe('init');
    expect(errorGroup('script')).toBe('resolve');
    expect(errorGroup('resolve_http')).toBe('resolve');
    expect(errorGroup('resolve_timeout')).toBe('resolve');
    expect(errorGroup('stream_http')).toBe('stream');
    expect(errorGroup('stream_non_audio')).toBe('stream');
    expect(errorGroup('unsupported')).toBe('unsupported');
    expect(errorGroup('untested')).toBe('untested');
  });

  it('所有错误类型都有分组', () => {
    for (const kind of ERROR_KINDS) {
      expect(errorGroup(kind)).toBeTruthy();
    }
  });
});

describe('safeUrlHost', () => {
  it('只保留 host 和截断的路径，不带 query', () => {
    const host = safeUrlHost('https://cdn.example.com/a/very/long/path/that/should/be/truncated/xyz.mp3?token=secret');
    expect(host).toContain('cdn.example.com');
    expect(host).not.toContain('token=secret');
    expect(host.length).toBeLessThanOrEqual(80);
  });

  it('无效 URL 返回 undefined', () => {
    expect(safeUrlHost('not a url')).toBeUndefined();
  });
});
