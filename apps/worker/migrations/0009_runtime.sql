-- 统一运行时：任务、锁、状态快照 + runs 扩展字段。

ALTER TABLE runs ADD COLUMN task_id TEXT;
ALTER TABLE runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'success';
ALTER TABLE runs ADD COLUMN message TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN error TEXT;
ALTER TABLE runs ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN log_key TEXT;
ALTER TABLE runs ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN started_at TEXT;
ALTER TABLE runs ADD COLUMN endpoints_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN endpoints_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cn_tested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cn_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN candidates_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN candidates_promoted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN proxies_used INTEGER NOT NULL DEFAULT 0;

ALTER TABLE source_runs ADD COLUMN version TEXT;
ALTER TABLE source_runs ADD COLUMN script_sha TEXT;
ALTER TABLE source_runs ADD COLUMN endpoints_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN endpoints_total INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 5,
  payload TEXT NOT NULL DEFAULT '{}',
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_unit TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  github_run_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_of TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);

CREATE TABLE IF NOT EXISTS task_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_state (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
