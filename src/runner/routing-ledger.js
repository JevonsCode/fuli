import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// What Tonborg decided on this runner (docs/runner.md, "Executor judgment on
// a runner") and how each choice turned out: one record per decision, kept
// so a repeated requestId gets the same answer, an outcome is reported once,
// and the next judgment here reads the earlier ones as feedback. A copy of
// each decision and outcome goes to the host through the outbox; the host's
// Tonborg ledger is the record of them. Nothing here expires with time, as
// nothing a follower keeps does (runner-store.js); `fuli runner leave` deletes
// the file.
export const ROUTING_LEDGER_FILE = 'runner/routing.sqlite';

export const ROUTING_LEDGER_FORMAT = sqliteFormat({
  store: 'runner-routing',
  schema: `
    CREATE TABLE IF NOT EXISTS decisions(
      id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL, request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      vote TEXT CHECK(vote IN ('up', 'down')), reason TEXT, reported_at TEXT,
      UNIQUE(space, project, request_id));`,
  migrations: []
});

export class RoutingLedger {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
    this.closed = false;
  }

  get db() {
    if (this.closed) throw new Error('The runner routing ledger is closed');
    this.database ??= openFormattedDatabase(this.path, ROUTING_LEDGER_FORMAT);
    return this.database;
  }

  // The decision already made for this request, or null.
  byRequest({ personalSpaceId, personalProjectId, requestId }) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT * FROM decisions WHERE space = ? AND project = ? AND request_id = ?')
      .get(personalSpaceId, personalProjectId, requestId);
    return row ? decision(row) : null;
  }

  get(id) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? decision(row) : null;
  }

  // record: the decision as it is answered and sent; requestFingerprint tells a
  // repeated request from another one. False when another MCP process of this
  // computer saved a decision for the same request first (the lookup and the
  // save are not one transaction, since the model answers between them): that
  // one is the decision this request has, as a repeated requestId gets.
  save(record, requestFingerprint) {
    return this.db.prepare(`INSERT OR IGNORE INTO decisions(id, space, project, request_id, request_fingerprint,
      body, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.personalSpaceId, record.personalProjectId,
      record.requestId, requestFingerprint, JSON.stringify(record), record.createdAt).changes === 1;
  }

  // How the chosen executor did, once per decision: false when it was reported already.
  reportOutcome(id, { vote, reason }) {
    return this.db.prepare(`UPDATE decisions SET vote = ?, reason = ?, reported_at = ? WHERE id = ? AND reported_at IS NULL`)
      .run(vote, reason, new Date(this.now()).toISOString(), id).changes === 1;
  }

  // The latest decisions in this project with how they turned out, newest first.
  recent({ personalSpaceId, personalProjectId, limit }) {
    if (this.#missing()) return [];
    return this.db.prepare('SELECT * FROM decisions WHERE space = ? AND project = ? ORDER BY created_at DESC LIMIT ?')
      .all(personalSpaceId, personalProjectId, limit).map(decision);
  }

  // Every decision gone, for `fuli runner leave` when the file itself cannot be
  // deleted (on Windows, while a client's FULI process still has it open).
  clear() {
    if (this.#missing()) return;
    this.db.prepare('DELETE FROM decisions').run();
  }

  #missing() {
    return !this.database && this.path !== ':memory:' && !existsSync(this.path);
  }

  close() {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}

function decision(row) {
  return { record: JSON.parse(row.body), requestFingerprint: row.request_fingerprint,
    outcome: row.reported_at ? { vote: row.vote, reason: row.reason, reportedAt: row.reported_at } : null };
}
