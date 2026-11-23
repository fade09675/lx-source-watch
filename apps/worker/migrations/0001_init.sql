-- lx-source-watch D1 初始结构
-- 约定：时间一律用 ISO 8601 UTC 字符串；布尔用 0/1；day 用 Asia/Shanghai 的 YYYY-MM-DD。

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  mirror TEXT,
  homepage TEXT,
  storage TEXT NOT NULL DEFAULT 'remote',
  version TEXT,
  author TEXT,
  description TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_status TEXT,
  last_ok INTEGER,
  last_tested INTEGER,
  streak INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  runner TEXT NOT NULL,
  check_scope TEXT NOT NULL,
  total INTEGER NOT NULL,
  available INTEGER NOT NULL,
  partial INTEGER NOT NULL,
  unavailable INTEGER NOT NULL,
  untested INTEGER NOT NULL,
  platforms_ok INTEGER NOT NULL,
  platforms_tested INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_generated ON runs(generated_at DESC);

CREATE TABLE IF NOT EXISTS source_runs (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  init_ok INTEGER NOT NULL,
  init_error TEXT,
  ok INTEGER NOT NULL,
  tested INTEGER NOT NULL,
  total INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_source_runs_source ON source_runs(source_id, run_id);

CREATE TABLE IF NOT EXISTS platform_results (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  declared INTEGER NOT NULL,
  tested INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  quality TEXT,
  resolve_ms INTEGER,
  ttfb_ms INTEGER,
  total_ms INTEGER,
  error_kind TEXT,
  error TEXT,
  url_host TEXT,
  http_status INTEGER,
  content_type TEXT,
  cn_tested INTEGER,
  cn_ok INTEGER,
  cn_ms INTEGER,
  cn_ttfb_ms INTEGER,
  cn_error TEXT,
  PRIMARY KEY (run_id, source_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_platform_results_source ON platform_results(source_id, platform, run_id);

CREATE TABLE IF NOT EXISTS source_daily (
  day TEXT NOT NULL,
  source_id TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  ok_sum INTEGER NOT NULL DEFAULT 0,
  tested_sum INTEGER NOT NULL DEFAULT 0,
  total_sum INTEGER NOT NULL DEFAULT 0,
  avg_ms INTEGER,
  last_status TEXT,
  PRIMARY KEY (day, source_id)
);

CREATE TABLE IF NOT EXISTS platform_daily (
  day TEXT NOT NULL,
  source_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  ok_sum INTEGER NOT NULL DEFAULT 0,
  tested_sum INTEGER NOT NULL DEFAULT 0,
  avg_ms INTEGER,
  PRIMARY KEY (day, source_id, platform)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  sha TEXT,
  title TEXT,
  version TEXT,
  author TEXT,
  description TEXT,
  platforms TEXT,
  bytes INTEGER,
  init_ok INTEGER,
  init_error TEXT,
  state TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(state, last_seen DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
