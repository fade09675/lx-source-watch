-- 上传型音源：D1 只存文件元数据，脚本正文在 KV（script:<sha256>）。
CREATE TABLE IF NOT EXISTS source_files (
  source_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS source_files_sha256 ON source_files(sha256);
