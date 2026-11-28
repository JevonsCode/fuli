use rusqlite::Connection;

use crate::error::StoreResult;

pub const SCHEMA_VERSION: i32 = 2;

const DDL_V1: &str = r#"
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    name_key      TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    reply_lang    TEXT NOT NULL DEFAULT 'zh-CN',
    persona_note  TEXT NOT NULL DEFAULT '',
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_bindings (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('git_remote', 'dir_path')),
    canonical_key TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'own' CHECK (role IN ('own', 'reference')),
    label         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    UNIQUE(agent_id, kind, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_bindings_lookup ON agent_bindings(kind, canonical_key);

CREATE TABLE IF NOT EXISTS knowledge_bases (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    name_key      TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL DEFAULT '',
    default_lang  TEXT NOT NULL DEFAULT 'zh-CN',
    read_only     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_kb_mounts (
    agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kb_id         TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    mount_role    TEXT NOT NULL CHECK (mount_role IN ('primary', 'attached_readonly')),
    created_at    TEXT NOT NULL,
    PRIMARY KEY (agent_id, kb_id)
);

CREATE TABLE IF NOT EXISTS kb_links (
    id            TEXT PRIMARY KEY,
    from_kb_id    TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    to_kb_id      TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('cites', 'inherits')),
    authority     TEXT NOT NULL CHECK (authority IN ('suggested', 'human_confirmed', 'revoked')),
    weight        REAL NOT NULL DEFAULT 1.0,
    rationale     TEXT NOT NULL DEFAULT '',
    confirmed_at  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(from_kb_id, to_kb_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_kb_links_from ON kb_links(from_kb_id, authority);

CREATE TABLE IF NOT EXISTS kb_items (
    id                TEXT PRIMARY KEY,
    kb_id             TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    stable_key        TEXT,
    item_type         TEXT NOT NULL CHECK (item_type IN ('fact', 'runbook', 'experience', 'decision')),
    status            TEXT NOT NULL CHECK (status IN ('proposal', 'confirmed', 'deprecated')),
    lang              TEXT NOT NULL DEFAULT 'zh-CN',
    translation_of_id TEXT REFERENCES kb_items(id) ON DELETE SET NULL,
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    context_summary   TEXT NOT NULL DEFAULT '',
    aliases_json      TEXT NOT NULL DEFAULT '[]',
    evidence_json     TEXT NOT NULL DEFAULT '{}',
    revision          INTEGER NOT NULL DEFAULT 1,
    valid_from        TEXT NOT NULL,
    valid_to          TEXT,
    superseded_by_id  TEXT REFERENCES kb_items(id) ON DELETE SET NULL,
    reuse_count       INTEGER NOT NULL DEFAULT 0,
    helpful_count     INTEGER NOT NULL DEFAULT 0,
    needs_review      INTEGER NOT NULL DEFAULT 0,
    last_reused_at    TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_items_kb_status ON kb_items(kb_id, status);
CREATE INDEX IF NOT EXISTS idx_kb_items_stable_key ON kb_items(kb_id, stable_key);

CREATE TABLE IF NOT EXISTS kb_item_versions (
    id              TEXT PRIMARY KEY,
    item_id         TEXT NOT NULL REFERENCES kb_items(id) ON DELETE CASCADE,
    revision        INTEGER NOT NULL,
    status          TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    context_summary TEXT NOT NULL DEFAULT '',
    aliases_json    TEXT NOT NULL DEFAULT '[]',
    change_reason   TEXT NOT NULL DEFAULT '',
    changed_by      TEXT NOT NULL DEFAULT 'system',
    created_at      TEXT NOT NULL,
    UNIQUE(item_id, revision)
);

CREATE TABLE IF NOT EXISTS kb_edges (
    id           TEXT PRIMARY KEY,
    from_item_id TEXT NOT NULL REFERENCES kb_items(id) ON DELETE CASCADE,
    to_item_id   TEXT NOT NULL REFERENCES kb_items(id) ON DELETE CASCADE,
    edge_type    TEXT NOT NULL CHECK (edge_type IN ('depends_on', 'contradicts', 'extends', 'related_to')),
    authority    TEXT NOT NULL CHECK (authority IN ('suggested', 'human_confirmed', 'revoked')),
    weight       REAL NOT NULL DEFAULT 1.0,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    UNIQUE(from_item_id, to_item_id, edge_type)
);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_items_fts USING fts5(
    item_id UNINDEXED,
    kb_id UNINDEXED,
    title_tokens,
    alias_tokens,
    context_tokens,
    body_tokens,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS kb_embeddings (
    item_id      TEXT PRIMARY KEY REFERENCES kb_items(id) ON DELETE CASCADE,
    model_id     TEXT NOT NULL,
    dims         INTEGER NOT NULL,
    vector_blob  BLOB NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules_and_prefs (
    id                 TEXT PRIMARY KEY,
    scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('personal_global', 'agent')),
    scope_id           TEXT NOT NULL DEFAULT '',
    constraint_class   TEXT NOT NULL CHECK (constraint_class IN ('hard_rule', 'preference')),
    aspect             TEXT NOT NULL CHECK (aspect IN ('hard_rule', 'taste', 'personality', 'judgment')),
    pref_key           TEXT NOT NULL,
    authority          TEXT NOT NULL CHECK (authority IN ('human_explicit', 'human_confirmed', 'ai_proposal')),
    status             TEXT NOT NULL CHECK (status IN ('active', 'pending', 'disabled')),
    content            TEXT NOT NULL,
    rationale          TEXT NOT NULL DEFAULT '',
    applicability_json TEXT NOT NULL DEFAULT '{}',
    revision           INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_scope ON rules_and_prefs(scope_kind, scope_id, status);

CREATE TABLE IF NOT EXISTS workstreams (
    id                 TEXT PRIMARY KEY,
    agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('active', 'paused', 'done')),
    head_checkpoint_id TEXT,
    worktree_path      TEXT NOT NULL DEFAULT '',
    branch_name        TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workstreams_agent ON workstreams(agent_id, status);

CREATE TABLE IF NOT EXISTS workstream_checkpoints (
    id                TEXT PRIMARY KEY,
    workstream_id     TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,
    goal              TEXT NOT NULL,
    current_state     TEXT NOT NULL,
    decisions_json    TEXT NOT NULL DEFAULT '[]',
    next_steps_json   TEXT NOT NULL DEFAULT '[]',
    reused_refs_json  TEXT NOT NULL DEFAULT '[]',
    source_client     TEXT NOT NULL DEFAULT '',
    source_session_id TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    UNIQUE(workstream_id, seq)
);

CREATE TABLE IF NOT EXISTS workflows (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    steps_json   TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'disabled')),
    run_count    INTEGER NOT NULL DEFAULT 0,
    pass_count   INTEGER NOT NULL DEFAULT 0,
    revision     INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_agent ON workflows(agent_id, status);

CREATE TABLE IF NOT EXISTS sessions (
    client_id     TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
    active_ws_id  TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
    cwd           TEXT NOT NULL DEFAULT '',
    context_epoch INTEGER NOT NULL DEFAULT 0,
    control_mode  TEXT NOT NULL DEFAULT 'normal' CHECK (control_mode IN ('normal', 'capture_paused', 'disabled')),
    last_summary  TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (client_id, session_id)
);

CREATE TABLE IF NOT EXISTS delivery_ledger (
    id              TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    context_epoch   INTEGER NOT NULL,
    turn_seq        INTEGER NOT NULL,
    trigger_kind    TEXT NOT NULL,
    target_kind     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    target_revision INTEGER NOT NULL,
    delivery_mode   TEXT NOT NULL CHECK (delivery_mode IN ('full', 'title_only', 'delta_removed', 'skipped_dedup', 'truncated_budget')),
    tokens_est      INTEGER NOT NULL DEFAULT 0,
    reason          TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_session ON delivery_ledger(client_id, session_id, context_epoch, turn_seq);

CREATE TABLE IF NOT EXISTS compounding_events (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    workstream_id   TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
    target_kind     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    target_revision INTEGER NOT NULL,
    client_id       TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    human_feedback  TEXT CHECK (human_feedback IS NULL OR human_feedback IN ('helpful', 'stale', 'wrong')),
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compounding_created ON compounding_events(created_at DESC);

CREATE TABLE IF NOT EXISTS roundtable_exchanges (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
    from_client     TEXT NOT NULL,
    from_session_id TEXT NOT NULL,
    to_client       TEXT NOT NULL,
    to_session_id   TEXT NOT NULL,
    question        TEXT NOT NULL,
    answer          TEXT,
    wake_status     TEXT NOT NULL CHECK (wake_status IN ('woken_replied', 'queued_inbox', 'failed')),
    created_at      TEXT NOT NULL,
    answered_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_roundtable_inbox ON roundtable_exchanges(to_client, to_session_id, wake_status);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

/// v2: lightweight run log. One row per step FULI took for a client turn (Hook or MCP).
/// Stores summaries only (counts, IDs, short titles), never knowledge bodies or prompts.
const DDL_V2_RUN_STEPS: &str = r#"
CREATE TABLE IF NOT EXISTS run_steps (
    id           TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    turn_seq     INTEGER NOT NULL DEFAULT 0,
    trace_id     TEXT NOT NULL,
    step_seq     INTEGER NOT NULL,
    source       TEXT NOT NULL,
    tag          TEXT NOT NULL,
    title        TEXT NOT NULL,
    detail       TEXT NOT NULL DEFAULT '',
    agent_id     TEXT,
    duration_us  INTEGER NOT NULL DEFAULT 0,
    tokens_est   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_session ON run_steps(client_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_steps_trace ON run_steps(trace_id, step_seq);
"#;

pub fn initialize_database(conn: &Connection) -> StoreResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;

    let current_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version < 1 {
        conn.execute_batch(DDL_V1)?;
    }
    if current_version < 2 {
        conn.execute_batch(DDL_V2_RUN_STEPS)?;
    }
    if current_version < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}
