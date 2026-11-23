/**
 * 登录与会话。
 *
 * 密码只存 PBKDF2 哈希，格式：pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>。
 * 会话 Cookie 是「payload.signature」，payload 里只有过期时间，签名用 HMAC-SHA256。
 * 这样 Worker 不需要存储会话，也不会把密码写进任何地方。
 */

const encoder = new TextEncoder();

export const SESSION_COOKIE = 'lx_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_SECONDS = 600;
export const MIN_PASSWORD_LENGTH = 8;

export interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;
  const [scheme, digest, iterationsRaw, saltRaw, hashRaw] = parts;
  if (scheme !== 'pbkdf2' || digest !== 'sha256') return null;
  const iterations = Number.parseInt(iterationsRaw ?? '', 10);
  if (!Number.isFinite(iterations) || iterations < 10_000 || iterations > 100_000) return null;
  try {
    return { iterations, salt: base64ToBytes(saltRaw ?? ''), hash: base64ToBytes(hashRaw ?? '') };
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, length * 8);
  return new Uint8Array(bits);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const derived = await derive(password, parsed.salt, parsed.iterations, parsed.hash.length);
  return timingSafeEqual(derived, parsed.hash);
}

/** Cloudflare Workers 的 WebCrypto 只支持 PBKDF2 最多 100000 轮，默认值必须不超过它。 */
export const PBKDF2_MAX_ITERATIONS = 100_000;

export async function hashPassword(password: string, iterations = PBKDF2_MAX_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations, 32);
  return `pbkdf2$sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSessionToken(secret: string, ttlSeconds = SESSION_TTL_SECONDS): Promise<string> {
  const payload: SessionPayload = { v: 1, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export interface SessionPayload {
  v: 1;
  exp: number;
}

export async function verifySessionToken(secret: string, token: string | null | undefined, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret || !token) return false;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;
  let expected: Uint8Array;
  try {
    expected = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  const actual = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(encoded));
  if (!timingSafeEqual(new Uint8Array(actual), expected)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as SessionPayload;
    return payload.v === 1 && typeof payload.exp === 'number' && payload.exp > now;
  } catch {
    return false;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

export function buildSessionCookie(token: string, secure: boolean, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function buildClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

function loginKey(ip: string): string {
  return `login:fail:${ip}`;
}

export async function loginAllowed(kv: KVNamespace, ip: string): Promise<boolean> {
  const raw = await kv.get(loginKey(ip));
  const count = raw ? Number.parseInt(raw, 10) : 0;
  return !(Number.isFinite(count) && count >= LOGIN_MAX_FAILURES);
}

export async function noteLoginFailure(kv: KVNamespace, ip: string): Promise<void> {
  const raw = await kv.get(loginKey(ip));
  const count = (raw ? Number.parseInt(raw, 10) : 0) + 1;
  await kv.put(loginKey(ip), String(count), { expirationTtl: LOGIN_LOCK_SECONDS });
}

export async function clearLoginFailures(kv: KVNamespace, ip: string): Promise<void> {
  await kv.delete(loginKey(ip));
}
