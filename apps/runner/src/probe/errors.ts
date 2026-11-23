import type { ErrorKind } from '@lx/shared';
import { errorMessage } from '../util.js';

export class ProbeError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;

  constructor(kind: ErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProbeError';
    this.kind = kind;
    this.status = status;
  }
}

const NETWORK_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR',
  'CERT_',
  'UNABLE_TO_VERIFY',
  'EPRIVATEHOST',
  'ERR_TLS',
];

function codeOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) return String((e as { code: unknown }).code);
  return '';
}

function statusOf(message: string): number | undefined {
  const m =
    message.match(/(?:HTTP|http|状态码|status(?:\s*code)?|code)[^\d]{0,8}(\d{3})/) ??
    message.match(/\b(4\d{2}|5\d{2})\b/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return n >= 100 && n <= 599 ? n : undefined;
}

export function isTimeout(e: unknown): boolean {
  if (codeOf(e) === 'ETIMEDOUT') return true;
  return /timeout|timed out|超时/i.test(errorMessage(e));
}

/** 把“取链阶段”的任意异常翻译成可展示的错误分类。 */
export function classifyResolveError(e: unknown): ProbeError {
  if (e instanceof ProbeError) return e;
  const message = errorMessage(e);
  if (/未返回播放地址|空地址/i.test(message)) {
    return new ProbeError('resolve_empty', message);
  }
  const status = statusOf(message);
  const code = codeOf(e).toUpperCase();
  if (isTimeout(e)) return new ProbeError('resolve_timeout', `取链超时：${message}`);
  if (NETWORK_CODES.some((c) => code.includes(c) || message.includes(c))) {
    return new ProbeError('resolve_network', `取链网络失败：${message}`);
  }
  if (status) return new ProbeError('resolve_http', `取链失败：HTTP ${status}`, status);
  return new ProbeError('script', message);
}

/** 拉流校验阶段的异常（verifyAudioUrl 通常直接返回结果，这里兜底）。 */
export function classifyStreamError(e: unknown): ProbeError {
  if (e instanceof ProbeError) return e;
  const message = errorMessage(e);
  if (isTimeout(e)) return new ProbeError('stream_timeout', `拉流超时：${message}`);
  if (/非音频|不是音频|non-audio/i.test(message)) {
    return new ProbeError('stream_non_audio', message);
  }
  const status = statusOf(message);
  if (status) return new ProbeError('stream_http', `拉流失败：HTTP ${status}`, status);
  return new ProbeError('stream_network', `拉流网络失败：${message}`);
}
