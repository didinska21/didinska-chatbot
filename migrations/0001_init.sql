CREATE TABLE IF NOT EXISTS conversations (
  user_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  project TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
