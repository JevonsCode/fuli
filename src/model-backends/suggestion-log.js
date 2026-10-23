import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { deletedKnowledgeBeside } from '../knowledge-hard-delete/delete-ledger.js';
import { forgetDurably, forgetReferences } from '../knowledge-hard-delete/forget-references.js';

// What the built-in Agents showed after asking their own model (rec#8,
// rec#10 D-26, D-30): Bole's performance_review, Astro's project_candidate and
// Jefa's board_match, one row per result exactly as the session received it
// at that moment (suggested, superseded, stopped or handed back to the
// session), without the session guidance. It is a record of what was said
// then, never a to-do: whether anything is still to be done is answered by
// the page that owns the decision. Every row keeps the host's suggestion_only
// gate; nothing reads a row as permission or applies it, and a superseded row
// holds no model content because the role returned none. subject names what a
// person opens: Bole's Agent, Astro's and Jefa's conversation. A row holds
// model text, so a role writes one only while recording is on for its call
// (src/graphiti/role-suggestion-note.js).
//
// Retention (D-30.2, D-30.8): a read returns only the last 90 days; rows past
// 90 days or beyond the newest 300 are deleted when the next row is written,
// in the same transaction. Nothing deletes them on expiry, and a plain DELETE
// is not an erasure of the medium.
//
// A person's permanent delete of knowledge (rec#5 C9) forgets the words of an
// object that names a deleted item, as in every local store. The rows written
// today name Agents, conversations, projects and board tasks, plus evidence
// versions and dimension names, never a knowledge item, so in practice the
// delete finds nothing here: a model reason that quoted deleted knowledge
// stays until retention removes its row.

export const RETENTION = Object.freeze({ days: 90, rows: 300 });
const DAY_MS = 86_400_000;
const LIST_LIMIT = 50;
// The JSON columns that can carry words.
const FORGETTABLE = Object.freeze(['subject', 'result']);

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
    // Read inside the write transaction, so a delete that finished before it is applied.
    this.deleted = deletedKnowledgeBeside(path);
  }

  // Opened on first write, so a data directory whose roles never asked a model has no file.
  get db() {
    this.database ??= openFormattedDatabase(this.path, ROLE_SUGGESTIONS_FORMAT);
    return this.database;
  }

  #json(value) {
    return JSON.stringify(forgetReferences(value, this.deleted()).value);
  }

  // Writes the row, then deletes rows past the retention, in one transaction.
  record({ role, operation, personalSpaceId, personalProjectId = null, subject = {}, result }) {
    const at = this.now();
    this.#transaction(() => {
      this.db.prepare('INSERT INTO role_suggestions(at, role, operation, space, project, subject, result) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(at.toISOString(), role, operation, personalSpaceId, personalProjectId, this.#json(subject),
          this.#json({ ...result, guidance: undefined }));
      this.db.prepare('DELETE FROM role_suggestions WHERE at < ?').run(retentionStart(at));
      this.db.prepare(`DELETE FROM role_suggestions WHERE id NOT IN
        (SELECT id FROM role_suggestions ORDER BY at DESC, id DESC LIMIT ?)`).run(RETENTION.rows);
    });
  }

  // The last 90 days, newest first, at most RETENTION.rows. A suggestion
  // followed by a newer suggestion for the same subject reads stale: 'newer';
  // its status stays as recorded. Reading never creates the file or deletes.
  list({ limit = LIST_LIMIT } = {}) {
    if (!this.database && this.path !== ':memory:' && !existsSync(this.path)) return [];
    const rows = this.db.prepare('SELECT * FROM role_suggestions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(retentionStart(this.now()), Math.min(Math.max(1, limit), RETENTION.rows));
    const suggested = new Set();
    return rows.map(row => {
      const entry = { ...JSON.parse(row.result), id: row.id, at: row.at, role: row.role, operation: row.operation,
        personalSpaceId: row.space, personalProjectId: row.project, subject: JSON.parse(row.subject) };
      const key = entry.status === 'suggested' ? subjectKey(entry) : null;
      if (!key) return entry;
      if (suggested.has(key)) return { ...entry, stale: 'newer' };
      suggested.add(key);
      return entry;
    });
  }

  // A person hard-deleted knowledge (rec#5 C9): a row of this space with an
  // object that names it keeps its shape and loses that object's words.
  // Returns how many rows changed.
  forgetKnowledgeItems(space, references) {
    return forgetDurably(this.db, () => this.#transaction(() => {
      let changed = 0;
      for (const row of this.db.prepare(`SELECT id, ${FORGETTABLE.join(', ')} FROM role_suggestions WHERE space = ?`).all(space)) {
        const updates = FORGETTABLE.map(column => [column, forgetReferences(JSON.parse(row[column]), references)])
          .filter(([, result]) => result.changed);
        if (!updates.length) continue;
        this.db.prepare(`UPDATE role_suggestions SET ${updates.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
          .run(...updates.map(([, result]) => JSON.stringify(result.value)), row.id);
        changed++;
      }
      return changed;
    }));
  }

  // Nested calls join the open transaction.
  #transaction(work) {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function retentionStart(at) {
  return new Date(at.getTime() - RETENTION.days * DAY_MS).toISOString();
}

// The same subject of one role in one space and project: Bole's Agent,
// Astro's and Jefa's conversation. A row without one stands alone.
function subjectKey(entry) {
  const id = entry.role === 'bole' ? entry.subject.agentId : entry.subject.conversationId;
  return id ? JSON.stringify([entry.role, entry.personalSpaceId, entry.personalProjectId, id]) : null;
}
