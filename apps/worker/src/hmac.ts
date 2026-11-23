const encoder = new TextEncoder();

export type VerifyReason =
  | 'no-secret'
  | 'missing-signature'
  | 'missing-timestamp'
  | 'bad-timestamp'
  | 'expired'
  | 'bad-signature';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyReason;
}

export interface VerifyOptions {
  body: string;
  secret: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
  /** 允许的时钟偏差，默认 ±10 分钟。 */
  windowMs?: number;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signBody(body: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * 校验 GitHub Actions 上报：HMAC-SHA256(body) + 时间戳窗口。
 * 用 WebCrypto 的 verify，避免自己写比较函数带来的时序侧信道。
 */
export async function verifySignature(opts: VerifyOptions): Promise<VerifyResult> {
  if (!opts.secret) return { ok: false, reason: 'no-secret' };
  if (!opts.signature) return { ok: false, reason: 'missing-signature' };
  if (!opts.timestamp) return { ok: false, reason: 'missing-timestamp' };

  const timestamp = Date.parse(opts.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'bad-timestamp' };

  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 10 * 60_000;
  if (Math.abs(now - timestamp) > windowMs) return { ok: false, reason: 'expired' };

  const signature = hexToBytes(opts.signature);
  if (!signature) return { ok: false, reason: 'bad-signature' };

  try {
    const key = await hmacKey(opts.secret);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(opts.body));
    return valid ? { ok: true } : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}
