-- 任务对账与重试查询索引。
CREATE INDEX IF NOT EXISTS idx_tasks_status_started
  ON tasks (status, started_at);

CREATE INDEX IF NOT EXISTS idx_tasks_github_run
  ON tasks (github_run_id);
