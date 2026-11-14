import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Who may visit this computer's shared project knowledge from another one, in
// which mode, and every attempt a visitor made (the visiting assistant). A
// requester is 'peer:<device fingerprint>' or 'guest:<link id>'. A row is one
// contact: a search, or a look at the shared lead's card. A read row is
// written before its search runs (outcome 'pending') and settled afterwards
// as 'answered' or 'failed'; a refused attempt is a 'refused' row with its
// code. Rows keep the visitor's queries as they were searched (already cut),
// how many items and bytes went back, never the items themselves. Guest links
// and visit requests come with their own slices as later versions.
const READS_TABLE = `
    CREATE TABLE IF NOT EXISTS visitor_reads(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_key TEXT NOT NULL,
      requester_label TEXT NOT NULL,
      agent_name TEXT,
      project_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('search', 'card')),
      outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'answered', 'failed', 'refused')),
      code TEXT,
      queries_json TEXT NOT NULL,
      results_count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visitor_reads_at ON visitor_reads(at);
    CREATE INDEX IF NOT EXISTS visitor_reads_requester_at ON visitor_reads(requester_key, at);`;

// Version 2 (guest links, src/guest-access): declared here exactly as that
// change declares it, so version 3 follows it in every build.
const GUEST_LINK_TABLES = `
    CREATE TABLE IF NOT EXISTS guest_links(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT);
    CREATE INDEX IF NOT EXISTS guest_links_live ON guest_links(revoked_at, expires_at);`;

// Version 3: requests a visitor sent to be done on this computer
// (src/visit-requests). One row per request, its state as of now; every
// change of state is one event row, kept with the request. The requester's
// own text (title, what, areas) is kept as it came, already bounded; the
// lead's assessment (plan_json) beside it, never mixed in. A refused request
// is a row too, so the owner sees what was asked.
const VISIT_REQUEST_TABLES = `
    CREATE TABLE IF NOT EXISTS visit_requests(
      id TEXT PRIMARY KEY,
      requester_key TEXT NOT NULL,
      requester_label TEXT NOT NULL,
      agent_name TEXT,
      source TEXT NOT NULL CHECK(source IN ('peer', 'guest')),
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      project_folder TEXT,
      title TEXT NOT NULL,
      what TEXT NOT NULL,
      requester_areas_json TEXT NOT NULL,
      plan_json TEXT,
      plan_error TEXT,
      state TEXT NOT NULL CHECK(state IN ('received', 'refused', 'planning', 'awaiting_owner', 'approved', 'running',
        'awaiting_review', 'declined', 'expired', 'cancelled', 'failed', 'unknown', 'kept', 'discarded')),
      review TEXT CHECK(review IN ('ready', 'held')),
      hold_reason TEXT,
      held_paths_json TEXT,
      mode_at_receipt TEXT NOT NULL,
      mode_at_decision TEXT,
      decided_by TEXT CHECK(decided_by IN ('owner', 'rule')),
      reason TEXT,
      branch TEXT,
      worktree_path TEXT,
      base_commit TEXT,
      result_summary TEXT,
      files_json TEXT,
      diffstat_json TEXT,
      planning_ms INTEGER NOT NULL,
      run_ms INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visit_requests_requester ON visit_requests(requester_key, created_at);
    CREATE INDEX IF NOT EXISTS visit_requests_state ON visit_requests(state, updated_at);
    CREATE TABLE IF NOT EXISTS visit_request_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL REFERENCES visit_requests(id),
      from_state TEXT,
      to_state TEXT NOT NULL,
      by TEXT NOT NULL CHECK(by IN ('requester', 'owner', 'rule', 'system')),
      rule TEXT,
      checks_json TEXT,
      note TEXT,
      at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visit_request_events_request ON visit_request_events(request_id, id);`;

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
    ${READS_TABLE}`,
  migrations: [{
    id: 'visitor-access/2-guest-links', to: 2, kind: 'add-table', table: 'guest_links',
    summary: 'guest links: one project a person without FULI may ask from the same network', create: GUEST_LINK_TABLES
  }, {
    id: 'visitor-access/3-visit-requests', to: 3, kind: 'add-table', table: 'visit_requests',
    summary: 'visit requests: work a paired computer asked to have done here, and every change of its state',
    create: VISIT_REQUEST_TABLES
  }]
});

// Rows older than this are deleted on the next recorded attempt.
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;
// A flood is visible long before this; past it, one requester's refusals in a
// day are no longer written, so the file stays bounded.
const REFUSALS_KEPT_PER_DAY = 1000;

export class VisitorAccessStore {
  constructor(path = ':memory:', { warn = line => process.stderr.write(line) } = {}) {
    this.path = path;
    this.warn = warn;
  }

  // Opened on the first write; a missing file reads as empty and is never created by a read.
  get db() {
    if (!this.database) {
      const database = openFormattedDatabase(this.path, VISITOR_ACCESS_FORMAT);
      try {
        const kept = setAsidePrereleaseReads(database);
        if (kept) this.warn(`FULI: visitor reads from a pre-release build were kept as ${kept}; a new list starts.\n`);
      } catch (error) {
        database.close();
        throw error;
      }
      this.database = database;
    }
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  // One immediate transaction: what is counted in it and what is written in it
  // cannot interleave with another process's attempt.
  transaction(work) {
    return immediateTransaction(this.db, work);
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

  // A search or card about to be answered, as 'pending'; answers its row id. at is a Date.
  reserveRead({ requesterKey, requesterLabel, agentName, projectId, action, queries, at }) {
    this.#retain(at);
    return Number(this.db.prepare(`INSERT INTO visitor_reads(requester_key, requester_label, agent_name, project_id,
      action, outcome, code, queries_json, results_count, bytes, at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, 0, 0, ?)`)
      .run(requesterKey, requesterLabel, agentName, projectId, action, JSON.stringify(queries), at.toISOString())
      .lastInsertRowid);
  }

  settleRead(id, { outcome, code = null, resultsCount = 0, bytes = 0 }) {
    this.db.prepare(`UPDATE visitor_reads SET outcome = ?, code = ?, results_count = ?, bytes = ?
      WHERE id = ? AND outcome = 'pending'`).run(outcome, code, resultsCount, bytes, id);
  }

  // A refused attempt, without its queries; not written past
  // REFUSALS_KEPT_PER_DAY of one requester's refusals in a day.
  recordRefusal({ requesterKey, requesterLabel, agentName, projectId, action, code, at }) {
    const today = new Date(at.getTime() - DAY_MS).toISOString();
    const refused = this.db.prepare(`SELECT COUNT(*) AS count FROM visitor_reads
      WHERE requester_key = ? AND outcome = 'refused' AND at > ?`).get(requesterKey, today).count;
    if (refused >= REFUSALS_KEPT_PER_DAY) return;
    this.#retain(at);
    this.db.prepare(`INSERT INTO visitor_reads(requester_key, requester_label, agent_name, project_id, action,
      outcome, code, queries_json, results_count, bytes, at) VALUES (?, ?, ?, ?, ?, 'refused', ?, '[]', 0, 0, ?)`)
      .run(requesterKey, requesterLabel, agentName, projectId, action, code, at.toISOString());
  }

  // How many reads of one project, by every requester, ran or are running after
  // since (an ISO instant); refused attempts are not reads.
  projectReadsSince(projectId, since) {
    if (!this.readable) return 0;
    return this.db.prepare("SELECT COUNT(*) AS count FROM visitor_reads WHERE project_id = ? AND outcome <> 'refused' AND at > ?")
      .get(projectId, since).count;
  }

  // How many attempts, of any outcome, one requester made after since (an ISO instant).
  attemptsSince(requesterKey, since) {
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

  #retain(at) {
    this.db.prepare('DELETE FROM visitor_reads WHERE at < ?').run(new Date(at.getTime() - RETENTION_MS).toISOString());
  }
}

// PRE-RELEASE REPAIR, delete after the first release that contains this store.
// Version 1 never shipped in a release, and no release build writes this
// file; only development builds of the visiting assistant did, with a
// visitor_reads table without an outcome or without the card action. The
// format engine has no step that rebuilds a table, so such a table is set
// aside here, whole, in one transaction (renamed visitor_reads_prerelease_<n>,
// its indexes dropped), and the current table is created; requesters stay as
// they are. Answers the name it was kept under, or null when nothing was needed.
function setAsidePrereleaseReads(database) {
  const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'visitor_reads'").get()?.sql ?? '';
  if (/\boutcome\b/.test(sql) && sql.includes("'card'")) return null;
  return immediateTransaction(database, () => {
    const taken = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'visitor_reads_prerelease_%'")
      .all().map(row => row.name));
    let index = 1;
    while (taken.has(`visitor_reads_prerelease_${index}`)) index += 1;
    const kept = `visitor_reads_prerelease_${index}`;
    database.exec(`DROP INDEX IF EXISTS visitor_reads_at; DROP INDEX IF EXISTS visitor_reads_requester_at;
      ALTER TABLE visitor_reads RENAME TO ${kept};${READS_TABLE}`);
    return kept;
  });
}

function requesterView(row) {
  return { key: row.key, kind: row.kind, label: row.label, mode: row.mode, ownDevice: row.own_device === 1,
    modeUpdatedAt: row.mode_updated_at };
}

function readView(row) {
  return { id: row.id, requesterKey: row.requester_key, requesterLabel: row.requester_label, agentName: row.agent_name,
    projectId: row.project_id, action: row.action, outcome: row.outcome, code: row.code,
    queries: JSON.parse(row.queries_json), resultsCount: row.results_count, bytes: row.bytes, at: row.at };
}
