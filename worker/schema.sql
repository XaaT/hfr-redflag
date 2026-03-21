CREATE TABLE IF NOT EXISTS posts (
  cat        INTEGER NOT NULL,
  numreponse INTEGER NOT NULL,
  post_id    INTEGER NOT NULL,
  flagged    INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cat, numreponse)
);

CREATE INDEX IF NOT EXISTS idx_topic ON posts(cat, post_id);
