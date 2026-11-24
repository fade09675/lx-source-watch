import { readFileSync, writeFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('sources/registry.json', 'utf8'));
const esc = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;

const values = registry.sources
  .map((source, index) => {
    const columns = [
      source.id,
      source.title,
      source.category ?? '在线',
      source.storage ?? 'remote',
      source.url ?? '',
      source.path ?? '',
      source.homepage ?? '',
      JSON.stringify(source.mirrors ?? []),
      source.enabled === false ? 0 : 1,
      source.trusted ? 1 : 0,
      source.notes ?? '',
      index,
    ].map(esc);
    return `(${columns.join(', ')}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  })
  .join(',\n');

const sql = `-- 音源注册表：Web 管理的音源清单，探测时从公开接口读取。
CREATE TABLE IF NOT EXISTS source_registry (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '在线',
  storage TEXT NOT NULL DEFAULT 'remote',
  url TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '',
  mirrors TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  trusted INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_registry_enabled ON source_registry(enabled, sort_order);

INSERT INTO source_registry
  (id, title, category, storage, url, path, homepage, mirrors, enabled, trusted, notes, sort_order, created_at, updated_at)
VALUES
${values};
`;

writeFileSync('apps/worker/migrations/0008_source_registry.sql', sql);
console.log(`wrote ${registry.sources.length} rows`);
