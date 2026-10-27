import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// The services FULI Agents started (服务管理): an Agent app's workbench FULI
// runs itself, or a server an Agent started from its client session and
// reported. One row per service with what it is for, whose it is, how it was
// started and the state it was last recorded in; the live state is checked on
// every read (port.js), never stored. agent_service_logs keeps what happened
// to each service (start, stop, crash, who did what, the output tail of a
// process FULI owns) until the person clears it or deletes the record.
export const AGENT_SERVICES_FORMAT = sqliteFormat({
  store: 'agent-services',
  schema: `
    CREATE TABLE IF NOT EXISTS agent_services(
      service_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('workbench', 'agent_service')),
      personal_space_id TEXT, agent_id TEXT, project_id TEXT, client TEXT, session_id TEXT, app_id TEXT,
      address TEXT, purpose TEXT NOT NULL, command TEXT,
      pid INTEGER, pid_identity TEXT, executable TEXT, command_line TEXT,
      state TEXT NOT NULL CHECK(state IN ('running', 'stopped')), started_at TEXT NOT NULL, stopped_at TEXT,
      stop_reason TEXT, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_services_app ON agent_services(app_id);
    CREATE TABLE IF NOT EXISTS agent_service_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS agent_service_logs_service ON agent_service_logs(service_id, id);`
});

const COLUMNS = Object.freeze({
  serviceId: 'service_id', kind: 'kind', personalSpaceId: 'personal_space_id', agentId: 'agent_id',
  projectId: 'project_id', client: 'client', sessionId: 'session_id', appId: 'app_id', address: 'address',
  purpose: 'purpose', command: 'command', pid: 'pid', pidIdentity: 'pid_identity', executable: 'executable',
  commandLine: 'command_line', state: 'state', startedAt: 'started_at', stoppedAt: 'stopped_at',
  stopReason: 'stop_reason', updatedAt: 'updated_at'
});

export class AgentServiceStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first write; a missing file reads as no services and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, AGENT_SERVICES_FORMAT);
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

  get(serviceId) {
    if (!this.readable) return null;
    return view(this.db.prepare('SELECT * FROM agent_services WHERE service_id = ?').get(serviceId));
  }

  // The running workbench record of an app, if any.
  runningWorkbench(appId) {
    if (!this.readable) return null;
    return view(this.db.prepare(`SELECT * FROM agent_services WHERE app_id = ? AND kind = 'workbench'
      AND state = 'running' ORDER BY started_at DESC LIMIT 1`).get(appId));
  }

  list() {
    if (!this.readable) return [];
    return this.db.prepare('SELECT * FROM agent_services ORDER BY started_at DESC, service_id').all().map(view);
  }

  insert(record) {
    const names = Object.values(COLUMNS);
    this.db.prepare(`INSERT INTO agent_services(${names.join(', ')}) VALUES(${names.map((name) => `:${name}`).join(', ')})`)
      .run(columns(record));
  }

  update(serviceId, fields) {
    const entries = Object.entries(fields).filter(([key]) => Object.hasOwn(COLUMNS, key) && key !== 'serviceId');
    if (!entries.length) return;
    this.db.prepare(`UPDATE agent_services SET ${entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ')}
      WHERE service_id = ?`).run(...entries.map(([, value]) => value ?? null), serviceId);
  }

  delete(serviceId) {
    this.db.prepare('DELETE FROM agent_service_logs WHERE service_id = ?').run(serviceId);
    return this.db.prepare('DELETE FROM agent_services WHERE service_id = ?').run(serviceId).changes > 0;
  }

  appendLog({ serviceId, at, action, actor, detail = null }) {
    this.db.prepare('INSERT INTO agent_service_logs(service_id, at, action, actor, detail) VALUES(?, ?, ?, ?, ?)')
      .run(serviceId, at, action, actor, detail === null ? null : JSON.stringify(detail));
  }

  // The newest entries first.
  logs(serviceId, limit) {
    if (!this.readable) return [];
    return this.db.prepare('SELECT * FROM agent_service_logs WHERE service_id = ? ORDER BY id DESC LIMIT ?')
      .all(serviceId, limit).map((row) => ({ id: row.id, at: row.at, action: row.action, actor: row.actor,
        detail: row.detail === null ? null : JSON.parse(row.detail) }));
  }

  clearLogs(serviceId) {
    return this.db.prepare('DELETE FROM agent_service_logs WHERE service_id = ?').run(serviceId).changes;
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function columns(record) {
  return Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [column, record[key] ?? null]));
}

function view(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [key, row[column]]));
}
