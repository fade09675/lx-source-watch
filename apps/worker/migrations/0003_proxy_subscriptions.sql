-- 代理订阅源：可以改名、刷新、删除；节点通过 subscription_id 归属订阅。
CREATE TABLE IF NOT EXISTS proxy_subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetch_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE proxies ADD COLUMN subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_proxies_subscription ON proxies(subscription_id);
