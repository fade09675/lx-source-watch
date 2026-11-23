-- Local KV put/delete counter, reconciled against Cloudflare Analytics so a
-- lagging report cannot under-report today's writes (KV writes and deletes are
-- separate daily quotas).
CREATE TABLE IF NOT EXISTS kv_write_counter (
  day TEXT PRIMARY KEY,
  puts INTEGER NOT NULL DEFAULT 0,
  deletes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
