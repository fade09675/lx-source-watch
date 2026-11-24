-- 0015: backfill registry content sha256 from the newest run that has it.
-- 0013 added the column but historical rows were empty; dedup cannot work
-- until existing registry sources carry their content fingerprint.

UPDATE source_registry
SET content_sha256 = (
  SELECT sr.content_sha256
  FROM source_runs sr
  WHERE sr.source_id = source_registry.id
    AND sr.content_sha256 IS NOT NULL
    AND sr.content_sha256 <> ''
  ORDER BY sr.checked_at DESC
  LIMIT 1
)
WHERE content_sha256 IS NULL OR content_sha256 = '';
