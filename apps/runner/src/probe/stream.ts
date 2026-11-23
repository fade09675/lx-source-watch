import { safeUrlHost } from '@lx/shared';
import { httpRequest, type ProxyConfig } from '../net/http.js';
import { errorMessage } from '../util.js';
import { ProbeError, classifyStreamError } from './errors.js';

export interface VerifyOptions {
  timeoutMs?: number;
  maxBytes?: number;
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
  userAgent?: string;
}

export interface VerifyResult {
  ok: boolean;
  status: number;
  contentType?: string;
  magic?: string;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  urlHost: string;
  error?: ProbeError;
}

const AUDIO_MAGIC: { name: string; test: (b: Buffer) => boolean }[] = [
  { name: 'mp3-id3', test: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' },
  { name: 'flac', test: (b) => b.subarray(0, 4).toString('latin1') === 'fLaC' },
  { name: 'ogg', test: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
  {
    name: 'wav',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE',
  },
  { name: 'mp4', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { name: 'aac-adts', test: (b) => b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0 },
  { name: 'mp3-frame', test: (b) => b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 },
  { name: 'amr', test: (b) => b.subarray(0, 5).toString('latin1') === '#!AMR' },
  { name: 'wv', test: (b) => b.subarray(0, 4).toString('latin1') === 'wvpk' },
  { name: 'ape', test: (b) => b.subarray(0, 4).toString('latin1') === 'MAC ' },
  { name: 'hls', test: (b) => b.subarray(0, 7).toString('latin1') === '#EXTM3U' },
];

const BAD_CONTENT_TYPES = ['text/', 'image/', 'application/json', 'application/xml', 'application/xhtml'];
const BAD_PREFIXES = ['<!doctype', '<html', '<?xml', '{', '['];

function detectMagic(body: Buffer): string | undefined {
  return AUDIO_MAGIC.find((m) => m.test(body))?.name;
}

function looksLikeErrorPage(body: Buffer, contentType: string): boolean {
  if (BAD_CONTENT_TYPES.some((t) => contentType.includes(t))) return true;
  const head = body.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  return BAD_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * Range 取前 2KB，验证拿到的确实是音频（或 HLS 清单），而不是 JSON/HTML 错误页。
 * 只下载极少量数据，避免浪费流量。
 */
export async function verifyAudioUrl(url: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const started = Date.now();
  const host = safeUrlHost(url) ?? '';
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 2048;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      status: 0,
      ttfbMs: 0,
      totalMs: Date.now() - started,
      bytes: 0,
      urlHost: host,
      error: new ProbeError('resolve_empty', '脚本返回的地址不是合法 URL'),
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      status: 0,
      ttfbMs: 0,
      totalMs: Date.now() - started,
      bytes: 0,
      urlHost: host,
      error: new ProbeError('resolve_empty', `不支持的播放地址协议：${parsed.protocol}`),
    };
  }

  const headers: Record<string, string> = {
    range: 'bytes=0-2047',
    accept: '*/*',
  };
  if (opts.userAgent) headers['user-agent'] = opts.userAgent;

  let res;
  try {
    res = await httpRequest(url, {
      method: 'GET',
      headers,
      timeoutMs,
      maxBytes,
      maxRedirects: 5,
      proxy: opts.proxy,
      allowPrivate: opts.allowPrivate,
    });
  } catch (e) {
    const err = classifyStreamError(e);
    return {
      ok: false,
      status: 0,
      ttfbMs: 0,
      totalMs: Date.now() - started,
      bytes: 0,
      urlHost: host,
      error: err,
    };
  }

  // 某些 CDN 不支持 Range，回退普通 GET（仍只读 2KB）。
  if ([400, 405, 416, 501].includes(res.status)) {
    try {
      res = await httpRequest(url, {
        method: 'GET',
        headers: { accept: '*/*' },
        timeoutMs,
        maxBytes,
        proxy: opts.proxy,
        allowPrivate: opts.allowPrivate,
      });
    } catch (e) {
      const err = classifyStreamError(e);
      return {
        ok: false,
        status: 0,
        ttfbMs: 0,
        totalMs: Date.now() - started,
        bytes: 0,
        urlHost: host,
        error: err,
      };
    }
  }

  const contentType = (res.headers['content-type'] ?? '').toLowerCase();
  const magic = detectMagic(res.body);
  const base = {
    status: res.status,
    contentType,
    ttfbMs: Math.round(res.firstByteMs),
    totalMs: Date.now() - started,
    bytes: res.body.length,
    urlHost: host,
  };

  if (res.status !== 200 && res.status !== 206) {
    return {
      ...base,
      ok: false,
      magic,
      error: new ProbeError('stream_http', `拉流失败：HTTP ${res.status}`, res.status),
    };
  }
  if (res.body.length === 0) {
    return {
      ...base,
      ok: false,
      magic,
      error: new ProbeError('stream_non_audio', '拉流返回空响应'),
    };
  }
  if (looksLikeErrorPage(res.body, contentType)) {
    return {
      ...base,
      ok: false,
      magic,
      error: new ProbeError(
        'stream_non_audio',
        `拉流返回非音频内容（${contentType || 'unknown'}）`,
      ),
    };
  }
  const audioType =
    contentType.startsWith('audio/') ||
    contentType.includes('application/ogg') ||
    contentType.includes('video/mp4') ||
    contentType.includes('application/octet-stream');
  if (!magic && !audioType) {
    return {
      ...base,
      ok: false,
      magic,
      error: new ProbeError(
        'stream_non_audio',
        `无法识别的音频格式（${contentType || '无 content-type'}）`,
      ),
    };
  }

  return { ...base, ok: true, magic };
}

export function describeVerifyError(e: unknown): string {
  return errorMessage(e);
}
