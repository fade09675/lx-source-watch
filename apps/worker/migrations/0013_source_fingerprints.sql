-- 0013: unified content fingerprint (full sha256) for cross-URL dedup.
-- source_endpoints.sha / candidates.sha keep the legacy short/git fingerprints;
-- sha256 is the comparable content identity.

ALTER TABLE source_endpoints ADD COLUMN sha256 TEXT;
ALTER TABLE source_runs ADD COLUMN content_sha256 TEXT;
ALTER TABLE candidates ADD COLUMN sha256 TEXT;
ALTER TABLE source_registry ADD COLUMN content_sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_source_endpoints_sha256 ON source_endpoints(sha256);
CREATE INDEX IF NOT EXISTS idx_source_runs_content_sha ON source_runs(content_sha256);
CREATE INDEX IF NOT EXISTS idx_candidates_sha256 ON candidates(sha256);
CREATE INDEX IF NOT EXISTS idx_source_registry_sha256 ON source_registry(content_sha256);
