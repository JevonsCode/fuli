import { randomUUID } from 'node:crypto';
import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { EmployeeError } from '../employees/manifest.js';
import { deletedKnowledgeBeside } from '../knowledge-hard-delete/delete-ledger.js';
import { forgetDurably, forgetReferences } from '../knowledge-hard-delete/forget-references.js';

export const DEFAULT_PINS = Object.freeze(['employee.bole', 'employee.jefa', 'employee.tonborg']);
export const DEFAULT_POLICY = Object.freeze({ mode: 'manual', quality: 'quality', client: 'codex' });
const conflict = () => new EmployeeError('This record changed. Reload and try again.', 409, 'judgment_conflict');
export const JUDGMENT_FORMAT = sqliteFormat({
  store: 'judgment',
  schema: `
    CREATE TABLE IF NOT EXISTS judgment_settings(space TEXT, key TEXT, revision INTEGER NOT NULL, value TEXT, PRIMARY KEY(space,key));
    CREATE TABLE IF NOT EXISTS judgment_records(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(space,request_key));
    CREATE TABLE IF NOT EXISTS judgment_feedback(id INTEGER PRIMARY KEY, decision TEXT NOT NULL, revision INTEGER NOT NULL, vote TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(decision,revision));
    CREATE TABLE IF NOT EXISTS judgment_execution(id INTEGER PRIMARY KEY, decision TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS judgment_leases(space TEXT, project TEXT, token TEXT, expires INTEGER, PRIMARY KEY(space,project));`
});

// Local, shared by independent MCP/console processes. Judgments are immutable;
// execution receipts and feedback are separate append-only histories.
export class JudgmentStore {
  constructor(path = ':memory:') {
    this.db = openFormattedDatabase(path, JUDGMENT_FORMAT);
    // Knowledge a person permanently deleted (rec#5 C9): every write below
    // reads it inside its own transaction and never stores its words again.
    this.deleted = deletedKnowledgeBeside(path);
  }
  // Whether a review candidate key names permanently deleted knowledge.
  forgets(candidateKey) { return this.deleted().names(candidateKey); }
  #clean(value) { return forgetReferences(value, this.deleted()).value; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(space, key) {
    const row = this.db.prepare('SELECT revision, value FROM judgment_settings WHERE space=? AND key=?').get(space, key);
    return row ? { revision: row.revision, value: JSON.parse(row.value) } : { revision: 0, value: null };
  }
  writeSetting(space, key, value, expectedRevision) {
    return this.transaction(() => {
      if (this.setting(space, key).revision !== expectedRevision) throw conflict();
      this.db.prepare(`INSERT INTO judgment_settings VALUES(?,?,?,?) ON CONFLICT(space,key) DO UPDATE SET revision=excluded.revision,value=excluded.value`)
        .run(space, key, expectedRevision + 1, JSON.stringify(value));
      return expectedRevision + 1;
    });
  }
  pins(space) { const row = this.setting(space, 'pins'); return { revision: row.revision, agentIds: row.value ?? [...DEFAULT_PINS] }; }
  pin(space, agentId, pinned, expectedRevision) {
    const current = this.pins(space);
    if (current.revision !== expectedRevision) throw conflict();
    const agentIds = pinned ? [...new Set([...current.agentIds, agentId])] : current.agentIds.filter(id => id !== agentId);
    const revision = this.writeSetting(space, 'pins', agentIds, expectedRevision);
    return { revision, agentIds };
  }
  policy(space, project = '') {
    const global = this.setting(space, 'policy:');
    const own = project ? this.setting(space, `policy:${project}`) : global;
    return { ...(own.value ?? global.value ?? DEFAULT_POLICY), revision: own.revision,
      globalRevision: global.revision, inherited: Boolean(project && !own.value), personalProjectId: project || null };
  }
  setPolicy(space, project, value, expectedRevision) {
    this.writeSetting(space, `policy:${project}`, value, expectedRevision);
    return this.policy(space, project);
  }
  record(space, data, requestKey) {
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id FROM judgment_records WHERE space=? AND request_key=?').get(space, requestKey);
      if (prior) return this.get(space, prior.id);
      const id = randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO judgment_records VALUES(?,?,?,?,?,?)')
        .run(id, space, data.personalProjectId ?? '', requestKey, new Date().toISOString(), JSON.stringify(this.#clean(data)));
      const saved = this.db.prepare('SELECT id FROM judgment_records WHERE space=? AND request_key=?').get(space, requestKey);
      return this.get(space, saved.id);
    });
  }
  get(space, id) {
    const row = this.db.prepare('SELECT * FROM judgment_records WHERE space=? AND id=?').get(space, id);
    if (!row) throw new EmployeeError('Judgment not found', 404, 'not_found');
    const feedbackHistory = this.db.prepare('SELECT revision,vote,reason,created_at AS createdAt FROM judgment_feedback WHERE decision=? ORDER BY revision').all(id);
    const executionHistory = this.db.prepare('SELECT status,receipt,created_at AS createdAt FROM judgment_execution WHERE decision=? ORDER BY id').all(id)
      .map(value => ({ ...value, receipt: JSON.parse(value.receipt) }));
    return { ...JSON.parse(row.body), id, createdAt: row.created_at, feedbackHistory, executionHistory,
      feedback: feedbackHistory.at(-1) ?? { revision: 0, vote: null, reason: '' },
      execution: executionHistory.at(-1) ?? { status: 'not_applied' } };
  }
  records(space, { personalProjectId, limit = 50 } = {}) {
    const rows = personalProjectId === undefined
      ? this.db.prepare('SELECT id FROM judgment_records WHERE space=? ORDER BY rowid DESC LIMIT ?').all(space, limit)
      : this.db.prepare('SELECT id FROM judgment_records WHERE space=? AND project=? ORDER BY rowid DESC LIMIT ?').all(space, personalProjectId ?? '', limit);
    return rows.map(({ id }) => this.get(space, id));
  }
  acceptances(space, agentId, personalProjectId = null) {
    return this.db.prepare(`SELECT id FROM judgment_records WHERE space=? AND json_extract(body,'$.kind')='acceptance'
      AND json_extract(body,'$.agentId')=? AND (? IS NULL OR project=?) ORDER BY rowid`)
      .all(space, agentId, personalProjectId, personalProjectId).map(({ id }) => this.get(space, id));
  }
  // exceptRequest: records of that request key prefix do not count.
  reviewed(space, project, target, evidenceFingerprint, policyVersion, { exceptRequest = null } = {}) {
    const row = this.db.prepare(`SELECT id FROM judgment_records WHERE space=? AND project=?
      AND json_extract(body,'$.target')=? AND json_extract(body,'$.evidenceFingerprint')=?
      AND json_extract(body,'$.policyVersion')=? AND (?6 IS NULL OR substr(request_key, 1, length(?6) + 1) != ?6 || ':')
      ORDER BY rowid DESC LIMIT 1`)
      .get(space, project, target, evidenceFingerprint, policyVersion, exceptRequest);
    if (!row) return false;
    const record = this.get(space, row.id);
    return record.outcome !== 'failed' && !['failed', 'stale'].includes(record.execution.status);
  }
  hasAutomaticPolicy(space) {
    return this.db.prepare(`SELECT 1 AS enabled FROM judgment_settings WHERE space=? AND key LIKE 'policy:%'
      AND json_extract(value,'$.mode') IN ('shared','autonomous') LIMIT 1`).get(space)?.enabled === 1;
  }
  feedback(space, id, vote, reason, expectedRevision) {
    return this.transaction(() => {
      const decision = this.get(space, id);
      if (decision.feedback.revision !== expectedRevision) throw conflict();
      // A reason about a judgment of deleted knowledge is not kept either.
      this.db.prepare('INSERT INTO judgment_feedback(decision,revision,vote,reason,created_at) VALUES(?,?,?,?,?)')
        .run(id, expectedRevision + 1, vote, decision.hard_deleted ? '' : reason, new Date().toISOString());
      return this.get(space, id);
    });
  }
  // lease: { project, token } of the run that writes the receipt. A run
  // whose scope lease was taken over (it was slow, not dead) writes nothing,
  // so it cannot contradict the receipt of the run that owns the scope now.
  execute(space, id, status, receipt, lease = null) {
    return this.transaction(() => {
      this.get(space, id);
      if (lease && !this.owns(space, lease.project, lease.token)) {
        throw new EmployeeError('This Tonborg run no longer holds its scope; its result was not recorded.', 409, 'judgment_lease_lost');
      }
      this.db.prepare('INSERT INTO judgment_execution(decision,status,receipt,created_at) VALUES(?,?,?,?)')
        .run(id, status, JSON.stringify(this.#clean(receipt)), new Date().toISOString());
      return this.get(space, id);
    });
  }
  // A person hard-deleted knowledge (rec#5 C9): every judgment, receipt and
  // feedback of this space that names it keeps its shape and loses its words.
  // Returns how many rows changed.
  forgetKnowledgeItems(space, references) {
    return forgetDurably(this.db, () => this.transaction(() => {
      let changed = 0;
      const forgotten = [];
      for (const row of this.db.prepare('SELECT id, body FROM judgment_records WHERE space=?').all(space)) {
        const result = forgetReferences(JSON.parse(row.body), references);
        if (!result.changed) continue;
        this.db.prepare('UPDATE judgment_records SET body=? WHERE id=?').run(JSON.stringify(result.value), row.id);
        forgotten.push(row.id);
        changed++;
      }
      for (const row of this.db.prepare(`SELECT e.id, e.receipt FROM judgment_execution e
        JOIN judgment_records r ON r.id = e.decision WHERE r.space=?`).all(space)) {
        const result = forgetReferences(JSON.parse(row.receipt), references);
        if (!result.changed) continue;
        this.db.prepare('UPDATE judgment_execution SET receipt=? WHERE id=?').run(JSON.stringify(result.value), row.id);
        changed++;
      }
      for (const decision of forgotten) {
        changed += Number(this.db.prepare("UPDATE judgment_feedback SET reason='' WHERE decision=? AND reason <> ''")
          .run(decision).changes);
      }
      return changed;
    }));
  }
  // The records one request created, as request key prefix (its own items).
  requestRecords(space, requestKey) {
    return this.db.prepare(`SELECT id FROM judgment_records WHERE space=? AND substr(request_key, 1, length(?2) + 1) = ?2 || ':'
      ORDER BY rowid`).all(space, requestKey).map(({ id }) => this.get(space, id));
  }
  claim(space, project) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT expires FROM judgment_leases WHERE space=? AND project=?').get(space, project);
      // Transient: the scope frees when the running judgment ends, so callers may retry.
      if (current?.expires > Date.now()) throw Object.assign(new EmployeeError('Tonborg is already reviewing this scope.', 409, 'judgment_busy'), { retryable: true });
      const token = randomUUID();
      this.db.prepare('INSERT INTO judgment_leases VALUES(?,?,?,?) ON CONFLICT(space,project) DO UPDATE SET token=excluded.token,expires=excluded.expires')
        .run(space, project, token, Date.now() + 600_000);
      return token;
    });
  }
  // Whether this run still holds the scope lease (time alone does not end it).
  owns(space, project, token) {
    return this.db.prepare('SELECT token FROM judgment_leases WHERE space=? AND project=?').get(space, project)?.token === token;
  }
  release(space, project, token) { this.db.prepare('DELETE FROM judgment_leases WHERE space=? AND project=? AND token=?').run(space, project, token); }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
