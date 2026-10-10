import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EmployeeError } from '../employees/manifest.js';

export const DEFAULT_PINS = Object.freeze(['employee.bole', 'employee.jefa', 'employee.tonborg']);
export const DEFAULT_POLICY = Object.freeze({ mode: 'manual', quality: 'quality', client: 'codex' });
const conflict = () => new EmployeeError('This record changed. Reload and try again.', 409, 'judgment_conflict');

// Local, shared by independent MCP/console processes. Judgments are immutable;
// execution receipts and feedback are separate append-only histories.
export class JudgmentStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS judgment_settings(space TEXT, key TEXT, revision INTEGER NOT NULL, value TEXT, PRIMARY KEY(space,key));
      CREATE TABLE IF NOT EXISTS judgment_records(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(space,request_key));
      CREATE TABLE IF NOT EXISTS judgment_feedback(id INTEGER PRIMARY KEY, decision TEXT NOT NULL, revision INTEGER NOT NULL, vote TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(decision,revision));
      CREATE TABLE IF NOT EXISTS judgment_execution(id INTEGER PRIMARY KEY, decision TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS judgment_leases(space TEXT, project TEXT, token TEXT, expires INTEGER, PRIMARY KEY(space,project));`);
  }
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
    const prior = this.db.prepare('SELECT id FROM judgment_records WHERE space=? AND request_key=?').get(space, requestKey);
    if (prior) return this.get(space, prior.id);
    const id = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO judgment_records VALUES(?,?,?,?,?,?)')
      .run(id, space, data.personalProjectId ?? '', requestKey, new Date().toISOString(), JSON.stringify(data));
    const saved = this.db.prepare('SELECT id FROM judgment_records WHERE space=? AND request_key=?').get(space, requestKey);
    return this.get(space, saved.id);
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
  reviewed(space, project, target, evidenceFingerprint, policyVersion) {
    const row = this.db.prepare(`SELECT id FROM judgment_records WHERE space=? AND project=?
      AND json_extract(body,'$.target')=? AND json_extract(body,'$.evidenceFingerprint')=?
      AND json_extract(body,'$.policyVersion')=? ORDER BY rowid DESC LIMIT 1`)
      .get(space, project, target, evidenceFingerprint, policyVersion);
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
      if (this.get(space, id).feedback.revision !== expectedRevision) throw conflict();
      this.db.prepare('INSERT INTO judgment_feedback(decision,revision,vote,reason,created_at) VALUES(?,?,?,?,?)')
        .run(id, expectedRevision + 1, vote, reason, new Date().toISOString());
      return this.get(space, id);
    });
  }
  execute(space, id, status, receipt) {
    this.get(space, id);
    this.db.prepare('INSERT INTO judgment_execution(decision,status,receipt,created_at) VALUES(?,?,?,?)')
      .run(id, status, JSON.stringify(receipt), new Date().toISOString());
    return this.get(space, id);
  }
  claim(space, project) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT expires FROM judgment_leases WHERE space=? AND project=?').get(space, project);
      if (current?.expires > Date.now()) throw new EmployeeError('Tonborg is already reviewing this scope.', 409, 'judgment_busy');
      const token = randomUUID();
      this.db.prepare('INSERT INTO judgment_leases VALUES(?,?,?,?) ON CONFLICT(space,project) DO UPDATE SET token=excluded.token,expires=excluded.expires')
        .run(space, project, token, Date.now() + 600_000);
      return token;
    });
  }
  release(space, project, token) { this.db.prepare('DELETE FROM judgment_leases WHERE space=? AND project=? AND token=?').run(space, project, token); }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
