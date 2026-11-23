import {
  DEFAULT_MIRROR_TEMPLATES,
  MIRROR_TEMPLATES_KEY,
  MirrorTemplateListSchema,
  templateError,
  type MirrorTemplate,
} from '@lx/shared';

export interface MirrorConfig {
  templates: MirrorTemplate[];
  custom: boolean;
}

export class MirrorConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join('；'));
    this.name = 'MirrorConfigError';
    this.issues = issues;
  }
}

/** 校验管理员提交的模板列表；不合法时抛 MirrorConfigError。 */
export function validateMirrorTemplates(input: unknown): MirrorTemplate[] {
  const parsed = MirrorTemplateListSchema.safeParse(input);
  if (!parsed.success) {
    throw new MirrorConfigError(
      parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const issues: string[] = [];
  const ids = new Set<string>();
  const templates = new Set<string>();
  if (parsed.data.length === 0) issues.push('至少保留一条模板');
  for (const item of parsed.data) {
    const problem = templateError(item.template);
    if (problem) issues.push(`${item.name || item.id}：${problem}`);
    if (ids.has(item.id)) issues.push(`模板 id 重复：${item.id}`);
    if (templates.has(item.template)) issues.push(`模板地址重复：${item.template}`);
    ids.add(item.id);
    templates.add(item.template);
  }
  if (issues.length > 0) throw new MirrorConfigError(issues);
  return parsed.data;
}

export async function getMirrorTemplates(db: D1Database): Promise<MirrorConfig> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(MIRROR_TEMPLATES_KEY)
    .first<{ value: string }>();
  if (!row) return { templates: DEFAULT_MIRROR_TEMPLATES, custom: false };
  try {
    const parsed = MirrorTemplateListSchema.parse(JSON.parse(row.value));
    if (parsed.length === 0) return { templates: DEFAULT_MIRROR_TEMPLATES, custom: false };
    return { templates: parsed, custom: true };
  } catch {
    return { templates: DEFAULT_MIRROR_TEMPLATES, custom: false };
  }
}

export async function saveMirrorTemplates(db: D1Database, input: unknown, now = new Date().toISOString()): Promise<MirrorConfig> {
  const templates = validateMirrorTemplates(input);
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(MIRROR_TEMPLATES_KEY, JSON.stringify(templates), now)
    .run();
  return { templates, custom: true };
}

export async function resetMirrorTemplates(db: D1Database): Promise<MirrorConfig> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(MIRROR_TEMPLATES_KEY).run();
  return { templates: DEFAULT_MIRROR_TEMPLATES, custom: false };
}
