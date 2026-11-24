-- 0014: source identity and aliases.
-- One piece of content (sha256) should have one canonical registry source;
-- every other URL that serves the same content is recorded here as an alias
-- URL (and later added to the canonical source's mirrors).

CREATE TABLE IF NOT EXISTS source_aliases (
  alias_url TEXT PRIMARY KEY,
  canonical_source_id TEXT NOT NULL,
  sha256 TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  state TEXT NOT NULL DEFAULT 'active',
  evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_aliases_canonical ON source_aliases(canonical_source_id);
CREATE INDEX IF NOT EXISTS idx_source_aliases_sha ON source_aliases(sha256);
CREATE INDEX IF NOT EXISTS idx_source_aliases_state ON source_aliases(state);
