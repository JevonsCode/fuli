import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Standing assignments (rec#29 D-41.1): "from now on, <this work> goes to
// <that Agent>", said once in any conversation and kept on this computer.
// They reference provider records by ID (personal space, project, lead Agent,
// global preferences) and copy none of them; nothing migrates into this store.
//
// Temporal history: standing_assignments holds each assignment's current
// state, and every change of it, its first registration included, appends
// the state it produced to standing_assignment_revisions under the next
// revision number in the same transaction. Revision rows are immutable
// (triggers refuse UPDATE and DELETE), so the current row can always be read
// back to how and from which conversation it came to be. A retired
// assignment keeps its row with retired_at set; it is never deleted.
//
// standing_assignment_terms indexes the term keys of active assignments only:
// its primary key lets one term name at most one active assignment in a
// space, and a retirement removes the assignment's keys there.

export const STANDING_ASSIGNMENTS_FORMAT = sqliteFormat({
  store: 'standing-assignments',
  schema: `
      CREATE TABLE IF NOT EXISTS standing_assignments(
        assignment_id TEXT PRIMARY KEY, personal_space_id TEXT NOT NULL, project_id TEXT NOT NULL,
        lead_agent_id TEXT NOT NULL, terms TEXT NOT NULL, responsibility TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('user', 'host')), source_conversation_id TEXT,
        preference_ids TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        retired_at TEXT);
      CREATE INDEX IF NOT EXISTS standing_assignments_owner
        ON standing_assignments(personal_space_id, project_id, lead_agent_id);
      CREATE TABLE IF NOT EXISTS standing_assignment_terms(
        personal_space_id TEXT NOT NULL, term_key TEXT NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES standing_assignments(assignment_id),
        PRIMARY KEY(personal_space_id, term_key));
      CREATE TABLE IF NOT EXISTS standing_assignment_revisions(
        assignment_id TEXT NOT NULL REFERENCES standing_assignments(assignment_id), revision INTEGER NOT NULL,
        change TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('user', 'host')), source_conversation_id TEXT,
        record TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(assignment_id, revision));
      CREATE TRIGGER IF NOT EXISTS standing_assignment_revisions_no_update BEFORE UPDATE ON standing_assignment_revisions
        BEGIN SELECT RAISE(ABORT, 'standing assignment revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS standing_assignment_revisions_no_delete BEFORE DELETE ON standing_assignment_revisions
        BEGIN SELECT RAISE(ABORT, 'standing assignment revisions are immutable'); END;
      -- INSERT OR REPLACE deletes the old row without firing the delete trigger
      -- (recursive_triggers is off), so an existing revision key is refused on insert.
      CREATE TRIGGER IF NOT EXISTS standing_assignment_revisions_no_replace BEFORE INSERT ON standing_assignment_revisions
        WHEN EXISTS (SELECT 1 FROM standing_assignment_revisions
          WHERE assignment_id = NEW.assignment_id AND revision = NEW.revision)
        BEGIN SELECT RAISE(ABORT, 'standing assignment revisions are immutable'); END;`
});

export class StandingAssignmentStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on first write; a missing file reads as no assignments and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, STANDING_ASSIGNMENTS_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(assignmentId) {
    if (!this.readable) return null;
    return view(this.db.prepare('SELECT * FROM standing_assignments WHERE assignment_id = ?').get(assignmentId));
  }

  activeFor(personalSpaceId, projectId, leadAgentId) {
    if (!this.readable) return null;
    return view(this.db.prepare(`SELECT * FROM standing_assignments WHERE personal_space_id = ? AND project_id = ?
      AND lead_agent_id = ? AND retired_at IS NULL`).get(personalSpaceId, projectId, leadAgentId));
  }

  // The active assignment a term key names in a space, if any.
  termOwner(personalSpaceId, termKey) {
    if (!this.readable) return null;
    return view(this.db.prepare(`SELECT a.* FROM standing_assignment_terms t
      JOIN standing_assignments a ON a.assignment_id = t.assignment_id
      WHERE t.personal_space_id = ? AND t.term_key = ?`).get(personalSpaceId, termKey));
  }

  // Every recorded state of the space's assignments, the latest first.
  * recordsNewestFirst(personalSpaceId) {
    if (!this.readable) return;
    for (const row of this.db.prepare(`SELECT r.record FROM standing_assignment_revisions r
      JOIN standing_assignments a ON a.assignment_id = r.assignment_id WHERE a.personal_space_id = ?
      ORDER BY r.rowid DESC`).iterate(personalSpaceId)) yield JSON.parse(row.record);
  }

  listActive(personalSpaceId) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM standing_assignments WHERE personal_space_id = ? AND retired_at IS NULL
      ORDER BY created_at, assignment_id`).all(personalSpaceId).map(view);
  }

  // Every active term key of a space with the assignment it names.
  activeTerms(personalSpaceId) {
    if (!this.readable) return [];
    return this.db.prepare('SELECT term_key, assignment_id FROM standing_assignment_terms WHERE personal_space_id = ?')
      .all(personalSpaceId).map((row) => ({ termKey: row.term_key, assignmentId: row.assignment_id }));
  }

  revisions(assignmentId) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM standing_assignment_revisions WHERE assignment_id = ? ORDER BY revision`)
      .all(assignmentId).map((row) => ({ revision: row.revision, change: row.change, source: row.source,
        sourceConversationId: row.source_conversation_id, record: JSON.parse(row.record), recordedAt: row.recorded_at }));
  }

  // Writes the assignment's new current state, its term keys while active,
  // and the revision row of the change, inside the caller's transaction.
  save(record, { change, source, sourceConversationId, termKeys }) {
    this.db.prepare(`INSERT INTO standing_assignments VALUES(:assignment_id, :personal_space_id, :project_id,
        :lead_agent_id, :terms, :responsibility, :source, :source_conversation_id, :preference_ids, :revision,
        :created_at, :updated_at, :retired_at)
      ON CONFLICT(assignment_id) DO UPDATE SET project_id = excluded.project_id,
        lead_agent_id = excluded.lead_agent_id, terms = excluded.terms, source = excluded.source,
        source_conversation_id = excluded.source_conversation_id, preference_ids = excluded.preference_ids,
        revision = excluded.revision, updated_at = excluded.updated_at, retired_at = excluded.retired_at`)
      .run(columns(record));
    this.db.prepare('DELETE FROM standing_assignment_terms WHERE assignment_id = ?').run(record.assignmentId);
    if (!record.retiredAt) {
      const index = this.db.prepare('INSERT INTO standing_assignment_terms VALUES(?, ?, ?)');
      for (const key of termKeys) index.run(record.personalSpaceId, key, record.assignmentId);
    }
    this.db.prepare('INSERT INTO standing_assignment_revisions VALUES(?, ?, ?, ?, ?, ?, ?)').run(record.assignmentId,
      record.revision, change, source, sourceConversationId, JSON.stringify(record), record.updatedAt);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function columns(record) {
  return { assignment_id: record.assignmentId, personal_space_id: record.personalSpaceId, project_id: record.projectId,
    lead_agent_id: record.leadAgentId, terms: JSON.stringify(record.terms), responsibility: record.responsibility,
    source: record.source, source_conversation_id: record.sourceConversationId,
    preference_ids: JSON.stringify(record.preferenceIds), revision: record.revision, created_at: record.createdAt,
    updated_at: record.updatedAt, retired_at: record.retiredAt };
}

function view(row) {
  if (!row) return null;
  return { assignmentId: row.assignment_id, personalSpaceId: row.personal_space_id, projectId: row.project_id,
    leadAgentId: row.lead_agent_id, terms: JSON.parse(row.terms), responsibility: row.responsibility,
    source: row.source, sourceConversationId: row.source_conversation_id,
    preferenceIds: JSON.parse(row.preference_ids), revision: row.revision, createdAt: row.created_at,
    updatedAt: row.updated_at, retiredAt: row.retired_at };
}
