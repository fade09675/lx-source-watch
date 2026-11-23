import { describe, expect, it } from 'vitest';
import { parseScriptMeta } from '../src/lx/meta.js';
import { qualityChain } from '../src/probe/quality.js';
import { classifyResolveError, classifyStreamError } from '../src/probe/errors.js';

describe('parseScriptMeta', () => {
  const code = `/**
 * @name 测试音源
 * @version 1.2.3
 * @author someone
 * @description 一个用于测试的音源
 * @homepage https://example.com/src
 * @expire 2027-01-01
 * @support kg, tx  wy
 */
const x = 1;
`;

  it('解析头部注释字段', () => {
    const meta = parseScriptMeta(code, 'fallback.js');
    expect(meta.name).toBe('测试音源');
    expect(meta.version).toBe('1.2.3');
    expect(meta.author).toBe('someone');
    expect(meta.homepage).toBe('https://example.com/src');
    expect(meta.expire).toBe('2027-01-01');
  });

  it('support 按逗号/空格拆成小写 key', () => {
    expect(parseScriptMeta(code).support).toEqual(['kg', 'tx', 'wy']);
  });

  it('没有 @name 时退回文件名', () => {
    expect(parseScriptMeta('const a = 1;', 'my-source.js').name).toBe('my-source');
  });
});

describe('qualityChain', () => {
  it('默认只测 128k', () => {
    expect(qualityChain(['128k', '320k', 'flac'], undefined, false)).toEqual(['128k']);
  });

  it('声明里没有 128k 时用第一个声明音质并回退 128k', () => {
    expect(qualityChain(['320k', 'flac'], undefined, false)).toEqual(['320k', '128k']);
  });

  it('--deep 从最高音质开始并回退 128k', () => {
    expect(qualityChain(['128k', '320k', 'flac'], undefined, true)).toEqual(['flac', '128k']);
  });

  it('显式指定音质时优先该音质，再回退 128k', () => {
    expect(qualityChain(['128k', '320k'], '320k', false)).toEqual(['320k', '128k']);
  });

  it('完全没声明时仍然测 128k', () => {
    expect(qualityChain([], undefined, false)).toEqual(['128k']);
  });
});

describe('classifyResolveError', () => {
  it('识别 HTTP 状态码', () => {
    const err = classifyResolveError(new Error('请求失败：HTTP 403'));
    expect(err.kind).toBe('resolve_http');
    expect(err.status).toBe(403);
  });

  it('识别网络错误码', () => {
    const err = classifyResolveError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(err.kind).toBe('resolve_network');
  });

  it('超时归为 resolve_timeout', () => {
    const err = classifyResolveError(new Error('请求超时（20000ms）'));
    expect(err.kind).toBe('resolve_timeout');
  });

  it('脚本没有返回地址时归为 resolve_empty', () => {
    const err = classifyResolveError(new Error('脚本未返回播放地址'));
    expect(err.kind).toBe('resolve_empty');
  });

  it('脚本内部异常归为 script', () => {
    const err = classifyResolveError(new Error('Cannot read properties of undefined'));
    expect(err.kind).toBe('script');
  });
});

describe('classifyStreamError', () => {
  it('拉流 4xx 归为 stream_http', () => {
    const err = classifyStreamError(new Error('拉流失败：HTTP 403'));
    expect(err.kind).toBe('stream_http');
    expect(err.status).toBe(403);
  });

  it('非音频内容单独归类', () => {
    const err = classifyStreamError(new Error('拉流返回非音频内容（application/json）'));
    expect(err.kind).toBe('stream_non_audio');
  });

  it('网络错误归为 stream_network', () => {
    const err = classifyStreamError(new Error('connect ECONNRESET'));
    expect(err.kind).toBe('stream_network');
  });
});
