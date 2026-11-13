import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Who may visit this computer's shared project knowledge from another one, in
// which mode, and every read a visitor made (the visiting assistant). A
// requester is 'peer:<device fingerprint>' or 'guest:<link id>'. A read row
// keeps the visitor's queries as they were searched (already cut), how many
// items and bytes went back, never the items themselves. Guest links and
// visit requests come with their own slices as later versions.
export const VISITOR_ACCESS_FORMAT = sqliteFormat({
  store: 'visitor-access',
  schema: `
    CREATE TABLE IF NOT EXISTS requesters(
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('peer', 'guest')),
      label TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('ask_only', 'plan', 'auto', 'trusted')),
      own_device INTEGER NOT NULL CHECK(own_device IN (0, 1)),
      mode_updated_at TEXT NOT NULL,
      CHECK(mode <> 'trusted' OR (kind = 'peer' AND own_device = 1)));
    CREATE TABLE IF NOT EXISTS visitor_reads(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_key TEXT NOT NULL,
      requester_label TEXT NOT NULL,
      agent_name TEXT,
      project_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('search')),
      queries_json TEXT NOT NULL,
      results_count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visitor_reads_at ON visitor_reads(at);
    CREATE INDEX IF NOT EXISTS visitor_reads_requester_at ON visitor_reads(requester_key, at);`
});

// Read rows older than this are deleted on the next recorded read.
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class VisitorAccessStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first write; a missing file reads as empty and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, VISITOR_ACCESS_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  requester(key) {
    if (!this.readable) return null;
    const row = this.db.prepare('SELECT * FROM requesters WHERE key = ?').get(key);
    return row ? requesterView(row) : null;
  }

  setRequester({ key, kind, label, mode, ownDevice, at }) {
    this.db.prepare(`INSERT INTO requesters(key, kind, label, mode, own_device, mode_updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, label = excluded.label,
      mode = excluded.mode, own_device = excluded.own_device, mode_updated_at = excluded.mode_updated_at`)
      .run(key, kind, label, mode, ownDevice ? 1 : 0, at);
    return this.requester(key);
  }

  // One read, and the retention cut, in one transaction. at is a Date.
  recordRead({ requesterKey, requesterLabel, agentName, projectId, action, queries, resultsCount, bytes, at }) {
    const cutoff = new Date(at.getTime() - RETENTION_MS).toISOString();
    immediateTransaction(this.db, () => {
      this.db.prepare('DELETE FROM visitor_reads WHERE at < ?').run(cutoff);
      this.db.prepare(`INSERT INTO visitor_reads(requester_key, requester_label, agent_name, project_id, action,
        queries_json, results_count, bytes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(requesterKey, requesterLabel, agentName ?? null, projectId, action, JSON.stringify(queries),
          resultsCount, bytes, at.toISOString());
    });
  }

  // How many reads one requester made after since (an ISO instant).
  readsSince(requesterKey, since) {
    if (!this.readable) return 0;
    return this.db.prepare('SELECT COUNT(*) AS count FROM visitor_reads WHERE requester_key = ? AND at > ?')
      .get(requesterKey, since).count;
  }

  // Newest first, optionally of one requester and one project.
  recentReads({ requesterKey = null, projectId = null, limit }) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM visitor_reads
      WHERE (? IS NULL OR requester_key = ?) AND (? IS NULL OR project_id = ?)
      ORDER BY at DESC, id DESC LIMIT ?`)
      .all(requesterKey, requesterKey, projectId, projectId, limit).map(readView);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function requesterView(row) {
  return { key: row.key, kind: row.kind, label: row.label, mode: row.mode, ownDevice: row.own_device === 1,
    modeUpdatedAt: row.mode_updated_at };
}

function readView(row) {
  return { id: row.id, requesterKey: row.requester_key, requesterLabel: row.requester_label, agentName: row.agent_name,
    projectId: row.project_id, action: row.action, queries: JSON.parse(row.queries_json),
    resultsCount: row.results_count, bytes: row.bytes, at: row.at };
}
