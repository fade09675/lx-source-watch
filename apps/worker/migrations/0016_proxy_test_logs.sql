-- 代理测活日志：每次测活一轮一条 summary，每个节点一行明细。
CREATE TABLE IF NOT EXISTS proxy_test_runs (
  run_id       TEXT PRIMARY KEY,
  task_id      TEXT,
  trigger      TEXT NOT NULL DEFAULT 'manual',
  started_at   TEXT,
  finished_at  TEXT NOT NULL,
  total        INTEGER NOT NULL DEFAULT 0,
  ok           INTEGER NOT NULL DEFAULT 0,
  kernel_ok    INTEGER NOT NULL DEFAULT 0,
  skipped_udp  INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxy_test_runs_finished ON proxy_test_runs (finished_at DESC);

CREATE TABLE IF NOT EXISTS proxy_test_results (
  run_id          TEXT NOT NULL,
  proxy_id        TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  protocol        TEXT NOT NULL DEFAULT '',
  host            TEXT NOT NULL DEFAULT '',
  port            INTEGER,
  subscription_id TEXT,
  kernel_only     INTEGER NOT NULL DEFAULT 0,
  ok              INTEGER NOT NULL,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  country         TEXT NOT NULL DEFAULT '',
  asn             TEXT NOT NULL DEFAULT '',
  error           TEXT,
  tested_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, proxy_id)
);

CREATE INDEX IF NOT EXISTS idx_proxy_test_results_ok ON proxy_test_results (run_id, ok);
CREATE INDEX IF NOT EXISTS idx_proxy_test_results_proxy ON proxy_test_results (proxy_id);
