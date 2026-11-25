-- 音源来源（仓库/路径），用于总览与详情解释“这个源从哪来”。
ALTER TABLE source_registry ADD COLUMN origin TEXT NOT NULL DEFAULT '';

-- 能从自动发现候选回填的先回填；旧的自动收录记录 notes 里带有“自动收录：owner/repo/path”。
UPDATE source_registry
   SET origin = COALESCE(
     (SELECT c.repo || '/' || c.path FROM candidates c
       WHERE c.url = source_registry.url
          OR (c.sha256 IS NOT NULL AND c.sha256 = source_registry.content_sha256)
       ORDER BY c.url = source_registry.url DESC
       LIMIT 1),
     ''
   )
 WHERE origin = '';

UPDATE source_registry
   SET origin = TRIM(REPLACE(notes, '自动收录：', ''))
 WHERE origin = '' AND notes LIKE '自动收录：%';
