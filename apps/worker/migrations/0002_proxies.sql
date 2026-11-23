-- 国内补测代理池：密码与内核配置用 AES-GCM 加密后存储。
CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT NOT NULL DEFAULT '',
  config_enc TEXT NOT NULL DEFAULT '',
  kernel_only INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_latency_ms INTEGER,
  egress_ip TEXT,
  last_error TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxies_enabled ON proxies (enabled, sort_order);
