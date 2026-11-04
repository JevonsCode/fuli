import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// What changed in each project's profile, who changed it and when. Every real
// change is one new row and nothing is updated or deleted (triggers refuse it),
// so the record reads back as it happened. `actor` is the person, a named Agent
// or FULI itself; `changes` is a JSON list of { field, before, after } text.
export const PROJECT_CHANGE_LOG_FORMAT = sqliteFormat({
  store: 'project-change-log',
  schema: `
    CREATE TABLE IF NOT EXISTS project_changes(
      id INTEGER PRIMARY KEY AUTOINCREMENT, personal_space_id TEXT NOT NULL, project_id TEXT NOT NULL, at TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('person', 'agent', 'fuli')), agent_id TEXT, agent_name TEXT,
      changes TEXT NOT NULL, CHECK(actor = 'agent' OR (agent_id IS NULL AND agent_name IS NULL)));
    CREATE INDEX IF NOT EXISTS project_changes_project ON project_changes(personal_space_id, project_id, id);
    CREATE TRIGGER IF NOT EXISTS project_changes_no_update BEFORE UPDATE ON project_changes
      BEGIN SELECT RAISE(ABORT, 'project changes are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS project_changes_no_delete BEFORE DELETE ON project_changes
      BEGIN SELECT RAISE(ABORT, 'project changes are immutable'); END;`
});

export class ProjectChangeStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first change; a missing file reads as no changes and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, PROJECT_CHANGE_LOG_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  add({ personalSpaceId, projectId, at, actor, changes }) {
    this.db.prepare(`INSERT INTO project_changes(personal_space_id, project_id, at, actor, agent_id, agent_name, changes)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(personalSpaceId, projectId, at, actor.kind, actor.agentId, actor.agentName,
      JSON.stringify(changes));
  }

  // The newest changes first.
  recent(personalSpaceId, projectId, limit) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM project_changes WHERE personal_space_id = ? AND project_id = ?
      ORDER BY id DESC LIMIT ?`).all(personalSpaceId, projectId, limit).map(changeView);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function changeView(row) {
  return { id: row.id, at: row.at, actor: { kind: row.actor, agentId: row.agent_id, agentName: row.agent_name },
    changes: JSON.parse(row.changes) };
}
