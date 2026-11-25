-- 自定义发现仓库：内置仓库仍写在 sources/discovery.json，这里只存网页新增的仓库。
CREATE TABLE IF NOT EXISTS discovery_repos (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  path_prefixes TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  last_scanned_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_repos_repo_branch
  ON discovery_repos (repo, branch);

CREATE INDEX IF NOT EXISTS idx_discovery_repos_enabled
  ON discovery_repos (enabled, created_at);
