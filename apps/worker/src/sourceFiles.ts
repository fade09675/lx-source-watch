import type { Env } from './env';

export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
export const SCRIPT_KEY_PREFIX = 'script:';

export interface SourceFileRow {
  sourceId: string;
  sha256: string;
  filename: string;
  bytes: number;
  createdAt: string;
}

export interface ScriptMeta {
  name?: string;
  version?: string;
  author?: string;
  description?: string;
}

export interface UploadSourceBody {
  filename?: unknown;
  content?: unknown;
  title?: unknown;
  author?: unknown;
  category?: unknown;
  homepage?: unknown;
  notes?: unknown;
  testAfterSave?: unknown;
}

export interface PreparedUpload {
  filename: string;
  content: string;
  sha256: string;
  bytes: number;
  title: string;
  author: string;
  category: string;
  homepage: string;
  notes: string;
  testAfterSave: boolean;
  meta: ScriptMeta;
}

export type UploadValidation =
  | { ok: true; value: PreparedUpload }
  | { ok: false; message: string };

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function baseFilename(raw: string): string {
  return (raw.split(/[\\/]/).pop() ?? raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function sanitizeSourceFilename(raw: string): string {
  const base = baseFilename(raw || 'source.js').slice(0, 120);
  const cleaned = base.replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'source.js';
}

export function downloadFilename(title: string): string {
  const base = sanitizeSourceFilename(title || 'source')
    .replace(/\.js$/i, '')
    .slice(0, 80)
    .trim();
  return `${base || 'source'}.js`;
}

export function parseScriptMeta(code: string): ScriptMeta {
  const header = code.slice(0, 12_000);
  const meta: ScriptMeta = {};
  const re = /^[\s/*#-]*@([a-zA-Z][\w-]*)\s*[:=]?\s*(.+?)\s*(?:\*\/)?\s*$/gm;
  for (const match of header.matchAll(re)) {
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim().replace(/\s*\*\/\s*$/, '').trim();
    if (!key || !value) continue;
    if (key === 'name' && !meta.name) meta.name = value.slice(0, 120);
    if (key === 'version' && !meta.version) meta.version = value.slice(0, 40);
    if (key === 'author' && !meta.author) meta.author = value.slice(0, 80);
    if (key === 'description' && !meta.description) meta.description = value.slice(0, 300);
  }
  return meta;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validateUpload(body: UploadSourceBody): UploadValidation {
  const filename = sanitizeSourceFilename(cleanText(body.filename, 200));
  if (!/\.js$/i.test(filename)) {
    return { ok: false, message: '只支持 .js 脚本文件' };
  }
  const content = typeof body.content === 'string' ? body.content.replace(/^\uFEFF/, '') : '';
  if (!content.trim()) return { ok: false, message: '脚本内容为空' };
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > MAX_SOURCE_FILE_BYTES) {
    return { ok: false, message: `脚本超过 2MB（当前 ${(bytes / 1024 / 1024).toFixed(1)}MB）` };
  }
  if (content.includes('\u0000')) {
    return { ok: false, message: '脚本包含二进制内容，不是文本 JS' };
  }
  if (/^\s*<(!doctype|html|head|body)\b/i.test(content)) {
    return { ok: false, message: '上传的是 HTML 页面，不是 JS 脚本' };
  }
  if (content.trim().length < 50) {
    return { ok: false, message: '脚本内容过短，无法作为音源' };
  }
  const meta = parseScriptMeta(content);
  const title =
    cleanText(body.title, 80) ||
    meta.name ||
    filename.replace(/\.js$/i, '').replace(/[-_]+/g, ' ').trim() ||
    '上传音源';
  const author = cleanText(body.author, 80) || meta.author || '';
  const category = cleanText(body.category, 30) || '上传';
  return {
    ok: true,
    value: {
      filename,
      content,
      sha256: '',
      bytes,
      title: title.slice(0, 80),
      author: author.slice(0, 80),
      category,
      homepage: cleanText(body.homepage, 500),
      notes: cleanText(body.notes, 1000),
      testAfterSave: body.testAfterSave === true,
      meta,
    },
  };
}

export async function storeScript(env: Env, sha256: string, content: string): Promise<void> {
  const existing = await env.DB.prepare('SELECT 1 AS n FROM source_files WHERE sha256 = ? LIMIT 1')
    .bind(sha256)
    .first<{ n: number }>();
  if (existing) return;
  await env.SNAPSHOT.put(`${SCRIPT_KEY_PREFIX}${sha256}`, content, {
    metadata: { bytes: new TextEncoder().encode(content).byteLength },
  });
}

export async function readScript(env: Env, sha256: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) return null;
  return env.SNAPSHOT.get(`${SCRIPT_KEY_PREFIX}${sha256.toLowerCase()}`);
}

export async function recordSourceFile(
  env: Env,
  sourceId: string,
  sha256: string,
  filename: string,
  bytes: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO source_files (source_id, sha256, filename, bytes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       sha256 = excluded.sha256,
       filename = excluded.filename,
       bytes = excluded.bytes,
       created_at = excluded.created_at`,
  )
    .bind(sourceId, sha256, filename, bytes, new Date().toISOString())
    .run();
}

export async function getSourceFile(env: Env, sourceId: string): Promise<SourceFileRow | null> {
  const row = await env.DB.prepare(
    'SELECT source_id, sha256, filename, bytes, created_at FROM source_files WHERE source_id = ? LIMIT 1',
  )
    .bind(sourceId)
    .first<{ source_id: string; sha256: string; filename: string; bytes: number; created_at: string }>();
  if (!row) return null;
  return {
    sourceId: row.source_id,
    sha256: row.sha256,
    filename: row.filename,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

export async function deleteSourceFile(env: Env, sourceId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM source_files WHERE source_id = ?').bind(sourceId).run();
}

export function scriptUrl(origin: string, sha256: string): string {
  return new URL(`/scripts/${sha256}.js`, origin).toString();
}
