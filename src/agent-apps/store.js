import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { appNotFound } from './errors.js';

const APP_ID = /^app-[0-9a-f]{32}$/;

// The local registry of Agent apps: identity and status, immutable versions,
// approvals, app tokens (hashes only) and an append-only event history. Code
// and data stay in their own directories; this database records metadata only.
// SQLite keeps the CLI and a running console consistent with each other. The
// database is created on first use, so an installation without apps has none.
export class AgentAppStore {
  #path;
  #database = null;
  #closed = false;

  constructor(path) {
    this.#path = path;
  }

  get database() {
    if (this.#closed) throw new Error('Agent app registry is closed');
    if (!this.#database) this.#database = openRegistry(this.#path);
    return this.#database;
  }

  transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  app(appId) {
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return null;
    const row = this.database.prepare('SELECT * FROM agent_apps WHERE app_id = ?').get(appId);
    return row ? appRecord(row) : null;
  }

  existingApp(appId) {
    const app = this.app(appId);
    if (!app) throw appNotFound('app_not_found', 'No Agent app has this id');
    return app;
  }

  apps({ personalSpaceId = null, agentId = null } = {}) {
    return this.database.prepare(`SELECT * FROM agent_apps
      WHERE (?1 IS NULL OR personal_space_id = ?1) AND (?2 IS NULL OR agent_id = ?2) ORDER BY created_at, app_id`)
      .all(personalSpaceId, agentId).map(appRecord);
  }

  saveApp(app) {
    this.database.prepare(`INSERT INTO agent_apps (app_id, provider, personal_space_id, agent_id, name, status,
        active_version, data_format, deletion_ticket, deletion_expires_at, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET status = excluded.status, active_version = excluded.active_version,
        data_format = excluded.data_format, deletion_ticket = excluded.deletion_ticket,
        deletion_expires_at = excluded.deletion_expires_at, created_at = excluded.created_at,
        updated_at = excluded.updated_at, last_used_at = excluded.last_used_at`)
      .run(app.appId, app.provider, app.personalSpaceId, app.agentId, app.name, app.status,
        app.activeVersion, app.dataFormat, app.deletionTicket, app.deletionExpiresAt,
        app.createdAt, app.updatedAt, app.lastUsedAt);
  }

  versions(appId) {
    return this.database.prepare('SELECT * FROM agent_app_versions WHERE app_id = ? ORDER BY rowid')
      .all(appId).map(versionRecord);
  }

  version(appId, version) {
    if (typeof version !== 'string') return null;
    const row = this.database.prepare('SELECT * FROM agent_app_versions WHERE app_id = ? AND version = ?').get(appId, version);
    return row ? versionRecord(row) : null;
  }

  insertVersion({ appId, version, state, digest, manifest, files, bytes, submittedAt }) {
    this.database.prepare(`INSERT INTO agent_app_versions
      (app_id, version, state, digest, manifest, files, bytes, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appId, version, state, digest, JSON.stringify(manifest), files, bytes, submittedAt);
  }

  setVersionState(appId, version, state) {
    this.database.prepare('UPDATE agent_app_versions SET state = ? WHERE app_id = ? AND version = ?').run(state, appId, version);
  }

  markCodeDeleted(appId) {
    return Number(this.database.prepare("UPDATE agent_app_versions SET state = 'code_deleted' WHERE app_id = ?")
      .run(appId).changes);
  }

  approval(appId, version) {
    const row = this.database.prepare('SELECT * FROM agent_app_approvals WHERE app_id = ? AND version = ?').get(appId, version);
    return row ? {
      appId: row.app_id, version: row.version, digest: row.digest, permissions: JSON.parse(row.permissions),
      data: JSON.parse(row.data), resident: row.resident === 1, approvedBy: row.approved_by,
      channel: row.channel, approvedAt: row.approved_at
    } : null;
  }

  insertApproval({ appId, version, digest, permissions, data, resident, approvedBy, channel, approvedAt }) {
    this.database.prepare(`INSERT INTO agent_app_approvals
      (app_id, version, digest, permissions, data, resident, approved_by, channel, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appId, version, digest, JSON.stringify(permissions), JSON.stringify(data), resident ? 1 : 0,
        approvedBy, channel, approvedAt);
  }

  token(tokenHash) {
    const row = this.database.prepare('SELECT * FROM agent_app_tokens WHERE token_hash = ?').get(tokenHash);
    return row ? {
      appId: row.app_id, version: row.version, digest: row.digest, permissions: JSON.parse(row.permissions),
      issuedAt: row.issued_at, revokedAt: row.revoked_at
    } : null;
  }

  insertToken({ tokenHash, appId, version, digest, permissions, issuedAt }) {
    this.database.prepare(`INSERT INTO agent_app_tokens (token_hash, app_id, version, digest, permissions, issued_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(tokenHash, appId, version, digest, JSON.stringify(permissions), issuedAt);
  }

  revokeTokens(appId, reason, at) {
    this.database.prepare(`UPDATE agent_app_tokens SET revoked_at = ?, revoked_reason = ?
      WHERE app_id = ? AND revoked_at IS NULL`).run(at, reason, appId);
  }

  // Leaves the app row and its event history: the content-free deletion record.
  eraseContent(appId) {
    for (const table of ['agent_app_versions', 'agent_app_approvals', 'agent_app_tokens']) {
      this.database.prepare(`DELETE FROM ${table} WHERE app_id = ?`).run(appId);
    }
  }

  recordEvent({ appId, at, action, version = null, actor = null, detail = null }) {
    this.database.prepare('INSERT INTO agent_app_events (app_id, at, action, version, actor, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(appId, at, action, version, actor, detail === null ? null : JSON.stringify(detail));
  }

  events(appId, limit) {
    return this.database.prepare('SELECT * FROM agent_app_events WHERE app_id = ? ORDER BY id DESC LIMIT ?')
      .all(appId, limit).reverse().map((row) => ({
        at: row.at, action: row.action, version: row.version, actor: row.actor,
        ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) })
      }));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
  }
}

function openRegistry(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS agent_apps (
      app_id TEXT PRIMARY KEY, provider TEXT NOT NULL, personal_space_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      active_version TEXT, data_format INTEGER, deletion_ticket TEXT, deletion_expires_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_app_versions (
      app_id TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL,
      manifest TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, submitted_at TEXT NOT NULL,
      PRIMARY KEY (app_id, version)
    );
    CREATE TABLE IF NOT EXISTS agent_app_approvals (
      app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, permissions TEXT NOT NULL,
      data TEXT NOT NULL, resident INTEGER NOT NULL, approved_by TEXT NOT NULL, channel TEXT NOT NULL,
      approved_at TEXT NOT NULL, PRIMARY KEY (app_id, version)
    );
    CREATE TABLE IF NOT EXISTS agent_app_tokens (
      token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
      permissions TEXT NOT NULL, issued_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_app_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, at TEXT NOT NULL,
      action TEXT NOT NULL, version TEXT, actor TEXT, detail TEXT
    )`);
  return database;
}

function appRecord(row) {
  return {
    appId: row.app_id, provider: row.provider, personalSpaceId: row.personal_space_id, agentId: row.agent_id,
    name: row.name, status: row.status, activeVersion: row.active_version, dataFormat: row.data_format,
    deletionTicket: row.deletion_ticket, deletionExpiresAt: row.deletion_expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at
  };
}

function versionRecord(row) {
  return {
    appId: row.app_id, version: row.version, state: row.state, digest: row.digest,
    manifest: JSON.parse(row.manifest), files: row.files, bytes: row.bytes, submittedAt: row.submitted_at
  };
}
