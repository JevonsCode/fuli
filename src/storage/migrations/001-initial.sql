PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'public')),
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  personal_space_id TEXT NOT NULL REFERENCES spaces(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  mode TEXT NOT NULL DEFAULT 'latest',
  created_at TEXT NOT NULL,
  PRIMARY KEY (personal_space_id, space_id)
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  source_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  source_uri TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_episode_id TEXT NOT NULL REFERENCES episodes(id),
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  scope TEXT NOT NULL DEFAULT 'personal',
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  replaced_by_fact_id TEXT REFERENCES facts(id)
);

CREATE INDEX facts_current_idx ON facts(space_id, predicate, invalid_at);
CREATE INDEX facts_source_idx ON facts(source_episode_id);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  personal_space_id TEXT NOT NULL REFERENCES spaces(id),
  target_space_id TEXT REFERENCES spaces(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT
);

CREATE INDEX outbox_pending_idx ON outbox(status, next_attempt_at, created_at);

CREATE TABLE imports (
  content_hash TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
