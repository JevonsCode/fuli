import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

import { DECISION_ENTRYPOINTS, PRESENCE_LEVELS } from './decision-source.js';
import { appNotFound } from './errors.js';

// A first-generation app id is app-<identity key>; a later generation of the
// same identity, created after the earlier one was deleted, adds -g<N>.
const APP_ID = /^app-[0-9a-f]{32}(?:-g[1-9][0-9]{0,8})?$/;
const OWNER_KINDS = Object.freeze(['console', 'standalone', 'cli']);

// The local registry of Agent apps: identity and status, immutable versions,
// approvals, app tokens (hashes only), the one current instance of each app,
// the owner lease of each app and an append-only event history. Code and data
// stay in their own directories; this database records metadata only. SQLite
// keeps the CLI, a standalone runner and a running console consistent with
// each other. The database is created on first use, so an installation without
// apps has none.
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

  // The newest generation of one identity (provider, space, Agent and name).
  latestGeneration(identityKey) {
    const row = this.database.prepare('SELECT * FROM agent_apps WHERE identity_key = ? ORDER BY generation DESC LIMIT 1')
      .get(identityKey);
    return row ? appRecord(row) : null;
  }

  apps({ personalSpaceId = null, agentId = null } = {}) {
    return this.database.prepare(`SELECT * FROM agent_apps
      WHERE (?1 IS NULL OR personal_space_id = ?1) AND (?2 IS NULL OR agent_id = ?2) ORDER BY created_at, app_id`)
      .all(personalSpaceId, agentId).map(appRecord);
  }

  saveApp(app) {
    this.database.prepare(`INSERT INTO agent_apps (app_id, provider, personal_space_id, agent_id, name, status,
        active_version, data_format, deletion_ticket, deletion_expires_at, deletion_data_digest,
        created_at, updated_at, last_used_at, identity_key, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET status = excluded.status, active_version = excluded.active_version,
        data_format = excluded.data_format, deletion_ticket = excluded.deletion_ticket,
        deletion_expires_at = excluded.deletion_expires_at, deletion_data_digest = excluded.deletion_data_digest,
        created_at = excluded.created_at, updated_at = excluded.updated_at, last_used_at = excluded.last_used_at`)
      .run(app.appId, app.provider, app.personalSpaceId, app.agentId, app.name, app.status,
        app.activeVersion, app.dataFormat, app.deletionTicket, app.deletionExpiresAt, app.deletionDataDigest ?? null,
        app.createdAt, app.updatedAt, app.lastUsedAt, app.identityKey, app.generation);
  }

  // The owner lease of an app (rec#7 D-28.21, D-28.25). owner_fence only grows.
  owner(appId) {
    const row = this.database.prepare(`SELECT owner_id, owner_kind, owner_pid, owner_pid_identity, owner_exe_path,
      owner_fence, owner_acquired_at, owner_heartbeat_at FROM agent_apps WHERE app_id = ?`).get(appId);
    if (!row) throw appNotFound('app_not_found', 'No Agent app has this id');
    return {
      ownerId: row.owner_id, ownerKind: row.owner_kind, pid: row.owner_pid, identity: row.owner_pid_identity,
      exePath: row.owner_exe_path, fence: row.owner_fence, acquiredAt: row.owner_acquired_at, heartbeatAt: row.owner_heartbeat_at
    };
  }

  // Takes the lease for this owner and returns the new fence.
  takeOwner(appId, { ownerId, ownerKind, pid, identity, exePath, at }) {
    if (!OWNER_KINDS.includes(ownerKind)) throw new TypeError(`Unknown app owner kind ${ownerKind}`);
    this.database.prepare(`UPDATE agent_apps SET owner_id = ?, owner_kind = ?, owner_pid = ?, owner_pid_identity = ?,
      owner_exe_path = ?, owner_fence = owner_fence + 1, owner_acquired_at = ?, owner_heartbeat_at = ? WHERE app_id = ?`)
      .run(ownerId, ownerKind, pid, identity, exePath, at, at, appId);
    return this.owner(appId).fence;
  }

  // Ends a lease for its holder only; the fence stays where it is.
  clearOwner(appId, { ownerId, fence }) {
    return Number(this.database.prepare(`UPDATE agent_apps SET owner_id = NULL, owner_kind = NULL, owner_pid = NULL,
      owner_pid_identity = NULL, owner_exe_path = NULL, owner_acquired_at = NULL, owner_heartbeat_at = NULL
      WHERE app_id = ? AND owner_id = ? AND owner_fence = ?`).run(appId, ownerId, fence).changes) === 1;
  }

  heartbeatOwner(appId, { ownerId, fence }, at) {
    return Number(this.database.prepare(`UPDATE agent_apps SET owner_heartbeat_at = ?
      WHERE app_id = ? AND owner_id = ? AND owner_fence = ?`).run(at, appId, ownerId, fence).changes) === 1;
  }

  // Claims the next instance generation for the caller that read expected.
  claimInstanceGeneration(appId, expected) {
    const changed = Number(this.database.prepare(`UPDATE agent_apps SET instance_generation = instance_generation + 1
      WHERE app_id = ? AND instance_generation = ?`).run(appId, expected).changes);
    return changed === 1 ? expected + 1 : null;
  }

  instance(appId) {
    const row = this.database.prepare('SELECT * FROM agent_app_instances WHERE app_id = ?').get(appId);
    return row ? instanceRecord(row) : null;
  }

  // The app's earlier instance, which has ended, gives way to the new one.
  insertInstance({ appId, instanceId, generation, mode, version, digest, ownerId, startedAt }) {
    this.database.prepare('DELETE FROM agent_app_instances WHERE app_id = ?').run(appId);
    this.database.prepare(`INSERT INTO agent_app_instances (app_id, instance_id, generation, mode, state, version, digest,
      owner_id, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(appId, instanceId, generation, mode, version, digest, ownerId, startedAt);
  }

  // Every change of an instance names it by id and generation; 0 rows means
  // another start superseded it.
  updateInstance({ instanceId, generation }, fields) {
    const columns = Object.keys(fields);
    const unknown = columns.filter((column) => !INSTANCE_COLUMNS.has(column));
    if (unknown.length) throw new TypeError(`Unknown instance columns ${unknown.join(', ')}`);
    const assignments = columns.map((column) => `${INSTANCE_COLUMNS.get(column)} = ?`).join(', ');
    return Number(this.database.prepare(`UPDATE agent_app_instances SET ${assignments}
      WHERE instance_id = ? AND generation = ?`).run(...columns.map((column) => fields[column]), instanceId, generation)
      .changes) === 1;
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
      challengeId: row.challenge_id, verifiedAt: row.verified_at, trustMode: row.trust_mode, termsVersion: row.terms_version,
      approvedAt: row.approved_at
    } : null;
  }

  // check: the confirmation of the decision ({ presence, verification, challengeId, verifiedAt, trustMode, termsVersion }).
  insertApproval({ appId, version, digest, permissions, data, resident, approvedBy, entrypoint, approvedAt }, check) {
    this.database.prepare(`INSERT INTO agent_app_approvals (app_id, version, digest, permissions, data, resident,
        approved_by, entrypoint, presence, verification, challenge_id, verified_at, trust_mode, terms_version, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appId, version, digest, JSON.stringify(permissions), JSON.stringify(data), resident ? 1 : 0,
        approvedBy, entrypoint, check.presence, check.verification, check.challengeId, check.verifiedAt,
        check.trustMode, check.termsVersion, approvedAt);
  }

  // Every activation rewrites the confirmation of the version it activates, so
  // a confirmation made for an earlier activation never carries over to a later one.
  setApprovalCheck(appId, version, check) {
    this.database.prepare(`UPDATE agent_app_approvals SET presence = ?, verification = ?, challenge_id = ?, verified_at = ?,
      trust_mode = ?, terms_version = ? WHERE app_id = ? AND version = ?`)
      .run(check.presence, check.verification, check.challengeId, check.verifiedAt, check.trustMode, check.termsVersion,
        appId, version);
  }

  // One open confirmation challenge per app; issuing another replaces it.
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

  // Whether the history records this challenge consumed by a completed terminal confirmation.
  challengeConfirmed(appId, challengeId) {
    return Boolean(this.database.prepare(`SELECT 1 FROM agent_app_events WHERE app_id = ? AND action = 'challenge_consumed'
      AND json_extract(detail, '$.challengeId') = ? AND json_extract(detail, '$.outcome') = 'confirmed' LIMIT 1`)
      .get(appId, challengeId));
  }

  token(tokenHash) {
    const row = this.database.prepare('SELECT * FROM agent_app_tokens WHERE token_hash = ?').get(tokenHash);
    return row ? {
      appId: row.app_id, version: row.version, digest: row.digest, permissions: JSON.parse(row.permissions),
      instanceId: row.instance_id, generation: row.generation, issuedAt: row.issued_at, revokedAt: row.revoked_at
    } : null;
  }

  insertToken({ tokenHash, appId, version, digest, permissions, instanceId, generation, issuedAt }) {
    this.database.prepare(`INSERT INTO agent_app_tokens (token_hash, app_id, version, digest, permissions,
      instance_id, generation, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tokenHash, appId, version, digest, JSON.stringify(permissions), instanceId, generation, issuedAt);
  }

  revokeTokens(appId, reason, at) {
    this.database.prepare(`UPDATE agent_app_tokens SET revoked_at = ?, revoked_reason = ?
      WHERE app_id = ? AND revoked_at IS NULL`).run(at, reason, appId);
  }

  revokeInstanceTokens(appId, instanceId, reason, at) {
    this.database.prepare(`UPDATE agent_app_tokens SET revoked_at = ?, revoked_reason = ?
      WHERE app_id = ? AND instance_id = ? AND revoked_at IS NULL`).run(at, reason, appId, instanceId);
  }

  // Leaves the app row and its event history: the content-free deletion record.
  eraseContent(appId) {
    for (const table of ['agent_app_versions', 'agent_app_approvals', 'agent_app_tokens', 'agent_app_instances']) {
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
      .all(appId, limit).reverse().map(eventRecord);
  }

  // How often one action of one instance happened at or after a time, for rate limits.
  countInstanceEvents(appId, instanceId, action, since) {
    return this.database.prepare(`SELECT COUNT(*) AS count FROM agent_app_events WHERE app_id = ? AND action = ? AND at >= ?
      AND json_extract(detail, '$.instanceId') = ?`).get(appId, action, since, instanceId).count;
  }

  lastEvent(appId, action) {
    const row = this.database.prepare('SELECT * FROM agent_app_events WHERE app_id = ? AND action = ? ORDER BY id DESC LIMIT 1')
      .get(appId, action);
    return row ? eventRecord(row) : null;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
  }
}

const sqlList = (values) => values.map((value) => `'${value}'`).join(', ');

const INSTANCE_COLUMNS = new Map(Object.entries({
  state: 'state', pid: 'pid', pidIdentity: 'pid_identity', exePath: 'exe_path', socket: 'socket',
  sealedAt: 'sealed_at', stoppedAt: 'stopped_at', stopReason: 'stop_reason'
}));

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
  }, {
    // rec#7 D-28.21/D-28.25: the one FULI process (console, standalone runner or
    // CLI) that may change the app or its data, and the fence a takeover raises.
    // Every existing app is generation 1 with no instance yet.
    id: 'agent-apps/4-owner-lease', to: 4, kind: 'add-columns', table: 'agent_apps',
    summary: 'the owner lease and fence of each app, its instance generation counter, its id generation and the content digest a data deletion ticket binds',
    columns: { owner_id: 'TEXT', owner_kind: 'TEXT', owner_pid: 'INTEGER', owner_pid_identity: 'TEXT',
      owner_exe_path: 'TEXT', owner_fence: 'INTEGER NOT NULL DEFAULT 0', owner_acquired_at: 'TEXT',
      owner_heartbeat_at: 'TEXT', instance_generation: 'INTEGER NOT NULL DEFAULT 0',
      generation: 'INTEGER NOT NULL DEFAULT 1', deletion_data_digest: 'TEXT' }
  }, {
    // rec#7 D-28.9/D-28.14: one current instance per app, named by a random id
    // and the generation its start claimed.
    id: 'agent-apps/5-instances', to: 5, kind: 'add-table', table: 'agent_app_instances',
    summary: 'the current or last instance of each app: id, generation, mode, state and process identity',
    create: `CREATE TABLE IF NOT EXISTS agent_app_instances (
      app_id TEXT NOT NULL UNIQUE, instance_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('managed', 'standalone')),
      state TEXT NOT NULL CHECK (state IN ('running', 'stopping', 'sealing', 'sealed')),
      version TEXT NOT NULL, digest TEXT NOT NULL, owner_id TEXT NOT NULL,
      pid INTEGER, pid_identity TEXT, exe_path TEXT, socket TEXT,
      started_at TEXT NOT NULL, sealed_at TEXT, stopped_at TEXT, stop_reason TEXT
    )`
  }, {
    // A token issued before instances names none and no longer verifies.
    id: 'agent-apps/6-token-instance', to: 6, kind: 'add-columns', table: 'agent_app_tokens',
    summary: 'the instance and generation an app token was issued to',
    columns: { instance_id: 'TEXT', generation: 'INTEGER' }
  }, {
    // rec#7 D-28.9: conflicts are found by identity, not by app id. The
    // identity key of a first-generation app is its id without the prefix.
    id: 'agent-apps/7-identity-keys', to: 7, kind: 'backfill', table: 'agent_apps',
    summary: 'the identity key (provider, space, Agent and name) of each existing app, which is its first generation',
    columns: { identity_key: 'TEXT' },
    // Asked before the column exists, so every existing app needs it.
    backfillKeys: (database) => database.prepare('SELECT app_id FROM agent_apps ORDER BY app_id').all().map((row) => row.app_id),
    backfill: (database) => database.exec('UPDATE agent_apps SET identity_key = substr(app_id, 5, 32)')
  }, {
    // rec#11 D-36.2/D-36.9: this version has no sandbox, so an approved app runs
    // in trusted mode (trust-terms.js). Every approval made before it (the
    // isolated mode of rec#7 PR①, Windows Hello approvals included) keeps NULL
    // here, and the run gate asks for a new terminal confirmation: consent to
    // code that was to run isolated is not consent to run it with the user's
    // own permissions, so it is never converted.
    id: 'agent-apps/8-approval-trust-mode', to: 8, kind: 'add-columns', table: 'agent_app_approvals',
    summary: 'the trust mode and terms version an approval was confirmed under; an earlier approval (isolated mode, '
      + 'Windows Hello included) has none, so its version is confirmed again before it runs',
    columns: { trust_mode: 'TEXT', terms_version: 'INTEGER' }
  }]
});

function openRegistry(path) {
  return openFormattedDatabase(path, AGENT_APP_FORMAT);
}

function appRecord(row) {
  return {
    appId: row.app_id, provider: row.provider, personalSpaceId: row.personal_space_id, agentId: row.agent_id,
    name: row.name, status: row.status, activeVersion: row.active_version, dataFormat: row.data_format,
    deletionTicket: row.deletion_ticket, deletionExpiresAt: row.deletion_expires_at, deletionDataDigest: row.deletion_data_digest,
    createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at,
    identityKey: row.identity_key, generation: row.generation, instanceGeneration: row.instance_generation
  };
}

function versionRecord(row) {
  return {
    appId: row.app_id, version: row.version, state: row.state, digest: row.digest,
    manifest: JSON.parse(row.manifest), files: row.files, bytes: row.bytes, submittedAt: row.submitted_at
  };
}

function instanceRecord(row) {
  return {
    appId: row.app_id, instanceId: row.instance_id, generation: row.generation, mode: row.mode, state: row.state,
    version: row.version, digest: row.digest, ownerId: row.owner_id, pid: row.pid, pidIdentity: row.pid_identity,
    exePath: row.exe_path, socket: row.socket, startedAt: row.started_at,
    sealedAt: row.sealed_at, stoppedAt: row.stopped_at, stopReason: row.stop_reason
  };
}

function eventRecord(row) {
  return {
    at: row.at, action: row.action, version: row.version, actor: row.actor,
    ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) })
  };
}
