import type { Env } from './env.js';
import { getSourceRegistry, listSourceRegistry, updateSourceRegistry, type SourceRegistryRow } from './sourceRegistry.js';

export type BackupMatchKind = 'manual' | 'title-author' | 'title' | 'none' | 'ambiguous';
export type BackupItemStatus = 'matched' | 'ambiguous' | 'unmatched' | 'already' | 'invalid' | 'unreachable';

export interface BackupPreviewItem {
  url: string;
  title: string;
  author: string;
  sha256?: string;
  bytes?: number;
  status: BackupItemStatus;
  matchKind: BackupMatchKind;
  sourceId?: string;
  sourceTitle?: string;
  message?: string;
}

export interface BackupPreviewResult {
  items: BackupPreviewItem[];
  summary: {
    total: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
    already: number;
    invalid: number;
    unreachable: number;
  };
}

const MAX_URLS = 20;
const MAX_BYTES = 2_000_000;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isPrivateIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** 只允许公网 HTTPS；禁止 localhost、内网 IPv4/IPv6 与带账号密码的 URL。 */
export function assertPublicScriptUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '[::1]' ||
    host.startsWith('[') ||
    isPrivateIpv4(host)
  ) {
    return null;
  }
  url.hash = '';
  return url.toString();
}

function parseUrls(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url) continue;
    if (!result.includes(url)) result.push(url);
    if (result.length >= MAX_URLS) break;
  }
  return result;
}

interface ScriptMeta {
  title: string;
  author: string;
}

function parseScriptMeta(code: string): ScriptMeta {
  const header = code.slice(0, 8000);
  let title = '';
  let author = '';
  const re = /^[\s/*#-]*@([a-zA-Z][\w-]*)\s*[:=]?\s*(.+?)\s*(?:\*\/)?\s*$/gm;
  for (const match of header.matchAll(re)) {
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim().replace(/\s*\*\/\s*$/, '').trim();
    if (key === 'name' && value) title = value;
    if (key === 'author' && value) author = value;
  }
  return { title, author };
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\u3000\-_·|:：()（）[\]【】<>《》"'“”‘’]/g, '')
    .trim();
}

async function fetchScript(url: string): Promise<{ code: string; bytes: number; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const valid = assertPublicScriptUrl(current);
    if (!valid) throw new Error('地址不是公网 HTTPS 链接');
    const response = await fetch(valid, {
      redirect: 'manual',
      headers: { 'user-agent': 'lx-source-watch-backup/1.0', accept: 'text/javascript,application/javascript,*/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少目标地址');
      current = new URL(location, valid).toString();
      continue;
    }
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new Error('脚本超过 2MB');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error('脚本超过 2MB');
    return {
      code: new TextDecoder().decode(buffer),
      bytes: buffer.byteLength,
      finalUrl: current,
    };
  }
  throw new Error('重定向次数过多');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function findMatch(
  rows: SourceRegistryRow[],
  title: string,
  author: string,
  manualSourceId?: string,
): { status: BackupItemStatus; matchKind: BackupMatchKind; source?: SourceRegistryRow; message?: string } {
  if (manualSourceId) {
    const source = rows.find((row) => row.id === manualSourceId);
    if (!source) return { status: 'invalid', matchKind: 'none', message: '指定的音源不存在' };
    return { status: 'matched', matchKind: 'manual', source };
  }
  const normalizedTitle = normalizeName(title);
  const normalizedAuthor = normalizeName(author);
  if (!normalizedTitle) return { status: 'unmatched', matchKind: 'none', message: '脚本头部没有 @name' };

  const byTitle = rows.filter((row) => normalizeName(row.title) === normalizedTitle);
  if (!byTitle.length) {
    return { status: 'unmatched', matchKind: 'none', message: '没有同名音源，不能自动作为备用线路' };
  }
  const byBoth = byTitle.filter(
    (row) => normalizedAuthor && normalizeName(row.author) === normalizedAuthor,
  );
  if (byBoth.length === 1) return { status: 'matched', matchKind: 'title-author', source: byBoth[0] };
  if (byBoth.length > 1) return { status: 'ambiguous', matchKind: 'ambiguous', message: '同名同作者有多个音源' };
  if (byTitle.length === 1) {
    return { status: 'matched', matchKind: 'title', source: byTitle[0], message: '仅标题匹配，作者不同' };
  }
  return { status: 'ambiguous', matchKind: 'ambiguous', message: '同名音源有多个，作者无法区分' };
}

export async function previewBackupUrls(
  env: Env,
  input: { text?: string; urls?: string[]; sourceId?: string },
): Promise<BackupPreviewResult> {
  const urls = Array.isArray(input.urls)
    ? input.urls.map((item) => clean(item, 1000)).filter(Boolean).slice(0, MAX_URLS)
    : parseUrls(clean(input.text, 20_000));
  const manualSourceId = clean(input.sourceId, 80) || undefined;
  const rows = await listSourceRegistry(env.DB);
  const items: BackupPreviewItem[] = [];

  for (const raw of urls) {
    const url = assertPublicScriptUrl(raw);
    if (!url) {
      items.push({
        url: raw,
        title: '',
        author: '',
        status: 'invalid',
        matchKind: 'none',
        message: '必须是公网 HTTPS 地址',
      });
      continue;
    }
    const already = rows.find(
      (row) => row.url === url || row.mirrors.includes(url),
    );
    if (already && !manualSourceId) {
      items.push({
        url,
        title: already.title,
        author: already.author,
        status: 'already',
        matchKind: 'title-author',
        sourceId: already.id,
        sourceTitle: already.title,
        message: '该地址已存在',
      });
      continue;
    }
    try {
      const script = await fetchScript(url);
      const meta = parseScriptMeta(script.code);
      const match = findMatch(rows, meta.title, meta.author, manualSourceId);
      const source = match.source;
      items.push({
        url,
        title: meta.title,
        author: meta.author,
        sha256: await sha256Hex(script.code),
        bytes: script.bytes,
        status: source && source.mirrors.includes(url) ? 'already' : match.status,
        matchKind: match.matchKind,
        ...(source ? { sourceId: source.id, sourceTitle: source.title } : {}),
        ...(match.message ? { message: match.message } : {}),
      });
    } catch (error) {
      items.push({
        url,
        title: '',
        author: '',
        status: 'unreachable',
        matchKind: 'none',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const count = (status: BackupItemStatus): number => items.filter((item) => item.status === status).length;
  return {
    items,
    summary: {
      total: items.length,
      matched: count('matched'),
      ambiguous: count('ambiguous'),
      unmatched: count('unmatched'),
      already: count('already'),
      invalid: count('invalid'),
      unreachable: count('unreachable'),
    },
  };
}

export interface BackupImportItem {
  url: string;
  sourceId: string;
}

export interface BackupImportResult {
  imported: number;
  skipped: number;
  errors: { url: string; message: string }[];
  sources: { id: string; title: string; mirrors: string[] }[];
}

export async function importBackupUrls(
  env: Env,
  items: BackupImportItem[],
  now = new Date().toISOString(),
): Promise<BackupImportResult> {
  const grouped = new Map<string, string[]>();
  for (const item of items.slice(0, MAX_URLS)) {
    const url = assertPublicScriptUrl(clean(item.url, 1000));
    const sourceId = clean(item.sourceId, 80);
    if (!url || !sourceId) continue;
    const list = grouped.get(sourceId) ?? [];
    if (!list.includes(url)) list.push(url);
    grouped.set(sourceId, list);
  }

  let imported = 0;
  let skipped = 0;
  const errors: { url: string; message: string }[] = [];
  const updated: { id: string; title: string; mirrors: string[] }[] = [];

  for (const [sourceId, urls] of grouped) {
    const existing = await getSourceRegistry(env.DB, sourceId);
    if (!existing) {
      for (const url of urls) errors.push({ url, message: '音源不存在' });
      continue;
    }
    const mirrors = [...existing.mirrors];
    const added: string[] = [];
    for (const url of urls) {
      if (url === existing.url || mirrors.includes(url)) {
        skipped += 1;
        continue;
      }
      if (mirrors.length >= 10) {
        errors.push({ url, message: '该音源自定义镜像已达 10 个上限' });
        continue;
      }
      mirrors.push(url);
      added.push(url);
    }
    if (mirrors.length === existing.mirrors.length) {
      updated.push({ id: existing.id, title: existing.title, mirrors: existing.mirrors });
      continue;
    }
    const result = await updateSourceRegistry(env.DB, sourceId, { mirrors }, now);
    if (!result.ok) {
      for (const url of urls) errors.push({ url, message: result.errors.join('；') });
      continue;
    }
    imported += added.length;
    updated.push({ id: result.row.id, title: result.row.title, mirrors: result.row.mirrors });
  }

  return { imported, skipped, errors, sources: updated };
}
