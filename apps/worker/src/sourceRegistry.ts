import {
  DEFAULT_MIRROR_TEMPLATES,
  parseGitHubRawUrl,
  renderMirror,
  type MirrorTemplate,
} from '@lx/shared';

export interface SourceRegistryRow {
  id: string;
  title: string;
  category: string;
  storage: 'remote' | 'repo';
  url: string;
  path: string;
  homepage: string;
  mirrors: string[];
  /** 主地址内容的完整 sha256；用于跨 URL 判重，旧数据可能为空。 */
  contentSha256: string | null;
  enabled: boolean;
  trusted: boolean;
  notes: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceInput {
  id?: string;
  title?: string;
  category?: string;
  url?: string;
  homepage?: string;
  mirrors?: string[];
  contentSha256?: string | null;
  enabled?: boolean;
  trusted?: boolean;
  notes?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: SourceRegistryRow;
}

interface RawRow {
  id: string;
  title: string;
  category: string;
  storage: string;
  url: string;
  path: string;
  homepage: string;
  mirrors: string;
  content_sha256: string | null;
  enabled: number;
  trusted: number;
  notes: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,40}$/;

function parseMirrors(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function fromRow(row: RawRow): SourceRegistryRow {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    storage: row.storage === 'repo' ? 'repo' : 'remote',
    url: row.url,
    path: row.path,
    homepage: row.homepage,
    mirrors: parseMirrors(row.mirrors),
    contentSha256: row.content_sha256 ?? null,
    enabled: row.enabled === 1,
    trusted: row.trusted === 1,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function validateSourceInput(input: SourceInput, base?: SourceRegistryRow): ValidationResult {
  const errors: string[] = [];
  const title = cleanText(input.title ?? base?.title, 80);
  if (!title) errors.push('标题不能为空');

  const url = cleanText(input.url ?? base?.url, 500);
  if (!url) errors.push('脚本地址不能为空');
  else if (!isHttp(url)) errors.push('脚本地址必须是 http(s) 链接');

  const homepage = cleanText(input.homepage ?? base?.homepage, 500);
  if (homepage && !isHttp(homepage)) errors.push('主页必须是 http(s) 链接');

  const category = cleanText(input.category ?? base?.category ?? '在线', 20) || '在线';
  const notes = cleanText(input.notes ?? base?.notes, 300);

  const mirrorsRaw = input.mirrors ?? base?.mirrors ?? [];
  const mirrors: string[] = [];
  if (!Array.isArray(mirrorsRaw)) {
    errors.push('镜像必须是数组');
  } else {
    for (const item of mirrorsRaw) {
      const mirror = cleanText(item, 500);
      if (!mirror) continue;
      if (!isHttp(mirror)) {
        errors.push(`镜像不是合法链接：${mirror}`);
        continue;
      }
      if (!mirrors.includes(mirror)) mirrors.push(mirror);
    }
    if (mirrors.length > 10) errors.push('镜像最多 10 个');
  }

  const requestedId = input.id ?? base?.id;
  let id = base?.id ?? '';
  if (!base) {
    if (requestedId) {
      if (!ID_PATTERN.test(requestedId)) errors.push('ID 只能是小写字母、数字、- 和 _，长度 2–41');
      id = requestedId;
    } else {
      id = slugify(title) || `src-${crypto.randomUUID().slice(0, 8)}`;
      if (!ID_PATTERN.test(id)) id = `src-${crypto.randomUUID().slice(0, 8)}`;
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    value: {
      id,
      title,
      category,
      storage: 'remote',
      url,
      path: '',
      homepage,
      mirrors,
      contentSha256: input.contentSha256 ?? base?.contentSha256 ?? null,
      enabled: input.enabled ?? base?.enabled ?? true,
      trusted: input.trusted ?? base?.trusted ?? false,
      notes,
      sortOrder: base?.sortOrder ?? 0,
      createdAt: base?.createdAt ?? '',
      updatedAt: base?.updatedAt ?? '',
    },
  };
}

const COLUMNS = `id, title, category, storage, url, path, homepage, mirrors, content_sha256, enabled, trusted, notes, sort_order, created_at, updated_at`;

export async function listSourceRegistry(db: D1Database): Promise<SourceRegistryRow[]> {
  const result = await db.prepare(`SELECT ${COLUMNS} FROM source_registry ORDER BY sort_order ASC, title ASC`).all<RawRow>();
  return (result.results ?? []).map(fromRow);
}

export async function getSourceRegistry(db: D1Database, id: string): Promise<SourceRegistryRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM source_registry WHERE id = ?`).bind(id).first<RawRow>();
  return row ? fromRow(row) : null;
}

/** 按脚本地址查找，自动收录时用来避免重复。 */
export async function findSourceRegistryByUrl(db: D1Database, url: string): Promise<SourceRegistryRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM source_registry WHERE url = ? LIMIT 1`).bind(url).first<RawRow>();
  return row ? fromRow(row) : null;
}

async function idExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS one FROM source_registry WHERE id = ?').bind(id).first<{ one: number }>();
  return Boolean(row);
}

export async function createSourceRegistry(
  db: D1Database,
  input: SourceInput,
  now = new Date().toISOString(),
): Promise<{ ok: true; row: SourceRegistryRow } | { ok: false; errors: string[] }> {
  const validated = validateSourceInput(input);
  if (!validated.ok || !validated.value) return { ok: false, errors: validated.errors };

  const source = validated.value;
  let id = source.id;
  if (await idExists(db, id)) {
    if (input.id) return { ok: false, errors: [`ID 已存在：${id}`] };
    let suffix = 2;
    while (await idExists(db, `${source.id}-${suffix}`)) suffix += 1;
    id = `${source.id}-${suffix}`;
  }

  const maxOrder = await db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM source_registry')
    .first<{ max_order: number }>();

  await db
    .prepare(
      `INSERT INTO source_registry (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      source.title,
      source.category,
      source.storage,
      source.url,
      source.path,
      source.homepage,
      JSON.stringify(source.mirrors),
      source.contentSha256 ?? null,
      source.enabled ? 1 : 0,
      source.trusted ? 1 : 0,
      source.notes,
      (maxOrder?.max_order ?? -1) + 1,
      now,
      now,
    )
    .run();

  const row = await getSourceRegistry(db, id);
  if (!row) return { ok: false, errors: ['写入后读取失败'] };
  return { ok: true, row };
}

export async function updateSourceRegistry(
  db: D1Database,
  id: string,
  input: SourceInput,
  now = new Date().toISOString(),
): Promise<{ ok: true; row: SourceRegistryRow } | { ok: false; errors: string[]; status?: number }> {
  const existing = await getSourceRegistry(db, id);
  if (!existing) return { ok: false, errors: ['音源不存在'], status: 404 };

  const validated = validateSourceInput(input, existing);
  if (!validated.ok || !validated.value) return { ok: false, errors: validated.errors };

  const value = validated.value;
  await db
    .prepare(
      `UPDATE source_registry
         SET title = ?, category = ?, storage = ?, url = ?, path = ?, homepage = ?, mirrors = ?,
             content_sha256 = COALESCE(?, content_sha256),
             enabled = ?, trusted = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      value.title,
      value.category,
      value.storage,
      value.url,
      value.path,
      value.homepage,
      JSON.stringify(value.mirrors),
      value.contentSha256 ?? null,
      value.enabled ? 1 : 0,
      value.trusted ? 1 : 0,
      value.notes,
      now,
      id,
    )
    .run();

  const row = await getSourceRegistry(db, id);
  if (!row) return { ok: false, errors: ['写入后读取失败'] };
  return { ok: true, row };
}

export async function deleteSourceRegistry(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM source_registry WHERE id = ?').bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface RegistryLink {
  url: string;
  label: string;
  primary: boolean;
}

/** 导入链接：主地址 + 自定义镜像 + 当前模板生成的加速地址。 */
export function buildRegistryLinks(
  url: string,
  mirrors: string[],
  templates: MirrorTemplate[] = DEFAULT_MIRROR_TEMPLATES,
): RegistryLink[] {
  const links: RegistryLink[] = [{ url, label: '主地址', primary: true }];
  const seen = new Set([url]);
  for (const mirror of mirrors) {
    if (!mirror || seen.has(mirror)) continue;
    seen.add(mirror);
    links.push({ url: mirror, label: '自定义镜像', primary: false });
  }
  const parts = parseGitHubRawUrl(url);
  if (parts) {
    for (const template of templates) {
      if (!template.enabled) continue;
      const rendered = renderMirror(template.template, { ...parts, url });
      if (!rendered || seen.has(rendered)) continue;
      seen.add(rendered);
      links.push({ url: rendered, label: template.name, primary: false });
    }
  }
  return links;
}

/** 公开给 Runner 的清单：只输出启用的音源。 */
export function toPublicRegistry(rows: SourceRegistryRow[]): {
  version: 1;
  sources: Record<string, unknown>[];
} {
  return {
    version: 1,
    sources: rows
      .filter((row) => row.enabled)
      .map((row) => ({
        id: row.id,
        title: row.title,
        storage: row.storage,
        ...(row.storage === 'repo' ? { path: row.path } : { url: row.url }),
        ...(row.homepage ? { homepage: row.homepage } : {}),
        category: row.category,
        trusted: row.trusted,
        ...(row.mirrors.length ? { mirrors: row.mirrors } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
      })),
  };
}
