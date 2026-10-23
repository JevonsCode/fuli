import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// What the built-in Agents showed after asking their own model (rec#8,
// rec#10 D-26): Bole's performance_review, Astro's project_candidate and
// Jefa's board_match, one row per result exactly as the session received it
// (suggested, superseded, stopped or handed back to the session), without the
// session guidance. The console lists them. Every row keeps the host's
// suggestion_only gate; nothing reads a row as permission or applies it, and
// a superseded row holds no model content because the role returned none.
// subject names what a person opens to act: Bole's Agent, Astro's
// conversation. Rows are never changed.

const LIST_LIMIT = 50;

export const ROLE_SUGGESTIONS_FORMAT = sqliteFormat({
  store: 'role-suggestions',
  schema: `
      CREATE TABLE IF NOT EXISTS role_suggestions(
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, role TEXT NOT NULL, operation TEXT NOT NULL,
        space TEXT NOT NULL, project TEXT, subject TEXT NOT NULL, result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS role_suggestions_at ON role_suggestions(at);`
});

export class RoleSuggestionLog {
  constructor(path = ':memory:', { now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
  }

  // Opened on first write, so a data directory whose roles never asked a model has no file.
  get db() {
    this.database ??= openFormattedDatabase(this.path, ROLE_SUGGESTIONS_FORMAT);
    return this.database;
  }

  record({ role, operation, personalSpaceId, personalProjectId = null, subject = {}, result }) {
    this.db.prepare('INSERT INTO role_suggestions(at, role, operation, space, project, subject, result) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(this.now().toISOString(), role, operation, personalSpaceId, personalProjectId, JSON.stringify(subject),
        JSON.stringify({ ...result, guidance: undefined }));
  }

  // Newest first. Reading never creates the file.
  list({ limit = LIST_LIMIT } = {}) {
    if (!this.database && this.path !== ':memory:' && !existsSync(this.path)) return [];
    return this.db.prepare('SELECT * FROM role_suggestions ORDER BY at DESC, id DESC LIMIT ?').all(limit).map(row => ({
      ...JSON.parse(row.result), id: row.id, at: row.at, role: row.role, operation: row.operation,
      personalSpaceId: row.space, personalProjectId: row.project, subject: JSON.parse(row.subject)
    }));
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

// A role notes what it showed. A log it cannot write (a newer FULI's file,
// a full disk) never changes the role's answer to the session.
export function noteRoleSuggestion(application, entry) {
  try {
    application.roleSuggestions?.record(entry);
  } catch {
    // The answer stands; only its console copy is missing.
  }
}
