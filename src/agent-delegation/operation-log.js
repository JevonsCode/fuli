import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Every console change an FLA made for the person (rec#11 D-81): who (FLA,
// project, client, session), which route and path, why, the field names it
// sent (never their values), how it ended and how to undo it. One row per
// call, never updated or deleted, so the person reads back exactly what
// happened in their name.
export const AGENT_DELEGATION_FORMAT = sqliteFormat({
  store: 'agent-delegation',
  schema: `
    CREATE TABLE IF NOT EXISTS delegated_operations(
      id TEXT PRIMARY KEY, at TEXT NOT NULL, route TEXT NOT NULL, path TEXT NOT NULL, category TEXT NOT NULL,
      agent_id TEXT, project_id TEXT, client TEXT, session_id TEXT, reason TEXT NOT NULL, body_fields TEXT NOT NULL,
      status INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed')), undo TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS delegated_operations_at ON delegated_operations(at);
    CREATE TRIGGER IF NOT EXISTS delegated_operations_no_update BEFORE UPDATE ON delegated_operations
      BEGIN SELECT RAISE(ABORT, 'delegated operations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS delegated_operations_no_delete BEFORE DELETE ON delegated_operations
      BEGIN SELECT RAISE(ABORT, 'delegated operations are immutable'); END;`
});

export class DelegatedOperationLog {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first record; a missing file reads as no operations.
  get db() {
    this.database ??= openFormattedDatabase(this.path, AGENT_DELEGATION_FORMAT);
    return this.database;
  }

  record(operation) {
    this.db.prepare(`INSERT INTO delegated_operations(id, at, route, path, category, agent_id, project_id, client,
      session_id, reason, body_fields, status, outcome, undo) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operation.id, operation.at, operation.route, operation.path, operation.category,
        operation.actor.agentId, operation.actor.projectId, operation.actor.client, operation.actor.sessionId,
        operation.reason, JSON.stringify(operation.bodyFields), operation.status, operation.outcome, operation.undo);
  }

  // Newest first.
  recent(limit) {
    if (!this.database && this.path !== ':memory:' && !existsSync(this.path)) return [];
    return this.db.prepare('SELECT * FROM delegated_operations ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)
      .map(operationView);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function operationView(row) {
  return { id: row.id, at: row.at, route: row.route, path: row.path, category: row.category,
    actor: { agentId: row.agent_id, projectId: row.project_id, client: row.client, sessionId: row.session_id },
    reason: row.reason, bodyFields: JSON.parse(row.body_fields), status: row.status, outcome: row.outcome,
    undo: row.undo };
}
