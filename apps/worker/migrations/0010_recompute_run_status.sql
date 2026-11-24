-- 0009 给历史运行记录的 status 默认值写成了 success。
-- 这里按计数重算一遍，避免旧记录把“部分成功/全部失败”显示成成功。
-- 规则与 apps/worker/src/db.ts 的 deriveRunStatus 一致：
--   total = 0                         -> failed
--   available = 0 且无 partial/untested -> failed（全部不可用）
--   有 partial/unavailable/untested   -> partial
--   其余（全部可用）                   -> success
UPDATE runs
SET status = CASE
  WHEN total = 0 THEN 'failed'
  WHEN available = 0 AND partial = 0 AND untested = 0 THEN 'failed'
  WHEN partial > 0 OR unavailable > 0 OR untested > 0 THEN 'partial'
  ELSE 'success'
END
WHERE status <> 'running';
