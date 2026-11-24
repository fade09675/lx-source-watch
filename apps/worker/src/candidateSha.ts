import type { D1Database } from '@cloudflare/workers-types';
import type { Candidate } from '@lx/shared';

/** 只允许从 GitHub raw 拉取候选脚本，避免被候选地址当成任意 SSRF 出口。 */
const ALLOWED_HOST = 'raw.githubusercontent.com';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 下载候选脚本并计算完整 sha256；非 GitHub raw 或超限时返回 null。 */
export async function fetchCandidateSha256(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_HOST) return null;

  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  const body = await response.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null;
  return toHex(await crypto.subtle.digest('SHA-256', body));
}

/**
 * 候选缺少 sha256 时自动补算并写回 D1。已有指纹、下载失败或地址不受支持时
 * 返回 null，调用方按“没有指纹”继续处理（不因此阻塞收录）。
 */
export async function ensureCandidateSha(
  db: D1Database,
  candidate: Pick<Candidate, 'id' | 'url' | 'sha256'>,
): Promise<string | null> {
  if (candidate.sha256) return candidate.sha256;
  let sha256: string | null = null;
  try {
    sha256 = await fetchCandidateSha256(candidate.url);
  } catch {
    sha256 = null;
  }
  if (!sha256) return null;
  await db.prepare('UPDATE candidates SET sha256 = ? WHERE id = ?').bind(sha256, candidate.id).run();
  return sha256;
}
