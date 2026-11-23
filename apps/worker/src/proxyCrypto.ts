import type { Env } from './env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function loadKey(env: Env): Promise<CryptoKey> {
  const raw = env.PROXY_ENC_KEY?.trim();
  if (raw) {
    try {
      const bytes = /^[0-9a-f]{64}$/i.test(raw)
        ? new Uint8Array(raw.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)))
        : base64ToBytes(raw);
      if (bytes.length === 32) return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch {
      // 回退到派生密钥。
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${env.SESSION_SECRET ?? ''}|lx-proxy`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const key = await loadKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64(combined);
}

export async function decryptSecret(env: Env, blob: string): Promise<string> {
  if (!blob) return '';
  try {
    const key = await loadKey(env);
    const bytes = base64ToBytes(blob);
    if (bytes.length <= 12) return '';
    const iv = bytes.slice(0, 12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(12));
    return decoder.decode(plaintext);
  } catch {
    return '';
  }
}
