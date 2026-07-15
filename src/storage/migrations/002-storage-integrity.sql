CREATE TABLE schema_migrations_new (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT INTO schema_migrations_new (version, checksum, applied_at)
SELECT
  version,
  CASE version
    WHEN 1 THEN 'ab393d736d8ff18fde75478002b2b4b3b4d7e906974cd724058e31436fba0ea9'
  END,
  applied_at
FROM schema_migrations;

DROP TABLE schema_migrations;
ALTER TABLE schema_migrations_new RENAME TO schema_migrations;

CREATE TABLE facts_new (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_episode_id TEXT NOT NULL REFERENCES episodes(id),
  status TEXT NOT NULL CHECK (
    status IN ('confirmed', 'observed', 'suggested', 'rejected', 'deprecated')
  ),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (
    typeof(confidence) IN ('integer', 'real') AND confidence >= 0.0 AND confidence <= 1.0
  ),
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (
    sensitivity IN ('normal', 'private', 'restricted')
  ),
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'public')),
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  replaced_by_fact_id TEXT REFERENCES facts_new(id)
);

INSERT INTO facts_new (
  id, space_id, subject, predicate, object, source_episode_id, status,
  confidence, sensitivity, scope, valid_at, invalid_at, replaced_by_fact_id
)
SELECT
  id, space_id, subject, predicate, object, source_episode_id, status,
  confidence, sensitivity, scope, valid_at, invalid_at, NULL
FROM facts;

UPDATE facts_new
SET replaced_by_fact_id = (
  SELECT facts.replaced_by_fact_id
  FROM facts
  WHERE facts.id = facts_new.id
);

DROP TABLE facts;
ALTER TABLE facts_new RENAME TO facts;
CREATE INDEX facts_current_idx ON facts(space_id, predicate, invalid_at);
CREATE INDEX facts_source_idx ON facts(source_episode_id);

CREATE TABLE candidates_new (
  id TEXT PRIMARY KEY,
  personal_space_id TEXT NOT NULL REFERENCES spaces(id),
  target_space_id TEXT REFERENCES spaces(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'synced', 'personal_only', 'ignored')
  ),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

INSERT INTO candidates_new (
  id, personal_space_id, target_space_id, episode_id, reason,
  status, created_at, decided_at
)
SELECT
  id, personal_space_id, target_space_id, episode_id, reason,
  status, created_at, decided_at
FROM candidates;

DROP TABLE candidates;
ALTER TABLE candidates_new RENAME TO candidates;

CREATE TABLE outbox_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attempts) = 'integer' AND attempts >= 0
  ),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT
);

INSERT INTO outbox_new (
  id, kind, aggregate_id, payload_json, status, attempts,
  next_attempt_at, created_at, sent_at, last_error
)
SELECT
  id, kind, aggregate_id, payload_json, status, attempts,
  next_attempt_at, created_at, sent_at, last_error
FROM outbox;

DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX outbox_pending_idx ON outbox(status, next_attempt_at, created_at);
