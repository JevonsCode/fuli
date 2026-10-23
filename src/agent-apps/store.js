import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

import { DECISION_ENTRYPOINTS, PRESENCE_LEVELS } from './decision-source.js';
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
      entrypoint: row.entrypoint, presence: row.presence, verification: row.verification,
      challengeId: row.challenge_id, verifiedAt: row.verified_at, approvedAt: row.approved_at
    } : null;
  }

  // check: the presence check of the decision ({ presence, verification, challengeId, verifiedAt }).
  insertApproval({ appId, version, digest, permissions, data, resident, approvedBy, entrypoint, approvedAt }, check) {
    this.database.prepare(`INSERT INTO agent_app_approvals (app_id, version, digest, permissions, data, resident,
        approved_by, entrypoint, presence, verification, challenge_id, verified_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appId, version, digest, JSON.stringify(permissions), JSON.stringify(data), resident ? 1 : 0,
        approvedBy, entrypoint, check.presence, check.verification, check.challengeId, check.verifiedAt, approvedAt);
  }

  // Every activation rewrites the presence check of the version it activates,
  // so a check made for an earlier activation never carries over to a later one.
  setApprovalCheck(appId, version, check) {
    this.database.prepare(`UPDATE agent_app_approvals SET presence = ?, verification = ?, challenge_id = ?, verified_at = ?
      WHERE app_id = ? AND version = ?`)
      .run(check.presence, check.verification, check.challengeId, check.verifiedAt, appId, version);
  }

  // One open presence challenge per app; issuing another replaces it.
  challenge(appId) {
    const row = this.database.prepare(`SELECT challenge_id, challenge_nonce_hash, challenge_decision, challenge_terms,
      challenge_expires_at, challenge_consumed_at FROM agent_apps WHERE app_id = ?`).get(appId);
    return row?.challenge_id ? {
      challengeId: row.challenge_id, nonceHash: row.challenge_nonce_hash, decision: JSON.parse(row.challenge_decision),
      terms: row.challenge_terms, expiresAt: row.challenge_expires_at, consumedAt: row.challenge_consumed_at
    } : null;
  }

  saveChallenge(appId, { challengeId, nonceHash, decision, terms, expiresAt }) {
    this.database.prepare(`UPDATE agent_apps SET challenge_id = ?, challenge_nonce_hash = ?, challenge_decision = ?,
      challenge_terms = ?, challenge_expires_at = ?, challenge_consumed_at = NULL, challenge_claim = NULL WHERE app_id = ?`)
      .run(challengeId, nonceHash, JSON.stringify(decision), terms, expiresAt, appId);
  }

  // Consumes the challenge for the one caller whose update still found it open,
  // and records that caller's claim token; true for that caller only.
  claimChallenge(appId, challengeId, { at, claim }) {
    return Number(this.database.prepare(`UPDATE agent_apps SET challenge_consumed_at = ?, challenge_claim = ?
      WHERE app_id = ? AND challenge_id = ? AND challenge_consumed_at IS NULL`).run(at, claim, appId, challengeId).changes) === 1;
  }

  // Ends a claim; true only for its holder, once. The challenge stays consumed.
  releaseChallengeClaim(appId, challengeId, claim) {
    return Number(this.database.prepare(`UPDATE agent_apps SET challenge_claim = NULL
      WHERE app_id = ? AND challenge_id = ? AND challenge_claim = ?`).run(appId, challengeId, claim).changes) === 1;
  }

  // Whether the history records this challenge consumed by a successful presence check.
  challengeVerified(appId, challengeId) {
    return Boolean(this.database.prepare(`SELECT 1 FROM agent_app_events WHERE app_id = ? AND action = 'challenge_consumed'
      AND json_extract(detail, '$.challengeId') = ? AND json_extract(detail, '$.outcome') = 'verified' LIMIT 1`)
      .get(appId, challengeId));
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
    this.database.prepare(`UPDATE agent_apps SET challenge_id = NULL, challenge_nonce_hash = NULL, challenge_decision = NULL,
      challenge_terms = NULL, challenge_expires_at = NULL, challenge_consumed_at = NULL, challenge_claim = NULL WHERE app_id = ?`).run(appId);
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

const sqlList = (values) => values.map((value) => `'${value}'`).join(', ');

export const AGENT_APP_FORMAT = sqliteFormat({
  store: 'agent-apps',
  schema: `
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
      data TEXT NOT NULL, resident INTEGER NOT NULL, approved_by TEXT NOT NULL,
      entrypoint TEXT NOT NULL CHECK (entrypoint IN (${sqlList(DECISION_ENTRYPOINTS)})),
      presence TEXT NOT NULL CHECK (presence IN (${sqlList(PRESENCE_LEVELS)})),
      approved_at TEXT NOT NULL, PRIMARY KEY (app_id, version)
    );
    CREATE TABLE IF NOT EXISTS agent_app_tokens (
      token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
      permissions TEXT NOT NULL, issued_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_app_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, at TEXT NOT NULL,
      action TEXT NOT NULL, version TEXT, actor TEXT, detail TEXT
    )`,
  migrations: [{
    // An approval written before presence checks has none of these and reads as unverified.
    id: 'agent-apps/2-approval-presence', to: 2, kind: 'add-columns', table: 'agent_app_approvals',
    summary: 'the OS user verification bound to the challenge of the decision that activated the version',
    columns: { verification: 'TEXT', challenge_id: 'TEXT', verified_at: 'TEXT' }
  }, {
    id: 'agent-apps/3-presence-challenges', to: 3, kind: 'add-columns', table: 'agent_apps',
    summary: 'the open presence challenge of a CLI approval or rollback: nonce hash, decision, terms digest, expiry and claim',
    columns: { challenge_id: 'TEXT', challenge_nonce_hash: 'TEXT', challenge_decision: 'TEXT', challenge_terms: 'TEXT',
      challenge_expires_at: 'TEXT', challenge_consumed_at: 'TEXT', challenge_claim: 'TEXT' }
  }]
});

function openRegistry(path) {
  return openFormattedDatabase(path, AGENT_APP_FORMAT);
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
