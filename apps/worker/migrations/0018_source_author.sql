-- 音源注册表补充作者字段：相似去重要求“标题 + 作者”同时匹配，避免同名不同作者被误判。
ALTER TABLE source_registry ADD COLUMN author TEXT NOT NULL DEFAULT '';

-- 旧数据的作者从候选表回填：优先按地址，其次按内容指纹。
UPDATE source_registry
SET author = COALESCE(
  (SELECT author FROM candidates WHERE candidates.url = source_registry.url AND author <> '' LIMIT 1),
  (SELECT author FROM candidates WHERE candidates.sha256 = source_registry.content_sha256 AND author <> '' LIMIT 1),
  ''
)
WHERE author = '';

CREATE INDEX IF NOT EXISTS idx_source_registry_title_author ON source_registry(title, author);
