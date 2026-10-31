import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// 全部暂停 / 恢复 over every FLA's work surfaces (rec#11 D-85). A pause first
// records which items it covered and whether each was on (work_surface_pause_items),
// then turns off the ones that were; a resume reopens exactly those. Every
// pause and resume is one row in work_surface_actions: who, when, and each
// item's result. Nothing here is updated or deleted (triggers refuse it), so
// the history reads back as it happened.
export const WORK_SURFACES_FORMAT = sqliteFormat({
  store: 'work-surfaces',
  schema: `
    CREATE TABLE IF NOT EXISTS work_surface_pauses(
      pause_id TEXT PRIMARY KEY, personal_space_id TEXT NOT NULL, filter TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS work_surface_pauses_space ON work_surface_pauses(personal_space_id, created_at);
    CREATE TABLE IF NOT EXISTS work_surface_pause_items(
      pause_id TEXT NOT NULL REFERENCES work_surface_pauses(pause_id), kind TEXT NOT NULL, item_id TEXT NOT NULL,
      name TEXT NOT NULL, agent_id TEXT, personal_project_id TEXT, was_on INTEGER NOT NULL CHECK(was_on IN (0, 1)),
      resume_detail TEXT, PRIMARY KEY(pause_id, kind, item_id));
    CREATE TABLE IF NOT EXISTS work_surface_actions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, pause_id TEXT NOT NULL REFERENCES work_surface_pauses(pause_id),
      action TEXT NOT NULL CHECK(action IN ('pause', 'resume')), actor TEXT NOT NULL CHECK(actor IN ('person', 'agent')),
      agent_id TEXT, session_id TEXT, at TEXT NOT NULL, results TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS work_surface_actions_pause ON work_surface_actions(pause_id, id);
    CREATE TRIGGER IF NOT EXISTS work_surface_pauses_no_update BEFORE UPDATE ON work_surface_pauses
      BEGIN SELECT RAISE(ABORT, 'work surface pauses are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS work_surface_pauses_no_delete BEFORE DELETE ON work_surface_pauses
      BEGIN SELECT RAISE(ABORT, 'work surface pauses are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS work_surface_pause_items_no_update BEFORE UPDATE ON work_surface_pause_items
      BEGIN SELECT RAISE(ABORT, 'work surface pause items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS work_surface_pause_items_no_delete BEFORE DELETE ON work_surface_pause_items
      BEGIN SELECT RAISE(ABORT, 'work surface pause items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS work_surface_actions_no_update BEFORE UPDATE ON work_surface_actions
      BEGIN SELECT RAISE(ABORT, 'work surface actions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS work_surface_actions_no_delete BEFORE DELETE ON work_surface_actions
      BEGIN SELECT RAISE(ABORT, 'work surface actions are immutable'); END;`
});

export class WorkSurfaceStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first pause; a missing file reads as no pauses and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, WORK_SURFACES_FORMAT);
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

  addPause({ pauseId, personalSpaceId, filter, createdAt, items }) {
    this.db.prepare('INSERT INTO work_surface_pauses VALUES(?, ?, ?, ?)')
      .run(pauseId, personalSpaceId, JSON.stringify(filter), createdAt);
    const insert = this.db.prepare('INSERT INTO work_surface_pause_items VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
    for (const item of items) {
      insert.run(pauseId, item.kind, item.id, item.name, item.agentId, item.personalProjectId, item.on ? 1 : 0,
        item.resume === undefined ? null : JSON.stringify(item.resume));
    }
  }

  addAction({ pauseId, action, actor, at, results }) {
    this.db.prepare(`INSERT INTO work_surface_actions(pause_id, action, actor, agent_id, session_id, at, results)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(pauseId, action, actor.type, actor.agentId ?? null, actor.sessionId ?? null, at,
      JSON.stringify(results));
  }

  pause(pauseId) {
    if (!this.readable) return null;
    return pauseView(this.db.prepare('SELECT * FROM work_surface_pauses WHERE pause_id = ?').get(pauseId));
  }

  latestPause(personalSpaceId) {
    if (!this.readable) return null;
    return pauseView(this.db.prepare(`SELECT * FROM work_surface_pauses WHERE personal_space_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(personalSpaceId));
  }

  // The newest pauses first.
  pauses(personalSpaceId, limit) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM work_surface_pauses WHERE personal_space_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(personalSpaceId, limit).map(pauseView);
  }

  items(pauseId) {
    return this.db.prepare('SELECT * FROM work_surface_pause_items WHERE pause_id = ? ORDER BY rowid')
      .all(pauseId).map((row) => ({ kind: row.kind, id: row.item_id, name: row.name, agentId: row.agent_id,
        personalProjectId: row.personal_project_id, wasOn: row.was_on === 1,
        resume: row.resume_detail === null ? null : JSON.parse(row.resume_detail) }));
  }

  actions(pauseId) {
    return this.db.prepare('SELECT * FROM work_surface_actions WHERE pause_id = ? ORDER BY id').all(pauseId)
      .map((row) => ({ action: row.action, actor: { type: row.actor, agentId: row.agent_id, sessionId: row.session_id },
        at: row.at, results: JSON.parse(row.results) }));
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function pauseView(row) {
  if (!row) return null;
  return { pauseId: row.pause_id, personalSpaceId: row.personal_space_id, filter: JSON.parse(row.filter),
    createdAt: row.created_at };
}
