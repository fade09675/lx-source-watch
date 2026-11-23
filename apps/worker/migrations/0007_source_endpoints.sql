-- 每个来源的接入点（主地址 + 镜像候选）下载检查结果。
-- 只保留 14 天，和 source_runs 一起清理。
CREATE TABLE IF NOT EXISTS source_endpoints (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  role TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  sha TEXT,
  version TEXT,
  version_state TEXT,
  bytes INTEGER,
  ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id, url)
);

CREATE INDEX IF NOT EXISTS idx_source_endpoints_source
  ON source_endpoints(source_id, checked_at DESC);

ALTER TABLE sources ADD COLUMN script_sha TEXT;
ALTER TABLE sources ADD COLUMN endpoints_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN endpoints_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_change_at TEXT;
