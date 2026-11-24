-- 0012: backfill endpoint / domestic-probe statistics for historical runs.
-- 0009 added these columns with a default of 0; runs that already had
-- source_endpoints / platform_results rows kept showing 0/0.

UPDATE runs
SET
  endpoints_ok = (
    SELECT COUNT(*) FROM source_endpoints e
    WHERE e.run_id = runs.run_id AND e.ok = 1
  ),
  endpoints_total = (
    SELECT COUNT(*) FROM source_endpoints e
    WHERE e.run_id = runs.run_id
  ),
  cn_tested = (
    SELECT COUNT(*) FROM platform_results p
    WHERE p.run_id = runs.run_id AND p.cn_tested = 1
  ),
  cn_ok = (
    SELECT COUNT(*) FROM platform_results p
    WHERE p.run_id = runs.run_id AND p.cn_tested = 1 AND p.cn_ok = 1
  )
WHERE EXISTS (
  SELECT 1 FROM source_endpoints e WHERE e.run_id = runs.run_id
);

UPDATE source_runs
SET
  endpoints_ok = (
    SELECT COUNT(*) FROM source_endpoints e
    WHERE e.run_id = source_runs.run_id
      AND e.source_id = source_runs.source_id
      AND e.ok = 1
  ),
  endpoints_total = (
    SELECT COUNT(*) FROM source_endpoints e
    WHERE e.run_id = source_runs.run_id
      AND e.source_id = source_runs.source_id
  ),
  version = COALESCE(
    version,
    (
      SELECT e.version FROM source_endpoints e
      WHERE e.run_id = source_runs.run_id
        AND e.source_id = source_runs.source_id
        AND e.role = 'primary'
      LIMIT 1
    )
  ),
  script_sha = COALESCE(
    script_sha,
    (
      SELECT e.sha FROM source_endpoints e
      WHERE e.run_id = source_runs.run_id
        AND e.source_id = source_runs.source_id
        AND e.role = 'primary'
      LIMIT 1
    )
  )
WHERE EXISTS (
  SELECT 1 FROM source_endpoints e
  WHERE e.run_id = source_runs.run_id
    AND e.source_id = source_runs.source_id
);
