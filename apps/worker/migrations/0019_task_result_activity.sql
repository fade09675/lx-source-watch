-- 任务结果摘要：让任务中心不用再猜“这次跑成了什么”。
ALTER TABLE tasks ADD COLUMN result TEXT;

-- 后台操作记录：任何会改数据的操作都留一条，失败也记。
CREATE TABLE IF NOT EXISTS admin_activity (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  method  TEXT NOT NULL,
  path    TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL DEFAULT '',
  ok      INTEGER NOT NULL DEFAULT 1,
  status  INTEGER NOT NULL DEFAULT 200,
  message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_admin_activity_at ON admin_activity (at DESC);
