-- 阶段 2：运行详情的三级查询（源 → 接入点 → 平台）与平台汇总。
CREATE INDEX IF NOT EXISTS idx_runs_generated ON runs(generated_at);
CREATE INDEX IF NOT EXISTS idx_platform_results_platform ON platform_results(platform, run_id);
CREATE INDEX IF NOT EXISTS idx_source_endpoints_run_ok ON source_endpoints(run_id, ok);
